import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
import { isoSeconds } from "../approvals/model";
import { normalizeEmail } from "../email";
import { boundedList } from "./bounds";
import { REQUESTS_AT_ONCE } from "./gmail";

export const CHAT_API = "https://chat.googleapis.com/v1";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
const get = <A>(send: Send, path: string, schema: Schema.Codec<A, unknown>) =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`${CHAT_API}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) return yield* Effect.fail(unavailable());
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    const body = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: unavailable });
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(unavailable));
  });

const SpaceName = Schema.String.check(Schema.isPattern(/^spaces\/[A-Za-z0-9_-]+$/));
const Timestamp = Schema.String.check(Schema.makeFilter((time) => !Number.isNaN(Date.parse(time))));
const SpaceList = Schema.Struct({
  spaces: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: SpaceName,
        spaceType: Schema.Literals(["DIRECT_MESSAGE", "GROUP_CHAT", "SPACE"]),
        displayName: Schema.optionalKey(Schema.String),
        lastActiveTime: Schema.optionalKey(Timestamp),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
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
      const params = new URLSearchParams({ pageSize: String(SPACE_PAGE_SIZE) });
      if (next !== undefined) params.set("pageToken", next);
      const result = yield* get(send, `spaces?${params}`, SpaceList);
      spaces.push(...(result.spaces ?? []));
      next = result.nextPageToken;
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

const activeAt = (space: Space) =>
  space.lastActiveTime === undefined ? -Infinity : Date.parse(space.lastActiveTime);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const listConversations = (send: Send, account: string) =>
  Effect.gen(function* () {
    const read = yield* readSpaces(send);
    const recent = read.spaces
      .sort((a, b) => activeAt(b) - activeAt(a) || compare(a.name, b.name))
      .slice(0, MAX_CONVERSATIONS);
    const entries = yield* Effect.forEach(
      recent,
      (space) =>
        (space.spaceType === "DIRECT_MESSAGE"
          ? otherMember(send, space.name, account)
          : Effect.succeed(undefined)
        ).pipe(
          Effect.map((other): Conversation => {
            const name = space.displayName || (other && "email" in other ? other.name : undefined);
            return {
              conversation: space.name,
              kind: kinds[space.spaceType],
              ...(name ? { name } : {}),
              ...(space.lastActiveTime === undefined
                ? {}
                : { last_active: isoSeconds(Date.parse(space.lastActiveTime)) }),
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
            `This result holds the ${conversations.length} most recent of the conversations the server read. A left-out conversation's ID still works in other tools.`,
          ]
        : []),
      ...(read.capped
        ? [
            `This account has more conversations than the server read: it read only the first ${MAX_SPACE_PAGES} pages of ${SPACE_PAGE_SIZE.toLocaleString("en-US")}, so a more recent conversation may be missing, and omitted counts only conversations in those pages.`,
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
