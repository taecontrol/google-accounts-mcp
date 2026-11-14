import { Effect, Result, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { calendarError, notFound, ToolFailure } from "../mcp/failures";
import { normalizeEmail } from "../owner/owner";
import { calendarContext, get, readableCalendar, type Calendar } from "./calendar";
import { eventTime, instantOf, parseTime, rangeOf, TimeText, ZoneName } from "./calendar-time";
import { REQUESTS_AT_ONCE } from "./gmail";
import { safeEnd } from "./bounds";
import { htmlToText } from "./html";

export const DEFAULT_EVENT_LIMIT = 25;
export const MAX_EVENT_LIMIT = 50;
export const MAX_EVENT_CALENDARS = 20;
export const MAX_EVENT_QUERY = 500;
export const MAX_EVENT_PAGE = 2000;
const LIMIT = 32_000;
const SIZE_NOTE =
  "The result reached its size limit; call again for each calendar with next_page or not_read.";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
export const EventId = Schema.String.check(
  Schema.isBetweenLength(1, 1024),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);

const Point = Schema.Union([
  Schema.Struct({
    date: TimeText.check(Schema.makeFilter((text) => parseTime(text).kind === "date")),
  }),
  Schema.Struct({
    dateTime: TimeText.check(Schema.makeFilter((text) => parseTime(text).kind !== "date")),
    timeZone: Schema.optionalKey(ZoneName),
  }),
]);
const Person = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(Schema.Boolean),
});
const Attendee = Schema.Struct({
  email: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  responseStatus: Schema.optionalKey(
    Schema.Literals(["accepted", "declined", "tentative", "needsAction"]),
  ),
  optional: Schema.optionalKey(Schema.Boolean),
  resource: Schema.optionalKey(Schema.Boolean),
  self: Schema.optionalKey(Schema.Boolean),
});
const LiveEvent = Schema.Struct({
  id: EventId,
  status: Schema.Literals(["confirmed", "tentative"]),
  start: Point,
  end: Point,
  summary: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  organizer: Schema.optionalKey(Person),
  attendees: Schema.optionalKey(Schema.Array(Attendee)),
  attendeesOmitted: Schema.optionalKey(Schema.Boolean),
  guestsCanSeeOtherGuests: Schema.optionalKey(Schema.Boolean),
  recurringEventId: Schema.optionalKey(EventId),
  recurrence: Schema.optionalKey(Schema.Array(Schema.String)),
  hangoutLink: Schema.optionalKey(Schema.String),
  htmlLink: Schema.optionalKey(Schema.String),
  eventType: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((event) => "date" in event.start === "date" in event.end));
type LiveEvent = typeof LiveEvent.Type;
const GoogleEvent = Schema.Union([
  Schema.Struct({ id: EventId, status: Schema.Literal("cancelled") }),
  LiveEvent,
]);
const EventList = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(GoogleEvent)),
  nextPageToken: Schema.optionalKey(
    Schema.String.check(
      Schema.isBetweenLength(1, MAX_EVENT_PAGE),
      // Printable ASCII without quotes or backslashes has the same length in JSON.
      Schema.makeFilter((token) => !/[^\x20-\x21\x23-\x5b\x5d-\x7e]/u.test(token)),
    ),
  ),
});

/** JSON characters, including quotes and escaping, with no split surrogate pair at the cut. */
const shortJson = (text: string, limit: number, marker = "…"): string => {
  if (JSON.stringify(text).length <= limit) return text;
  let low = 0;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, safeEnd(text, middle)) + marker).length <= limit) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, safeEnd(text, low)) + marker;
};
const boundedList = <A>(items: readonly A[], limit: number): { kept: A[]; left: number } => {
  let size = 2;
  const kept: A[] = [];
  for (const item of items) {
    const extra = JSON.stringify(item).length + (kept.length ? 1 : 0);
    if (size + extra > limit) break;
    kept.push(item);
    size += extra;
  }
  return { kept, left: items.length - kept.length };
};
const responseOf = (attendee: typeof Attendee.Type) =>
  attendee.responseStatus === undefined || attendee.responseStatus === "needsAction"
    ? "needs_action"
    : attendee.responseStatus;
const belongsToAccount = (person: typeof Person.Type, account: string, calendar: Calendar) =>
  (calendar.primary && person.self === true) ||
  normalizeEmail(person.email) === normalizeEmail(account);
const kinds: Readonly<Record<string, string>> = {
  outOfOffice: "out_of_office",
  focusTime: "focus_time",
  birthday: "birthday",
  fromGmail: "from_gmail",
  workingLocation: "working_location",
};
const peopleOf = (event: LiveEvent, account: string, calendar: Calendar) => {
  const guests = (event.attendees ?? []).filter((guest) => !guest.resource);
  const mine = calendar.primary
    ? guests.find((guest) => guest.self)
    : guests.find((guest) => normalizeEmail(guest.email) === normalizeEmail(account));
  return {
    guests,
    flags: {
      ...(event.attendeesOmitted ||
      (event.guestsCanSeeOtherGuests === false &&
        !(event.organizer && belongsToAccount(event.organizer, account, calendar)))
        ? { guests_hidden: true as const }
        : {}),
      ...(mine ? { my_response: responseOf(mine) } : {}),
    },
  };
};
const summaryOf = (event: LiveEvent, zone: string, textLimit: number) => ({
  event: event.id,
  title: shortJson(event.summary ?? "", textLimit),
  ...eventTime(event.start, event.end, zone),
  ...(event.location === undefined ? {} : { location: shortJson(event.location, textLimit) }),
  ...(event.organizer?.email === undefined ? {} : { organizer: event.organizer.email }),
  ...(event.recurringEventId === undefined ? {} : { series: event.recurringEventId }),
  ...(event.eventType && kinds[event.eventType] ? { type: kinds[event.eventType] } : {}),
});
type EventSummary = ReturnType<typeof summaryOf> & {
  guest_count: number;
  guests_hidden?: true;
  my_response?: string;
};
interface CalendarResult {
  calendar: string;
  events?: EventSummary[];
  next_page?: string;
  not_read?: true;
  error?: NonNullable<ReturnType<typeof calendarError>>;
}
export interface SearchEventsInput {
  readonly account: string;
  readonly calendars?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly time_zone?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly page?: string;
}
const listPage = (
  send: Send,
  calendar: string,
  input: SearchEventsInput,
  range: { from: number; to: number },
  zone: string,
  limit: number,
) => {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(limit),
    timeMin: new Date(Math.floor(range.from / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    timeMax: new Date(Math.ceil(range.to / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    timeZone: zone,
  });
  for (const kind of ["default", "outOfOffice", "focusTime", "birthday", "fromGmail"])
    params.append("eventTypes", kind);
  if (input.query !== undefined) params.set("q", input.query);
  if (input.page !== undefined) params.set("pageToken", input.page);
  return get(
    send,
    `calendars/${encodeURIComponent(calendar)}/events?${params}`,
    EventList,
    (status) =>
      status === 404 || status === 410
        ? notFound("calendar", calendar)
        : status === 400 && input.page !== undefined
          ? new ToolFailure({
              code: "invalid_arguments",
              field: { name: "page", expects: "the next_page value of an earlier result" },
            })
          : unavailable(),
  );
};
const inRange = (event: LiveEvent, zone: string, range: { from: number; to: number }) => {
  const pointInstant = (point: LiveEvent["start"]) =>
    "date" in point
      ? instantOf(parseTime(point.date), zone)
      : instantOf(parseTime(point.dateTime), point.timeZone ?? zone);
  return pointInstant(event.end) > range.from && pointInstant(event.start) < range.to;
};
const failureOf = (failures: readonly ToolFailure[]) =>
  failures.find((failure) => failure.code === "google_unavailable") ??
  (failures.every((failure) => failure.code === "not_found")
    ? failures[0]!
    : failures.find((failure) => failure.code === "invalid_arguments")!);

export const searchEvents = (send: Send, input: SearchEventsInput) =>
  Effect.gen(function* () {
    const ctx = yield* calendarContext(send, input.time_zone);
    const range = yield* Effect.fromResult(rangeOf(input.from, input.to, ctx.zone));
    const calendars = input.calendars ?? [ctx.primary?.calendar ?? ""];
    const attempts = yield* Effect.forEach(
      calendars,
      (id) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.result(
            Effect.gen(function* () {
              const calendar = yield* Effect.fromResult(
                readableCalendar(ctx, input.calendars === undefined ? undefined : id),
              );
              return yield* listPage(
                send,
                calendar.calendar,
                input,
                range,
                ctx.zone,
                input.limit ?? DEFAULT_EVENT_LIMIT,
              );
            }),
          );
          if (Result.isFailure(attempt) && calendarError(attempt.failure, input.account) === null)
            return yield* Effect.fail(attempt.failure);
          return attempt;
        }),
      { concurrency: REQUESTS_AT_ONCE },
    );
    const failures = attempts.flatMap((attempt) =>
      Result.isFailure(attempt) ? [attempt.failure] : [],
    );
    if (failures.length === attempts.length) return yield* Effect.fail(failureOf(failures));

    const result: {
      account: string;
      time_zone: string;
      calendars: CalendarResult[];
      note?: string;
    } = {
      account: input.account,
      time_zone: ctx.zone,
      calendars: attempts.map((attempt, index) =>
        Result.isFailure(attempt)
          ? { calendar: calendars[index]!, error: calendarError(attempt.failure, input.account)! }
          : {
              calendar: calendars[index]!,
              events: [],
              ...(attempt.success.nextPageToken === undefined
                ? {}
                : { next_page: attempt.success.nextPageToken }),
            },
      ),
    };
    const stop = (index: number, unreadCurrent: boolean) => {
      for (let i = index + (unreadCurrent ? 0 : 1); i < result.calendars.length; i++)
        result.calendars[i] = { calendar: calendars[i]!, not_read: true };
      result.note = SIZE_NOTE;
    };
    const reservedSize = () =>
      JSON.stringify({ ...result, note: SIZE_NOTE }).length +
      result.calendars.reduce(
        (extra, entry) =>
          extra +
          Math.max(
            0,
            JSON.stringify({ calendar: entry.calendar, not_read: true }).length -
              JSON.stringify(entry).length,
          ),
        0,
      );
    // Reserve every envelope before any event. An unusually long group of tokens can fill it.
    for (let i = 0; i < result.calendars.length; i++) {
      if (reservedSize() <= LIMIT) break;
      stop(result.calendars.length - i - 1, true);
    }
    for (const [index, attempt] of attempts.entries()) {
      const entry = result.calendars[index]!;
      if (entry.not_read) break;
      if (Result.isFailure(attempt)) continue;
      const calendar = yield* Effect.fromResult(readableCalendar(ctx, entry.calendar));
      let consumed = 0;
      for (const item of attempt.success.items ?? []) {
        if (item.status === "cancelled") {
          consumed++;
          continue;
        }
        if (!inRange(item, ctx.zone, range)) {
          consumed++;
          continue;
        }
        const mapped = summaryOf(item, ctx.zone, 200);
        const people = peopleOf(item, input.account, calendar);
        const event = { ...mapped, guest_count: people.guests.length, ...people.flags };
        entry.events!.push(event);
        // A cut may need a new token. The response schema excludes JSON escapes.
        const maxTokenSize = MAX_EVENT_PAGE + 2;
        const tokenReserve =
          entry.next_page === undefined
            ? ',"next_page":'.length + maxTokenSize
            : maxTokenSize - JSON.stringify(entry.next_page).length;
        if (reservedSize() + tokenReserve <= LIMIT) {
          consumed++;
          continue;
        }
        entry.events!.pop();
        stop(index, consumed === 0);
        if (consumed > 0) {
          const continuation = yield* Effect.result(
            listPage(send, entry.calendar, input, range, ctx.zone, consumed),
          );
          if (Result.isFailure(continuation)) {
            const error = calendarError(continuation.failure, input.account);
            if (error === null) return yield* Effect.fail(continuation.failure);
            result.calendars[index] = { calendar: entry.calendar, error };
            if (result.calendars.every((calendar) => calendar.error !== undefined))
              return yield* Effect.fail(failureOf([...failures, continuation.failure]));
          } else {
            delete entry.next_page;
            if (continuation.success.nextPageToken !== undefined)
              entry.next_page = continuation.success.nextPageToken;
          }
        }
        return result;
      }
    }
    return result;
  });

export const findEvent = (
  send: Send,
  calendar: Calendar,
  event: string,
  zone?: string,
): Effect.Effect<LiveEvent, ToolFailure> =>
  get(
    send,
    `calendars/${encodeURIComponent(calendar.calendar)}/events/${encodeURIComponent(event)}${zone === undefined ? "" : `?${new URLSearchParams({ timeZone: zone })}`}`,
    GoogleEvent,
    (status) => (status === 404 || status === 410 ? notFound("event", event) : unavailable()),
  ).pipe(
    Effect.flatMap((found) =>
      found.status === "cancelled" ? Effect.fail(notFound("event", event)) : Effect.succeed(found),
    ),
  );

/** The view needs only the mapped title and start, plus the event's own zone when supplied. */
export const eventView = (send: Send, calendar: Calendar, event: string, zone: string) =>
  findEvent(send, calendar, event, zone).pipe(
    Effect.map((found) => ({
      title: shortJson(found.summary ?? "", 1_000),
      start: eventTime(found.start, found.end, zone).start,
      own_zone: "timeZone" in found.start ? found.start.timeZone : undefined,
    })),
  );

export const readEvent = (
  send: Send,
  input: { account: string; calendar?: string; event: string; time_zone?: string },
) =>
  Effect.gen(function* () {
    const ctx = yield* calendarContext(send, input.time_zone);
    const calendar = yield* Effect.fromResult(readableCalendar(ctx, input.calendar));
    const event = yield* findEvent(send, calendar, input.event, ctx.zone);
    const people = peopleOf(event, input.account, calendar);
    const guests = boundedList(
      people.guests.map((guest) => ({
        email: guest.email,
        ...(guest.displayName === undefined ? {} : { name: guest.displayName }),
        response: responseOf(guest),
        optional: guest.optional === true,
      })),
      8_000,
    );
    const recurrence = boundedList(
      event.recurringEventId === undefined ? (event.recurrence ?? []) : [],
      4_000,
    );
    let description = event.description ?? "";
    if (/<\/?(?:br|p|div|span|a|b|i|u|ul|ol|li)(?:\s|\/?>)/i.test(description))
      description = yield* Effect.tryPromise({
        try: () => htmlToText(description),
        catch: unavailable,
      });
    return {
      account: input.account,
      calendar: calendar.calendar,
      time_zone: ctx.zone,
      ...summaryOf(event, ctx.zone, 1_000),
      description: shortJson(description, 10_000, "\n[The rest of the description was left out.]"),
      guests: guests.kept,
      ...people.flags,
      ...(guests.left ? { guests_left_out: guests.left } : {}),
      ...(event.recurrence !== undefined && event.recurringEventId === undefined
        ? { recurrence: recurrence.kept }
        : {}),
      ...(recurrence.left ? { recurrence_left_out: recurrence.left } : {}),
      ...(event.hangoutLink === undefined ? {} : { meet: event.hangoutLink }),
      status: event.status,
      link: event.htmlLink ?? "",
    };
  });
