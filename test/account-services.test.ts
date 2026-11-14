import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { CALENDAR_SCOPES } from "./support/calendar";
import { SCOPES, google } from "./support/google";
import { accounts, finish, NOW, ownerBrowser, start } from "./support/accounts";
import { dump, observeStatements } from "./support/db";
import { answer, approve, decided, digest, get, page, post, rows } from "./support/approvals";
import { expectError, fixture, googleTraffic, PERSONAL, toolCall } from "./support/permissions";
import { attachCall, attaching, copy, setTool } from "./support/uploads";
import { ORIGIN, testEnv } from "./support/worker";

const chosen = async (
  browser: Awaited<ReturnType<typeof ownerBrowser>>,
  services: string[],
  id?: string,
) => {
  const response = await browser.post(
    id ? `/accounts/${id}/reconnect` : "/accounts/connect",
    services.map((s) => ["services", s]),
  );
  expect(response.status).toBe(200);
  return new URL((await response.json<{ url: string }>()).url);
};
const missing = (service: string) =>
  `This server has no ${service} access to ${PERSONAL}. Ask the owner to reconnect it at ${ORIGIN}/accounts with ${service} chosen and every box checked.`;

it.each([["gmail"], ["calendar"], ["gmail", "calendar"]].map((services) => ({ services })))(
  "asks only for the chosen services $services",
  async ({ services }) => {
    const browser = await ownerBrowser();
    const url = await chosen(browser, services);
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      [
        "openid",
        "email",
        ...(services.includes("gmail") ? SCOPES : []),
        ...(services.includes("calendar") ? CALENDAR_SCOPES : []),
      ].sort(),
    );
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  },
);

it.each(
  [[], ["unknown"], ["gmail", "unknown"], ["calendar", "calendar"]].map((services) => ({
    services,
  })),
)("rejects invalid services $services before starting either flow", async ({ services }) => {
  const f = await fixture();
  for (const path of ["/accounts/connect", `/accounts/${f.personal.id}/reconnect`]) {
    const response = await f.mcp.browser.post(
      path,
      services.map((s) => ["services", s]),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ outcome: "invalid" });
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect(google.events).toEqual([]);
});

it.each([undefined, [], ["unknown"], ["gmail", "gmail"]].map((services) => ({ services })))(
  "rejects a flow cookie with invalid services $services without exchanging its code",
  async ({ services }) => {
    const browser = await ownerBrowser();
    const { url } = await start(browser);
    const name = `__Host-g-${url.searchParams.get("state")}`;
    const value = JSON.parse(decodeURIComponent(browser.cookies.get(ORIGIN)!.get(name)!));
    value.services = services;
    const before = await dump();
    await browser.get(google.issueCode(url), {
      headers: { Cookie: `${name}=${encodeURIComponent(JSON.stringify(value))}` },
    });
    expect(await dump()).toEqual(before);
    expect(google.events).toEqual([]);
  },
);

it("stores a partial Calendar grant and warns about its incomplete access", async () => {
  const browser = await ownerBrowser();
  const url = await chosen(browser, ["calendar"]);
  const callback = await browser.get(
    google.issueCode(url, { scope: ["openid", "email", ...SCOPES, CALENDAR_SCOPES[0]!].join(" ") }),
  );
  const alert = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-accounts-outcome="))!;
  expect(JSON.parse(decodeURIComponent(alert.split(";")[0]!.split("=")[1]!))).toEqual({
    kind: "connected",
    address: PERSONAL,
    incomplete: ["calendar"],
  });
  expect(JSON.parse((await accounts())[0]!.scopes)).toEqual([CALENDAR_SCOPES[0]]);
  expect(await (await browser.get("/accounts")).text()).toContain(
    "Google didn&#x27;t grant all of Calendar&#x27;s access",
  );
});

it("lists both chosen services in the incomplete notice when both grants are partial", async () => {
  const browser = await ownerBrowser();
  const url = await chosen(browser, ["gmail", "calendar"]);
  const response = await browser.get(
    google.issueCode(url, { scope: ["openid", SCOPES[0]!, CALENDAR_SCOPES[0]!].join(" ") }),
  );
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-accounts-outcome="))!;
  expect(JSON.parse(decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!)).incomplete).toEqual([
    "gmail",
    "calendar",
  ]);
  expect(JSON.parse((await accounts())[0]!.scopes)).toEqual([SCOPES[0], CALENDAR_SCOPES[0]]);
  expect(await (await browser.get("/accounts")).text()).toContain("Gmail and Calendar");
});

it.each(["connect", "reconnect"])(
  "keeps all stored data unchanged when %s grants none of the chosen scopes",
  async (kind) => {
    const f = await fixture({ sub: "personal" });
    const before = await dump();
    const url = await chosen(
      f.mcp.browser,
      ["calendar"],
      kind === "reconnect" ? f.personal.id : undefined,
    );
    const result = await finish(f.mcp.browser, url, {
      scope: ["openid", "email", ...SCOPES].join(" "),
    });
    expect(result.text).toContain(
      "Nothing changed. Google didn't grant any of the access you chose. Try again and check the boxes on Google's screen.",
    );
    expect(await dump()).toEqual(before);
    expect(google.events).not.toContain("revoke");
  },
);

it.each(["allow", "ask"] as const)(
  "keeps Gmail usable and refuses Calendar on a legacy Gmail account at %s",
  async (setting) => {
    const f = await fixture();
    await setTool(f, "list_labels", "allow");
    expect(
      (await answer(await toolCall(f.mcp, "list_labels", { account: PERSONAL }))).labels,
    ).toBeDefined();
    expect(await answer(await toolCall(f.mcp, "list_accounts"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ services: { gmail: { status: "ready" } } }),
      ]),
    );
    await setTool(f, "list_calendars", setting);
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, "list_calendars", { account: PERSONAL }),
      "account_missing_access",
      missing("Calendar"),
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
    const listed = await answer(await toolCall(f.mcp, "list_accounts"));
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          services: {
            gmail: { status: "ready" },
            calendar: { status: "missing_access", message: missing("Calendar") },
          },
        }),
      ]),
    );
  },
);

it.each(["allow", "ask"] as const)(
  "refuses incomplete Calendar scopes on an expired admin block at %s without Google or an approval",
  async (setting) => {
    const f = await fixture({
      health: "blocked_by_admin",
      blocked_until: NOW - 1,
      access_token: null,
      access_expires_at: null,
    });
    await setTool(f, "list_calendars", setting);
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, "list_calendars", { account: PERSONAL }),
      "account_blocked_by_admin",
      /admin blocked/,
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

const gmailInputs = [
  ["list_labels", {}],
  ["search_threads", { query: "lunch" }],
  ["read_thread", { thread: "abc" }],
  ["change_labels", { threads: ["abc"], add: ["STARRED"] }],
  ["create_draft", { body: "Hi" }],
  ["trash_messages", { messages: ["abc"] }],
  ["restore_messages", { messages: ["abc"] }],
  ["delete_messages", { messages: ["abc"] }],
  ["get_attachment", { message: "abc", attachment: "2" }],
  ["send_message", { to: ["sam@example.com"], subject: "Hello", body: "Hi" }],
  ["send_reply", { message: "abc", body: "Hi" }],
  ["forward_message", { message: "abc", to: ["sam@example.com"] }],
  ["send_draft", { draft: "abc" }],
] as const;
it.each(["allow", "ask"] as const)(
  "refuses every Gmail tool on Calendar-only access at %s before Google or an approval",
  async (setting) => {
    const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES) });
    const before = googleTraffic().length;
    for (const [tool, input] of gmailInputs) {
      await setTool(f, tool, setting);
      await expectError(
        await toolCall(f.mcp, tool, { account: PERSONAL, ...input }),
        "account_missing_access",
        missing("Gmail"),
      );
    }
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

it.each(["gmail", "calendar"] as const)(
  "refuses a waiting approval after a reconnect drops %s, even when Google returns its scopes",
  async (dropped) => {
    const f = await fixture({
      sub: "personal",
      scopes: JSON.stringify([...SCOPES, ...CALENDAR_SCOPES]),
    });
    const tool = dropped === "gmail" ? "list_labels" : "list_calendars";
    await setTool(f, tool, "ask");
    const pending = await answer(await toolCall(f.mcp, tool, { account: PERSONAL }));
    const id = pending.approval as string;
    const kept = dropped === "gmail" ? "calendar" : "gmail";
    await finish(f.mcp.browser, await chosen(f.mcp.browser, [kept], f.personal.id), {
      scope: ["openid", "email", ...SCOPES, ...CALENDAR_SCOPES].join(" "),
    });
    expect(JSON.parse((await accounts())[0]!.scopes)).toEqual(
      kept === "gmail" ? SCOPES : CALENDAR_SCOPES,
    );
    expect((await rows())[0]!.state).toBe("waiting");
    const before = googleTraffic().length;
    await approve(f, id);
    expect((await get(f, id)).error).toEqual({
      code: "account_missing_access",
      message: missing(dropped === "gmail" ? "Gmail" : "Calendar"),
    });
    expect(googleTraffic()).toHaveLength(before);
    expect(google.events).not.toContain("revoke");
  },
);

it.each(["allow", "ask"] as const)(
  "refuses a Calendar-only copied-attachment source at %s before creating an approval",
  async (setting) => {
    const f = await attaching("send_message", setting);
    await setTool(f, "get_attachment", "allow", f.northwind);
    await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
      .bind(JSON.stringify(CALENDAR_SCOPES), f.northwind.id)
      .run();
    const before = googleTraffic().length;
    await expectError(
      await attachCall(f, [copy]),
      "account_missing_access",
      new RegExp(`no Gmail access to ${f.northwind.email}`),
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

const partial = [
  { tool: "list_labels", name: "Gmail", scopes: [...SCOPES.slice(0, 4), ...CALENDAR_SCOPES] },
  { tool: "list_calendars", name: "Calendar", scopes: [...SCOPES, ...CALENDAR_SCOPES.slice(0, 2)] },
] as const;
it.each(partial.flatMap((c) => (["allow", "ask"] as const).map((setting) => ({ ...c, setting }))))(
  "refuses $tool when $name is granted only in part, at $setting, before Google or an approval",
  async ({ tool, name, scopes, setting }) => {
    const f = await fixture({ scopes: JSON.stringify(scopes) });
    await setTool(f, tool, setting);
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, tool, { account: PERSONAL }),
      "account_missing_access",
      missing(name),
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

it.each(partial)(
  "fails the approved run of $tool when $name is granted only in part by then",
  async ({ tool, name, scopes }) => {
    const f = await fixture({ scopes: JSON.stringify([...SCOPES, ...CALENDAR_SCOPES]) });
    await setTool(f, tool, "ask");
    const id = (await answer(await toolCall(f.mcp, tool, { account: PERSONAL })))
      .approval as string;
    await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
      .bind(JSON.stringify(scopes), f.personal.id)
      .run();
    const before = googleTraffic().length;
    await approve(f, id);
    expect((await get(f, id)).error).toEqual({
      code: "account_missing_access",
      message: missing(name),
    });
    expect(googleTraffic()).toHaveLength(before);
  },
);

it.each(["allow", "ask"] as const)(
  "refuses a copied-attachment source with Gmail granted only in part at %s",
  async (setting) => {
    const f = await attaching("send_message", setting);
    await setTool(f, "get_attachment", "allow", f.northwind);
    await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
      .bind(JSON.stringify(SCOPES.slice(0, 4)), f.northwind.id)
      .run();
    const before = googleTraffic().length;
    await expectError(
      await attachCall(f, [copy]),
      "account_missing_access",
      new RegExp(`no Gmail access to ${f.northwind.email}`),
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

it("lists only the services each connection uses and hides deny and obsolete-only accounts", async () => {
  const f = await fixture();
  await setTool(f, "list_labels", "allow");
  await setTool(f, "list_calendars", "ask", f.northwind);
  const listed = await answer(await toolCall(f.mcp, "list_accounts"));
  expect(listed).toEqual([
    { account: PERSONAL, name: "Personal", services: { gmail: { status: "ready" } } },
    {
      account: f.northwind.email,
      name: "Northwind",
      services: {
        calendar: { status: "missing_access", message: expect.stringContaining("Calendar") },
      },
    },
  ]);
  await setTool(f, "list_labels", "deny");
  await env.DB.prepare("UPDATE permissions SET tool = 'removed_tool' WHERE account_id = ?")
    .bind(f.northwind.id)
    .run();
  expect(await answer(await toolCall(f.mcp, "list_accounts"))).toEqual([]);
});

it.each(["allow", "ask"] as const)(
  "refuses a source's expired admin block without its Gmail scopes at %s",
  async (setting) => {
    const f = await attaching("send_message", setting);
    await setTool(f, "get_attachment", "allow", f.northwind);
    await env.DB.prepare(
      "UPDATE accounts SET scopes = ?, health = 'blocked_by_admin', blocked_until = ?, access_token = NULL, access_expires_at = NULL WHERE id = ?",
    )
      .bind(JSON.stringify(CALENDAR_SCOPES), NOW - 1, f.northwind.id)
      .run();
    const before = googleTraffic().length;
    await expectError(
      await attachCall(f, [copy]),
      "account_blocked_by_admin",
      new RegExp(`admin blocked this server for ${f.northwind.email}`),
    );
    expect(googleTraffic()).toHaveLength(before);
    expect(await rows()).toEqual([]);
  },
);

it("refuses an approved copied attachment when its source loses Gmail between view and decision", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const shown = await digest(f, id);
  let changed = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!changed && sql.startsWith("UPDATE approvals SET state = 'approved'")) {
      changed = true;
      await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
        .bind(JSON.stringify(CALENDAR_SCOPES), f.northwind.id)
        .run();
    }
  });
  const result = await decided(
    await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })),
  );
  expect(result.state.kind).toBe("failed");
  expect((await get(f, id)).error).toEqual({
    code: "account_missing_access",
    message: expect.stringContaining(`no Gmail access to ${f.northwind.email}`),
  });
  expect(google.sends).toEqual([]);
  expect(google.uploads).toEqual([]);
});

it("does not read an approval's attachment source after its Gmail access is dropped", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
    .bind(JSON.stringify(CALENDAR_SCOPES), f.northwind.id)
    .run();
  const before = googleTraffic().length;
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: false });
  expect(googleTraffic()).toHaveLength(before);
});
