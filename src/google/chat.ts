import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import type { ViewValue } from "../approvals/model";
import { normalizeEmail } from "../email";
import { notFound, ToolFailure, ViewUnavailable } from "../mcp/failures";
import { boundedList } from "./bounds";
import { getFrom } from "./get";
import { REQUESTS_AT_ONCE } from "./gmail";

export const CHAT_API = "https://chat.googleapis.com/v1";
const get = getFrom(CHAT_API);

const SpaceName = Schema.String.check(Schema.isPattern(/^spaces\/[A-Za-z0-9_-]+$/));
export const ConversationId = Schema.String.check(
  Schema.isPattern(/^spaces\/[A-Za-z0-9_-]{1,100}$/),
);
export const CONVERSATION_EXPECTS =
  "a conversation ID such as spaces/AAAA: spaces/ and 1 to 100 letters, digits, hyphens, or underscores";
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/),
  Schema.makeFilter((time) => !Number.isNaN(Date.parse(time))),
);
const SpaceList = Schema.Struct({
  spaces: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: SpaceName,
        spaceType: Schema.Literals(["DIRECT_MESSAGE", "GROUP_CHAT", "SPACE"]),
        displayName: Schema.optionalKey(Schema.String),
        singleUserBotDm: Schema.optionalKey(Schema.Boolean),
        lastActiveTime: Schema.optionalKey(Timestamp),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const MemberList = Schema.Struct({
  memberships: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        member: Schema.optionalKey(
          Schema.Struct({
            type: Schema.optionalKey(Schema.String),
            displayName: Schema.optionalKey(Schema.String),
            email: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const SpaceInfo = Schema.Struct({
  spaceType: Schema.Literals(["DIRECT_MESSAGE", "GROUP_CHAT", "SPACE"]),
  displayName: Schema.optionalKey(Schema.String),
  singleUserBotDm: Schema.optionalKey(Schema.Boolean),
});
type Space = NonNullable<(typeof SpaceList.Type)["spaces"]>[number];
type With = { readonly name?: string; readonly email: string } | { readonly app: true };
export interface Conversation {
  readonly conversation: string;
  readonly kind: "direct_message" | "group" | "space";
  readonly name?: string;
  readonly last_active?: string;
  readonly with?: With;
}

export const MAX_SPACE_PAGES = 5;
export const SPACE_PAGE_SIZE = 1000;
export const MAX_CONVERSATIONS = 50;
export const MAX_CONVERSATIONS_CHARACTERS = 30_000;
const kinds = {
  DIRECT_MESSAGE: "direct_message",
  GROUP_CHAT: "group",
  SPACE: "space",
} as const;

const readSpaces = (send: Send) =>
  Effect.gen(function* () {
    const spaces: Space[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_SPACE_PAGES; page++) {
      const params = new URLSearchParams({
        pageSize: String(SPACE_PAGE_SIZE),
        fields: "nextPageToken,spaces(name,spaceType,displayName,lastActiveTime,singleUserBotDm)",
      });
      if (next !== undefined) params.set("pageToken", next);
      const result = yield* get(send, `spaces?${params}`, SpaceList);
      spaces.push(...(result.spaces ?? []));
      next = result.nextPageToken || undefined;
      if (next === undefined) break;
    }
    return { spaces, capped: next !== undefined };
  });

const otherMember = (send: Send, space: string, account: string) =>
  get(send, `${space}/members`, MemberList).pipe(
    Effect.map((list): With | undefined => {
      for (const { member } of list.memberships ?? []) {
        if (member?.type === "BOT") return { app: true };
        const email = normalizeEmail(member?.email);
        if (member?.type === "HUMAN" && email && email !== account)
          return { ...(member.displayName ? { name: member.displayName } : {}), email };
      }
      return undefined;
    }),
  );

export const fullPrecision = (time: string) =>
  time.replace(
    /(?:\.(\d+))?Z$/,
    (_, fraction: string | undefined = "") => `.${fraction.padEnd(9, "0")}Z`,
  );
const activeAt = (space: Space) =>
  space.lastActiveTime === undefined ? "" : fullPrecision(space.lastActiveTime);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const listConversations = (send: Send, account: string) =>
  Effect.gen(function* () {
    const read = yield* readSpaces(send);
    const recent = read.spaces
      .sort((a, b) => compare(activeAt(b), activeAt(a)) || compare(a.name, b.name))
      .slice(0, MAX_CONVERSATIONS);
    const entries = yield* Effect.forEach(
      recent,
      (space) =>
        (space.spaceType !== "DIRECT_MESSAGE"
          ? Effect.succeed(undefined)
          : space.singleUserBotDm
            ? Effect.succeed<With>({ app: true })
            : otherMember(send, space.name, account)
        ).pipe(
          Effect.map((other): Conversation => {
            const name = other && "email" in other ? other.name : space.displayName;
            return {
              conversation: space.name,
              kind: kinds[space.spaceType],
              ...(name ? { name } : {}),
              ...(space.lastActiveTime === undefined ? {} : { last_active: space.lastActiveTime }),
              ...(other ? { with: other } : {}),
            };
          }),
        ),
      { concurrency: REQUESTS_AT_ONCE },
    );
    const { kept: conversations } = boundedList(entries, MAX_CONVERSATIONS_CHARACTERS);
    const omitted = read.spaces.length - conversations.length;
    const notes = [
      ...(omitted
        ? [
            `This result holds the ${conversations.length} most recent of the conversations the server read; omitted counts the ones it left out. A left-out conversation's ID still identifies the same conversation.`,
          ]
        : []),
      ...(read.capped
        ? [
            `This account has more conversations than the server read: it stopped after ${MAX_SPACE_PAGES} pages, and the pages it did not read may hold more recent conversations.`,
          ]
        : []),
    ];
    return {
      account,
      conversations,
      ...(omitted ? { omitted } : {}),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  });

export const conversationRefused = (conversation: string) => (status: number) =>
  status === 400 || status === 403 || status === 404
    ? notFound("conversation", conversation)
    : new ToolFailure({ code: "google_unavailable" });

export const readSpace = (send: Send, conversation: string) =>
  get(send, conversation, SpaceInfo, conversationRefused(conversation));

export const MAX_SHOWN_MEMBERS = 10;
const shown = (text: string) => text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
const person = (member: { displayName?: string; email?: string }, account: string) => {
  const name = shown(member.displayName ?? "");
  const email = normalizeEmail(member.email);
  if (email === account) return undefined;
  if (name && email) return `${name} <${email}>`;
  return email ?? (name || undefined);
};
const others = (send: Send, conversation: string, account: string) =>
  get(send, `${conversation}/members`, MemberList, conversationRefused(conversation)).pipe(
    Effect.map((list) => {
      const people: string[] = [];
      let app = false;
      let unnamed = false;
      for (const { member } of list.memberships ?? []) {
        if (member?.type === "BOT") app = true;
        if (member?.type !== "HUMAN") continue;
        const line = person(member, account);
        if (line) people.push(line);
        else if (normalizeEmail(member.email) !== account) unnamed = true;
      }
      return { people, app, more: unnamed || list.nextPageToken !== undefined };
    }),
  );

export const conversationValues = (send: Send, conversation: string, account: string) =>
  Effect.gen(function* () {
    const space = yield* readSpace(send, conversation);
    const name = shown(space.displayName ?? "");
    const id = (caption?: string): ViewValue => ({
      name: caption ? `Conversation ID, ${caption}` : "Conversation ID",
      text: conversation,
      from: "agent",
    });
    if (space.spaceType === "SPACE") {
      if (!name) return yield* Effect.fail(new ViewUnavailable());
      return [{ name: "Space", text: name, from: "chat" }, id()] satisfies ViewValue[];
    }
    if (space.spaceType === "GROUP_CHAT" && name)
      return [{ name: "Group conversation", text: name, from: "chat" }, id()] satisfies ViewValue[];
    if (space.spaceType === "DIRECT_MESSAGE" && space.singleUserBotDm)
      return [id("a direct message with a Chat app")];
    const members = yield* others(send, conversation, account);
    if (space.spaceType === "DIRECT_MESSAGE") {
      const other = members.people[0];
      if (other)
        return [
          { name: "Direct message with", text: other, from: "chat" },
          id(),
        ] satisfies ViewValue[];
      return [
        id(
          members.app
            ? "a direct message with a Chat app"
            : "a direct message whose other person Google does not name",
        ),
      ];
    }
    if (!members.people.length)
      return [id("a group conversation whose members Google does not name")];
    const more = members.more || members.people.length > MAX_SHOWN_MEMBERS;
    return [
      {
        name: more ? "Group conversation with, among others" : "Group conversation with",
        text: members.people.slice(0, MAX_SHOWN_MEMBERS).join("\n"),
        from: "chat",
      },
      id(),
    ] satisfies ViewValue[];
  });
