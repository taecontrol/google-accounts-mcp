import { Effect, Result, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
import { shorten } from "./bounds";
import { ZoneName } from "./calendar-time";

const API = "https://www.googleapis.com/calendar/v3";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
export const CalendarId = Schema.String.check(Schema.isBetweenLength(1, 254));
export const get = <A>(
  send: Send,
  path: string,
  schema: Schema.Codec<A, unknown>,
  refused: (status: number) => ToolFailure = unavailable,
) =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`${API}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) return yield* Effect.fail(refused(response.status));
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    const body = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: unavailable });
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(unavailable));
  });

export interface CalendarContext {
  readonly calendars: readonly Calendar[];
  readonly primary: Calendar | undefined;
  readonly zone: string;
}
export const calendarContext = (
  send: Send,
  timeZone?: string,
): Effect.Effect<CalendarContext, ToolFailure> =>
  readCalendarList(send).pipe(
    Effect.flatMap(({ calendars }) => {
      const primary = calendars.find((calendar) => calendar.primary);
      const zone = timeZone ?? primary?.time_zone;
      if (zone === undefined || !Schema.is(ZoneName)(zone))
        return Effect.fail(
          new ToolFailure({
            code: "invalid_arguments",
            field: {
              name: "time_zone",
              expects:
                "given as an IANA zone name: this account has no valid primary calendar zone",
            },
          }),
        );
      return Effect.succeed({ calendars, primary, zone });
    }),
  );

/** The single access check for every event read, including approval views. */
export const readableCalendar = (
  ctx: CalendarContext,
  id: string | undefined,
): Result.Result<Calendar, ToolFailure> => {
  const calendar =
    id === undefined ? ctx.primary : ctx.calendars.find((calendar) => calendar.calendar === id);
  if (!calendar || calendar.calendar === "primary")
    return Result.fail(
      new ToolFailure({
        code: "not_found",
        said: "No such calendar in the account's Google Calendar list; leave calendars out to use the primary calendar, or use IDs from list_calendars.",
      }),
    );
  if (calendar.access === "free_busy")
    return Result.fail(
      new ToolFailure({
        code: "invalid_arguments",
        field: {
          name: "calendar",
          expects:
            "a calendar where this account can read events: it sees only busy times here; use check_availability for those",
        },
      }),
    );
  return Result.succeed(calendar);
};

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
