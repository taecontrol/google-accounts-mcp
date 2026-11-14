import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { answer, decided, digest, get, page, post } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  invitationFixture,
  patchEventsFake,
  PRIMARY_CALENDAR,
  respondCall,
} from "./support/calendar";
import { observeStatements } from "./support/db";
import { PERSONAL } from "./support/permissions";
import { requests } from "./support/network";
import { testEnv, textOf } from "./support/worker";

const list = (...items: object[]) => Response.json({ items });
const repeatList = (...items: object[]) =>
  calendarFake(...Array.from({ length: 12 }, () => () => list(...items)));
const emailNote = {
  text: "Google emails the answer to the organizer, and may also show it or send it to other guests who can see the guest list.",
  warning: false,
};
const visibilityNote = {
  text: "The note goes with the answer. The organizer gets it by email. Other guests who can see the guest list, and people the organizer's calendar is shared with, may also see it or get it by email.",
  warning: true,
};

it("shows the complete Calendar and agent values, waits for approval and patches with the run's fresh etag", async () => {
  const f = await eventsFixture("respond_to_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  let approved = false;
  const reads = eventsFake({
    [PERSONAL]: {
      events: {
        e1: () =>
          Response.json(
            invitationFixture({
              etag: approved ? '"run-v2"' : '"view-v1"',
              summary: "Planning\nAnother heading",
              start: { dateTime: "2026-11-20T15:00:00+01:00", timeZone: "Europe/Madrid" },
              end: { dateTime: "2026-11-20T16:00:00+01:00", timeZone: "Europe/Madrid" },
              attendees: [
                {
                  email: "room@example.com",
                  self: true,
                  resource: true,
                  responseStatus: "accepted",
                },
                { email: PERSONAL, self: true, responseStatus: "tentative", comment: "Old note" },
              ],
            }),
          ),
      },
    },
  });
  const patches = patchEventsFake(() => {
    expect(approved).toBe(true);
    return Response.json({
      attendees: [{ email: PERSONAL, self: true, responseStatus: "accepted" }],
    });
  });
  const note = "Thank you.\n" + "😀".repeat(988) + "!";
  expect(Array.from(note)).toHaveLength(1000);
  const pending = await answer(await respondCall(f, { note }));
  expect(pending.status).toBe("pending");
  const id = pending.approval as string;
  expect(reads).toEqual([]);
  expect(patches).toEqual([]);
  expect(requests.filter((url) => url.includes("/calendar/v3/"))).toEqual([]);
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
  expect(view.request.tool).toMatchObject({
    label: "Respond to invitation",
    action: "answer a calendar invitation",
    joiner: "from",
  });
  expect(view.request.values).toEqual([
    { name: "Event", text: "Planning Another heading", from: "calendar" },
    {
      name: "Starts",
      text: "Nov 20, 2026 at 09:00 (America/Bogota); event's own zone: Europe/Madrid",
      from: "calendar",
    },
    { name: "Kind", text: "A single event", from: "calendar" },
    { name: "Organizer", text: "host@example.com", from: "calendar" },
    { name: "Current answer", text: "Maybe", from: "calendar" },
    { name: "Answer", text: "Accept", from: "agent" },
    { name: "Note", text: note, from: "agent" },
    { name: "Earlier note, replaced", text: "Old note", from: "calendar" },
  ]);
  expect(view.request.notes).toEqual([emailNote, visibilityNote]);
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  expect(textOf(html)).toContain("the server read the rest from Google Calendar");
  expect(html).toMatch(/>Approve</);
  expect(patches).toEqual([]);
  const shown = view.state.kind === "waiting" ? view.state.digest! : "";
  const db = observeStatements(env.DB, (sql) => {
    if (sql.startsWith("UPDATE approvals SET state = 'approved'")) approved = true;
  });
  const result = await decided(
    await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })),
  );
  expect(result.state.kind).toBe("succeeded");
  expect((await get(f, id)).result).toEqual({
    account: PERSONAL,
    event: "e1",
    my_response: "accepted",
  });
  expect(patches).toHaveLength(1);
  expect(patches[0]!.headers.get("If-Match")).toBe('"run-v2"');
  expect(JSON.parse(patches[0]!.body)).toEqual({
    attendeesOmitted: true,
    attendees: [{ email: PERSONAL, responseStatus: "accepted", comment: note }],
  });
});

it.each([
  { kind: "single", repeating: {}, label: "Starts", text: "A single event" },
  {
    kind: "occurrence",
    repeating: { recurringEventId: "series", recurrence: ["RRULE:FREQ=WEEKLY"] },
    label: "Starts",
    text: "One occurrence of a repeating event",
  },
  {
    kind: "series",
    repeating: { recurrence: ["RRULE:FREQ=WEEKLY"] },
    label: "First occurrence",
    text: "Every occurrence of a repeating event (the whole series). It also replaces answers given before to single occurrences.",
  },
  {
    kind: "series with empty recurrence",
    repeating: { recurrence: [] },
    label: "First occurrence",
    text: "Every occurrence of a repeating event (the whole series). It also replaces answers given before to single occurrences.",
  },
])("shows the scope and start label of a $kind", async ({ repeating, label, text }) => {
  const f = await eventsFixture("respond_to_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          invitationFixture({
            ...repeating,
            start: { dateTime: "2026-11-20T14:00:00Z", timeZone: "America/Bogota" },
          }),
        ),
      },
    },
  });
  const id = (await answer(await respondCall(f))).approval as string;
  const view = await page(f, id);
  expect(view.request.values).toEqual([
    { name: "Event", text: "Planning", from: "calendar" },
    { name: label, text: "Nov 20, 2026 at 09:00 (America/Bogota)", from: "calendar" },
    { name: "Kind", text, from: "calendar" },
    { name: "Organizer", text: "host@example.com", from: "calendar" },
    { name: "Answer", text: "Accept", from: "agent" },
  ]);
  expect(view.request.notes).toEqual([emailNote]);
});

it("keeps all-day starts as dates and shows the event's own zone unchanged", async () => {
  const f = await eventsFixture("respond_to_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          invitationFixture({
            start: { date: "2026-11-20", timeZone: "Japan" },
            end: { date: "2026-11-21", timeZone: "Japan" },
          }),
        ),
      },
    },
  });
  const id = (await answer(await respondCall(f))).approval as string;
  expect((await page(f, id)).request.values[1]).toEqual({
    name: "Starts",
    text: "Nov 20, 2026 (all day); event's own zone: Japan",
    from: "calendar",
  });
});

it.each([
  { status: "accepted", current: "Accepted", response: "declined", next: "Decline" },
  { status: "declined", current: "Declined", response: "tentative", next: "Maybe" },
  { status: "tentative", current: "Maybe", response: "accepted", next: "Accept" },
  { status: "needsAction", current: undefined, response: "accepted", next: "Accept" },
  { status: undefined, current: undefined, response: "accepted", next: "Accept" },
])(
  "labels current answer $status and requested answer $response separately",
  async ({ status, current, response, next }) => {
    const f = await eventsFixture("respond_to_event", "ask");
    repeatList(PRIMARY_CALENDAR);
    eventsFake({
      [PERSONAL]: {
        events: {
          e1: Response.json(
            invitationFixture({
              attendees: [{ email: PERSONAL, self: true, responseStatus: status }],
            }),
          ),
        },
      },
    });
    const id = (await answer(await respondCall(f, { response }))).approval as string;
    const values = (await page(f, id)).request.values;
    expect(values.filter((value) => value.name === "Current answer")).toEqual(
      current === undefined ? [] : [{ name: "Current answer", text: current, from: "calendar" }],
    );
    expect(values.find((value) => value.name === "Answer")).toEqual({
      name: "Answer",
      text: next,
      from: "agent",
    });
  },
);

it.each(["Earlier note\nwith its second line", "", undefined])(
  "shows only the earlier nonempty note removed by an answer without a note %#",
  async (comment) => {
    const f = await eventsFixture("respond_to_event", "ask");
    repeatList(PRIMARY_CALENDAR);
    eventsFake({
      [PERSONAL]: {
        events: {
          e1: Response.json(
            invitationFixture({
              attendees: [{ email: PERSONAL, self: true, responseStatus: "accepted", comment }],
            }),
          ),
        },
      },
    });
    const id = (await answer(await respondCall(f))).approval as string;
    const view = await page(f, id);
    expect(view.request.values.filter((value) => value.name.startsWith("Note"))).toEqual(
      comment ? [{ name: "Note removed", text: comment, from: "calendar" }] : [],
    );
    expect(view.request.notes).toEqual([emailNote]);
  },
);

it("shows the earlier note that a new note replaces", async () => {
  const f = await eventsFixture("respond_to_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          invitationFixture({
            attendees: [
              { email: PERSONAL, self: true, responseStatus: "accepted", comment: "See you there" },
            ],
          }),
        ),
      },
    },
  });
  const id = (await answer(await respondCall(f, { response: "declined", note: "Sorry, I can't" })))
    .approval as string;
  const view = await page(f, id);
  expect(
    view.request.values.filter((value) => value.name === "Note" || value.name.includes("note")),
  ).toEqual([
    { name: "Note", text: "Sorry, I can't", from: "agent" },
    { name: "Earlier note, replaced", text: "See you there", from: "calendar" },
  ]);
  expect(view.request.notes).toEqual([emailNote, visibilityNote]);
});

it.each([undefined, "BST", "invalid/zone"])(
  "cannot build an approval view without a valid primary zone %#",
  async (timeZone) => {
    const f = await eventsFixture("respond_to_event", "ask");
    repeatList({ ...PRIMARY_CALENDAR, timeZone });
    eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
    const patches = patchEventsFake(Response.json({}));
    const id = (await answer(await respondCall(f))).approval as string;
    expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
    expect(await (await f.mcp.browser.get(`/approvals/${id}`)).text()).not.toMatch(/>Approve</);
    expect(patches).toEqual([]);
  },
);

it("repeats invitation refusals in the approved run when the own entry becomes the organizer", async () => {
  const f = await eventsFixture("respond_to_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  let organizer = false;
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: () =>
          Response.json(
            invitationFixture({ attendees: [{ email: PERSONAL, self: true, organizer }] }),
          ),
      },
    },
  });
  const patches = patchEventsFake(Response.json({}));
  const id = (await answer(await respondCall(f))).approval as string;
  const shown = await digest(f, id);
  const db = observeStatements(env.DB, (sql) => {
    if (sql.startsWith("UPDATE approvals SET state = 'approved'")) organizer = true;
  });
  const result = await decided(
    await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })),
  );
  expect(result.state.kind).toBe("failed");
  expect((await get(f, id)).error).toMatchObject({
    code: "invalid_arguments",
    message: expect.stringMatching(/The event field.*organizer/),
  });
  expect(organizer).toBe(true);
  expect(patches).toEqual([]);
});
