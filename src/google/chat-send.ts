import { Effect, Schema } from "effect";
import type { Confirm, Send, Sending } from "../mcp/tools";
import { sameValues, viewDate, type ViewNote, type ViewValue } from "../approvals/model";
import { normalizeEmail } from "../email";
import { Duplicate, duplicateValue } from "../mcp/duplicate";
import { creating, notFound, ToolFailure, ViewUnavailable } from "../mcp/failures";
import { GuestAddress, guestKey, NOT_CREATED } from "./event-write";
import {
  CHAT_API,
  ConversationId,
  conversationRefused,
  readSpace,
  spaceValues,
  type SpaceInfo,
} from "./chat";
import { chatMessage, MessageList, ThreadId, threadIssue, type ChatMessage } from "./chat-messages";
import { errorText } from "./errors";
import { getFrom } from "./get";

const get = getFrom(CHAT_API);
export const MAX_CHAT_TEXT = 32_000;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export const SendChatMessageInput = Schema.Struct({
  account: Schema.String,
  conversation: ConversationId,
  text: Schema.String.check(
    Schema.makeFilter((text) => utf8Bytes(text) >= 1 && utf8Bytes(text) <= MAX_CHAT_TEXT),
  ),
  thread: Schema.optionalKey(ThreadId),
  duplicate: Schema.optionalKey(Duplicate),
}).check(Schema.makeFilter(threadIssue));
type SendArgs = typeof SendChatMessageInput.Type;

const SentMessage = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^spaces\/[A-Za-z0-9_-]+\/messages\/[^/]+$/)),
  thread: Schema.Struct({ name: Schema.NonEmptyString }),
});
export const ChatSent = Schema.Struct({
  conversation: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  thread: Schema.NonEmptyString,
});
type Sent = typeof ChatSent.Type;

const outcomeUnknown = () => new ToolFailure({ code: "outcome_unknown", unknown: true });
const readSent = (response: Response, failure: () => ToolFailure) =>
  Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: failure }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(SentMessage)(raw).pipe(Effect.mapError(failure)),
    ),
    Effect.map((sent): Sent => ({
      conversation: sent.name.slice(0, sent.name.indexOf("/messages/")),
      message: sent.name,
      thread: sent.thread.name,
    })),
  );

const appMissing = (response: Response) =>
  response.status === 404
    ? Effect.promise(() => errorText(response)).pipe(
        Effect.map((text) => text?.includes("Google Chat app not found") ?? false),
      )
    : Effect.succeed(false);
const rateLimited = (what: string) =>
  new ToolFailure({
    code: "google_unavailable",
    said: `Google Chat refused the request for now because of its rate limit, so nothing was ${what}. Call again in a few seconds.`,
  });

const threaded = (space: SpaceInfo) =>
  space.spaceThreadingState === "THREADED_MESSAGES"
    ? Effect.void
    : Effect.fail(
        new ToolFailure({
          code: "invalid_arguments",
          field: {
            name: "thread",
            expects:
              "left out in this conversation: the server cannot reply in a thread here, because Google Chat does not report threads as working in this conversation; send without thread",
          },
        }),
      );

const senderText = (from: ChatMessage["from"]) =>
  "app" in from
    ? (from.name ?? from.user)
    : from.name && from.email
      ? `${from.name} <${from.email}>`
      : (from.email ?? from.name ?? from.user);
const threadStart = (send: Send, conversation: string, thread: string) =>
  Effect.gen(function* () {
    const query = new URLSearchParams({
      filter: `thread.name = "${thread}"`,
      orderBy: "createTime asc",
      pageSize: "1",
    });
    const page = yield* get(
      send,
      `${conversation}/messages?${query}`,
      MessageList,
      conversationRefused(conversation),
    );
    const first = page.messages?.[0];
    if (!first || first.threadReply) return yield* Effect.fail(new ViewUnavailable());
    const message = chatMessage(first);
    return [
      {
        name:
          "app" in message.from
            ? "The thread starts with a message from a Chat app"
            : "The thread starts with a message from",
        text: senderText(message.from),
        from: "chat",
      },
      { name: "Sent", text: viewDate(Date.parse(message.time)), from: "chat" },
      ...(message.text ? [{ name: "Its text", text: message.text, from: "chat" as const }] : []),
    ] satisfies ViewValue[];
  });

export const sendValues = (send: Send, args: SendArgs) =>
  Effect.gen(function* () {
    const space = yield* readSpace(send, args.conversation);
    if (args.thread !== undefined) yield* threaded(space);
    const conversation = yield* spaceValues(
      send,
      args.conversation,
      normalizeEmail(args.account)!,
      space,
    );
    return [
      ...conversation,
      ...(args.thread === undefined
        ? []
        : [
            { name: "Reply in thread", text: args.thread, from: "agent" as const },
            ...(yield* threadStart(send, args.conversation, args.thread)),
          ]),
      ...duplicateValue(args.duplicate),
      { name: "Text", text: args.text, from: "agent" },
    ] satisfies ViewValue[];
  });

const MENTIONS_ALL = /<users\/all>|<chat-user\b[^>]*\bdata-user="users\/all"/;
export const sendNotes = (args: SendArgs): ViewNote[] => [
  ...(MENTIONS_ALL.test(args.text)
    ? [{ text: "This message mentions everyone in the conversation.", warning: true }]
    : []),
  {
    text: "People in the conversation get the message and its notification as soon as it is sent. Deleting it later in Chat does not take the notification back.",
    warning: true,
  },
];

const messageRefused = (response: Response, args: SendArgs) =>
  Effect.gen(function* () {
    if (yield* appMissing(response)) return new ToolFailure({ code: "chat_app_not_configured" });
    if (response.status === 429) return rateLimited("sent");
    if (response.status === 404 && args.thread !== undefined)
      return notFound("thread", args.thread);
    if (response.status === 400)
      return new ToolFailure({
        code: "invalid_arguments",
        field: {
          name: "text",
          expects:
            "a text that Google Chat accepts in this conversation; Google Chat refused this message, and nothing was sent",
        },
      });
    return conversationRefused(args.conversation)(response.status);
  });

const postMessage = (sending: Sending, args: SendArgs, key: string) =>
  Effect.gen(function* () {
    const query = new URLSearchParams({
      messageId: `client-${key}`,
      ...(args.thread === undefined ? {} : { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" }),
    });
    const response = yield* creating(
      sending(
        (token, signal) =>
          new Request(`${CHAT_API}/${args.conversation}/messages?${query}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              text: args.text,
              ...(args.thread === undefined ? {} : { thread: { name: args.thread } }),
            }),
            redirect: "manual",
            signal,
          }),
      ),
    );
    if (response.ok) return yield* readSent(response, outcomeUnknown);
    if (!NOT_CREATED.includes(response.status)) return yield* Effect.fail(outcomeUnknown());
    return yield* Effect.fail(yield* messageRefused(response, args));
  });

export const sendChatMessage = (
  send: Send,
  args: SendArgs,
  confirm: Confirm,
  approved: ReadonlyArray<ViewValue> | null,
  key: string,
) =>
  Effect.gen(function* () {
    if (approved !== null) {
      const changed = () =>
        new ToolFailure({
          code: "invalid_arguments",
          said: "The conversation changed after approval. Nothing was sent. Call again so the owner can approve the current values.",
        });
      const current = yield* sendValues(send, args).pipe(
        Effect.mapError((error) => (error instanceof ViewUnavailable ? changed() : error)),
      );
      if (!sameValues(approved, current)) return yield* Effect.fail(changed());
    } else if (args.thread !== undefined)
      yield* readSpace(send, args.conversation).pipe(Effect.flatMap(threaded));
    const sending = yield* confirm.check;
    return yield* postMessage(sending, args, key);
  });

export const settleChatMessage = (read: Send, args: SendArgs, key: string) =>
  read(
    (token, signal) =>
      new Request(`${CHAT_API}/${args.conversation}/messages/client-${key}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal,
      }),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.succeed(null)
        : response.status === 200
          ? readSent(response, () => new ToolFailure({ code: "google_unavailable" }))
          : Effect.fail(new ToolFailure({ code: "google_unavailable" })),
    ),
  );

export const OpenDirectMessageInput = Schema.Struct({
  account: Schema.String,
  to: GuestAddress,
}).check(
  Schema.makeFilter((args) =>
    guestKey(args.to) === guestKey(normalizeEmail(args.account) ?? args.account)
      ? { path: ["to"], issue: "an address other than the account's own" }
      : true,
  ),
);
type OpenArgs = typeof OpenDirectMessageInput.Type;

const SetupSpace = Schema.Struct({ name: ConversationId });
const setupUnknown = () => new ToolFailure({ code: "google_unavailable", unknown: true });
export const openDirectMessage = (sending: Sending, account: string, args: OpenArgs) =>
  Effect.gen(function* () {
    const response = yield* sending(
      (token, signal) =>
        new Request(`${CHAT_API}/spaces:setup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            space: { spaceType: "DIRECT_MESSAGE" },
            memberships: [{ member: { name: `users/${args.to}`, type: "HUMAN" } }],
          }),
          redirect: "manual",
          signal,
        }),
    );
    if (response.ok) {
      const space = yield* Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: setupUnknown,
      }).pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(SetupSpace)(raw).pipe(Effect.mapError(setupUnknown)),
        ),
      );
      return { account, conversation: space.name };
    }
    if (yield* appMissing(response))
      return yield* Effect.fail(new ToolFailure({ code: "chat_app_not_configured" }));
    if (response.status === 429) return yield* Effect.fail(rateLimited("created"));
    if (response.status >= 400 && response.status < 500)
      return yield* Effect.fail(
        new ToolFailure({
          code: "invalid_arguments",
          field: {
            name: "to",
            expects:
              "an address that Google Chat opens a direct message with; Google Chat would not open a direct message with this address, and nothing was created",
          },
        }),
      );
    return yield* Effect.fail(setupUnknown());
  });
