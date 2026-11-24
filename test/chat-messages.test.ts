import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer } from "./support/approvals";
import { chatRoutes, chatTools, fieldPaths, googleMessage, routeOf } from "./support/chat";
import { expectError, PERSONAL, toolCall } from "./support/permissions";
import { rpcResult } from "./support/oauth";
import { decodeArgs, TOOLS, type Tool } from "../src/mcp/tools";

type Fixture = Awaited<ReturnType<typeof chatTools>>;
type Out = { messages: Array<Record<string, unknown>>; next_page?: string };
const read = (f: Fixture, args: Record<string, unknown>) =>
  toolCall(f.mcp, "read_conversation", { account: PERSONAL, ...args });
const search = (f: Fixture, args: Record<string, unknown>) =>
  toolCall(f.mcp, "search_messages", { account: PERSONAL, ...args });
const resultText = async (response: Response) => {
  const result = await rpcResult(response);
  expect(result.isError).toBeUndefined();
  return (result.content as { text: string }[])[0]!.text;
};

it("tells a missing thread from a Google page that says more remain", async () => {
  const f = await chatTools({ read_conversation: "allow" });
  let reply: Record<string, unknown> = {};
  const log = chatRoutes({ "GET spaces/AAA/messages": () => Response.json(reply) });
  const thread = "spaces/AAA/threads/T1";
  const missing = JSON.parse(
    await expectError(await read(f, { conversation: "spaces/AAA", thread }), "not_found", /./),
  ).message as string;
  expect(missing).toContain(`"${thread}"`);
  expect(missing).toContain('"spaces/AAA"');
  expect(missing).not.toMatch(/only in the account/);
  expect(
    await answer(
      await read(f, { conversation: "spaces/AAA", thread, page: "2026-11-22T10:00:00Z" }),
    ),
  ).toEqual({ account: PERSONAL, conversation: "spaces/AAA", messages: [] });
  reply = { nextPageToken: "more" };
  const before = log.length;
  await expectError(
    await read(f, { conversation: "spaces/AAA", thread }),
    "google_unavailable",
    /Try again later/,
  );
  expect(log.slice(before).map(routeOf)).toEqual(["GET spaces/AAA/messages"]);
});

it("keeps a last page of exactly 32,000 characters whole and resumes after the last message returned", async () => {
  const f = await chatTools({ read_conversation: "allow" });
  const thread = "spaces/FIT/threads/T";
  const times = [
    "2026-11-22T10:00:00.300003Z",
    "2026-11-22T10:00:00.200002Z",
    "2026-11-22T10:00:00.100001Z",
  ];
  const ids = ["c", "b", "a"];
  const shown = (i: number, text: string) => ({
    message: `spaces/FIT/messages/${ids[i]}`,
    conversation: "spaces/FIT",
    thread,
    ...(i < 2 ? { thread_reply: true } : {}),
    from: { user: "users/101", name: "Bea", email: "bea@example.org" },
    time: times[i],
    text,
  });
  const expected = (oldest: string) => ({
    account: PERSONAL,
    conversation: "spaces/FIT",
    messages: [shown(0, "message c"), shown(1, "message b"), shown(2, oldest)],
  });
  const room = 32_000 - JSON.stringify(expected("")).length;
  const fitting = `${'"'.repeat(Math.floor(room / 2))}${"x".repeat(room % 2)}`;
  expect(JSON.stringify(expected(fitting))).toHaveLength(32_000);
  let oldest = fitting;
  const log = chatRoutes({
    "GET spaces/FIT/messages": () =>
      Response.json({
        messages: [0, 1, 2].map((i) =>
          googleMessage("spaces/FIT", ids[i]!, times[i]!, {
            text: i === 2 ? oldest : `message ${ids[i]}`,
            thread: { name: thread },
            ...(i < 2 ? { threadReply: true } : {}),
          }),
        ),
      }),
  });
  const exact = await resultText(await read(f, { conversation: "spaces/FIT", thread }));
  expect(exact).toHaveLength(32_000);
  expect(JSON.parse(exact)).toEqual(expected(fitting));

  oldest = `${fitting}x`;
  const over = await resultText(await read(f, { conversation: "spaces/FIT", thread }));
  expect(over.length).toBeLessThanOrEqual(32_000);
  const { messages } = expected(oldest);
  expect(JSON.parse(over)).toEqual({
    account: PERSONAL,
    conversation: "spaces/FIT",
    messages: messages.slice(0, 2),
    next_page: times[1],
  });

  await read(f, { conversation: "spaces/FIT", thread, page: times[1] });
  expect(log.at(-1)!.params.get("filter")).toBe(
    `thread.name = ${thread} AND createTime < "${times[1]}"`,
  );
});

it("cuts an oversized first message to fit and points past it when more remain", async () => {
  const f = await chatTools({ read_conversation: "allow" });
  chatRoutes({
    "GET spaces/HUGE/messages": () =>
      Response.json({
        messages: [
          googleMessage("spaces/HUGE", "big", "2026-11-22T10:00:02Z", { text: '"'.repeat(20_000) }),
          googleMessage("spaces/HUGE", "small", "2026-11-22T10:00:01Z"),
        ],
      }),
  });
  const text = await resultText(await read(f, { conversation: "spaces/HUGE" }));
  expect(text.length).toBeLessThanOrEqual(32_000);
  const out = JSON.parse(text) as Out;
  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]).toMatchObject({
    message: "spaces/HUGE/messages/big",
    text: expect.stringMatching(/^"+/),
    text_cut: true,
  });
  expect(out.next_page).toBe("2026-11-22T10:00:02Z");
});

const tool = (name: string) =>
  TOOLS.find((t) => t.name === name) as Extract<Tool, { kind: "account" }>;
it.each([
  ["read_conversation", { page: "2026-02-30T10:00:00Z" }, "page"],
  ["read_conversation", { page: "2028-02-29T10:00:00Z" }, null],
  [
    "search_messages",
    { after: "2026-11-22T10:30:00Z", before: "2026-11-22T07:30:00-03:00" },
    "before",
  ],
  [
    "search_messages",
    { after: "2026-11-22T10:30:00.1Z", before: "2026-11-22T10:30:00.100000Z" },
    "before",
  ],
  [
    "search_messages",
    { after: "2026-11-22T10:30:00.123456789Z", before: "2026-11-22T10:30:00.123456790Z" },
    null,
  ],
] as const)("%s admits %j only when it names no bad field (%s)", (name, args, field) => {
  const decoded = decodeArgs(tool(name), {
    account: PERSONAL,
    ...(name === "read_conversation" ? { conversation: "spaces/AAA" } : {}),
    ...args,
  });
  expect(decoded).toEqual(
    field === null ? { ok: true, value: expect.anything() } : { ok: false, field },
  );
});

it("asks Google only for the message fields the tools return, and both tools name the same message", async () => {
  const f = await chatTools({ read_conversation: "allow", search_messages: "allow" });
  const long = `${'"'.repeat(600)}end`;
  const projected = [
    {
      name: "spaces/AAA/messages/m2",
      sender: { name: "users/app1", type: "BOT" },
      createTime: "2026-11-22T10:00:02Z",
      text: long,
      thread: { name: "spaces/AAA/threads/t1" },
      threadReply: true,
    },
    {
      name: "spaces/AAA/messages/m1",
      sender: { name: "users/456", type: "HUMAN" },
      createTime: "2026-11-22T10:00:01Z",
      text: "hi",
      thread: { name: "spaces/AAA/threads/t1" },
    },
  ];
  const log = chatRoutes({
    "GET spaces/AAA/messages": () => Response.json({ messages: projected }),
    "POST spaces/-/messages:search": () =>
      Response.json({ results: projected.map((message) => ({ message })) }),
  });
  const r = (await answer(await read(f, { conversation: "spaces/AAA" }))) as Out;
  const s = (await answer(await search(f, { text: "x" }))) as Out;
  expect(log.map(routeOf)).toEqual(["GET spaces/AAA/messages", "POST spaces/-/messages:search"]);
  const message = [
    "name",
    "sender.name",
    "sender.type",
    "sender.displayName",
    "sender.email",
    "createTime",
    "text",
    "thread.name",
    "threadReply",
  ];
  expect(fieldPaths(log[0]!.params.get("fields") ?? "").sort()).toEqual(
    ["nextPageToken", ...message.map((m) => `messages.${m}`)].sort(),
  );
  expect(fieldPaths(log[1]!.params.get("fields") ?? "").sort()).toEqual(
    ["nextPageToken", ...message.map((m) => `results.message.${m}`)].sort(),
  );
  const identity = (out: Out) =>
    out.messages.map(({ message, conversation, thread, from }) => ({
      message,
      conversation,
      thread,
      from,
    }));
  const expected = [
    {
      message: "spaces/AAA/messages/m2",
      conversation: "spaces/AAA",
      thread: "spaces/AAA/threads/t1",
      from: { user: "users/app1", app: true },
    },
    {
      message: "spaces/AAA/messages/m1",
      conversation: "spaces/AAA",
      thread: "spaces/AAA/threads/t1",
      from: { user: "users/456" },
    },
  ];
  expect(identity(r)).toEqual(expected);
  expect(identity(s)).toEqual(expected);
  expect(r.messages[0]).toMatchObject({ text: long, thread_reply: true });
  expect(r.messages[0]!.text_cut).toBeUndefined();
  expect(s.messages[0]!.text_cut).toBe(true);
  expect(JSON.stringify(s.messages[0]!.text).length).toBeLessThanOrEqual(1_000);
  expect(s.messages[1]).toMatchObject({ text: "hi" });
});

it("stops a search in a conversation the account cannot see before searching", async () => {
  const f = await chatTools({ search_messages: "allow" });
  const log = chatRoutes({
    "GET spaces/ZZZ": () =>
      Response.json({ error: { code: 403, status: "PERMISSION_DENIED" } }, { status: 403 }),
    "POST spaces/-/messages:search": () => Response.json({}),
  });
  const message = JSON.parse(
    await expectError(await search(f, { conversation: "spaces/ZZZ" }), "not_found", /./),
  ).message as string;
  expect(message).toMatch(/"spaces\/ZZZ".*cannot see it/);
  expect(message).not.toMatch(/only in the account/);
  expect(log.map(routeOf)).toEqual(["GET spaces/ZZZ"]);
});
