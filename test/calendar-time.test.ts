import { expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import {
  eventTime,
  instantOf,
  parseTime,
  rangeOf,
  TimeText,
  viewTime,
  zonedIso,
  ZoneName,
} from "../src/google/calendar-time";

it.each([
  ["2026-11-20", "America/Bogota", "2026-11-20T00:00:00-05:00"],
  ["2026-11-20T15:45", "America/Bogota", "2026-11-20T15:45:00-05:00"],
  ["2026-11-20T20:45:30.999Z", "America/Bogota", "2026-11-20T15:45:30-05:00"],
  ["2026-11-20T15:45:30.1-05:00", "Europe/Madrid", "2026-11-20T21:45:30+01:00"],
  ["2026-03-08T06:59:59Z", "America/New_York", "2026-03-08T01:59:59-05:00"],
  ["2026-03-08T07:00:00Z", "America/New_York", "2026-03-08T03:00:00-04:00"],
  ["2026-11-01T05:59:59Z", "America/New_York", "2026-11-01T01:59:59-04:00"],
  ["2026-11-01T06:00:00Z", "America/New_York", "2026-11-01T01:00:00-05:00"],
  ["2026-03-29T00:59:59Z", "Europe/Madrid", "2026-03-29T01:59:59+01:00"],
  ["2026-03-29T01:00:00Z", "Europe/Madrid", "2026-03-29T03:00:00+02:00"],
  ["2026-10-25T00:59:59Z", "Europe/Madrid", "2026-10-25T02:59:59+02:00"],
  ["2026-10-25T01:00:00Z", "Europe/Madrid", "2026-10-25T02:00:00+01:00"],
  ["2026-10-25T01:30", "Europe/Madrid", "2026-10-25T01:30:00+02:00"],
  ["2026-10-25T03:30", "Europe/Madrid", "2026-10-25T03:30:00+01:00"],
  ["2026-04-05T01:30", "Australia/Sydney", "2026-04-05T01:30:00+11:00"],
  ["2026-11-01T00:30", "America/New_York", "2026-11-01T00:30:00-04:00"],
  ["2026-09-06", "America/Santiago", "2026-09-06T01:00:00-03:00"],
  ["2026-03-08T02:30", "America/New_York", "2026-03-08T03:30:00-04:00"],
  ["2026-03-29T02:30", "Europe/Madrid", "2026-03-29T03:30:00+02:00"],
  ["1900-01-01T00:00Z", "UTC", "1900-01-01T00:00:00+00:00"],
  ["1900-01-01T00:00Z", "America/New_York", "1899-12-31T19:00:00-05:00"],
  ["2999-12-31T23:59Z", "UTC", "2999-12-31T23:59:00+00:00"],
])("reads %s in %s as %s", (text, zone, expected) => {
  const decoded = Schema.decodeUnknownSync(TimeText)(text);
  expect(decoded).toBe(text);
  expect(zonedIso(instantOf(parseTime(decoded), zone), zone)).toBe(expected);
});

it.each([
  "1899-12-31",
  "3000-01-01",
  "0099-01-01",
  "2026-02-30",
  "2025-02-29",
  "2026-00-01",
  "2026-13-01",
  "2026-01-00",
  "2026-01-32",
  "2026-11-20T24:00",
  "2026-11-20T00:60",
  "2026-11-20T00:00:60",
  "2026-11-20T00:00+24:00",
  "2026-11-20T00:00-05:60",
  "2026-11-20 00:00",
  "2026-11-20T00:00.123",
  "2026-11-20T00:00:00.1234Z",
])("refuses invalid time %s", (text) => {
  expect(Schema.is(TimeText)(text)).toBe(false);
});

it.each(["UTC", "America/Bogota", "america/new_york", "Etc/UTC"])(
  "keeps zone name %s as given",
  (zone) => {
    expect(Schema.decodeUnknownSync(ZoneName)(zone)).toBe(zone);
  },
);
it.each(["BST", "EST", "+05:00", "Foo/Bar", "", "GMT"])("refuses non-IANA zone %s", (zone) => {
  expect(Schema.is(ZoneName)(zone)).toBe(false);
});

it("converts a range across DST with an offset for each endpoint and rejects a reversed range", () => {
  const range = rangeOf("2026-03-08", "2026-03-09", "America/New_York");
  expect(range).toEqual(
    Result.succeed({
      from: Date.parse("2026-03-08T05:00:00Z"),
      to: Date.parse("2026-03-09T04:00:00Z"),
    }),
  );
  expect(Result.isFailure(rangeOf("2026-11-21", "2026-11-20", "America/Bogota"))).toBe(true);
  expect(
    eventTime(
      { dateTime: "2026-03-08T06:59:59Z" },
      { dateTime: "2026-03-08T07:00:00Z" },
      "America/New_York",
    ),
  ).toEqual({
    all_day: false,
    start: "2026-03-08T01:59:59-05:00",
    end: "2026-03-08T03:00:00-04:00",
  });
  expect(eventTime({ date: "2026-11-20" }, { date: "2026-11-22" }, "America/Bogota")).toEqual({
    all_day: true,
    start: "2026-11-20",
    end: "2026-11-22",
  });
  expect(viewTime("2026-11-20T20:00Z", "America/Bogota")).toBe(
    "Nov 20, 2026 at 15:00 (America/Bogota)",
  );
  expect(viewTime("2026-11-20", "Asia/Tokyo")).toBe("Nov 20, 2026 (all day)");
  expect(viewTime("1899-12-31T19:00:00-05:00", "America/New_York")).toBe(
    "Dec 31, 1899 at 19:00 (America/New_York)",
  );
});
