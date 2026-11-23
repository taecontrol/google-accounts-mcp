import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer, approve, get, page } from "./support/approvals";
import { eventsFixture } from "./support/calendar";
import { createEventCall, eventWriter, primaryList } from "./support/event-write";
import { expectError, PERSONAL } from "./support/permissions";

it.each([
  {
    args: { repeat: { every: "day", interval: 3, count: 10 } },
    line: "RRULE:FREQ=DAILY;INTERVAL=3;COUNT=10",
  },
  {
    args: {
      start: "2027-01-06T09:00",
      end: "2027-01-06T10:00",
      repeat: { every: "week" },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=WE",
  },
  {
    args: { repeat: { every: "week", interval: 2, weekdays: ["friday", "monday"] } },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;INTERVAL=2;BYDAY=MO,FR",
  },
  {
    args: {
      start: "2027-01-15T09:00",
      end: "2027-01-15T10:00",
      repeat: { every: "month" },
    },
    line: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
  },
  {
    args: { repeat: { every: "day", until: "2027-03-31" } },
    line: "RRULE:FREQ=DAILY;UNTIL=20270401T045959Z",
  },
  {
    args: {
      start: "2027-01-04T00:30",
      end: "2027-01-04T01:30",
      time_zone: "America/New_York",
      repeat: { every: "day", until: "2027-07-15" },
    },
    line: "RRULE:FREQ=DAILY;UNTIL=20270716T035959Z",
  },
  {
    args: {
      start: "2026-11-20",
      end: "2026-11-21",
      repeat: { every: "day", until: "2027-03-31" },
    },
    line: "RRULE:FREQ=DAILY;UNTIL=20270331",
  },
  {
    args: {
      start: "2026-11-23T10:00",
      end: "2026-11-23T11:00",
      guests: ["guest@example.com"],
      repeat: { every: "week", weekdays: ["monday", "wednesday"], count: 4 },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO,WE;COUNT=4",
  },
  {
    args: {
      start: "2027-01-31T09:00",
      end: "2027-01-31T10:00",
      repeat: { every: "month", count: 6 },
    },
    line: "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=6",
  },
  {
    args: {
      start: "2026-11-21T20:00",
      end: "2026-11-21T21:00",
      repeat: { every: "day", until: "2026-11-23" },
    },
    line: "RRULE:FREQ=DAILY;UNTIL=20261124T045959Z",
  },
  {
    args: {
      start: "2026-11-27T09:00",
      end: "2026-11-27T10:00",
      repeat: { every: "week", interval: 2, weekdays: ["friday", "monday"], count: 4 },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;INTERVAL=2;BYDAY=MO,FR;COUNT=4",
  },
  {
    args: {
      start: "2026-11-23",
      end: "2026-11-24",
      repeat: { every: "week", until: "2026-12-07" },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO;UNTIL=20261207",
  },
  {
    args: {
      start: "2027-09-01T23:30",
      end: "2027-09-01T23:45",
      time_zone: "America/Santiago",
      repeat: { every: "day", until: "2027-09-04" },
    },
    line: "RRULE:FREQ=DAILY;UNTIL=20270905T035959Z",
  },
  {
    args: { repeat: { every: "day", interval: 99, count: 730 } },
    line: "RRULE:FREQ=DAILY;INTERVAL=99;COUNT=730",
  },
  {
    args: { repeat: { every: "day", interval: 1, count: 1 } },
    line: "RRULE:FREQ=DAILY;COUNT=1",
  },
  {
    args: { repeat: { every: "day", until: "2026-11-20" } },
    line: "RRULE:FREQ=DAILY;UNTIL=20261121T045959Z",
  },
  {
    args: { repeat: { every: "day", until: "2999-12-31" } },
    line: "RRULE:FREQ=DAILY;UNTIL=30000101T045959Z",
  },
  {
    args: {
      start: "2026-11-24T01:00Z",
      end: "2026-11-24T02:00Z",
      repeat: { every: "week", weekdays: ["monday"], until: "2026-11-23" },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO;UNTIL=20261124T045959Z",
  },
  {
    args: {
      start: "2027-02-01T01:00Z",
      end: "2027-02-01T02:00Z",
      repeat: { every: "month", count: 3 },
    },
    line: "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
  },
  {
    args: {
      repeat: {
        every: "week",
        weekdays: ["sunday", "saturday", "friday", "thursday", "wednesday", "tuesday", "monday"],
      },
    },
    line: "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO,TU,WE,TH,FR,SA,SU",
  },
])("sends the exact recurrence through create_event: $line", async ({ args, line }) => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  const result = await answer(await createEventCall(f, args));
  expect(google.inserts).toHaveLength(1);
  expect(google.inserts[0]!.body.recurrence).toEqual([line]);
  expect(result.event).toBe(google.inserts[0]!.body.id);
});

it.each([
  { start: "2026-11-17T01:00:00Z", repeat: { every: "week", weekdays: ["tuesday"] } },
  { start: "2026-11-17T06:00:00Z", repeat: { every: "day", until: "2026-11-16" } },
])("refuses a primary-zone-dependent repeat with allow: %j", async ({ start, repeat }) => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  const end = new Date(Date.parse(start) + 3_600_000).toISOString().replace(".000Z", "Z");
  await expectError(
    await createEventCall(f, { start, end, repeat }),
    "invalid_arguments",
    /The repeat field/,
  );
  expect(google.inserts).toHaveLength(0);
});

it("creates and approves one all-day series, then returns it on an identical call", async () => {
  const f = await eventsFixture("create_event", "ask");
  primaryList();
  const google = eventWriter();
  const args = {
    start: "2026-11-23",
    end: "2026-11-24",
    repeat: { every: "week", until: "2026-12-07" },
  };
  const pending = await answer(await createEventCall(f, args));
  expect(await answer(await createEventCall(f, args))).toEqual(pending);
  const id = pending.approval as string;
  const view = await page(f, id);
  expect(view.request.values).toContainEqual({
    name: "Repeats",
    text: "Every week on Monday, until Dec 7, 2026 (that day included).",
    from: "agent",
  });
  expect(google.inserts).toHaveLength(0);
  await approve(f, id);
  const first = (await get(f, id)).result;
  expect(first).toMatchObject({ account: PERSONAL, calendar: PERSONAL, event: expect.any(String) });
  expect(google.inserts[0]!.body).toMatchObject({
    start: { date: "2026-11-23" },
    end: { date: "2026-11-24" },
    recurrence: ["RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO;UNTIL=20261207"],
  });
  expect(await answer(await createEventCall(f, args))).toMatchObject({
    ...(first as Record<string, unknown>),
    repeat_of: expect.any(String),
  });
  expect(google.inserts).toHaveLength(1);
});

it("names the weekday and zone when the primary zone moves start off the listed day", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  await expectError(
    await createEventCall(f, {
      start: "2026-11-17T01:00:00Z",
      end: "2026-11-17T02:00:00Z",
      repeat: { every: "week", weekdays: ["tuesday"] },
    }),
    "invalid_arguments",
    /Monday, the weekday of start \(2026-11-16\) in America\/Bogota/,
  );
  expect(google.inserts).toHaveLength(0);
});

it("sends the approved rule of a timed series", async () => {
  const f = await eventsFixture("create_event", "ask");
  primaryList();
  const google = eventWriter();
  const id = (
    await answer(
      await createEventCall(f, {
        start: "2026-11-21T20:00",
        end: "2026-11-21T21:00",
        repeat: { every: "day", until: "2026-11-23" },
      }),
    )
  ).approval as string;
  expect((await page(f, id)).request.values).toContainEqual({
    name: "Repeats",
    text: "Every day, until Nov 23, 2026 (that day included).",
    from: "agent",
  });
  await approve(f, id);
  expect(google.inserts).toHaveLength(1);
  expect(google.inserts[0]!.body).toMatchObject({
    start: { dateTime: "2026-11-21T20:00:00-05:00", timeZone: "America/Bogota" },
    recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261124T045959Z"],
  });
});
