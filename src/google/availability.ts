import { Effect, Result, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { calendarError, ToolFailure } from "../mcp/failures";
import { CALENDAR_API, calendarContext, missingCalendar, type CalendarContext } from "./calendar";
import { parseTime, rangeOf, zonedIso } from "./calendar-time";

export const MAX_AVAILABILITY_CALENDARS = 20;
export const MAX_AVAILABILITY_DAYS = 31;
export const MAX_BUSY_TIMES = 150;
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
const group = () =>
  new ToolFailure({
    code: "invalid_arguments",
    said: "This ID is a group; check_availability does not expand groups. Name each person's address instead.",
  });
type Range = { readonly from: number; readonly to: number };
export interface AvailabilityInput {
  readonly account: string;
  readonly from: string;
  readonly to: string;
  readonly time_zone?: string;
  readonly calendars?: readonly string[];
}
type CalendarError = NonNullable<ReturnType<typeof calendarError>>;
export type AvailabilityEntry =
  | { calendar: string; busy: Array<{ start: string; end: string }> }
  | { calendar: string; error: CalendarError };

/** Unlike elapsed milliseconds, wall-clock days do not gain or lose an hour across DST. */
export const availabilityRange = (from: string, to: string, zone: string) =>
  rangeOf(from, to, zone).pipe(
    Result.flatMap((range) => {
      const wall = (ms: number) => parseTime(zonedIso(ms, zone).slice(0, 19)).ms;
      return wall(range.to) - wall(range.from) <= MAX_AVAILABILITY_DAYS * 86_400_000
        ? Result.succeed(range)
        : Result.fail(
            new ToolFailure({
              code: "invalid_arguments",
              field: { name: "to", expects: "at most 31 days after from" },
            }),
          );
    }),
  );

/** Busy-only and unlisted calendars are valid targets. Only the default needs a listed ID. */
export const availabilityCalendars = (ctx: CalendarContext, calendars?: readonly string[]) =>
  calendars !== undefined
    ? Result.succeed(calendars)
    : ctx.primary === undefined || ctx.primary.calendar === "primary"
      ? Result.fail(missingCalendar())
      : Result.succeed([ctx.primary.calendar]);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
/**
 * Google's instants in whole seconds, rounded outward by the caller: a busy start or an answer's
 * timeMax rounds down, a busy end or an answer's timeMin rounds up, so busy time never shrinks.
 * Date.parse would turn an impossible date such as February 30 into March, so it is not used.
 */
export const googleInstant = (text: string, round: "down" | "up"): number | null => {
  const match = RFC3339.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59)
    return null;
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour!, minute!, second!, 0);
  if (date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  const zone = match[8]!.toUpperCase();
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  const fraction = match[7] !== undefined && /[1-9]/.test(match[7]);
  return date.getTime() - offset + (round === "up" && fraction ? 1000 : 0);
};
const Instant = Schema.String.check(
  Schema.makeFilter((text) => googleInstant(text, "down") !== null),
);
// Calendar values are decoded individually: a malformed entry must not hide the other answers.
const Envelope = Schema.Struct({
  timeMin: Instant,
  timeMax: Instant,
  groups: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  calendars: Schema.Record(Schema.String, Schema.Unknown),
});
const Errors = Schema.Struct({
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ domain: Schema.optionalKey(Schema.String), reason: Schema.String }),
    ),
  ),
});
const Busy = Schema.Struct({
  busy: Schema.Array(
    Schema.Struct({ start: Instant, end: Instant }).check(
      Schema.makeFilter(
        (time) => googleInstant(time.end, "up")! > googleInstant(time.start, "down")!,
      ),
    ),
  ),
});
const errorEntry = (
  calendar: string,
  failure: ToolFailure,
  account: string,
): AvailabilityEntry => ({ calendar, error: calendarError(failure, account)! });

/** Only an exact, complete, positively decoded Google answer can produce a busy list. */
export const availabilityEntries = (
  body: unknown,
  calendars: readonly string[],
  range: Range,
  account: string,
  zone: string,
): Result.Result<AvailabilityEntry[], ToolFailure> => {
  const decoded = Schema.decodeUnknownResult(Envelope)(body);
  if (Result.isFailure(decoded)) return Result.fail(unavailable());
  const answer = decoded.success;
  if (
    googleInstant(answer.timeMin, "up")! > range.from ||
    googleInstant(answer.timeMax, "down")! < range.to
  )
    return Result.fail(unavailable());
  let remaining = MAX_BUSY_TIMES;
  return Result.succeed(
    calendars.map((calendar): AvailabilityEntry => {
      const failed = (failure: ToolFailure) => errorEntry(calendar, failure, account);
      if (calendar === "primary") return failed(missingCalendar());
      if (answer.groups !== undefined && Object.hasOwn(answer.groups, calendar))
        return failed(group());
      if (!Object.hasOwn(answer.calendars, calendar))
        return failed(
          new ToolFailure({
            code: "not_found",
            said: "Google's answer has no entry for this exact ID. Use the ID as list_calendars returns it, or the person's address.",
          }),
        );
      const entry = answer.calendars[calendar];
      const errors = Schema.decodeUnknownResult(Errors)(entry);
      if (Result.isFailure(errors)) return failed(unavailable());
      if (errors.success.errors?.length) {
        if (errors.success.errors.some((error) => error.reason === "notFound"))
          return failed(
            new ToolFailure({
              code: "not_found",
              said: "Google cannot check this calendar: it does not exist, or this account cannot see its busy times.",
            }),
          );
        return failed(
          errors.success.errors.some((error) => error.reason === "groupTooBig")
            ? group()
            : unavailable(),
        );
      }
      const times = Schema.decodeUnknownResult(Busy)(entry);
      if (Result.isFailure(times)) return failed(unavailable());
      const busy = times.success.busy
        .map((time) => ({
          start: Math.max(googleInstant(time.start, "down")!, range.from),
          end: Math.min(googleInstant(time.end, "up")!, range.to),
        }))
        .filter((time) => time.end > time.start)
        .sort((a, b) => a.start - b.start);
      if (busy.length > remaining)
        return failed(
          new ToolFailure({
            code: "invalid_arguments",
            said: "Too many busy times to fit in one result (at most 150). Shorten the range or name fewer calendars. Name the calendars that matter most first.",
          }),
        );
      remaining -= busy.length;
      return {
        calendar,
        busy: busy.map((time) => ({
          start: zonedIso(time.start, zone),
          end: zonedIso(time.end, zone),
        })),
      };
    }),
  );
};

const freeBusy = (send: Send, calendars: readonly string[], range: Range) =>
  Effect.gen(function* () {
    // All-day events keep their calendar's midnight boundaries; timeZone only changes offsets.
    const body = JSON.stringify({
      timeMin: new Date(range.from).toISOString(),
      timeMax: new Date(range.to).toISOString(),
      items: calendars.map((id) => ({ id })),
    });
    const response = yield* send(
      (token, signal) =>
        new Request(`${CALENDAR_API}/freeBusy`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) return yield* Effect.fail(unavailable());
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    return yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: unavailable });
  });

export const checkAvailability = (send: Send, input: AvailabilityInput) =>
  Effect.gen(function* () {
    const ctx = yield* calendarContext(send, input.time_zone);
    const range = yield* Effect.fromResult(availabilityRange(input.from, input.to, ctx.zone));
    const calendars = yield* Effect.fromResult(availabilityCalendars(ctx, input.calendars));
    const sent = calendars.filter((calendar) => calendar !== "primary");
    if (!sent.length) return yield* Effect.fail(missingCalendar());
    const body = yield* freeBusy(send, sent, range);
    const entries = yield* Effect.fromResult(
      availabilityEntries(body, calendars, range, input.account, ctx.zone),
    );
    const errors = entries.flatMap((entry) => ("error" in entry ? [entry.error] : []));
    if (errors.length === entries.length) {
      const first = errors[0]!;
      const code = errors.every((error) => error.code === first.code)
        ? first.code
        : errors.some((error) => error.code === "google_unavailable")
          ? "google_unavailable"
          : "invalid_arguments";
      return yield* Effect.fail(
        new ToolFailure({ code, said: errors.find((error) => error.code === code)!.message }),
      );
    }
    return { account: input.account, time_zone: ctx.zone, calendars: entries };
  });
