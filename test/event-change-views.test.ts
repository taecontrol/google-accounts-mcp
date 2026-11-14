import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { answer, decided, digest, get, page, post } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  eventChangeCall,
  PRIMARY_CALENDAR,
} from "./support/calendar";
import { PERSONAL } from "./support/permissions";
import { observeStatements } from "./support/db";
import { testEnv } from "./support/worker";

const list = (...items: object[]) => Response.json({ items });
const repeatList = (...items: object[]) =>
  calendarFake(...Array.from({ length: 10 }, () => () => list(...items)));
const base = [
  { name: "Calendar", text: `Personal (${PERSONAL})`, from: "calendar" },
  { name: "Event", text: "Planning\nNov 20, 2026 at 09:00 (America/Bogota)", from: "calendar" },
];
const single = { name: "Changes", text: "A single event", from: "agent" };
const guest = { email: "stay@example.com" };

it("shows before and after field values, removals and Calendar attribution in the update view", async () => {
  const f = await eventsFixture("update_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            location: "Room 1",
            description: "<span>Old &amp; plain<br>notes</span>",
            attendees: [guest],
          }),
        ),
      },
    },
  });
  const id = (
    await answer(
      await eventChangeCall(f, "update_event", {
        title: "New title",
        location: "",
        description: "",
      }),
    )
  ).approval as string;
  expect(sent).toEqual([]);
  const view = await page(f, id);
  expect(view.request.tool).toMatchObject({ action: "change an event", joiner: "in" });
  expect(view.request.values).toEqual([
    ...base,
    single,
    { name: "Title now", text: "Planning", from: "calendar" },
    { name: "New title", text: "New title", from: "agent" },
    { name: "Location now", text: "Room 1", from: "calendar" },
    { name: "New location", text: "(removed)", from: "agent" },
    { name: "Description now", text: "Old & plain\nnotes", from: "calendar" },
    { name: "New description", text: "(removed)", from: "agent" },
    { name: "Google emails the change to this guest", text: "stay@example.com", from: "calendar" },
  ]);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
});

it("shows times in the call's zone and both event zones before a time change", async () => {
  const f = await eventsFixture("update_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "America/Bogota" },
            end: { dateTime: "2026-11-20T15:00:00Z", timeZone: "America/Bogota" },
          }),
        ),
      },
    },
  });
  const id = (
    await answer(
      await eventChangeCall(f, "update_event", {
        start: "2026-11-20T16:00",
        time_zone: "Europe/Madrid",
      }),
    )
  ).approval as string;
  expect((await page(f, id)).request.values).toEqual([
    base[0],
    { name: "Event", text: "Planning\nNov 20, 2026 at 15:00 (Europe/Madrid)", from: "calendar" },
    single,
    { name: "Starts now", text: "Nov 20, 2026 at 15:00 (Europe/Madrid)", from: "calendar" },
    { name: "New start", text: "Nov 20, 2026 at 16:00 (Europe/Madrid)", from: "agent" },
    { name: "Ends now", text: "Nov 20, 2026 at 16:00 (Europe/Madrid)", from: "calendar" },
    { name: "New end", text: "Nov 20, 2026 at 17:00 (Europe/Madrid)", from: "agent" },
    { name: "Event's own zone now", text: "America/Bogota", from: "calendar" },
    { name: "New event's own zone", text: "Europe/Madrid", from: "agent" },
  ]);
});

it("shows no-op guest requests and invitation, change and cancellation groups on an occurrence", async () => {
  const f = await eventsFixture("update_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            recurringEventId: "series",
            attendees: [
              guest,
              { email: "remove@example.com" },
              { email: PERSONAL, self: true },
              { email: "room@example.com", resource: true },
            ],
          }),
        ),
      },
    },
  });
  const id = (
    await answer(
      await eventChangeCall(f, "update_event", {
        add_guests: ["stay@example.com", "new@example.com"],
        remove_guests: ["remove@example.com", "absent@example.com"],
      }),
    )
  ).approval as string;
  expect((await page(f, id)).request.values).toEqual([
    ...base,
    {
      name: "Changes",
      text: "One occurrence of a series. The rest of the series stays as it is.",
      from: "agent",
    },
    { name: "Already a guest", text: "stay@example.com", from: "agent" },
    { name: "Not a guest", text: "absent@example.com", from: "agent" },
    { name: "Google emails the invitation to this guest", text: "new@example.com", from: "agent" },
    { name: "Google emails the change to this guest", text: "stay@example.com", from: "calendar" },
    {
      name: "Google emails the cancellation to this guest",
      text: "remove@example.com",
      from: "calendar",
    },
  ]);
});

it("shows the unknown number of emailed guests for a cut list without offering guest edits", async () => {
  const f = await eventsFixture("update_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: { e1: Response.json(eventFixture({ attendeesOmitted: true, attendees: [guest] })) },
    },
  });
  const id = (await answer(await eventChangeCall(f, "update_event", { title: "New title" })))
    .approval as string;
  expect((await page(f, id)).request.values).toEqual([
    ...base,
    single,
    { name: "Title now", text: "Planning", from: "calendar" },
    { name: "New title", text: "New title", from: "agent" },
    {
      name: "Guest emails",
      text: "Google will email the guests. The number of guests is not known.",
      from: "calendar",
    },
  ]);
});

it.each(["single", "occurrence", "series"])(
  "shows the delete target and cancellation guests: %s",
  async (kind) => {
    const f = await eventsFixture("delete_event", "ask");
    repeatList(PRIMARY_CALENDAR);
    eventsFake({
      [PERSONAL]: {
        events: {
          e1: Response.json(
            eventFixture({
              ...(kind === "occurrence"
                ? { recurringEventId: "series" }
                : kind === "series"
                  ? {
                      recurrence: ["RRULE:FREQ=WEEKLY"],
                      start: { dateTime: "2030-11-20T14:00:00Z" },
                      end: { dateTime: "2030-11-20T15:00:00Z" },
                    }
                  : {}),
              attendees: [
                guest,
                { email: "other@example.com" },
                { email: PERSONAL, self: true },
                { email: "room@example.com", resource: true },
              ],
            }),
          ),
        },
        instances: { e1: list() },
      },
    });
    const id = (await answer(await eventChangeCall(f, "delete_event"))).approval as string;
    const view = await page(f, id);
    expect(view.request.tool).toMatchObject({ action: "delete an event", joiner: "from" });
    expect(view.request.notes).toEqual([
      { text: "Google emails each guest a cancellation.", warning: true },
    ]);
    expect(view.request.values).toEqual([
      base[0],
      kind === "series"
        ? { ...base[1], text: "Planning\nNov 20, 2030 at 09:00 (America/Bogota)" }
        : base[1],
      {
        name: "Deletes",
        text:
          kind === "single"
            ? "This event"
            : kind === "occurrence"
              ? "One occurrence of a series. The rest of the series stays."
              : "The whole series: every occurrence.",
        from: "agent",
      },
      {
        name: "Google emails the cancellation to these 2 guests",
        text: "stay@example.com\nother@example.com",
        from: "calendar",
      },
    ]);
  },
);

const refusals = [
  "gone",
  "cancelled",
  "guest",
  "no organizer",
  "special",
  "series",
  "unlisted",
  "reader",
  "busy",
  "after-read input",
];
it.each(
  (["update_event", "delete_event"] as const).flatMap((tool) =>
    refusals.map((kind) => ({ tool, kind })),
  ),
)("$tool offers no Approve when the plan fails: $kind", async ({ tool, kind }) => {
  const f = await eventsFixture(tool, "ask");
  repeatList(
    PRIMARY_CALENDAR,
    { id: "reader", accessRole: "reader" },
    { id: "busy", accessRole: "freeBusyReader" },
  );
  const sent = eventsFake({
    [PERSONAL]: {
      events: {
        e1:
          kind === "gone"
            ? new Response(null, { status: 404 })
            : Response.json(
                eventFixture({
                  ...(kind === "cancelled" ? { status: "cancelled" } : {}),
                  ...(kind === "guest" ? { organizer: { email: "host@example.com" } } : {}),
                  ...(kind === "no organizer" ? { organizer: undefined } : {}),
                  ...(kind === "special" ? { eventType: "focusTime" } : {}),
                  ...(kind === "series" ? { recurrence: ["RRULE:FREQ=WEEKLY"] } : {}),
                  ...(kind === "after-read input" && tool === "delete_event"
                    ? {
                        recurrence: ["RRULE:FREQ=WEEKLY"],
                        start: { dateTime: "2030-11-20T14:00:00Z" },
                        end: { dateTime: "2030-11-20T15:00:00Z" },
                      }
                    : {}),
                }),
              ),
      },
      instances: { e1: new Response(null, { status: 503 }) },
    },
  });
  const id = (
    await answer(
      await eventChangeCall(f, tool, {
        title: "Changed",
        ...(["unlisted", "reader", "busy"].includes(kind) ? { calendar: kind } : {}),
        ...(kind === "after-read input" && tool === "update_event"
          ? { end: "2026-11-20T08:00" }
          : {}),
      }),
    )
  ).approval as string;
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false, digest: null });
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  expect(html).not.toMatch(/>Approve</);
  expect(sent.every((r) => r.method === "GET")).toBe(true);
  if (["unlisted", "reader", "busy"].includes(kind)) expect(sent).toEqual([]);
});

it.each(["removed guest", "changed duration", "new guest"])(
  "writes nothing when the run differs from the approved plan: %s",
  async (kind) => {
    const tool = kind === "new guest" ? "delete_event" : "update_event";
    const f = await eventsFixture(tool, "ask");
    repeatList(PRIMARY_CALENDAR);
    let changed = false;
    const sent = eventsFake({
      [PERSONAL]: {
        events: {
          e1: () =>
            Response.json(
              eventFixture({
                attendees:
                  kind === "removed guest" ? (changed ? [] : [guest]) : changed ? [guest] : [],
                ...(kind === "changed duration" && changed
                  ? { end: { dateTime: "2026-11-20T16:00:00Z" } }
                  : {}),
                etag: changed ? '"version-2"' : '"version-1"',
              }),
            ),
        },
        patch: { e1: Response.json({ id: "e1", htmlLink: "changed" }) },
        delete: { e1: new Response(null, { status: 204 }) },
      },
    });
    const id = (
      await answer(
        await eventChangeCall(
          f,
          tool,
          kind === "removed guest"
            ? { title: "Changed", add_guests: [guest.email] }
            : kind === "changed duration"
              ? { start: "2026-11-20T11:00" }
              : {},
        ),
      )
    ).approval as string;
    const shown = await digest(f, id);
    const db = observeStatements(env.DB, (sql) => {
      if (sql.startsWith("UPDATE approvals SET state = 'approved'")) changed = true;
    });
    expect(
      (await decided(await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })))).state
        .kind,
    ).toBe("failed");
    expect(changed).toBe(true);
    expect((await get(f, id)).error).toEqual({
      code: "google_unavailable",
      message: expect.stringMatching(/event changed after the approval.*Call again/),
    });
    expect(sent.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
  },
);

it.each(["update_event", "delete_event"] as const)(
  "$tool uses the run read's etag when the approved values stay the same",
  async (tool) => {
    const f = await eventsFixture(tool, "ask");
    repeatList(PRIMARY_CALENDAR);
    let running = false;
    const sent = eventsFake({
      [PERSONAL]: {
        events: {
          e1: () =>
            Response.json(eventFixture({ etag: running ? '"run-version"' : '"view-version"' })),
        },
        patch: { e1: Response.json({ id: "e1", htmlLink: "changed" }) },
        delete: { e1: new Response(null, { status: 204 }) },
      },
    });
    const id = (await answer(await eventChangeCall(f, tool, { title: "Changed" })))
      .approval as string;
    const shown = await digest(f, id);
    const db = observeStatements(env.DB, (sql) => {
      if (sql.startsWith("UPDATE approvals SET state = 'approved'")) running = true;
    });
    expect(
      (await decided(await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })))).state
        .kind,
    ).toBe("succeeded");
    expect(sent.map((r) => r.method)).toEqual([
      "GET",
      "GET",
      "GET",
      tool === "update_event" ? "PATCH" : "DELETE",
    ]);
    expect(sent[3]!.headers.get("If-Match")).toBe('"run-version"');
    expect((await get(f, id)).result).toMatchObject({ event: "e1", calendar: PERSONAL });
  },
);

it("shows no guest email notices when every requested change already matches", async () => {
  const f = await eventsFixture("update_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: { events: { e1: Response.json(eventFixture({ attendees: [guest] })) } },
  });
  const id = (await answer(await eventChangeCall(f, "update_event", { add_guests: [guest.email] })))
    .approval as string;
  expect((await page(f, id)).request.values).toEqual([
    ...base,
    single,
    { name: "Already a guest", text: guest.email, from: "agent" },
  ]);
});
