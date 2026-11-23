import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { HttpResponse } from "msw";
import { answer } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  eventChangeCall,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
} from "./support/calendar";
import { callRows, expectError, PERSONAL } from "./support/permissions";
import { requests } from "./support/network";

const list = (...items: object[]) => Response.json({ items });
const call = (f: Awaited<ReturnType<typeof eventsFixture>>, args: Record<string, unknown> = {}) =>
  eventChangeCall(f, "update_event", args);
const setup = async (
  event: Record<string, unknown> = {},
  response = Response.json({ id: "e1", htmlLink: "https://calendar.google.com/changed" }),
) => {
  const f = await eventsFixture("update_event");
  calendarFake(list(PRIMARY_CALENDAR, { ...SECONDARY_CALENDAR, accessRole: "writer" }));
  const sent = eventsFake({
    [PERSONAL]: { events: { e1: Response.json(eventFixture(event)) }, patch: { e1: response } },
  });
  return { f, sent };
};

it.each([
  { field: "account", value: false },
  { field: "calendar", value: "c".repeat(255) },
  { field: "calendar", value: "team@example.com\nPersonal" },
  { field: "calendar", value: "team@example.com\u2028" },
  { field: "event", value: "e".repeat(1025) },
  { field: "event", value: "a/b" },
  { field: "title", value: "x".repeat(1001) },
  { field: "title", value: "" },
  { field: "title", value: "bad\ntext" },
  { field: "title", value: "bad\u0085text" },
  { field: "location", value: "bad\u0085place" },
  { field: "description", value: "bad\u0085text" },
  { field: "location", value: "x".repeat(1001) },
  { field: "location", value: "bad\tplace" },
  { field: "description", value: "x".repeat(8001) },
  { field: "description", value: "bad\u0000text" },
  { field: "description", value: "é".repeat(4001) },
  { field: "description", value: "<".repeat(2000) },
  { field: "start", value: "2026-02-30" },
  { field: "end", value: "3000-01-01" },
  { field: "start", value: "2026-11-20T15:00:01Z" },
  { field: "end", value: "2026-11-20T15:00:59" },
  { field: "start", value: "2026-11-20T15:00:00.000Z" },
  { field: "end", value: "2026-11-20T15:00:00.1" },
  { field: "time_zone", value: "BST" },
  ...["add_guests", "remove_guests"].flatMap((field) => [
    { field, value: Array.from({ length: 51 }, (_, i) => `g${i}@example.com`) },
    { field, value: ["Name <guest@example.com>"] },
    { field, value: ["missing-at"] },
    { field, value: ["a@example.com", "A@example.com"] },
  ]),
])("refuses invalid $field before Google %#", async ({ field, value }) => {
  const f = await eventsFixture("update_event", "ask");
  await expectError(
    await call(f, { title: "Changed", [field]: value }),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(requests.filter((url) => url.includes("/calendar/v3/"))).toEqual([]);
});

it.each([
  {},
  { add_guests: [], remove_guests: [] },
  { add_guests: ["guest@example.com"], remove_guests: ["GUEST@example.com"] },
])("refuses no requested change or overlapping guests before Google %#", async (args) => {
  const f = await eventsFixture("update_event");
  await expectError(
    await call(f, args),
    "invalid_arguments",
    args.remove_guests?.length ? /remove_guests/ : /./,
  );
  expect(requests.filter((url) => url.includes("/calendar/v3/"))).toEqual([]);
});

it.each([
  {
    field: "title",
    before: { summary: "Planning" },
    value: "New title",
    body: { summary: "New title" },
  },
  {
    field: "location",
    before: { location: "Room 1" },
    value: "Room 2",
    body: { location: "Room 2" },
  },
  {
    field: "description",
    before: { description: "<span>Old<br>notes</span>" },
    value: 'New & <notes>\n"quoted"\\',
    body: { description: '<span>New &amp; &lt;notes&gt;<br>"quoted"\\</span>' },
  },
  { field: "location", before: { location: "Room 1" }, value: "", body: { location: "" } },
  {
    field: "description",
    before: { description: "Old notes" },
    value: "",
    body: { description: "" },
  },
])(
  "sends only a changed $field, with notifications and the read etag %#",
  async ({ field, before, value, body }) => {
    const { f, sent } = await setup(before);
    expect(await answer(await call(f, { [field]: value }))).toEqual({
      account: PERSONAL,
      calendar: PERSONAL,
      event: "e1",
      link: "https://calendar.google.com/changed",
    });
    expect(sent.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(sent[1]!.body).toEqual(body);
    expect(sent[1]!.headers.get("If-Match")).toBe('"version-1"');
    expect(new URL(sent[1]!.url).searchParams.get("sendUpdates")).toBe("all");
  },
);

it("sends nothing when every requested value already matches, comparing descriptions as plain text", async () => {
  const { f, sent } = await setup({
    description: "<span>A &amp; B<br>Agenda</span>",
    attendees: [{ email: "Guest@example.com", responseStatus: "accepted" }],
  });
  expect(
    await answer(
      await call(f, {
        title: "Planning",
        location: "",
        description: "A & B\nAgenda",
        start: "2026-11-20T09:00",
        end: "2026-11-20T10:00:00-05:00",
        add_guests: ["guest@example.com"],
        remove_guests: ["absent@example.com"],
      }),
    ),
  ).toEqual({ account: PERSONAL, calendar: PERSONAL, event: "e1", link: eventFixture().htmlLink });
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});
it("does not patch an empty description when Google has none", async () => {
  const { f, sent } = await setup();
  await answer(await call(f, { description: "" }));
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it.each([
  {
    event: {},
    args: { start: "2026-11-20T11:00" },
    start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "America/Bogota", date: null },
    end: { dateTime: "2026-11-20T12:00:00-05:00", timeZone: "America/Bogota", date: null },
  },
  {
    event: { start: { date: "2026-11-20" }, end: { date: "2026-11-23" } },
    args: { start: "2026-11-27" },
    start: { date: "2026-11-27", dateTime: null, timeZone: null },
    end: { date: "2026-11-30", dateTime: null, timeZone: null },
  },
  {
    event: {},
    args: { end: "2026-11-20T11:00" },
    start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: "America/Bogota", date: null },
    end: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "America/Bogota", date: null },
  },
  {
    event: {},
    args: { start: "2026-11-22", end: "2026-11-24" },
    start: { date: "2026-11-22", dateTime: null, timeZone: null },
    end: { date: "2026-11-24", dateTime: null, timeZone: null },
  },
  {
    event: { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
    args: { start: "2026-11-20T11:00", end: "2026-11-20T12:00" },
    start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "America/Bogota", date: null },
    end: { dateTime: "2026-11-20T12:00:00-05:00", timeZone: "America/Bogota", date: null },
  },
  {
    event: {
      start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: "America/Bogota" },
      end: { dateTime: "2026-11-20T10:00:00-05:00", timeZone: "America/Bogota" },
    },
    args: { start: "2026-11-20T15:00", time_zone: "Europe/Madrid" },
    start: { dateTime: "2026-11-20T15:00:00+01:00", timeZone: "Europe/Madrid", date: null },
    end: { dateTime: "2026-11-20T16:00:00+01:00", timeZone: "Europe/Madrid", date: null },
  },
  {
    event: {
      start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-11-20T15:00:00Z", timeZone: "Europe/Madrid" },
    },
    args: { start: "2026-11-20T11:00" },
    start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "Europe/Madrid", date: null },
    end: { dateTime: "2026-11-20T12:00:00-05:00", timeZone: "Europe/Madrid", date: null },
  },
  {
    event: {
      start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "America/Bogota" },
      end: { dateTime: "2026-11-20T15:00:00Z", timeZone: "America/Bogota" },
    },
    args: { time_zone: "Europe/Madrid" },
    start: { dateTime: "2026-11-20T15:00:00+01:00", timeZone: "Europe/Madrid", date: null },
    end: { dateTime: "2026-11-20T16:00:00+01:00", timeZone: "Europe/Madrid", date: null },
  },
])(
  "changes whole time points, retaining the missing side and choosing the right zone %#",
  async ({ event, args, start, end }) => {
    const { f, sent } = await setup(event);
    await answer(await call(f, args));
    expect(sent[1]!.body).toEqual({ start, end });
  },
);

it("does not patch a time_zone equal to the event's own zone", async () => {
  const { f, sent } = await setup({
    start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "America/Bogota" },
    end: { dateTime: "2026-11-20T15:00:00Z", timeZone: "America/Bogota" },
  });
  await answer(await call(f, { time_zone: "America/Bogota" }));
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it.each([
  { event: {}, args: { end: "2026-11-20T09:00" }, field: "end" },
  { event: {}, args: { start: "2026-11-21" }, field: "end" },
  { event: {}, args: { end: "2026-11-21" }, field: "end" },
  {
    event: { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
    args: { start: "2026-11-21T09:00" },
    field: "end",
  },
  {
    event: { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
    args: { end: "2026-11-21T09:00" },
    field: "end",
  },
  {
    event: { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
    args: { time_zone: "UTC" },
    field: "time_zone",
  },
  {
    event: {},
    args: { start: "2026-11-21", end: "2026-11-22", time_zone: "UTC" },
    field: "time_zone",
  },
  { event: {}, args: { start: "2026-11-21", end: "2026-11-21T12:00" }, field: "end" },
  { event: {}, args: { start: "2026-11-21T10:00", end: "2026-11-21T09:00" }, field: "end" },
  { event: {}, args: { start: "2026-03-29T02:30", time_zone: "Europe/Madrid" }, field: "start" },
  {
    event: {},
    args: { start: "2026-03-29T01:30", end: "2026-03-29T02:30", time_zone: "Europe/Madrid" },
    field: "end",
  },
])("refuses invalid time changes without a write %#", async ({ event, args, field }) => {
  const { f, sent } = await setup(event);
  await expectError(await call(f, args), "invalid_arguments", new RegExp(`The ${field} field`));
  expect(sent.every((r) => r.method === "GET")).toBe(true);
});

it("retains duration across a DST transition without treating the computed end as a local input", async () => {
  const { f, sent } = await setup({ end: { dateTime: "2026-11-20T16:00:00Z" } });
  await answer(await call(f, { start: "2026-03-29T01:30", time_zone: "Europe/Madrid" }));
  expect(sent[1]!.body).toEqual({
    start: { dateTime: "2026-03-29T01:30:00+01:00", timeZone: "Europe/Madrid", date: null },
    end: { dateTime: "2026-03-29T04:30:00+02:00", timeZone: "Europe/Madrid", date: null },
  });
});

it.each([
  { title: "New title" },
  { location: "Room" },
  { description: "Notes" },
  { add_guests: ["guest@example.com"] },
  { remove_guests: ["guest@example.com"] },
  { start: "2026-11-21T09:00" },
  { end: "2026-11-21T10:00" },
  { time_zone: "UTC" },
  { time_zone: "America/Bogota" },
])("refuses every requested field on a whole series before writing %#", async (args) => {
  const { f, sent } = await setup({
    recurrence: ["RRULE:FREQ=WEEKLY"],
    start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "America/Bogota" },
  });
  await expectError(
    await call(f, args),
    "invalid_arguments",
    /event field.*whole series cannot be changed.*occurrences one at a time/,
  );
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it("patches an occurrence ID on a writable secondary calendar, never its series", async () => {
  const f = await eventsFixture("update_event");
  calendarFake(list(PRIMARY_CALENDAR, { ...SECONDARY_CALENDAR, accessRole: "writer" }));
  const id = "series_20261120T140000Z";
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      events: {
        [id]: Response.json(eventFixture({ id, recurringEventId: "series", recurrence: ["RULE"] })),
      },
      patch: { [id]: Response.json({ id, htmlLink: "changed" }) },
    },
  });
  await answer(await call(f, { calendar: SECONDARY_CALENDAR.id, event: id, title: "Occurrence" }));
  expect(new URL(sent[1]!.url).pathname).toBe(
    `/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events/${id}`,
  );
  expect(sent[1]!.body).toEqual({ summary: "Occurrence" });
});

it("replaces only the changed guest set and preserves every field of rooms, self and retained attendees", async () => {
  const retained = {
    email: "Stay@example.com",
    responseStatus: "accepted",
    comment: "Thanks",
    additionalGuests: 2,
    optional: true,
    displayName: "Guest",
    id: "guest-id",
    unknownKey: { nested: [1, true] },
  };
  const room = { email: "room@example.com", resource: true, responseStatus: "accepted" };
  const self = { email: PERSONAL.toUpperCase(), self: true, responseStatus: "accepted" };
  const { f, sent } = await setup({
    attendees: [retained, { email: "remove@example.com", responseStatus: "tentative" }, room, self],
  });
  await answer(
    await call(f, {
      add_guests: ["stay@example.com", "new@example.com"],
      remove_guests: ["REMOVE@example.com", "absent@example.com"],
    }),
  );
  expect(sent[1]!.body).toEqual({
    attendees: [retained, room, self, { email: "new@example.com" }],
  });
});

it.each(
  ["add_guests", "remove_guests"].flatMap((field) =>
    [
      { address: PERSONAL.toUpperCase(), event: {}, expectedField: field },
      {
        address: "alias@example.com",
        event: { attendees: [{ email: "Alias@example.com", self: true }] },
        expectedField: field,
      },
      {
        address: "ROOM@example.com",
        event: { attendees: [{ email: "room@example.com", resource: true }] },
        expectedField: field,
      },
      { address: "guest@example.com", event: { attendeesOmitted: true }, expectedField: "event" },
    ].map((entry) => ({ field, ...entry })),
  ),
)(
  "refuses own addresses, self aliases, rooms and cut lists in $field %#",
  async ({ field, address, event, expectedField }) => {
    const { f, sent } = await setup(event);
    await expectError(
      await call(f, { [field]: [address] }),
      "invalid_arguments",
      new RegExp(`The ${expectedField} field`),
    );
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  },
);

it("leaves attendees out of a field-only patch when requested guest changes do nothing", async () => {
  const { f, sent } = await setup({
    attendees: [{ email: "guest@example.com", comment: "Preserve" }],
  });
  await answer(
    await call(f, {
      title: "Changed",
      add_guests: ["GUEST@example.com"],
      remove_guests: ["absent@example.com"],
    }),
  );
  expect(sent[1]!.body).toEqual({ summary: "Changed" });
});

it.each([500, "aborted", "unreadable"] as const)(
  "reports a possibly applied change after a lost %s answer and keeps the audit unknown",
  async (status) => {
    const { f, sent } = await setup(
      {},
      status === "aborted"
        ? HttpResponse.error()
        : status === "unreadable"
          ? new Response("not JSON")
          : new Response(null, { status }),
    );
    await expectError(
      await call(f, { title: "Changed" }),
      "google_unavailable",
      /change may have been made.*Calling again is safe/,
    );
    expect(sent.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect((await callRows()).at(-1)!.outcome).toBeNull();
  },
);

it("treats a stale If-Match as a known failure with safe retry advice", async () => {
  const { f, sent } = await setup({}, new Response(null, { status: 412 }));
  await expectError(
    await call(f, { title: "Changed" }),
    "google_unavailable",
    /event changed in Google.*Nothing was changed.*Calling again is safe/,
  );
  expect(sent[1]!.headers.get("If-Match")).toBe('"version-1"');
  expect((await callRows()).at(-1)).toMatchObject({
    outcome: "failed",
    reason: "google_unavailable",
  });
});

it("accepts the exact text and guest limits, counting description encoding before Google", async () => {
  const { f, sent } = await setup();
  const description = '"\t\\' + "x".repeat(7994);
  const title = "t".repeat(1000);
  const location = "l".repeat(1000);
  const guests = Array.from({ length: 50 }, (_, i) => `g${i}@example.com`);
  await answer(await call(f, { title, location, description, add_guests: guests }));
  expect(sent[1]!.body).toEqual({
    summary: title,
    location,
    description,
    attendees: guests.map((email) => ({ email })),
  });
});

it.each([
  { description: "A & B\nAgenda", storedDescription: "<span>A &amp; B<br>Agenda</span>" },
  { description: "<b>", storedDescription: "<span>&lt;b&gt;</span>" },
])(
  "a retry after a changed description sends no second patch or guest email: $description",
  async ({ description, storedDescription }) => {
    const f = await eventsFixture("update_event");
    calendarFake(list(PRIMARY_CALENDAR), list(PRIMARY_CALENDAR));
    let changed = false;
    const sent = eventsFake({
      [PERSONAL]: {
        events: {
          e1: () =>
            Response.json(
              eventFixture(
                changed
                  ? {
                      summary: "Changed",
                      description: storedDescription,
                      attendees: [{ email: "new@example.com" }],
                      etag: '"version-2"',
                    }
                  : {},
              ),
            ),
        },
        patch: {
          e1: () => {
            changed = true;
            return HttpResponse.error();
          },
        },
      },
    });
    const args = { title: "Changed", description, add_guests: ["new@example.com"] };
    await expectError(
      await call(f, args),
      "google_unavailable",
      /change may have been made.*Calling again is safe/,
    );
    expect(await answer(await call(f, args))).toEqual({
      account: PERSONAL,
      calendar: PERSONAL,
      event: "e1",
      link: eventFixture().htmlLink,
    });
    expect(sent.map((r) => r.method)).toEqual(["GET", "PATCH", "GET"]);
  },
);

it.each([
  {
    args: { start: "2026-11-20T11:00" },
    start: "2026-11-20T11:00:00-05:00",
    end: "2026-11-20T11:00:31.250-05:00",
    zone: "America/Bogota",
  },
  {
    args: { time_zone: "Europe/Madrid" },
    start: "2026-11-20T15:00:30.500+01:00",
    end: "2026-11-20T15:01:01.750+01:00",
    zone: "Europe/Madrid",
  },
])(
  "preserves the instants and duration of fractional times read from Google %#",
  async ({ args, start, end, zone }) => {
    const { f, sent } = await setup({
      start: { dateTime: "2026-11-20T14:00:30.500Z" },
      end: { dateTime: "2026-11-20T14:01:01.750Z" },
    });
    await answer(await call(f, args));
    expect(sent[1]!.body).toEqual({
      start: { dateTime: start, timeZone: zone, date: null },
      end: { dateTime: end, timeZone: zone, date: null },
    });
  },
);

it.each([
  {
    startZone: "europe/madrid",
    endZone: "America/New_York",
    expectedStart: "Europe/Madrid",
    expectedEnd: "America/New_York",
  },
  {
    startZone: "Europe/Madrid",
    endZone: undefined,
    expectedStart: "Europe/Madrid",
    expectedEnd: "America/Bogota",
  },
  {
    startZone: undefined,
    endZone: "Europe/Madrid",
    expectedStart: "America/Bogota",
    expectedEnd: "Europe/Madrid",
  },
])(
  "retains each point's canonical own zone, falling back separately to the call zone %#",
  async ({ startZone, endZone, expectedStart, expectedEnd }) => {
    const { f, sent } = await setup({
      start: { dateTime: "2026-11-20T14:00:00Z", timeZone: startZone },
      end: { dateTime: "2026-11-20T15:00:00Z", timeZone: endZone },
    });
    await answer(await call(f, { start: "2026-11-20T11:00" }));
    expect(sent[1]!.body).toEqual({
      start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: expectedStart, date: null },
      end: { dateTime: "2026-11-20T12:00:00-05:00", timeZone: expectedEnd, date: null },
    });
  },
);

it.each(["Europe/Madrid", undefined])(
  "changes both point zones even when time_zone already equals only the start's zone: %s",
  async (endZone) => {
    const { f, sent } = await setup({
      start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-20T15:00:00Z", timeZone: endZone },
    });
    await answer(await call(f, { time_zone: "UTC" }));
    expect(sent.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(sent[1]!.body).toEqual({
      start: { dateTime: "2026-11-20T14:00:00+00:00", timeZone: "UTC", date: null },
      end: { dateTime: "2026-11-20T15:00:00+00:00", timeZone: "UTC", date: null },
    });
  },
);

it("writes an explicitly requested time_zone with its canonical spelling", async () => {
  const { f, sent } = await setup();
  await answer(await call(f, { start: "2026-11-20T16:00", time_zone: "europe/madrid" }));
  expect(sent[1]!.body).toEqual({
    start: { dateTime: "2026-11-20T16:00:00+01:00", timeZone: "Europe/Madrid", date: null },
    end: { dateTime: "2026-11-20T17:00:00+01:00", timeZone: "Europe/Madrid", date: null },
  });
});

it("sends no patch when only the spelling of time_zone differs from the event zones", async () => {
  const { f, sent } = await setup({
    start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "Europe/Madrid" },
    end: { dateTime: "2026-11-20T15:00:00Z", timeZone: "Europe/Madrid" },
  });
  await answer(await call(f, { time_zone: "europe/madrid" }));
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it.each(["A\t<b>", "A  <b>", "A<b>\n"])(
  "refuses a description that would lose characters through HTML: %j",
  async (description) => {
    const { f, sent } = await setup();
    await expectError(
      await call(f, { description }),
      "invalid_arguments",
      /description field.*Google Calendar can keep exactly/,
    );
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  },
);

it.each([
  {
    args: { end: "2026-11-20T12:00" },
    start: "2026-11-20T09:00:00-05:00",
    end: "2026-11-20T12:00:00-05:00",
    zone: "Europe/Madrid",
  },
  {
    args: { time_zone: "UTC" },
    start: "2026-11-20T14:00:00+00:00",
    end: "2026-11-20T15:00:00+00:00",
    zone: "UTC",
  },
])(
  "keeps floating event times at their original instants when retaining a read point %#",
  async ({ args, start, end, zone }) => {
    const { f, sent } = await setup({
      start: { dateTime: "2026-11-20T15:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-11-20T16:00", timeZone: "Europe/Madrid" },
    });
    await answer(await call(f, args));
    expect(sent[1]!.body).toEqual({
      start: { dateTime: start, timeZone: zone, date: null },
      end: { dateTime: end, timeZone: zone, date: null },
    });
  },
);
