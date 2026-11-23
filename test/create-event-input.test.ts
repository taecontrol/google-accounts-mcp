import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer, rows } from "./support/approvals";
import { eventsFixture } from "./support/calendar";
import { createEventCall, eventWriter, primaryList, repeatCalendars } from "./support/event-write";
import { PRIMARY_CALENDAR } from "./support/calendar";
import { expectError, PERSONAL } from "./support/permissions";
import { readEventCall } from "./support/calendar";
import { setTool } from "./support/uploads";

it.each([false, true])("keeps the exact insert request bytes, Meet: %s", async (meet) => {
  const f = await eventsFixture("create_event");
  const calendar = "team+calendar@example.com";
  repeatCalendars({ ...PRIMARY_CALENDAR, id: calendar });
  const google = eventWriter();
  await answer(
    await createEventCall(f, {
      calendar,
      location: "Room 1",
      description: "a <b> c & d\nNext",
      guests: ["Guest@Example.com"],
      repeat: { every: "day", count: 2 },
      meet,
    }),
  );
  const insert = google.inserts[0]!;
  expect(insert.request.url).toBe(
    `https://www.googleapis.com/calendar/v3/calendars/team%2Bcalendar%40example.com/events?${meet ? "conferenceDataVersion=1&" : ""}sendUpdates=all`,
  );
  expect(insert.request.method).toBe("POST");
  expect(insert.request.redirect).toBe("manual");
  expect([...insert.request.headers.keys()].sort()).toEqual(["authorization", "content-type"]);
  expect(insert.request.headers.get("Authorization")).toMatch(/^Bearer /);
  expect(insert.request.headers.get("Content-Type")).toBe("application/json");
  expect(insert.bodyText).toBe(
    `{"id":"${String(insert.body.id)}","summary":"Planning","start":{"dateTime":"2026-11-20T09:00:00-05:00","timeZone":"America/Bogota"},"end":{"dateTime":"2026-11-20T10:00:00-05:00","timeZone":"America/Bogota"},"recurrence":["RRULE:FREQ=DAILY;COUNT=2"],"location":"Room 1","description":"<span>a &lt;b&gt; c &amp; d<br>Next</span>","attendees":[{"email":"Guest@Example.com"}]${meet ? `,"conferenceData":{"createRequest":{"requestId":"${String(insert.body.id)}","conferenceSolutionKey":{"type":"hangoutsMeet"}}}` : ""}}`,
  );
});

it.each([
  { title: "Planning\n" },
  { calendar: "team@example.com\nPersonal" },
  { calendar: "team@example.com\u2028" },
  { location: "Room\n" },
  { guests: ["guest@example.com\n"] },
  { start: "2026-11-20T09:00\n" },
  { title: "" },
  { title: "x".repeat(1001) },
  { title: "hidden\u0000" },
  { title: "hidden\u0085" },
  { location: "x".repeat(1001) },
  { location: "a\nb" },
  { description: "x".repeat(8001) },
  { description: "é".repeat(4001) },
  { description: "a\rb" },
  { description: "a\u0000b" },
  { description: '"'.repeat(4001) },
  { description: "\\".repeat(4001) },
  { description: "<".repeat(2000) },
  { description: "&\na".repeat(900) },
  { guests: Array.from({ length: 51 }, (_, i) => `guest${i}@example.com`) },
  { guests: ["guest@example.com", "GUEST@EXAMPLE.COM"] },
  { guests: [PERSONAL.toUpperCase()] },
  ...[
    "mail",
    "@example.com",
    "a@",
    "a@example",
    "a@@example.com",
    "Name <a@example.com>",
    "Name<a@example.com>",
    "a @example.com",
    "a@exam\u200bple.com",
    "a@exam\u0000ple.com",
    `${"a".repeat(244)}@example.com`,
  ].map((address) => ({ guests: [address] })),
  { end: "2026-11-20" },
  { start: "2026-11-20", end: "2026-11-21", time_zone: "UTC" },
  { end: "2026-11-20T09:00" },
  { end: "2026-11-20T08:00" },
  { start: "2026-11-21", end: "2026-11-20" },
  { start: "2026-11-20T09:00:01" },
  { end: "2026-11-20T10:00:59Z" },
  { start: "2026-11-20T09:00:00.000" },
  { end: "2026-11-20T10:00:00.001Z" },
  { duplicate: 1 },
  { duplicate: 101 },
  { meet: "true" },
  { unexpected: true },
])("refuses invalid input before any Google request: %j", async (args) => {
  const f = await eventsFixture("create_event", "ask");
  const lists = primaryList();
  const google = eventWriter();
  const field =
    "unexpected" in args
      ? "unexpected"
      : "start" in args && "end" in args
        ? "time_zone" in args
          ? "time_zone"
          : "end"
        : Object.keys(args)[0]!;
  await expectError(
    await createEventCall(f, args),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(lists).toHaveLength(0);
  expect(google.inserts).toHaveLength(0);
});

it.each([
  { repeat: null },
  { repeat: "week" },
  { repeat: {} },
  { repeat: { every: "year" } },
  { repeat: { every: "DAY" } },
  ...[0, 100, 1.5, "2"].map((interval) => ({ repeat: { every: "day", interval } })),
  ...[0, 731, 1.5, "2"].map((count) => ({ repeat: { every: "day", count } })),
  ...[[], ["Friday"], ["fri"], ["friday", "friday"], ["monday"], "friday"].map((weekdays) => ({
    repeat: { every: "week", weekdays },
  })),
  { repeat: { every: "week", weekdays: [...Array<string>(7).fill("monday"), "friday"] } },
  { repeat: { every: "day", weekdays: ["friday"] } },
  { repeat: { every: "month", weekdays: ["friday"] } },
  ...[
    "2026-11-19",
    "2026-11-20T10:00",
    "2026-11-20\n",
    "2026-02-30",
    "3000-01-01",
    "2026-1-20",
  ].map((until) => ({
    repeat: { every: "day", until },
  })),
  { repeat: { every: "day", until: "2026-11-20", count: 1 } },
  { repeat: { every: "day", extra: true } },
  {
    start: "2026-11-20",
    end: "2026-11-21",
    repeat: { every: "week", weekdays: ["thursday"] },
  },
  {
    start: "2026-11-20",
    end: "2026-11-21",
    repeat: { every: "day", until: "2026-11-19" },
  },
  {
    start: "2026-11-17T01:00Z",
    end: "2026-11-17T02:00Z",
    time_zone: "America/Bogota",
    repeat: { every: "week", weekdays: ["tuesday"] },
  },
  {
    start: "2026-11-17T23:00-05:00",
    end: "2026-11-18T00:00-05:00",
    time_zone: "Asia/Tokyo",
    repeat: { every: "day", until: "2026-11-17" },
  },
  {
    start: "2026-11-17T12:00Z",
    end: "2026-11-17T13:00Z",
    repeat: { every: "day", until: "2020-01-01" },
  },
  {
    start: "2026-11-17T12:00Z",
    end: "2026-11-17T13:00Z",
    repeat: { every: "week", weekdays: ["friday"] },
  },
])("refuses invalid repeat before any approval or Google request: %j", async (args) => {
  const f = await eventsFixture("create_event", "ask");
  const lists = primaryList();
  const google = eventWriter();
  await expectError(await createEventCall(f, args), "invalid_arguments", /The repeat field/);
  expect(await rows()).toEqual([]);
  expect(lists).toHaveLength(0);
  expect(google.inserts).toHaveLength(0);
});

it.each([
  {
    args: { start: "2026-11-20T14:00Z", end: "2026-11-20T08:00" },
    field: "end",
    text: /after start/,
  },
  {
    args: { start: "2026-03-08T02:30", end: "2026-03-08T04:00", time_zone: "America/New_York" },
    field: "start",
    text: /does not exist in America\/New_York; give another time or an offset/,
  },
  {
    args: { start: "2026-03-08T01:30", end: "2026-03-08T02:30", time_zone: "America/New_York" },
    field: "end",
    text: /does not exist in America\/New_York/,
  },
])("refuses a zone-dependent $field before the insert", async ({ args, field, text }) => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  await expectError(await createEventCall(f, args), "invalid_arguments", text);
  expect(google.inserts).toHaveLength(0);
  await expectError(
    await createEventCall(f, args),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
});

it.each([
  {
    args: {},
    start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: "America/Bogota" },
    end: { dateTime: "2026-11-20T10:00:00-05:00", timeZone: "America/Bogota" },
  },
  {
    args: { time_zone: "Asia/Tokyo", start: "2026-11-20T14:00Z", end: "2026-11-20T15:00Z" },
    start: { dateTime: "2026-11-20T23:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-11-21T00:00:00+09:00", timeZone: "Asia/Tokyo" },
  },
  {
    args: { time_zone: "US/Eastern", start: "2026-11-20T09:00", end: "2026-11-20T10:00" },
    start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-20T10:00:00-05:00", timeZone: "America/New_York" },
  },
  {
    args: { start: "2026-11-20", end: "2026-11-21" },
    start: { date: "2026-11-20" },
    end: { date: "2026-11-21" },
  },
  {
    args: {
      start: "2026-03-08T02:30-05:00",
      end: "2026-03-08T04:00-04:00",
      time_zone: "America/New_York",
    },
    start: { dateTime: "2026-03-08T03:30:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-03-08T04:00:00-04:00", timeZone: "America/New_York" },
  },
])("sends Google's exact timed or all-day points: $args", async ({ args, start, end }) => {
  const f = await eventsFixture("create_event");
  const lists = primaryList();
  const google = eventWriter();
  await answer(await createEventCall(f, args));
  expect(lists).toHaveLength(1);
  const insert = google.inserts[0]!;
  expect(insert.body).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{32}$/),
    summary: "Planning",
    start,
    end,
  });
  expect(new URL(insert.request.url).searchParams.get("sendUpdates")).toBe("all");
  expect(new URL(insert.request.url).searchParams.has("conferenceDataVersion")).toBe(false);
});

it("accepts the field limits and sends the guests exactly as given", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  const guests = Array.from({ length: 50 }, (_, i) => `Guest${i}@Example.com`);
  await answer(
    await createEventCall(f, {
      title: "x".repeat(1000),
      location: "y".repeat(1000),
      description: '"'.repeat(4000),
      guests,
      duplicate: 100,
    }),
  );
  expect(google.inserts[0]!.body).toMatchObject({
    summary: "x".repeat(1000),
    location: "y".repeat(1000),
    description: '"'.repeat(4000),
    attendees: guests.map((email) => ({ email })),
  });
});

it.each([
  { text: "Plain text", sent: "Plain text" },
  {
    text: "  Agenda:\n\n1.\tBudget  review\n2. Plan ",
    sent: "  Agenda:\n\n1.\tBudget  review\n2. Plan ",
  },
  { text: "a <b> c & d\nNext", sent: "<span>a &lt;b&gt; c &amp; d<br>Next</span>" },
  { text: "a > b", sent: "<span>a &gt; b</span>" },
  { text: "literal &amp; and &#38;", sent: "<span>literal &amp;amp; and &amp;#38;</span>" },
])("sends $text as plain text and read_event returns it exactly", async ({ text, sent }) => {
  const f = await eventsFixture("create_event");
  await setTool(f, "read_event", "allow");
  primaryList();
  const google = eventWriter();
  const result = await answer(await createEventCall(f, { description: text }));
  expect(google.inserts[0]!.body.description).toBe(sent);
  expect((await answer(await readEventCall(f, { event: result.event }))).description).toBe(text);
});

it.each(["a <b>  c", "a & b\tc", " a <b>", "a <b>\n"])(
  "refuses a description whose HTML round trip changes characters: %j",
  async (description) => {
    const f = await eventsFixture("create_event");
    primaryList();
    const google = eventWriter();
    await expectError(
      await createEventCall(f, { description }),
      "invalid_arguments",
      /The description field.*remove/,
    );
    expect(google.inserts).toHaveLength(0);
  },
);
