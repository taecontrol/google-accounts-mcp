import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import type { ViewValue } from "../approvals/model";
import { normalizeEmail } from "../email";
import { notFound, ToolFailure } from "../mcp/failures";
import { boundedList, shortJson } from "./bounds";
import { decodeResponse, getFrom } from "./get";
import {
  CHAT_API,
  ConversationId,
  conversationRefused,
  conversationValues,
  fullPrecision,
  readSpace,
  Timestamp,
} from "./chat";

const get = getFrom(CHAT_API);
export const MESSAGES_LIMIT = 32_000;
export const DEFAULT_READ_LIMIT = 25;
export const MAX_READ_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 15;
export const MAX_SEARCH_TEXT = 1_000;
export const MAX_SENDER_NAME = 200;
export const MAX_WORDS = 200;
export const MAX_SENDER = 254;
export const MAX_SEARCH_PAGE = 2_000;

const GoogleMessage = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^spaces\/[A-Za-z0-9_-]+\/messages\/[^/]+$/)),
  sender: Schema.Struct({
    name: Schema.String,
    type: Schema.optionalKey(Schema.String),
    displayName: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
  }),
  createTime: Timestamp,
  text: Schema.optionalKey(Schema.String),
  thread: Schema.Struct({ name: Schema.String }),
  threadReply: Schema.optionalKey(Schema.Boolean),
});
const MessageList = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(GoogleMessage)),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const SearchList = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(Schema.Struct({ message: GoogleMessage }))),
  nextPageToken: Schema.optionalKey(Schema.String),
});

export interface ChatMessage {
  readonly message: string;
  readonly conversation: string;
  readonly thread: string;
  readonly thread_reply?: true;
  readonly from:
    | { readonly user: string; readonly name?: string; readonly email?: string }
    | { readonly user: string; readonly app: true; readonly name?: string };
  readonly time: string;
  readonly text: string;
  readonly text_cut?: true;
}

const withText = (message: ChatMessage, text: string, limit: number): ChatMessage => {
  const cut = shortJson(text, limit);
  const { text_cut: _, ...rest } = message;
  return { ...rest, text: cut, ...(cut === text ? {} : { text_cut: true }) };
};

export const chatMessage = (item: typeof GoogleMessage.Type, textLimit = Infinity): ChatMessage => {
  const { sender } = item;
  const name = sender.displayName ? shortJson(sender.displayName, MAX_SENDER_NAME) : undefined;
  const email = normalizeEmail(sender.email);
  const message: ChatMessage = {
    message: item.name,
    conversation: item.name.slice(0, item.name.indexOf("/messages/")),
    thread: item.thread.name,
    ...(item.threadReply ? { thread_reply: true } : {}),
    from:
      sender.type === "BOT"
        ? { user: sender.name, app: true, ...(name ? { name } : {}) }
        : { user: sender.name, ...(name ? { name } : {}), ...(email ? { email } : {}) },
    time: item.createTime,
    text: "",
  };
  return withText(message, item.text ?? "", textLimit);
};

export const ThreadId = Schema.String.check(
  Schema.isPattern(/^spaces\/[A-Za-z0-9_-]{1,100}\/threads\/[A-Za-z0-9_-]{1,100}$/),
);
export const ReadConversationInput = Schema.Struct({
  account: Schema.String,
  conversation: ConversationId,
  thread: Schema.optionalKey(ThreadId),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LIMIT })),
  ),
  page: Schema.optionalKey(Timestamp),
}).check(
  Schema.makeFilter((args) =>
    args.thread === undefined || args.thread.startsWith(`${args.conversation}/threads/`)
      ? true
      : { path: ["thread"], issue: "must be a thread of the conversation" },
  ),
);
type ReadArgs = typeof ReadConversationInput.Type;

export const readConversation = (send: Send, account: string, args: ReadArgs) =>
  Effect.gen(function* () {
    const filter = [
      ...(args.thread === undefined ? [] : [`thread.name = ${args.thread}`]),
      ...(args.page === undefined ? [] : [`createTime < "${args.page}"`]),
    ].join(" AND ");
    const query = [
      `pageSize=${args.limit ?? DEFAULT_READ_LIMIT}`,
      `orderBy=${encodeURIComponent("createTime desc")}`,
      ...(filter ? [`filter=${encodeURIComponent(filter)}`] : []),
    ].join("&");
    const page = yield* get(
      send,
      `${args.conversation}/messages?${query}`,
      MessageList,
      conversationRefused(args.conversation),
    );
    const items = (page.messages ?? []).map((item) => chatMessage(item));
    if (!items.length && page.nextPageToken)
      return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
    if (args.thread !== undefined && args.page === undefined && !items.length)
      return yield* Effect.fail(notFound("thread", args.thread));
    const result = (messages: ChatMessage[], more: boolean) => ({
      account,
      conversation: args.conversation,
      messages,
      ...(more && messages.length ? { next_page: messages.at(-1)!.time } : {}),
    });
    const size = (messages: ChatMessage[], more: boolean) =>
      JSON.stringify(result(messages, more)).length;
    let { kept } = boundedList(items, MESSAGES_LIMIT - size([], false) + 2);
    let more = Boolean(page.nextPageToken) || kept.length < items.length;
    while (more && kept.length && size(kept, true) > MESSAGES_LIMIT) kept.pop();
    if (!kept.length && items.length) {
      const first = items[0]!;
      more = Boolean(page.nextPageToken) || items.length > 1;
      const others = size([{ ...first, text: "", text_cut: true }], more) - 2;
      kept = [withText(first, first.text, MESSAGES_LIMIT - others)];
    }
    return result(kept, more);
  });

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
export const utcOf = (text: string): string | null => {
  const match = INSTANT.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", fraction = ""] = match;
  const sign = match[8] === "-" ? -1 : 1;
  const [offsetHours, offsetMinutes] = [Number(match[9] ?? 0), Number(match[10] ?? 0)];
  const parts = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (
    parts[0] < 2000 ||
    parts[0] > 2999 ||
    offsetHours > 23 ||
    offsetMinutes > 59 ||
    local.getUTCFullYear() !== parts[0] ||
    local.getUTCMonth() !== parts[1] - 1 ||
    local.getUTCDate() !== parts[2] ||
    local.getUTCHours() !== parts[3] ||
    local.getUTCMinutes() !== parts[4] ||
    local.getUTCSeconds() !== parts[5]
  )
    return null;
  const utc = local.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return `${new Date(utc).toISOString().slice(0, 19)}${fraction}Z`;
};

const senderOf = (raw: string): string | null => {
  const email = raw.toLowerCase();
  return !/[\s"\\]/.test(raw) && email.length <= MAX_SENDER && normalizeEmail(raw) === email
    ? email
    : null;
};
const Instant = Schema.String.check(Schema.makeFilter((text) => utcOf(text) !== null));
const CRITERIA = ["text", "from", "conversation", "after", "before", "unread", "mentions_me"];
const SearchFields = Schema.Struct({
  account: Schema.String,
  text: Schema.optionalKey(
    Schema.String.check(
      Schema.isBetweenLength(1, MAX_WORDS),
      Schema.makeFilter((text) => /\S/.test(text) && !/["\\]/.test(text)),
    ),
  ),
  from: Schema.optionalKey(Schema.String.check(Schema.makeFilter((raw) => senderOf(raw) !== null))),
  conversation: Schema.optionalKey(ConversationId),
  after: Schema.optionalKey(Instant),
  before: Schema.optionalKey(Instant),
  unread: Schema.optionalKey(Schema.Literal(true)),
  mentions_me: Schema.optionalKey(Schema.Literal(true)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
  ),
  page: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_SEARCH_PAGE))),
});
type SearchArgs = typeof SearchFields.Type;

const criteriaOf = (args: SearchArgs) => ({
  words: args.text?.split(/\s+/).filter(Boolean) ?? [],
  from: args.from === undefined ? undefined : senderOf(args.from)!,
  conversation: args.conversation,
  after: args.after === undefined ? undefined : utcOf(args.after)!,
  before: args.before === undefined ? undefined : utcOf(args.before)!,
  unread: args.unread === true,
  mentions: args.mentions_me === true,
  limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
});
type Criteria = ReturnType<typeof criteriaOf>;
const filterOf = (criteria: Criteria) =>
  [
    ...(criteria.words.length ? [criteria.words.map((word) => `"${word}"`).join(" ")] : []),
    ...(criteria.from === undefined ? [] : [`sender.name = "users/${criteria.from}"`]),
    ...(criteria.conversation === undefined ? [] : [`space.name = ${criteria.conversation}`]),
    ...(criteria.after === undefined ? [] : [`create_time >= "${criteria.after}"`]),
    ...(criteria.before === undefined ? [] : [`create_time < "${criteria.before}"`]),
    ...(criteria.unread ? ["is_unread()"] : []),
    ...(criteria.mentions ? ["annotations.user_mentions.user.name:users/me"] : []),
  ].join(" AND ");
const digestOf = (account: string, criteria: Criteria) =>
  createHash("sha256")
    .update(JSON.stringify([account, filterOf(criteria), criteria.limit]))
    .digest("hex")
    .slice(0, 16);
const tokenIn = (page: string, digest: string) =>
  page.length > digest.length + 1 && page.startsWith(`${digest}.`)
    ? page.slice(digest.length + 1)
    : undefined;

export const SearchMessagesInput = SearchFields.check(
  Schema.makeFilter((args) => {
    if (!CRITERIA.some((key) => args[key as keyof typeof args] !== undefined))
      return { path: ["text"], issue: "a search needs at least one criterion" };
    if (
      args.after !== undefined &&
      args.before !== undefined &&
      fullPrecision(utcOf(args.after)!) >= fullPrecision(utcOf(args.before)!)
    )
      return { path: ["before"], issue: "must be later than after" };
    const account = normalizeEmail(args.account);
    if (
      args.page !== undefined &&
      account !== null &&
      tokenIn(args.page, digestOf(account, criteriaOf(args))) === undefined
    )
      return { path: ["page"], issue: "belongs to another search" };
    return true;
  }),
);

export const PAGE_EXPECTS = `the next_page of an earlier result with the same account, criteria, and limit, 1 to ${MAX_SEARCH_PAGE.toLocaleString("en-US")} characters: this next_page belongs to another search; send it with the criteria and limit that returned it`;
const pageField = (expects: string) =>
  new ToolFailure({ code: "invalid_arguments", field: { name: "page", expects } });
const searchRefused = (args: SearchArgs) => (status: number) => {
  if (status !== 400) return new ToolFailure({ code: "google_unavailable" });
  const sender = "an email address of a Chat user Google knows";
  const page = "the next_page of an earlier result with the same criteria";
  if (args.from !== undefined && args.page !== undefined)
    return new ToolFailure({
      code: "invalid_arguments",
      said: `Google refused the search. The from field must be ${sender}, and the page field must be ${page}.`,
    });
  if (args.from !== undefined)
    return new ToolFailure({ code: "invalid_arguments", field: { name: "from", expects: sender } });
  if (args.page !== undefined) return pageField(page);
  return new ToolFailure({
    code: "invalid_arguments",
    said: "Google refused the search criteria.",
  });
};

export const searchMessages = (send: Send, account: string, args: SearchArgs) =>
  Effect.gen(function* () {
    const criteria = criteriaOf(args);
    const digest = digestOf(account, criteria);
    const token = args.page === undefined ? undefined : tokenIn(args.page, digest);
    if (args.page !== undefined && token === undefined)
      return yield* Effect.fail(pageField(PAGE_EXPECTS));
    if (criteria.conversation !== undefined) yield* readSpace(send, criteria.conversation);
    const body = JSON.stringify({
      filter: filterOf(criteria),
      pageSize: criteria.limit,
      ...(token === undefined ? {} : { pageToken: token }),
    });
    const response = yield* send(
      (accessToken, signal) =>
        new Request(`${CHAT_API}/spaces/-/messages:search`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body,
          redirect: "manual",
          signal,
        }),
    );
    const page = yield* decodeResponse(response, SearchList, searchRefused(args));
    return {
      account,
      messages: (page.results ?? []).map((result) => chatMessage(result.message, MAX_SEARCH_TEXT)),
      ...(page.nextPageToken ? { next_page: `${digest}.${page.nextPageToken}` } : {}),
    };
  });

export const readValues = (send: Send, args: ReadArgs) =>
  conversationValues(send, args.conversation, normalizeEmail(args.account)!).pipe(
    Effect.map((values): ViewValue[] => [
      ...values,
      ...(args.thread === undefined
        ? []
        : [{ name: "Only this thread", text: args.thread, from: "agent" as const }]),
      ...(args.page === undefined
        ? []
        : [{ name: "Older than", text: args.page, from: "agent" as const }]),
      { name: "Limit", text: String(args.limit ?? DEFAULT_READ_LIMIT), from: "agent" },
    ]),
  );

export const searchValues = (send: Send, args: SearchArgs) =>
  Effect.gen(function* () {
    const criteria = criteriaOf(args);
    const agent = (name: string, text: string): ViewValue => ({ name, text, from: "agent" });
    return [
      ...(criteria.words.length ? [agent("Words", criteria.words.join("\n"))] : []),
      ...(criteria.from === undefined ? [] : [agent("From", criteria.from)]),
      ...(criteria.conversation === undefined
        ? []
        : yield* conversationValues(send, criteria.conversation, normalizeEmail(args.account)!)),
      ...(criteria.after === undefined ? [] : [agent("After", criteria.after)]),
      ...(criteria.before === undefined ? [] : [agent("Before", criteria.before)]),
      ...(criteria.unread ? [agent("Only unread", "Yes")] : []),
      ...(criteria.mentions ? [agent("Only messages that mention this account", "Yes")] : []),
      agent("Limit", String(criteria.limit)),
      ...(args.page === undefined ? [] : [agent("Page", args.page)]),
    ];
  });
