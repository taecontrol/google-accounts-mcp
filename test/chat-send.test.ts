import "./support/account-checks";
import { env } from "cloudflare:workers";
import { http } from "msw";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import * as store from "../src/approvals/store";
import { sendValues } from "../src/google/chat-send";
import { ToolFailure } from "../src/mcp/failures";
import { TOOLS } from "../src/mcp/tools";
import { answer, decided, digest, get, page, post } from "./support/approvals";
import { CHAT_SCOPES } from "./support/chat";
import { onceRows } from "./support/draft";
import { deferred } from "./support/google";
import { network } from "./support/network";
import { expectError, fixture, PERSONAL, toolCall } from "./support/permissions";
import { setTool } from "./support/uploads";

const CHAT = "https://chat.googleapis.com/v1";
const DM = "spaces/DMAAA";
const THREAD = `${DM}/threads/T`;
const DANA = { name: "users/200", type: "HUMAN", displayName: "Dana", email: "dana@example.com" };
const threadedDm = { spaceType: "DIRECT_MESSAGE", spaceThreadingState: "THREADED_MESSAGES" };
const members = {
  memberships: [
    { member: { name: "users/100", type: "HUMAN", displayName: "Alex", email: PERSONAL } },
    { member: DANA },
  ],
};
const starter = (text = "Can you review the plan?", threadReply?: boolean) => ({
  name: `${DM}/messages/T.T`,
  text,
  sender: DANA,
  createTime: "2026-11-22T09:15:00Z",
  thread: { name: THREAD },
  ...(threadReply === undefined ? {} : { threadReply }),
});
const sentMessage = { name: `${DM}/messages/g1.g1`, thread: { name: `${DM}/threads/g1` } };

type Answer = () => Response | Promise<Response>;
interface Stand {
  space?: Answer;
  starter?: () => Record<string, unknown>;
  post?: Answer;
  lookup?: Answer[];
}
function chat(stand: Stand) {
  const log: Array<{ method: string; path: string; query: URLSearchParams; body: string }> = [];
  const record = async (request: Pick<Request, "url" | "method" | "text">) => {
    const url = new URL(request.url);
    log.push({
      method: request.method,
      path: decodeURIComponent(url.pathname.slice("/v1/".length)),
      query: url.searchParams,
      body: request.method === "GET" ? "" : await request.text(),
    });
  };
  network.use(
    http.get(`${CHAT}/spaces/:space`, async ({ request }) => {
      await record(request);
      return stand.space ? stand.space() : Response.json(threadedDm);
    }),
    http.get(`${CHAT}/spaces/:space/members`, async ({ request }) => {
      await record(request);
      return Response.json(members);
    }),
    http.get(`${CHAT}/spaces/:space/messages`, async ({ request }) => {
      await record(request);
      const filter = new URL(request.url).searchParams.get("filter") ?? "";
      const first = stand.starter?.();
      return Response.json(
        first && filter.replaceAll('"', "") === `thread.name = ${THREAD}`
          ? { messages: [first] }
          : {},
      );
    }),
    http.post(`${CHAT}/spaces/:space/messages`, async ({ request }) => {
      await record(request);
      return stand.post ? stand.post() : Response.json(sentMessage);
    }),
    http.get(`${CHAT}/spaces/:space/messages/:message`, async ({ request }) => {
      await record(request);
      const next = stand.lookup?.shift();
      if (!next) throw new Error("Unexpected Chat message lookup");
      return next();
    }),
  );
  return { log, posts: () => log.filter((entry) => entry.method === "POST") };
}

const chatAccount = async (tools: Record<string, "ask" | "allow" | "deny">) => {
  const f = await fixture({ scopes: JSON.stringify(CHAT_SCOPES) });
  for (const [tool, setting] of Object.entries(tools)) await setTool(f, tool, setting);
  return f;
};
type Fixture = Awaited<ReturnType<typeof chatAccount>>;
const send = (f: Fixture, args: Record<string, unknown> = {}) =>
  toolCall(f.mcp, "send_chat_message", {
    account: PERSONAL,
    conversation: DM,
    text: "Looks good",
    ...args,
  });

it.each([
  { reply: undefined, offered: true },
  { reply: true, offered: false },
])(
  "an approval page for a reply offers Approve only when its thread's first message is not a reply (threadReply $reply)",
  async ({ reply, offered }) => {
    const f = await chatAccount({ send_chat_message: "ask" });
    const { log, posts } = chat({ starter: () => starter("Can you review the plan?", reply) });
    const pending = await answer(await send(f, { thread: THREAD }));
    const { state, request } = await page(f, pending.approval as string);
    expect(state).toMatchObject({ kind: "waiting", shown: offered });
    if (offered) {
      expect(request.values).toContainEqual({
        name: "Its text",
        text: "Can you review the plan?",
        from: "chat",
      });
      const lookup = log.find(
        (entry) => entry.method === "GET" && entry.path.endsWith("/messages"),
      );
      expect(Object.fromEntries(lookup!.query)).toEqual({
        filter: `thread.name = ${THREAD}`,
        orderBy: "createTime asc",
        pageSize: "1",
      });
    }
    expect(posts()).toEqual([]);
  },
);

const BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest";
it.each([
  {
    name: "a parent violation",
    violations: [{ field: "parent", description: "The space is not valid." }],
    code: "not_found",
    message: /^No conversation "spaces\/DMAAA" exists in /,
  },
  {
    name: "a parent violation after one that names no field",
    violations: [
      { description: "Another request constraint also failed." },
      { field: "parent", description: "The space is not valid." },
    ],
    code: "not_found",
    message: /^No conversation "spaces\/DMAAA" exists in /,
  },
  {
    name: "a text violation whose description mentions the parent",
    violations: [{ field: "message.text", description: "The parent space refuses this text." }],
    code: "invalid_arguments",
    message: /^The text field must be a text that Google Chat accepts in this conversation/,
  },
])("a send that Google refuses with $name names the part to correct", async (row) => {
  const f = await chatAccount({ send_chat_message: "allow" });
  const { posts } = chat({
    post: () =>
      Response.json(
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Invalid argument.",
            details: [{ "@type": BAD_REQUEST, fieldViolations: row.violations }],
          },
        },
        { status: 400 },
      ),
  });
  await expectError(await send(f), row.code, row.message);
  expect(posts()).toHaveLength(1);
  expect(await onceRows()).toEqual([]);
});

it("builds a direct-message reply's approval values with the members and the thread's first message read together", async () => {
  const LATENCY = 3_000;
  vi.useFakeTimers();
  try {
    const answers: Record<string, unknown> = {
      [DM]: threadedDm,
      [`${DM}/members`]: members,
      [`${DM}/messages`]: { messages: [starter("Original question")] },
    };
    const requests: string[] = [];
    const delayed = (build: (token: string, signal: AbortSignal) => Request) => {
      const url = new URL(build("token", new AbortController().signal).url);
      const path = decodeURIComponent(url.pathname.slice("/v1/".length));
      requests.push(path);
      return Effect.promise(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(Response.json(answers[path])), LATENCY),
          ),
      );
    };
    let values: unknown;
    const view = Effect.runPromise(
      sendValues(delayed, {
        account: PERSONAL,
        conversation: DM,
        text: "Yes",
        thread: THREAD,
      }),
    ).then((result) => {
      values = result;
    });
    await vi.advanceTimersByTimeAsync(LATENCY);
    expect(requests).toContain(DM);
    await vi.advanceTimersByTimeAsync(LATENCY);
    expect(values).toEqual(
      expect.arrayContaining([
        { name: "Direct message with", text: "Dana <dana@example.com>", from: "chat" },
        { name: "Its text", text: "Original question", from: "chat" },
      ]),
    );
    await vi.runAllTimersAsync();
    await view;
  } finally {
    vi.useRealTimers();
  }
});

it("recovers a send that Google accepted by its original ID after a lookup that found nothing", async () => {
  const f = await chatAccount({ send_chat_message: "allow" });
  const missing = () => Response.json({ error: { code: 404 } }, { status: 404 });
  const { log } = chat({ lookup: [missing, () => Response.json(sentMessage)] });
  const tool = TOOLS.find((t) => t.name === "send_chat_message")!;
  if (tool.kind !== "account" || !tool.answer) throw new Error("Missing send tool");
  vi.spyOn(tool, "answer").mockImplementationOnce(() => {
    throw new ToolFailure({ code: "google_unavailable" });
  });
  await expectError(await send(f), "outcome_unknown", /never sends it twice/);
  await expectError(
    await send(f),
    "outcome_unknown",
    /^Google Chat does not show the message\. Ask the owner to look in conversation spaces\/DMAAA\./,
  );
  const recovered = await answer(await send(f));
  expect(recovered).toMatchObject({
    conversation: DM,
    message: sentMessage.name,
    thread: sentMessage.thread.name,
    repeat_of: expect.any(String),
  });
  expect(await answer(await send(f))).toEqual(recovered);
  const key = (await env.DB.prepare("SELECT request_key FROM once").first<{
    request_key: string;
  }>())!.request_key;
  expect(log.map((entry) => [entry.method, entry.path])).toEqual([
    ["POST", `${DM}/messages`],
    ["GET", `${DM}/messages/client-${key}`],
    ["GET", `${DM}/messages/client-${key}`],
  ]);
  expect(log[0]!.query.get("messageId")).toBe(`client-${key}`);
});

it("refuses an approved reply when the thread's first message changed after the owner decided", async () => {
  const f = await chatAccount({ send_chat_message: "ask" });
  let text = "Original question";
  const { posts } = chat({ starter: () => starter(text) });
  const pending = await answer(await send(f, { thread: THREAD }));
  const id = pending.approval as string;
  const shown = await digest(f, id);
  const original = store.decideApproval;
  vi.spyOn(store, "decideApproval").mockImplementation((ctx, input) =>
    original(ctx, input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          text = "Edited question";
        }),
      ),
    ),
  );
  const props = await decided(await post(f, id, "approve", { digest: shown }));
  expect(props.state).toMatchObject({ kind: "failed" });
  expect(JSON.stringify(await get(f, id))).toMatch(/The conversation changed after approval/);
  expect(posts()).toEqual([]);
});

it("posts an allowed reply in a threaded conversation with Google's reply-or-fail option", async () => {
  const f = await chatAccount({ send_chat_message: "allow" });
  const { posts } = chat({
    post: () => Response.json({ ...sentMessage, thread: { name: THREAD } }),
  });
  expect(await answer(await send(f, { text: "In thread", thread: THREAD }))).toMatchObject({
    thread: THREAD,
  });
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!.query.get("messageReplyOption")).toBe("REPLY_MESSAGE_OR_FAIL");
  expect(JSON.parse(posts()[0]!.body)).toEqual({ text: "In thread", thread: { name: THREAD } });
});

it.each([{ threading: "UNTHREADED_MESSAGES" }, { threading: undefined }])(
  "refuses a reply where Google reports threading $threading",
  async ({ threading }) => {
    const f = await chatAccount({ send_chat_message: "allow" });
    const { posts } = chat({
      space: () =>
        Response.json({
          spaceType: "GROUP_CHAT",
          ...(threading ? { spaceThreadingState: threading } : {}),
        }),
    });
    await expectError(
      await send(f, { thread: THREAD }),
      "invalid_arguments",
      /^The thread field must be left out in this conversation/,
    );
    expect(posts()).toEqual([]);
  },
);

it("checks permission after a reply's slow space read so a deny in between sends nothing", async () => {
  const f = await chatAccount({ send_chat_message: "allow", read_conversation: "allow" });
  const entered = deferred();
  const released = deferred();
  const { posts } = chat({
    space: async () => {
      entered.resolve();
      await released.promise;
      return Response.json(threadedDm);
    },
  });
  const call = send(f, { thread: THREAD });
  try {
    await entered.promise;
    await setTool(f, "send_chat_message", "deny");
  } finally {
    released.resolve();
  }
  await expectError(await call, "tool_not_allowed", /has not allowed send_chat_message/);
  expect(posts()).toEqual([]);
});
