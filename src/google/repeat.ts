import { Result, Schema } from "effect";
import { ToolFailure } from "../mcp/failures";
import { canonicalZone, instantOf, parseTime, TimeText, zonedIso } from "./calendar-time";

const days = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const dayMs = 86_400_000;
export const Repeat = Schema.Struct({
  every: Schema.Literals(["day", "week", "month"]),
  interval: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }))),
  weekdays: Schema.optionalKey(
    Schema.Array(Schema.Literals(days)).check(Schema.isBetweenLength(1, 7), Schema.isUnique()),
  ),
  until: Schema.optionalKey(
    TimeText.check(
      Schema.makeFilter((text) => text.length === 10 && parseTime(text).kind === "date"),
    ),
  ),
  count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 730 }))),
}).check(
  Schema.makeFilter(
    (repeat) =>
      (repeat.weekdays === undefined || repeat.every === "week") &&
      (repeat.until === undefined || repeat.count === undefined),
  ),
);
export type Repeat = typeof Repeat.Type;
type Input = { start: string; time_zone?: string; repeat?: Repeat };

/** Dates and wall clocks already name their local date; only an instant needs a zone. */
const startDate = (start: string, zone: string): string => {
  const point = parseTime(start);
  return point.kind === "instant" ? zonedIso(point.ms, zone).slice(0, 10) : start.slice(0, 10);
};
const weekdayOf = (date: string): number => (new Date(date).getUTCDay() + 6) % 7;
const dayName = (day: number): string => days[day]![0]!.toUpperCase() + days[day]!.slice(1);
/** Every local date an instant can have: zone offsets run from UTC−12 to UTC+14. */
const possibleDates = (ms: number): string[] => {
  const first = new Date(ms - 12 * 3_600_000).toISOString().slice(0, 10);
  const last = new Date(ms + 14 * 3_600_000).toISOString().slice(0, 10);
  const dates = [first];
  while (dates.at(-1)! < last)
    dates.push(new Date(Date.parse(dates.at(-1)!) + dayMs).toISOString().slice(0, 10));
  return dates;
};
type Issue = { path: [string]; issue: string };
const dateIssue = (repeat: Repeat, date: string, where: string): Issue | null => {
  if (repeat.until !== undefined && repeat.until < date)
    return {
      path: ["repeat"],
      issue: `a rule whose until is on or after ${date}, the date of start ${where}`,
    };
  if (repeat.weekdays !== undefined && !repeat.weekdays.includes(days[weekdayOf(date)]!))
    return {
      path: ["repeat"],
      issue: `a rule whose weekdays include ${dayName(weekdayOf(date))}, the weekday of start (${date}) ${where}`,
    };
  return null;
};
/**
 * Decode every check whose answer does not depend on the primary calendar's zone. An instant
 * without an explicit zone is refused now only when it fails on every local date it can have.
 */
export const repeatIssue = (a: Input, zone = a.time_zone): true | Issue => {
  if (a.repeat === undefined) return true;
  const point = parseTime(a.start);
  if (point.kind === "instant" && zone === undefined) {
    const issues = possibleDates(point.ms).map((date) => dateIssue(a.repeat!, date, "in any zone"));
    return issues.every((issue) => issue !== null) ? issues[0]! : true;
  }
  return dateIssue(a.repeat, startDate(a.start, zone ?? "UTC"), `in ${zone ?? "UTC"}`) ?? true;
};

type Rule = {
  interval: number;
  startDate: string;
  allDay: boolean;
  zone: string;
  showZone: boolean;
  end: { kind: "count"; count: number } | { kind: "until"; date: string } | { kind: "none" };
} & (
  | { every: "day" }
  | { every: "week"; weekdays: readonly number[] }
  | { every: "month"; day: number }
);
const lineOf = (rule: Rule): string => {
  const parts = [`FREQ=${{ day: "DAILY", week: "WEEKLY", month: "MONTHLY" }[rule.every]}`];
  if (rule.every === "week") parts.push("WKST=MO");
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.every === "week")
    parts.push(`BYDAY=${rule.weekdays.map((day) => dayCodes[day]).join(",")}`);
  if (rule.every === "month") parts.push(`BYMONTHDAY=${rule.day}`);
  if (rule.end.kind === "count") parts.push(`COUNT=${rule.end.count}`);
  if (rule.end.kind === "until") {
    const until = rule.allDay
      ? rule.end.date.replaceAll("-", "")
      : new Date(
          instantOf({ kind: "local", ms: Date.parse(rule.end.date) + dayMs }, rule.zone) - 1000,
        )
          .toISOString()
          .slice(0, 19)
          .replaceAll(/[-:]/g, "") + "Z";
    parts.push(`UNTIL=${until}`);
  }
  return `RRULE:${parts.join(";")}`;
};
const dateWords = (ms: number, weekday = false): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...(weekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(ms);
/** Expand only the weekly case whose interval can make the words misleading. A fifth date
 * proves that the four shown dates need an ellipsis, even with a finite end. */
const firstDates = (rule: Rule & { every: "week" }): number[] => {
  const start = Date.parse(rule.startDate);
  const monday = start - weekdayOf(rule.startDate) * dayMs;
  const dates: number[] = [];
  for (let week = monday; ; week += rule.interval * 7 * dayMs) {
    for (const day of rule.weekdays) {
      const date = week + day * dayMs;
      if (date < start) continue;
      if (
        (rule.end.kind === "count" && dates.length === rule.end.count) ||
        (rule.end.kind === "until" && date > Date.parse(rule.end.date))
      )
        return dates;
      dates.push(date);
      if (dates.length === 5) return dates;
    }
  }
};
const wordsOf = (rule: Rule): string => {
  let text = `Every ${rule.interval === 1 ? rule.every : `${rule.interval} ${rule.every}s`}`;
  if (rule.every === "week") {
    const names = rule.weekdays.map(dayName);
    text += ` on ${new Intl.ListFormat("en-US", { type: "conjunction" }).format(names)}`;
  }
  if (rule.every === "month") text += ` on day ${rule.day}`;
  text +=
    rule.end.kind === "count"
      ? `, ${rule.end.count} ${rule.end.count === 1 ? "time" : "times"}.`
      : rule.end.kind === "until"
        ? `, until ${dateWords(Date.parse(rule.end.date))} (that day included).`
        : ", with no end date.";
  if (rule.every === "week" && rule.interval > 1 && rule.weekdays.length > 1) {
    const dates = firstDates(rule);
    text +=
      " Weeks run Monday to Sunday and count from the week of the start: " +
      dates
        .slice(0, 4)
        .map((date) => dateWords(date, true))
        .join("; ") +
      (dates.length > 4 ? "; …" : ".");
  }
  if (rule.every === "month" && rule.day >= 29)
    text += ` Months without a day ${rule.day} are skipped.`;
  if (rule.showZone) text += ` Days are in ${rule.zone}.`;
  return text;
};

/** The request and approval are two renderings of this one normalized rule. Callers never
 * interpret recurrence syntax or compute recurrence dates. */
export const repeatRule = (
  a: Input,
  zone: string,
  primaryZone: string | undefined,
): Result.Result<{ line: string; text: string } | null, ToolFailure> => {
  if (a.repeat === undefined) return Result.succeed(null);
  const issue = repeatIssue(a, zone);
  if (issue !== true)
    return Result.fail(
      new ToolFailure({
        code: "invalid_arguments",
        field: { name: "repeat", expects: issue.issue },
      }),
    );
  const repeat = a.repeat;
  const date = startDate(a.start, zone);
  const allDay = parseTime(a.start).kind === "date";
  const rule: Rule = {
    interval: repeat.interval ?? 1,
    startDate: date,
    allDay,
    zone,
    // An alias such as US/Eastern names the primary zone America/New_York too.
    showZone:
      !allDay &&
      (canonicalZone(zone) ?? zone) !==
        (primaryZone === undefined ? undefined : (canonicalZone(primaryZone) ?? primaryZone)),
    end:
      repeat.count !== undefined
        ? { kind: "count", count: repeat.count }
        : repeat.until !== undefined
          ? { kind: "until", date: repeat.until }
          : { kind: "none" },
    ...(repeat.every === "week"
      ? {
          every: "week",
          weekdays:
            repeat.weekdays === undefined
              ? [weekdayOf(date)]
              : repeat.weekdays.map((day) => days.indexOf(day)).sort((a, b) => a - b),
        }
      : repeat.every === "month"
        ? { every: "month", day: Number(date.slice(8, 10)) }
        : { every: "day" }),
  };
  return Result.succeed({ line: lineOf(rule), text: wordsOf(rule) });
};
