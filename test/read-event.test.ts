import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
  readEventCall,
} from "./support/calendar";
import { callRows, expectError, PERSONAL } from "./support/permissions";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";

const list = (...items: object[]) => Response.json({ items });
const paths = () =>
  requests
    .filter((url) => url.startsWith("https://www.googleapis.com/calendar/v3/"))
    .map((url) => new URL(url).pathname);

it("reads a series with raw recurrence lines, guests without rooms, the primary self answer and Meet", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        series: Response.json(
          eventFixture({
            id: "series",
            status: "tentative",
            location: "Room 1",
            description: "Agenda",
            organizer: { email: "host@example.com" },
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261130T140000Z"],
            attendees: [
              {
                email: "alias@example.com",
                displayName: "Alex",
                self: true,
                responseStatus: "tentative",
                optional: true,
              },
              { email: "guest@example.com", responseStatus: "needsAction" },
              { email: "room@example.com", resource: true, responseStatus: "accepted" },
            ],
            hangoutLink: "https://meet.google.com/abc-defg-hij",
          }),
        ),
      },
    },
  });
  expect(await answer(await readEventCall(f, { event: "series" }))).toEqual({
    account: PERSONAL,
    calendar: PERSONAL,
    time_zone: "America/Bogota",
    event: "series",
    title: "Planning",
    start: "2026-11-20T09:00:00-05:00",
    end: "2026-11-20T10:00:00-05:00",
    all_day: false,
    location: "Room 1",
    description: "Agenda",
    organizer: "host@example.com",
    guests: [
      { email: "alias@example.com", name: "Alex", response: "tentative", optional: true },
      { email: "guest@example.com", response: "needs_action", optional: false },
    ],
    my_response: "tentative",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261130T140000Z"],
    meet: "https://meet.google.com/abc-defg-hij",
    status: "tentative",
    link: "https://calendar.google.com/calendar/event?eid=test",
  });
  expect(paths()).toEqual([
    "/calendar/v3/users/me/calendarList",
    `/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events/series`,
  ]);
  expect(new URL(sent[0]!.url).searchParams.get("timeZone")).toBe("America/Bogota");
  expect((await callRows()).at(-1)).toMatchObject({ outcome: "success", tool: "read_event" });
});

it("reads a moved occurrence using its new start, retains its series ID and maps working_location", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const id = "series_20261130T130000Z";
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      events: {
        [id]: Response.json(
          eventFixture({
            id,
            recurringEventId: "series",
            recurrence: ["MUST_NOT_RETURN"],
            originalStartTime: { dateTime: "2026-11-30T13:00:00Z" },
            start: { dateTime: "2026-11-30T16:00:00+01:00", timeZone: "Europe/Madrid" },
            end: { dateTime: "2026-11-30T17:00:00+01:00", timeZone: "Europe/Madrid" },
            eventType: "workingLocation",
          }),
        ),
      },
    },
  });
  const result = await answer(
    await readEventCall(f, { calendar: SECONDARY_CALENDAR.id, event: id, time_zone: "UTC" }),
  );
  expect(result).toMatchObject({
    time_zone: "UTC",
    start: "2026-11-30T15:00:00+00:00",
    end: "2026-11-30T16:00:00+00:00",
    series: "series",
    type: "working_location",
  });
  expect(result).not.toHaveProperty("recurrence");
  expect(new URL(sent[0]!.url).searchParams.get("timeZone")).toBe("UTC");
});

it("keeps all-day exclusive dates without turning them into timed events", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({ start: { date: "2026-09-06" }, end: { date: "2026-09-08" } }),
        ),
      },
    },
  });
  expect(await answer(await readEventCall(f, { time_zone: "America/Santiago" }))).toMatchObject({
    start: "2026-09-06",
    end: "2026-09-08",
    all_day: true,
    time_zone: "America/Santiago",
  });
});

it("converts the known Calendar editor tags to plain text with link targets", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  // The editor's output was not observed; these tags are the documented editor fixtures.
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            description:
              '<b>Bold</b><br><i>Italic</i> <u>Underlined</u><br><a href="https://example.com/agenda">Agenda</a><ul><li>First</li><li>Second</li></ul>',
          }),
        ),
      },
    },
  });
  expect((await answer(await readEventCall(f))).description).toBe(
    "Bold\nItalic Underlined\nAgenda (https://example.com/agenda)\n- First\n- Second",
  );
});

it("preserves plain descriptions with angle-bracket URLs and mailboxes", async () => {
  const f = await eventsFixture("read_event");
  const description = "Ana <ana@example.com>\nJoin <https://zoom.us/j/1> & bring notes";
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({ [PERSONAL]: { events: { e1: Response.json(eventFixture({ description })) } } });
  expect((await answer(await readEventCall(f))).description).toBe(description);
});

it("marks the observed hidden guest list without relying on attendeesOmitted", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            organizer: { email: "host@example.com" },
            guestsCanSeeOtherGuests: false,
            attendees: [{ email: PERSONAL, self: true, responseStatus: "accepted" }],
          }),
        ),
      },
    },
  });
  const result = await answer(await readEventCall(f));
  expect(result).toMatchObject({
    guests_hidden: true,
    my_response: "accepted",
    guests: [{ email: PERSONAL, response: "accepted", optional: false }],
  });
  expect(result).not.toHaveProperty("guests_left_out");
});

it.each([404, 410, "cancelled"])(
  "returns not_found for a missing or cancelled event: %s",
  async (status) => {
    const f = await eventsFixture("read_event");
    calendarFake(list(PRIMARY_CALENDAR));
    eventsFake({
      [PERSONAL]: {
        events: {
          e1:
            typeof status === "number"
              ? new Response(null, { status })
              : Response.json({ id: "e1", status: "cancelled" }),
        },
      },
    });
    await expectError(
      await readEventCall(f),
      "not_found",
      `No event "e1" exists in ${PERSONAL}. A event ID works only in the account that returned it.`,
    );
  },
);

it.each(["primary", "colleague@example.com", "public", "busy"])(
  "does not request events in calendar %s when it cannot be read",
  async (calendar) => {
    const f = await eventsFixture("read_event");
    calendarFake(list(PRIMARY_CALENDAR, { id: "busy", accessRole: "freeBusyReader" }));
    await expectError(
      await readEventCall(f, { calendar }),
      calendar === "busy" ? "invalid_arguments" : "not_found",
      calendar === "busy" ? /calendar field.*only busy times/ : /No such calendar/,
    );
    expect(paths()).toEqual(["/calendar/v3/users/me/calendarList"]);
  },
);

it("bounds escaped fields, guests and whole recurrence lines, with exact omitted counts and an MCP text result below 32,000 characters", async () => {
  const f = await eventsFixture("read_event");
  const calendar = '"'.repeat(254);
  const id = "e".repeat(1024);
  const guests = Array.from({ length: 100 }, (_, i) => ({
    email: `guest${i}@example.com`,
    displayName: '"\\\n😀'.repeat(250),
    responseStatus: "accepted",
  }));
  const recurrence = Array.from({ length: 10 }, (_, i) => `RULE${i}:${"r".repeat(994)}`);
  calendarFake(list(PRIMARY_CALENDAR, { id: calendar, accessRole: "reader" }));
  eventsFake({
    [calendar]: {
      events: {
        [id]: Response.json(
          eventFixture({
            id,
            summary: '"\\\n😀'.repeat(1000),
            location: '"'.repeat(1000),
            description: '"\\\n\t😀'.repeat(10_000),
            attendees: guests,
            recurrence,
          }),
        ),
      },
    },
  });
  const rpc = await rpcResult(await readEventCall(f, { calendar, event: id }));
  expect(rpc.isError).toBeUndefined();
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(text.length).toBeLessThanOrEqual(32_000);
  const result = JSON.parse(text) as Record<string, unknown>;
  expect(JSON.stringify(result.title).length).toBeLessThanOrEqual(1_000);
  expect(JSON.stringify(result.location).length).toBeLessThanOrEqual(1_000);
  expect(String(result.title)).toMatch(/…$/);
  expect(String(result.location)).toMatch(/…$/);
  expect(JSON.stringify(result.description).length).toBeLessThanOrEqual(10_000);
  expect(String(result.description)).toMatch(/\[The rest of the description was left out\.\]$/);
  const kept = result.guests as Array<Record<string, unknown>>;
  expect(kept.length).toBeGreaterThan(0);
  expect(JSON.stringify(kept).length).toBeLessThanOrEqual(8_000);
  expect(
    JSON.stringify([
      ...kept,
      {
        email: guests[kept.length]!.email,
        name: guests[kept.length]!.displayName,
        response: "accepted",
        optional: false,
      },
    ]).length,
  ).toBeGreaterThan(8_000);
  expect(result.guests_left_out).toBe(100 - kept.length);
  expect(result.recurrence).toEqual(recurrence.slice(0, 3));
  expect(result.recurrence_left_out).toBe(7);
  expect(JSON.stringify(result.recurrence).length).toBeLessThanOrEqual(4_000);
  expect(paths()).toEqual([
    "/calendar/v3/users/me/calendarList",
    `/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/${id}`,
  ]);
});

it.each([
  { field: "account", value: false },
  { field: "calendar", value: "" },
  { field: "calendar", value: "c".repeat(255) },
  { field: "event", value: "" },
  { field: "event", value: "." },
  { field: "event", value: ".." },
  { field: "event", value: "a/b" },
  { field: "event", value: "e".repeat(1025) },
  { field: "time_zone", value: "BST" },
])("refuses invalid $field before Google %#", async ({ field, value }) => {
  const f = await eventsFixture("read_event");
  await expectError(
    await readEventCall(f, { [field]: value }),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(paths()).toEqual([]);
});

it.each([
  new Response(null, { status: 503 }),
  new Response("not JSON"),
  Response.json({ id: "e1", status: "confirmed" }),
])("fails read_event on a Google refusal or malformed event %#", async (response) => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({ [PERSONAL]: { events: { e1: response } } });
  await expectError(await readEventCall(f), "google_unavailable", /Google could not complete/);
});
