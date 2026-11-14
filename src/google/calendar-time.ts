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
  const ms = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  if (new Date(ms).getUTCDate() !== day) return null;
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
/** Call after TimeText has validated the text. Floating ms is a wall clock, not an instant. */
export const parseTime = (text: string): TimeInput => inputOf(text)!;

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
  const first = input.ms - offsetAt(input.ms, zone);
  const firstOffset = offsetAt(first, zone);
  const second = input.ms - firstOffset;
  if (first + firstOffset === input.ms) return first;
  if (second + offsetAt(second, zone) === input.ms) return second;
  // Only a gap has no candidate that maps back to the requested wall clock.
  return Math.max(first, second);
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
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const value = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === name)!.value;
  const offset = Math.round(offsetAt(ms, zone) / 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

export interface EventPoint {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}
export type EventTime =
  | { readonly all_day: true; readonly start: string; readonly end: string }
  | { readonly all_day: false; readonly start: string; readonly end: string };
export const eventTime = (start: EventPoint, end: EventPoint, zone: string): EventTime =>
  start.date !== undefined && end.date !== undefined
    ? { all_day: true, start: start.date, end: end.date }
    : {
        all_day: false,
        start: zonedIso(instantOf(parseTime(start.dateTime!), start.timeZone ?? zone), zone),
        end: zonedIso(instantOf(parseTime(end.dateTime!), end.timeZone ?? zone), zone),
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
