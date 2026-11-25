import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { answer, approve, decided, digest, get, page, post, row, rows } from "./support/approvals";
import { CHAT_SCOPES, chatRoutes, chatTools, googleMessage, human, routeOf } from "./support/chat";
import { rpcResult } from "./support/oauth";
import { expectError, NORTHWIND, PERSONAL, textResult, toolCall } from "./support/permissions";
import { setTool } from "./support/uploads";

type Fixture = Awaited<ReturnType<typeof chatTools>>;
type Out = { messages: Array<Record<string, unknown>>; next_page?: string };
const read = (f: Fixture, args: Record<string, unknown>) =>
  toolCall(f.mcp, "read_conversation", { account: PERSONAL, ...args });
const search = (f: Fixture, args: Record<string, unknown>) =>
  toolCall(f.mcp, "search_messages", { account: PERSONAL, ...args });
const pending = async (response: Response) => {
  const out = await answer(response);
  expect(out.status).toBe("pending");
  return out.approval as string;
};
const firstValue = async (f: Fixture, id: string) => (await page(f, id)).request.values[0];

it("refuses another search's page or a malformed one at the call, before an approval or a Chat request", async () => {
  const f = await chatTools({ search_messages: "ask" });
  await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
    .bind(JSON.stringify(CHAT_SCOPES), f.northwind.id)
    .run();
  await setTool(f, "search_messages", "ask", f.northwind);
  const log = chatRoutes({
    "POST spaces/-/messages:search": ({ body }) =>
      Response.json({ results: [], ...(body?.pageToken ? {} : { nextPageToken: "G-TOKEN" }) }),
  });
  const first = await pending(await search(f, { unread: true }));
  await approve(f, first);
  const cursor = ((await get(f, first)).result as Out).next_page!;
  const [own] = cursor.split(".");
  const approvals = (await rows()).length;
  const requests = log.length;
  for (const args of [
    { mentions_me: true, page: cursor },
    { unread: true, limit: 11, page: cursor },
    { account: NORTHWIND, unread: true, page: cursor },
    { unread: true, page: "" },
    { unread: true, page: 12 },
    { unread: true, page: `${own}.${"T".repeat(2_000 - own!.length)}` },
    { unread: true, page: `${own}.` },
  ])
    await expectError(
      await search(f, args),
      "invalid_arguments",
      /^The page field must be the complete next_page .*1 to 2,000 characters.*the account, criteria, and limit that returned it\.$/,
    );
  expect(await rows()).toHaveLength(approvals);
  expect(log).toHaveLength(requests);
  await pending(
    await search(f, { account: `  ${PERSONAL.toUpperCase()} `, unread: true, page: cursor }),
  );
});

it("approves an unnamed group whose people Google lists in another order, and stops when one changed", async () => {
  const f = await chatTools({ read_conversation: "ask" });
  const members: Record<string, Record<string, unknown>> = {};
  const group = (space: string) => ({
    [`GET ${space}`]: () => Response.json({ spaceType: "GROUP_CHAT" }),
    [`GET ${space}/members`]: () => Response.json(members[space]),
    [`GET ${space}/messages`]: () =>
      Response.json({ messages: [googleMessage(space, "m", "2026-11-22T10:00:00Z")] }),
  });
  const log = chatRoutes({ ...group("spaces/G11"), ...group("spaces/G2") });
  const me = human(PERSONAL, "Alex");
  const n = (i: number) => String(i).padStart(2, "0");
  const eleven = Array.from({ length: 11 }, (_, i) => human(`p${n(i)}@example.org`, `P${n(i)}`));
  const readResult = async (id: string) => {
    expect((await row(id))!.state).toBe("approved");
    expect(((await get(f, id)).result as Out).messages).toHaveLength(1);
  };

  members["spaces/G11"] = { memberships: [me, ...eleven] };
  const many = await pending(await read(f, { conversation: "spaces/G11" }));
  const seenMany = await digest(f, many);
  expect(await firstValue(f, many)).toEqual({
    name: "Group conversation with, among others",
    text: Array.from({ length: 10 }, (_, i) => `P${n(i)} <p${n(i)}@example.org>`).join("\n"),
    from: "chat",
  });
  members["spaces/G11"] = { memberships: [me, ...eleven.toReversed()] };
  await post(f, many, "approve", { digest: seenMany }).then(decided);
  await readResult(many);

  const two = [me, human("bea@example.org", "Bea\nStone"), human("kim@example.org", "Kim")];
  members["spaces/G2"] = { memberships: two, nextPageToken: "" };
  const complete = await pending(await read(f, { conversation: "spaces/G2" }));
  const seenComplete = await digest(f, complete);
  expect(await firstValue(f, complete)).toEqual({
    name: "Group conversation with",
    text: "Bea Stone <bea@example.org>\nKim <kim@example.org>",
    from: "chat",
  });
  members["spaces/G2"] = { memberships: two };
  await post(f, complete, "approve", { digest: seenComplete }).then(decided);
  await readResult(complete);

  const changed = await pending(await read(f, { conversation: "spaces/G2" }));
  const seenChanged = await digest(f, changed);
  members["spaces/G2"] = { memberships: [...two.slice(0, 2), human("kim2@example.org", "Kim")] };
  const before = log.length;
  await post(f, changed, "approve", { digest: seenChanged }).then(decided);
  expect((await row(changed))!.state).toBe("waiting");
  expect(log.slice(before).map(routeOf)).not.toContain("GET spaces/G2/messages");
});

it("searches for exactly the criteria the owner approved and continues with any spelling of them", async () => {
  const f = await chatTools({ search_messages: "ask" });
  const log = chatRoutes({
    "GET spaces/AAA": () =>
      Response.json({ spaceType: "SPACE", displayName: "Direct message with Bea" }),
    "POST spaces/-/messages:search": ({ body }) =>
      Response.json({ results: [], ...(body?.pageToken ? {} : { nextPageToken: "G" }) }),
  });
  const args = {
    text: "launch budget",
    from: "Bea@Example.org",
    conversation: "spaces/AAA",
    after: "2026-11-20T08:00:00.1Z",
    before: "2026-11-23T02:00:00.123456789+02:00",
    unread: true,
    mentions_me: true,
    limit: 7,
  };
  const id = await pending(await search(f, args));
  const values = [
    { name: "Words", text: "launch\nbudget", from: "agent" },
    { name: "From", text: "bea@example.org", from: "agent" },
    { name: "Space", text: "Direct message with Bea", from: "chat" },
    { name: "Conversation ID", text: "spaces/AAA", from: "agent" },
    { name: "After", text: "2026-11-20T08:00:00.1Z", from: "agent" },
    { name: "Before", text: "2026-11-23T00:00:00.123456789Z", from: "agent" },
    { name: "Only unread", text: "Yes", from: "agent" },
    { name: "Only messages that mention this account", text: "Yes", from: "agent" },
    { name: "Limit", text: "7", from: "agent" },
  ];
  expect((await page(f, id)).request.values).toEqual(values);
  const before = log.length;
  await approve(f, id);
  const filter =
    '"launch" "budget" AND sender.name = "users/bea@example.org" AND space.name = spaces/AAA' +
    ' AND create_time >= "2026-11-20T08:00:00.1Z" AND create_time < "2026-11-23T00:00:00.123456789Z"' +
    " AND is_unread() AND annotations.user_mentions.user.name:users/me";
  const run = log.slice(before);
  expect(run.slice(-2).map(routeOf)).toEqual(["GET spaces/AAA", "POST spaces/-/messages:search"]);
  expect(run.at(-1)!.body).toEqual({ filter, pageSize: 7 });
  const cursor = ((await get(f, id)).result as Out).next_page!;
  await setTool(f, "search_messages", "allow");
  const continuation = { ...args, after: new Date(args.after).toISOString(), page: cursor };
  expect(await rpcResult(await search(f, continuation))).toEqual(
    textResult({ account: PERSONAL, messages: [] }),
  );
  expect(log.at(-1)!.body).toEqual({ filter, pageSize: 7, pageToken: "G" });

  const requests = log.length;
  await expectError(
    await search(f, { ...continuation, after: "2026-11-20T08:00:00.100000001Z" }),
    "invalid_arguments",
    /^The page field must be the complete next_page /,
  );
  expect(log).toHaveLength(requests);

  await setTool(f, "search_messages", "ask");
  const next = await pending(
    await search(f, { ...continuation, after: "2026-11-20T05:00:00.100000000-03:00" }),
  );
  expect((await page(f, next)).request.values).toEqual([
    ...values,
    { name: "Page", text: cursor, from: "agent" },
  ]);
});

it("continues a search started at a UTC minute with the same minute in another offset", async () => {
  const f = await chatTools({ search_messages: "allow" });
  const log = chatRoutes({
    "POST spaces/-/messages:search": ({ body }) =>
      Response.json(body?.pageToken ? {} : { nextPageToken: "G" }),
  });
  const first = await answer(await search(f, { after: "2026-11-22T10:30Z" }));
  await answer(await search(f, { after: "2026-11-22T07:30-03:00", page: first.next_page }));
  const request = { filter: 'create_time >= "2026-11-22T10:30:00Z"', pageSize: 10 };
  expect(log.map(({ body }) => body)).toEqual([request, { ...request, pageToken: "G" }]);
});
