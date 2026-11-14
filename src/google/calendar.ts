import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
import { shorten } from "./bounds";

const API = "https://www.googleapis.com/calendar/v3";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
export const get = <A>(send: Send, path: string, schema: Schema.Codec<A, unknown>) =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`${API}/${path}`, {
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

const CalendarList = Schema.Struct({
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        summary: Schema.optionalKey(Schema.String),
        summaryOverride: Schema.optionalKey(Schema.String),
        primary: Schema.optionalKey(Schema.Boolean),
        accessRole: Schema.optionalKey(Schema.String),
        timeZone: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
});
export interface Calendar {
  readonly calendar: string;
  readonly name: string;
  readonly primary: boolean;
  readonly access: "owner" | "writer" | "reader" | "free_busy";
  readonly time_zone?: string;
}
export const MAX_CALENDAR_PAGES = 8;
export const MAX_CALENDARS = 100;
export const MAX_CALENDARS_CHARACTERS = 30_000;
export const MAX_CALENDAR_NAME = 100;
const accessOf = (role: string | undefined): Calendar["access"] => {
  switch (role) {
    case "owner":
      return "owner";
    case "writer":
    case "writerWithoutPrivateAccess":
      return "writer";
    case "reader":
      return "reader";
    default:
      return "free_busy";
  }
};
/**
 * The account's listed calendars, with Google's default exclusion of hidden and deleted entries.
 * Later tools check IDs and access here: a calendar counts exactly when this reader returns it,
 * including entries beyond list_calendars' output limits. Entries beyond eight pages (2000) do
 * not count. `capped` means Google had another page that this reader did not read.
 */
export const readCalendarList = (send: Send) =>
  Effect.gen(function* () {
    const calendars: Calendar[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
      const params = new URLSearchParams({ maxResults: "250" });
      if (next !== undefined) params.set("pageToken", next);
      const result = yield* get(send, `users/me/calendarList?${params}`, CalendarList);
      for (const entry of result.items ?? [])
        calendars.push({
          calendar: entry.id,
          name: shorten(entry.summaryOverride || entry.summary || entry.id, MAX_CALENDAR_NAME),
          primary: entry.primary === true,
          access: accessOf(entry.accessRole),
          ...(entry.timeZone === undefined ? {} : { time_zone: entry.timeZone }),
        });
      next = result.nextPageToken;
      if (next === undefined) break;
    }
    return { calendars, capped: next !== undefined };
  });

const accessOrder: Record<Calendar["access"], number> = {
  owner: 0,
  writer: 1,
  reader: 2,
  free_busy: 3,
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const listCalendars = (send: Send) =>
  readCalendarList(send).pipe(
    Effect.map((list) => {
      const ordered = list.calendars.sort(
        (a, b) =>
          Number(b.primary) - Number(a.primary) ||
          accessOrder[a.access] - accessOrder[b.access] ||
          compare(a.name, b.name) ||
          compare(a.calendar, b.calendar),
      );
      let size = 2;
      const calendars: Calendar[] = [];
      for (const entry of ordered) {
        const extra = JSON.stringify(entry).length + (calendars.length ? 1 : 0);
        if (calendars.length >= MAX_CALENDARS || size + extra > MAX_CALENDARS_CHARACTERS) break;
        calendars.push(entry);
        size += extra;
      }
      const omitted = ordered.length - calendars.length;
      const notes = [
        ...(omitted
          ? [
              `This result holds the first ${calendars.length} calendars in primary, access, name, and ID order. A left-out calendar's ID still works in other tools.`,
            ]
          : []),
        ...(list.capped
          ? [
              "This account has more calendars than the server counted. Only the first eight pages were read; omitted counts only calendars in those pages.",
            ]
          : []),
      ];
      return {
        calendars,
        ...(omitted ? { omitted } : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
      };
    }),
  );
