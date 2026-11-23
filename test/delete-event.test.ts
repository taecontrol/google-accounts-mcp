import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { HttpResponse } from "msw";
import { answer } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  eventChangeCall,
  readEventCall,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
} from "./support/calendar";
import { callRows, expectError, PERSONAL } from "./support/permissions";
import { requests } from "./support/network";
import { NOW } from "./support/accounts";
import { observeStatements } from "./support/db";
import { setTool } from "./support/uploads";
import { testEnv } from "./support/worker";

const list = (...items: object[]) => Response.json({ items });
const tools = ["update_event", "delete_event"] as const;

it.each(tools)(
  "%s sends no write when the setting turns deny after the plan's reads",
  async (tool) => {
    const f = await eventsFixture(tool, "allow");
    await setTool(f, "list_calendars", "allow");
    calendarFake(list(PRIMARY_CALENDAR));
    const sent = eventsFake({
      [PERSONAL]: {
        events: { e1: Response.json(eventFixture()) },
        patch: { e1: Response.json({ id: "e1" }) },
        delete: { e1: new Response(null, { status: 204 }) },
      },
    });
    let checks = 0;
    const db = observeStatements(env.DB, async (sql) => {
      if (/AS ask\s+FROM accounts a/.test(sql) && ++checks === 2) {
        expect(sent.map((request) => request.method)).toEqual(["GET"]);
        await setTool(f, tool, "deny");
      }
    });
    await expectError(
      await eventChangeCall(
        f,
        tool,
        tool === "update_event" ? { title: "Changed" } : {},
        testEnv({ DB: db }),
      ),
      "tool_not_allowed",
      /has not allowed/,
    );
    expect(checks).toBe(2);
    expect(sent.map((request) => request.method)).toEqual(["GET"]);
  },
);

it.each([
  { field: "account", value: false },
  { field: "calendar", value: "c".repeat(255) },
  { field: "calendar", value: "team@example.com\nPersonal" },
  { field: "calendar", value: "team@example.com\u2028" },
  { field: "event", value: "e".repeat(1025) },
  { field: "event", value: "a/b" },
])("refuses an invalid delete $field before Google %#", async ({ field, value }) => {
  const f = await eventsFixture("delete_event", "ask");
  await expectError(
    await eventChangeCall(f, "delete_event", { [field]: value }),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(requests.filter((url) => url.includes("/calendar/v3/"))).toEqual([]);
});

it.each(
  tools.flatMap((tool) =>
    ["primary", "unlisted", "reader", "busy"].map((calendar) => ({ tool, calendar })),
  ),
)("$tool refuses $calendar without any event request", async ({ tool, calendar }) => {
  const f = await eventsFixture(tool);
  calendarFake(
    list(
      PRIMARY_CALENDAR,
      { id: "reader", accessRole: "reader" },
      { id: "busy", accessRole: "freeBusyReader" },
    ),
  );
  await expectError(
    await eventChangeCall(f, tool, {
      calendar,
      ...(tool === "update_event" ? { title: "Changed" } : {}),
    }),
    ["reader", "busy"].includes(calendar) ? "invalid_arguments" : "not_found",
    ["reader", "busy"].includes(calendar) ? /calendar field/ : /No such calendar/,
  );
  expect(requests.filter((url) => new URL(url).pathname.includes("/events"))).toEqual([]);
});

it.each(tools.flatMap((tool) => [404, 410, "cancelled"].map((status) => ({ tool, status }))))(
  "$tool reports a gone or cancelled event as not_found: $status",
  async ({ tool, status }) => {
    const f = await eventsFixture(tool);
    calendarFake(list(PRIMARY_CALENDAR));
    const sent = eventsFake({
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
      await eventChangeCall(f, tool, tool === "update_event" ? { title: "Changed" } : {}),
      "not_found",
      /No event "e1"/,
    );
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  },
);

it.each(
  tools.flatMap((tool) =>
    [
      {
        event: { organizer: { email: "host@example.com" } },
        message: /event field.*guest.*respond_to_event/,
      },
      {
        event: { organizer: { email: "host@example.com", self: false } },
        message: /event field.*guest.*respond_to_event/,
      },
      { event: { organizer: undefined }, message: /event field.*cannot tell who organizes/ },
      ...["outOfOffice", "focusTime", "birthday", "fromGmail", "workingLocation", "futureKind"].map(
        (eventType) => ({
          event: { eventType },
          message: /event field.*only regular events can be changed or deleted/,
        }),
      ),
    ].map((refusal) => ({ tool, ...refusal })),
  ),
)(
  "$tool refuses a guest's copy, missing organizer or special kind %#",
  async ({ tool, event, message }) => {
    const f = await eventsFixture(tool);
    calendarFake(list(PRIMARY_CALENDAR));
    const sent = eventsFake({ [PERSONAL]: { events: { e1: Response.json(eventFixture(event)) } } });
    await expectError(
      await eventChangeCall(f, tool, tool === "update_event" ? { title: "Changed" } : {}),
      "invalid_arguments",
      message,
    );
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  },
);

it.each(
  tools.flatMap((tool) =>
    [
      new Response(null, { status: 503 }),
      new Response("not JSON"),
      Response.json(eventFixture({ etag: undefined })),
      Response.json(eventFixture({ attendees: [{ displayName: "Missing email" }] })),
      Response.json(eventFixture({ start: { date: "2026-11-20" } })),
    ].map((response) => ({ tool, response })),
  ),
)("$tool fails closed on an unavailable or malformed read %#", async ({ tool, response }) => {
  const f = await eventsFixture(tool);
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({ [PERSONAL]: { events: { e1: response } } });
  await expectError(
    await eventChangeCall(f, tool, tool === "update_event" ? { title: "Changed" } : {}),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it.each([false, true])("deletes exactly the named event, occurrence: %s", async (occurrence) => {
  const f = await eventsFixture("delete_event");
  calendarFake(list(PRIMARY_CALENDAR, { ...SECONDARY_CALENDAR, accessRole: "writer" }));
  const id = occurrence ? "series_20261120T140000Z" : "e1";
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      events: {
        [id]: Response.json(
          eventFixture({
            id,
            eventType: "default",
            ...(occurrence ? { recurringEventId: "series" } : {}),
          }),
        ),
      },
      delete: { [id]: new Response(null, { status: 204 }) },
    },
  });
  expect(
    await answer(
      await eventChangeCall(f, "delete_event", { calendar: SECONDARY_CALENDAR.id, event: id }),
    ),
  ).toEqual({ account: PERSONAL, calendar: SECONDARY_CALENDAR.id, event: id });
  expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE"]);
  expect(new URL(sent[1]!.url).pathname).toBe(
    `/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events/${id}`,
  );
  expect(new URL(sent[1]!.url).searchParams.get("sendUpdates")).toBe("all");
  expect(sent[1]!.headers.get("If-Match")).toBe('"version-1"');
  expect(sent[1]!.body).toBeUndefined();
});

it("a repeated delete reads cancelled and returns not_found without a second write", async () => {
  const f = await eventsFixture("delete_event");
  calendarFake(list(PRIMARY_CALENDAR), list(PRIMARY_CALENDAR));
  let deleted = false;
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        e1: () => Response.json(deleted ? { id: "e1", status: "cancelled" } : eventFixture()),
      },
      delete: {
        e1: () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
      },
    },
  });
  await answer(await eventChangeCall(f, "delete_event"));
  await expectError(await eventChangeCall(f, "delete_event"), "not_found", /No event/);
  expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE", "GET"]);
});

it.each(["past start", "moved before now", "future"])(
  "checks a whole series before deleting: %s",
  async (kind) => {
    const f = await eventsFixture("delete_event");
    calendarFake(list(PRIMARY_CALENDAR));
    const past = kind === "past start";
    const sent = eventsFake({
      [PERSONAL]: {
        events: {
          series: Response.json(
            eventFixture({
              id: "series",
              recurrence: ["RRULE:FREQ=WEEKLY"],
              start: { dateTime: past ? "2030-11-08T14:00:00Z" : "2030-11-20T14:00:00Z" },
              end: { dateTime: past ? "2030-11-08T15:00:00Z" : "2030-11-20T15:00:00Z" },
            }),
          ),
        },
        instances: {
          series: list(
            ...(kind === "moved before now"
              ? [{ id: "series_20301120T140000Z", start: { dateTime: "2030-11-08T14:00:00Z" } }]
              : []),
          ),
        },
        delete: { series: new Response(null, { status: 204 }) },
      },
    });
    const response = await eventChangeCall(f, "delete_event", { event: "series" });
    if (kind === "future")
      expect(await answer(response)).toEqual({
        account: PERSONAL,
        calendar: PERSONAL,
        event: "series",
      });
    else
      await expectError(
        response,
        "invalid_arguments",
        /event field.*series has occurrences in the past.*This and following events/,
      );
    expect(sent.map((r) => r.method)).toEqual(
      past ? ["GET"] : kind === "future" ? ["GET", "GET", "DELETE"] : ["GET", "GET"],
    );
    if (!past) {
      const url = new URL(sent[1]!.url);
      expect(url.pathname).toBe(
        `/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events/series/instances`,
      );
      expect(url.searchParams.get("timeMax")).toBe(new Date(NOW).toISOString());
      expect(url.searchParams.get("maxResults")).toBe("1");
      expect(url.searchParams.get("showDeleted")).toBe("false");
    }
  },
);

it.each([500, "aborted", "unreadable"] as const)(
  "reports an uncertain delete after %s with later-not_found advice",
  async (status) => {
    const f = await eventsFixture("delete_event");
    calendarFake(list(PRIMARY_CALENDAR));
    const sent = eventsFake({
      [PERSONAL]: {
        events: { e1: Response.json(eventFixture()) },
        delete: {
          e1:
            status === "aborted"
              ? HttpResponse.error()
              : status === "unreadable"
                ? new Response("not JSON")
                : new Response(null, { status }),
        },
      },
    });
    await expectError(
      await eventChangeCall(f, "delete_event"),
      "google_unavailable",
      /later.*not_found.*event is gone/,
    );
    expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE"]);
    expect((await callRows()).at(-1)!.outcome).toBeNull();
  },
);

it("rejects a series starting exactly now without requesting instances or deleting it", async () => {
  const f = await eventsFixture("delete_event");
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            recurrence: ["RRULE:FREQ=WEEKLY"],
            start: { dateTime: new Date(NOW).toISOString() },
            end: { dateTime: new Date(NOW + 3600000).toISOString() },
          }),
        ),
      },
    },
  });
  await expectError(
    await eventChangeCall(f, "delete_event"),
    "invalid_arguments",
    /event field.*series has occurrences in the past/,
  );
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});

it("does not delete a series when an empty instance page still has a next page", async () => {
  const f = await eventsFixture("delete_event");
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            recurrence: ["RRULE:FREQ=WEEKLY"],
            start: { dateTime: "2030-11-20T14:00:00Z" },
            end: { dateTime: "2030-11-20T15:00:00Z" },
          }),
        ),
      },
      instances: { e1: Response.json({ items: [], nextPageToken: "more-instances" }) },
      delete: { e1: new Response(null, { status: 204 }) },
    },
  });
  await expectError(
    await eventChangeCall(f, "delete_event"),
    "invalid_arguments",
    /event field.*series has occurrences in the past/,
  );
  expect(sent.map((r) => r.method)).toEqual(["GET", "GET"]);
});

it.each(tools.flatMap((tool) => ["timeZone", "send_updates"].map((field) => ({ tool, field }))))(
  "$tool refuses unknown $field before creating an approval",
  async ({ tool, field }) => {
    const f = await eventsFixture(tool, "ask");
    await expectError(
      await eventChangeCall(f, tool, {
        ...(tool === "update_event" ? { title: "Changed" } : {}),
        [field]: "ignored-before",
      }),
      "invalid_arguments",
      `The ${field} field must be left out: this tool has no such field.`,
    );
    expect(requests.filter((url) => url.includes("/calendar/v3/"))).toEqual([]);
  },
);

it.each(tools)("$tool reports a 410 on the write as a known not_found", async (tool) => {
  const f = await eventsFixture(tool);
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      events: { e1: Response.json(eventFixture()) },
      patch: { e1: new Response(null, { status: 410 }) },
      delete: { e1: new Response(null, { status: 410 }) },
    },
  });
  await expectError(
    await eventChangeCall(f, tool, tool === "update_event" ? { title: "Changed" } : {}),
    "not_found",
    /No event "e1"/,
  );
  expect(sent.map((r) => r.method)).toEqual(["GET", tool === "update_event" ? "PATCH" : "DELETE"]);
  expect((await callRows()).at(-1)).toMatchObject({ outcome: "refused", reason: "not_found" });
});

it("keeps unknown fields ignored on read_event, where the strict input policy is not enabled", async () => {
  const f = await eventsFixture("read_event");
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({ [PERSONAL]: { events: { e1: Response.json(eventFixture()) } } });
  expect((await answer(await readEventCall(f, { send_updates: "ignored" }))).event).toBe("e1");
  expect(sent.map((r) => r.method)).toEqual(["GET"]);
});
