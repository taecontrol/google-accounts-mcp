import "./support/account-checks";
import { env } from "cloudflare:workers";
import { http } from "msw";
import { expect, it, vi } from "vite-plus/test";
import { TOOLS } from "../src/mcp/tools";
import { answer, approve, decided, digest, get, page, post } from "./support/approvals";
import {
  CALENDAR_LIST,
  calendarFake,
  eventsFixture,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
} from "./support/calendar";
import { createEventCall, eventWriter, primaryList, repeatCalendars } from "./support/event-write";
import { onceRows } from "./support/draft";
import { observeStatements } from "./support/db";
import { expectError, PERSONAL } from "./support/permissions";
import { testEnv } from "./support/worker";
import { setTool } from "./support/uploads";
import { network } from "./support/network";
import { rpcResult } from "./support/oauth";

it("names the last day of an all-day event, not its exclusive end", async () => {
  const f = await eventsFixture("create_event", "ask");
  repeatCalendars(PRIMARY_CALENDAR);
  eventWriter();
  const id = (await answer(await createEventCall(f, { start: "2026-11-20", end: "2026-11-21" })))
    .approval as string;
  const view = await page(f, id);
  expect(
    view.request.values.filter((value) => ["Starts", "Ends", "Last day"].includes(value.name)),
  ).toEqual([
    { name: "Starts", text: "Nov 20, 2026 (all day)", from: "agent" },
    { name: "Last day", text: "Nov 20, 2026 (all day)", from: "agent" },
  ]);
});

it.each([false, true])(
  "shows the full approval in order before writing, secondary: %s",
  async (secondary) => {
    const f = await eventsFixture("create_event", "ask");
    const lists = repeatCalendars(PRIMARY_CALENDAR, {
      ...SECONDARY_CALENDAR,
      accessRole: "writer",
    });
    const google = eventWriter();
    const id = (
      await answer(
        await createEventCall(f, {
          ...(secondary ? { calendar: SECONDARY_CALENDAR.id } : {}),
          guests: ["a@example.com", "team@example.com"],
          meet: true,
          location: "Room 1",
          description: "a <b> c & d\nNext",
          duplicate: 2,
        }),
      )
    ).approval as string;
    expect(lists).toHaveLength(0);
    expect(google.inserts).toHaveLength(0);
    const view = await page(f, id);
    expect(view.request.tool).toMatchObject({ action: "create an event", joiner: "in" });
    expect(view.request.values).toEqual([
      {
        name: "Calendar",
        text: secondary ? `Team (${SECONDARY_CALENDAR.id})` : `Personal (${PERSONAL})`,
        from: "calendar",
      },
      ...(secondary
        ? [
            {
              name: "Guests see the organizer as",
              text: `Team (${SECONDARY_CALENDAR.id})`,
              from: "calendar",
            },
          ]
        : []),
      { name: "Title", text: "Planning", from: "agent" },
      { name: "Starts", text: "Nov 20, 2026 at 09:00 (America/Bogota)", from: "agent" },
      { name: "Ends", text: "Nov 20, 2026 at 10:00 (America/Bogota)", from: "agent" },
      {
        name: "Google emails the invitation to these 2 addresses",
        text: "a@example.com\nteam@example.com",
        from: "agent",
      },
      { name: "Google Meet", text: "Asks Google to add a Google Meet link", from: "agent" },
      { name: "Location", text: "Room 1", from: "agent" },
      { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
      { name: "Description", text: "a <b> c & d\nNext", from: "agent" },
    ]);
    expect(view.request.notes).toEqual([
      { text: "A group's address reaches each of its members.", warning: false },
    ]);
    expect(view.state).toMatchObject({ kind: "waiting", shown: true });
    expect(google.inserts).toHaveLength(0);
    await approve(f, id);
    expect(google.inserts).toHaveLength(1);
    expect(google.inserts[0]!.calendar).toBe(secondary ? SECONDARY_CALENDAR.id : PERSONAL);
  },
);

it("labels a single guest in the singular", async () => {
  const f = await eventsFixture("create_event", "ask");
  primaryList();
  const id = (await answer(await createEventCall(f, { guests: ["guest@example.com"] })))
    .approval as string;
  expect((await page(f, id)).request.values).toContainEqual({
    name: "Google emails the invitation to this address",
    text: "guest@example.com",
    from: "agent",
  });
});

it.each(["unlisted", "primary", "reader", "freeBusyReader", "invalid zone", "description"])(
  "offers no Approve for %s",
  async (kind) => {
    const f = await eventsFixture("create_event", "ask");
    repeatCalendars(
      { ...PRIMARY_CALENDAR, ...(kind === "invalid zone" ? { timeZone: "invalid" } : {}) },
      { id: "reader", accessRole: "reader" },
      { id: "freeBusyReader", accessRole: "freeBusyReader" },
    );
    const google = eventWriter();
    const id = (
      await answer(
        await createEventCall(
          f,
          kind === "description"
            ? { description: "a <b>  c" }
            : kind === "invalid zone"
              ? {}
              : { calendar: kind },
        ),
      )
    ).approval as string;
    expect((await page(f, id)).state).toMatchObject({
      kind: "waiting",
      shown: false,
      digest: null,
    });
    expect(await (await f.mcp.browser.get(`/approvals/${id}`)).text()).not.toMatch(/>Approve</);
    expect(google.inserts).toHaveLength(0);
  },
);
it.each(["unlisted", "primary", "reader", "freeBusyReader"])(
  "refuses %s directly from the calendar list",
  async (kind) => {
    const f = await eventsFixture("create_event");
    repeatCalendars(
      PRIMARY_CALENDAR,
      { id: "reader", accessRole: "reader" },
      { id: "freeBusyReader", accessRole: "freeBusyReader" },
    );
    const google = eventWriter();
    await expectError(
      await createEventCall(f, { calendar: kind }),
      ["unlisted", "primary"].includes(kind) ? "not_found" : "invalid_arguments",
      ["unlisted", "primary"].includes(kind)
        ? /No such calendar/
        : /The calendar field.*access owner or writer in list_calendars/,
    );
    expect(google.inserts).toHaveLength(0);
  },
);

it.each(["calendar name", "primary zone", "primary calendar"])(
  "releases the row when %s changes after Approve before the run",
  async (kind) => {
    const f = await eventsFixture("create_event", "ask");
    let changed = false;
    calendarFake(
      ...Array.from(
        { length: 20 },
        () => () =>
          Response.json({
            items: [
              {
                ...PRIMARY_CALENDAR,
                ...(changed
                  ? kind === "calendar name"
                    ? { summary: "Changed" }
                    : kind === "primary zone"
                      ? { timeZone: "Asia/Tokyo" }
                      : { id: "changed@example.com" }
                  : {}),
              },
            ],
          }),
      ),
    );
    const google = eventWriter();
    const id = (await answer(await createEventCall(f))).approval as string;
    const shown = await digest(f, id);
    const db = observeStatements(env.DB, (sql) => {
      if (sql.startsWith("UPDATE approvals SET state = 'approved'")) changed = true;
    });
    expect(
      (await decided(await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })))).state
        .kind,
    ).toBe("failed");
    expect((await get(f, id)).error).toMatchObject({
      code: "invalid_arguments",
      message: expect.stringMatching(
        /calendar or time zone changed after approval.*Nothing was created.*Call again/,
      ),
    });
    expect(google.inserts).toHaveLength(0);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["deny", "ask"] as const)(
  "confirm.check stops an insert when allow becomes %s during preparation",
  async (setting) => {
    const f = await eventsFixture("create_event");
    await setTool(f, "list_calendars", "allow");
    network.use(
      http.get(CALENDAR_LIST, async () => {
        await setTool(f, "create_event", setting);
        return Response.json({ items: [PRIMARY_CALENDAR] });
      }),
    );
    const google = eventWriter();
    await expectError(
      await createEventCall(f),
      setting === "deny" ? "tool_not_allowed" : "server_unavailable",
      /./,
    );
    expect(google.inserts).toHaveLength(0);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["create", "run", "late"])(
  "refuses Calendar writes through an unconfirmed %s send",
  async (mode) => {
    const f = await eventsFixture("create_event");
    const google = eventWriter();
    const name = mode === "run" ? "read_event" : "create_event";
    await setTool(f, name, "allow");
    const tool = TOOLS.find((t) => t.kind === "account" && t.name === name)!;
    if (tool.kind !== "account") throw new Error("Missing tool");
    const build = (_token: string, signal: AbortSignal) =>
      new Request(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events/e1`,
        { method: "PATCH", signal, body: "{}" },
      );
    if (mode === "run") {
      vi.spyOn(tool, "run").mockImplementation((send) => send(build));
      await expectError(
        await f.mcp.call("tools/call", undefined, {
          name,
          arguments: { account: PERSONAL, event: "e1" },
        }),
        "google_unavailable",
        /Google/,
      );
    } else {
      vi.spyOn(tool, "create").mockImplementation((send, _account, _args, confirm) =>
        (mode === "late" ? confirm.late : send)(build),
      );
      await expectError(await createEventCall(f), "google_unavailable", /Google/);
    }
    expect(google.inserts).toHaveLength(0);
    expect(google.reads).toHaveLength(0);
  },
);

it("exposes the write annotations and irreversible invitation permission in the connection page", async () => {
  const f = await eventsFixture("create_event");
  const listed = (await rpcResult(await f.mcp.call("tools/list"))).tools as Array<
    Record<string, unknown>
  >;
  expect(listed.find((t) => t.name === "create_event")).toMatchObject({
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  });
  const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  const props = JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!,
  ) as { tools: unknown[] };
  expect(props.tools).toContainEqual({
    name: "create_event",
    group: "Create and change events",
    irreversible: true,
    label: "Create event",
    description:
      "Create events in calendars where this account can add events. Google emails an invitation to every guest, and an invitation cannot be taken back.",
  });
});
