import { Result, Schema } from "effect";
import { ToolFailure } from "../mcp/failures";

/** Keep the caller's spelling; Intl's canonical names can change between runtime versions. */
export const ZoneName = Schema.String.check(
  Schema.makeFilter((zone) => {
    if (zone !== "UTC" && !zone.includes("/")) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }),
);

export type TimeInput = { readonly kind: "date" | "local" | "instant"; readonly ms: number };
const inputOf = (text: string): TimeInput | null => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      text,
    );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((v) => Number(v ?? 0));
  if (month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59)
    return null;
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour!, minute!, second!, 0);
  const ms = date.getTime();
  if (date.getUTCDate() !== day) return null;
  const offset = match[7];
  if (!offset) return { kind: match[4] === undefined ? "date" : "local", ms };
  if (offset === "Z") return { kind: "instant", ms };
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4));
  if (hours > 23 || minutes > 59) return null;
  return {
    kind: "instant",
    ms: ms - (offset[0] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000,
  };
};

/** Validated strings stay JSON-shaped so sealed approval arguments decode a second time. */
export const TimeText = Schema.String.check(
  Schema.makeFilter(
    (text) =>
      Number(text.slice(0, 4)) >= 1900 &&
      Number(text.slice(0, 4)) <= 2999 &&
      inputOf(text) !== null,
  ),
);
/** Agent input or a formatted event time. Floating ms is a wall clock, not an instant. */
export const parseTime = (text: string): TimeInput =>
  inputOf(text) ?? { kind: "instant", ms: Date.parse(text) };

/** Google accepts the canonical spelling, while results retain the caller's spelling. */
export const canonicalZone = (zone: string): string =>
  new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;

const offsetAt = (ms: number, zone: string): number => {
  const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((part) => part.type === "timeZoneName")!.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset);
  if (!match) return 0; // Some Intl versions spell the zero offset as GMT.
  return (
    (match[1] === "-" ? -1 : 1) *
    (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) *
    1000
  );
};

export const instantOf = (input: TimeInput, zone: string): number => {
  if (input.kind === "instant") return input.ms;
  // Probe both sides of a possible transition so an overlap exposes both occurrences.
  const candidates = [-86_400_000, 86_400_000].map(
    (delta) => input.ms - offsetAt(input.ms + delta, zone),
  );
  const valid = candidates.filter(
    (candidate) => candidate + offsetAt(candidate, zone) === input.ms,
  );
  // The first occurrence wins in an overlap; a gap moves forward to the later instant.
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
};
export const rangeOf = (
  from: string,
  to: string,
  zone: string,
): Result.Result<{ from: number; to: number }, ToolFailure> => {
  const range = { from: instantOf(parseTime(from), zone), to: instantOf(parseTime(to), zone) };
  return range.to > range.from
    ? Result.succeed(range)
    : Result.fail(
        new ToolFailure({
          code: "invalid_arguments",
          field: { name: "to", expects: "after from in the call's time zone" },
        }),
      );
};

export const zonedIso = (ms: number, zone: string): string => {
  const offset = Math.round(offsetAt(ms, zone) / 60_000);
  const fields = new Date(ms + offset * 60_000).toISOString().replace(/\.\d{3}Z$/, "");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${fields}${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

/** Google's event times are broader than agent input; an event's own zone is display text. */
export const EventPoint = Schema.Union([
  Schema.Struct({
    date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
    timeZone: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    dateTime: Schema.String.check(
      Schema.makeFilter(
        (text) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) && Number.isFinite(Date.parse(text)),
      ),
    ),
    timeZone: Schema.optionalKey(Schema.String),
  }),
]);
export type EventPoint = typeof EventPoint.Type;
export const eventInstant = (point: EventPoint, zone: string): number =>
  "date" in point
    ? instantOf({ kind: "date", ms: Date.parse(point.date) }, zone)
    : Date.parse(point.dateTime);
export type EventTime =
  | { readonly all_day: true; readonly start: string; readonly end: string }
  | { readonly all_day: false; readonly start: string; readonly end: string };
export const eventTime = (start: EventPoint, end: EventPoint, zone: string): EventTime =>
  "date" in start && "date" in end
    ? { all_day: true, start: start.date, end: end.date }
    : {
        all_day: false,
        start: zonedIso(eventInstant(start, zone), zone),
        end: zonedIso(eventInstant(end, zone), zone),
      };

/** A point of a range or an event, in words for the approval page. */
export const viewTime = (text: string, zone: string, showZone = true): string => {
  const input = parseTime(text);
  const allDay = input.kind === "date";
  const ms = allDay ? input.ms : instantOf(input, zone);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: allDay ? "UTC" : zone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(ms);
  if (allDay) return `${date} (all day)`;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
  return `${date} at ${time}${showZone ? ` (${zone})` : ""}`;
};
