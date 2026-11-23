import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { HttpResponse } from "msw";
import { Effect } from "effect";
import { answerInvitation, invitation } from "../src/google/respond";
import { runChange } from "../src/google/event-change";
import type { Send, Sending } from "../src/mcp/tools";
import { answer, page } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  invitationFixture,
  patchEventsFake,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
  respondCall,
} from "./support/calendar";
import { callRows, expectError, PERSONAL, unconfirmedMessage } from "./support/permissions";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";
import { env } from "cloudflare:workers";
import { observeStatements } from "./support/db";
import { setTool } from "./support/uploads";
import { toolCall } from "./support/permissions";
import { testEnv } from "./support/worker";

const list = (...items: object[]) => Response.json({ items });
const calendarPaths = () =>
  requests
    .filter((url) => url.startsWith("https://www.googleapis.com/calendar/v3/"))
    .map((url) => new URL(url).pathname);
const confirmed = (response = "accepted") =>
  Response.json({ attendees: [{ email: PERSONAL, self: true, responseStatus: response }] });

it.each([
  { response: "accepted", hidden: true, zone: undefined },
  { response: "declined", hidden: false, zone: "invalid/zone" },
  { response: "tentative", hidden: false, zone: "BST" },
])(
  "patches only the self guest as $response, without depending on the primary zone",
  async ({ response, hidden, zone }) => {
    const f = await eventsFixture("respond_to_event");
    const calendar = "primary-calendar+id@example.com";
    const email = "A.lex+invitation@example.com";
    const note = "Thanks for inviting me.\n😀";
    calendarFake(list(SECONDARY_CALENDAR, { ...PRIMARY_CALENDAR, id: calendar, timeZone: zone }));
    const read = eventsFake({
      [calendar]: {
        events: {
          e1: Response.json(
            invitationFixture({
              guestsCanModify: true,
              guestsCanSeeOtherGuests: !hidden,
              attendeesOmitted: hidden,
              attendees: [
                { email: "guest1@example.com", responseStatus: "declined" },
                {
                  email: "room@example.com",
                  self: true,
                  resource: true,
                  responseStatus: "accepted",
                },
                {
                  email,
                  self: true,
                  responseStatus: "needsAction",
                  optional: true,
                  displayName: "Alex",
                  additionalGuests: 1,
                },
                { email: "guest2@example.com", responseStatus: "tentative" },
              ],
            }),
          ),
        },
      },
    });
    const patches = patchEventsFake(
      Response.json({
        attendees: [
          { email: "room@example.com", self: true, resource: true, responseStatus: "needsAction" },
          { email: "guest1@example.com", responseStatus: "declined" },
          { email, self: true, responseStatus: response },
        ],
      }),
    );
    expect(await answer(await respondCall(f, { response, note }))).toEqual({
      account: PERSONAL,
      event: "e1",
      my_response: response,
    });
    expect(patches).toHaveLength(1);
    const sent = patches[0]!;
    expect(sent.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/e1?sendUpdates=all`,
    );
    expect(sent.method).toBe("PATCH");
    expect(sent.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get("If-Match")).toBe('"invitation-v1"');
    expect(sent.redirect).toBe("manual");
    expect(sent.signal.aborted).toBe(false);
    expect(sent.body).toBe(
      JSON.stringify({
        attendeesOmitted: true,
        attendees: [{ email, responseStatus: response, comment: note }],
      }),
    );
    expect(read).toHaveLength(1);
    expect(calendarPaths()).toEqual([
      "/calendar/v3/users/me/calendarList",
      `/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/e1`,
      `/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/e1`,
    ]);
    expect((await callRows()).at(-1)).toMatchObject({
      tool: "respond_to_event",
      outcome: "success",
    });
  },
);

it.each([
  { field: "account", value: false },
  { field: "event", value: "" },
  { field: "event", value: "." },
  { field: "event", value: "../e1" },
  { field: "event", value: "e".repeat(1025) },
  { field: "response", value: "needs_action" },
  { field: "response", value: "needsAction" },
  { field: "response", value: "yes" },
  { field: "response", value: false },
  { field: "response", value: undefined },
  { field: "note", value: "" },
  { field: "note", value: " \n\t\r\u2003" },
  { field: "note", value: "\u200B\u2800\u3164 \u200D" },
  { field: "note", value: "😀".repeat(1001) },
  { field: "note", value: "a".repeat(1001) },
  { field: "note", value: "e\u0301".repeat(500) + "!" },
  { field: "note", value: 42 },
])("refuses invalid $field before any Calendar request %#", async ({ field, value }) => {
  const f = await eventsFixture("respond_to_event");
  const messages: Record<string, RegExp> = {
    account: /The account field must be a string/,
    event: /The event field must be .*primary calendar.*1 to 1,024.*letters.*digits/,
    response: /The response field must be accepted, declined, or tentative/,
    note: /The note field must be .*1 to 1,000 Unicode code points.*visible character.*line breaks/,
  };
  await expectError(
    await respondCall(f, { [field]: value }),
    "invalid_arguments",
    messages[field]!,
  );
  expect(calendarPaths()).toEqual([]);
});

it.each([
  { kind: "control", note: "\u0000" },
  { kind: "combining grapheme joiner", note: "\u034f" },
  { kind: "variation selector", note: "\ufe0f" },
])("refuses a note containing only an invisible $kind before Calendar", async ({ note }) => {
  const f = await eventsFixture("respond_to_event");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
  const patches = patchEventsFake(confirmed());
  await expectError(
    await respondCall(f, { note }),
    "invalid_arguments",
    /The note field must be .*visible character/,
  );
  expect(calendarPaths()).toEqual([]);
  expect(patches).toEqual([]);
});

it.each(["calendar", "time_zone", "duplicate", "extra"])(
  "refuses the extra field %s instead of ignoring it",
  async (field) => {
    const f = await eventsFixture("respond_to_event");
    await expectError(
      await respondCall(f, { [field]: "unexpected" }),
      "invalid_arguments",
      `The ${field} field must be left out: this tool has no such field.`,
    );
    expect(calendarPaths()).toEqual([]);
  },
);

it.each(["😀".repeat(1000), "\n😀", "a", "\u0000Cafe\u0301\u034F\n👩\u200D💻 ☕\uFE0F"])(
  "sends the full valid note counted in Unicode code points %#",
  async (note) => {
    const f = await eventsFixture("respond_to_event");
    calendarFake(list(PRIMARY_CALENDAR));
    eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
    const patches = patchEventsFake(confirmed());
    await answer(await respondCall(f, { note }));
    expect(JSON.parse(patches[0]!.body).attendees[0].comment).toBe(note);
  },
);

it("clears an earlier note and executes a repeated call again", async () => {
  const f = await eventsFixture("respond_to_event");
  calendarFake(list(PRIMARY_CALENDAR), list(PRIMARY_CALENDAR));
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          invitationFixture({
            eventType: undefined,
            attendees: [
              { email: PERSONAL, self: true, responseStatus: "accepted", comment: "See you there" },
            ],
          }),
        ),
      },
    },
  });
  const patches = patchEventsFake(confirmed(), confirmed());
  for (let i = 0; i < 2; i++)
    expect(await answer(await respondCall(f))).toEqual({
      account: PERSONAL,
      event: "e1",
      my_response: "accepted",
    });
  expect(patches).toHaveLength(2);
  for (const sent of patches) {
    expect(sent.headers.get("If-Match")).toBe('"invitation-v1"');
    expect(JSON.parse(sent.body)).toEqual({
      attendeesOmitted: true,
      attendees: [{ email: PERSONAL, responseStatus: "accepted", comment: "" }],
    });
  }
});

const refusals: Array<{
  kind: string;
  calendars?: object[];
  event?: Record<string, unknown> | Response;
  code: string;
  message: RegExp;
}> = [
  {
    kind: "no primary",
    calendars: [SECONDARY_CALENDAR],
    code: "not_found",
    message: /No primary calendar ID/,
  },
  {
    kind: "literal primary",
    calendars: [{ ...PRIMARY_CALENDAR, id: "primary" }],
    code: "not_found",
    message: /No primary calendar ID/,
  },
  ...[404, 410].map((status) => ({
    kind: `missing ${status}`,
    event: new Response(null, { status }),
    code: "not_found",
    message: /No event/,
  })),
  {
    kind: "cancelled",
    event: { id: "e1", status: "cancelled" },
    code: "not_found",
    message: /No event/,
  },
  ...["outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail", "futureKind"].map(
    (eventType) => ({
      kind: eventType,
      event: invitationFixture({ eventType }),
      code: "invalid_arguments",
      message: /The event field.*regular invitation/,
    }),
  ),
  {
    kind: "no organizer",
    event: invitationFixture({ organizer: undefined }),
    code: "invalid_arguments",
    message: /The event field.*organizer address/,
  },
  {
    kind: "no organizer address",
    event: invitationFixture({ organizer: {} }),
    code: "invalid_arguments",
    message: /The event field.*organizer address/,
  },
  {
    kind: "organizer self only",
    event: invitationFixture({ organizer: { email: PERSONAL, self: true } }),
    code: "invalid_arguments",
    message: /The event field.*organized by someone else/,
  },
  {
    kind: "own organizer flag only",
    event: invitationFixture({ attendees: [{ email: PERSONAL, self: true, organizer: true }] }),
    code: "invalid_arguments",
    message: /The event field.*organized by someone else/,
  },
  {
    kind: "no attendees",
    event: invitationFixture({ attendees: undefined }),
    code: "invalid_arguments",
    message: /The event field.*exactly one guest/,
  },
  {
    kind: "own email without self",
    event: invitationFixture({ attendees: [{ email: PERSONAL, responseStatus: "needsAction" }] }),
    code: "invalid_arguments",
    message: /The event field.*exactly one guest/,
  },
  {
    kind: "Google Group only",
    event: invitationFixture({ attendees: [{ email: "team@googlegroups.com" }] }),
    code: "invalid_arguments",
    message: /The event field.*Google Group/,
  },
  {
    kind: "room self only",
    event: invitationFixture({
      attendees: [{ email: "room@example.com", self: true, resource: true }],
    }),
    code: "invalid_arguments",
    message: /The event field.*exactly one guest/,
  },
  {
    kind: "two human self entries",
    event: invitationFixture({
      attendees: [
        { email: PERSONAL, self: true },
        { email: "alias@example.com", self: true },
      ],
    }),
    code: "invalid_arguments",
    message: /The event field.*exactly one guest/,
  },
  {
    kind: "own entry without address",
    event: invitationFixture({ attendees: [{ self: true }] }),
    code: "invalid_arguments",
    message: /The event field.*address on this account/,
  },
];
it.each(
  refusals.flatMap((refusal) => {
    const settings =
      refusal.kind === "no primary" || refusal.kind === "organizer self only"
        ? (["allow", "ask"] as const)
        : (["allow"] as const);
    return settings.map((setting) => ({ ...refusal, setting }));
  }),
)(
  "refuses $kind at $setting without a patch or an Approve button",
  async ({ kind, calendars, event, code, message, setting }) => {
    const f = await eventsFixture("respond_to_event", setting);
    calendarFake(
      ...Array.from({ length: 8 }, () => () => list(...(calendars ?? [PRIMARY_CALENDAR]))),
    );
    const reads = eventsFake({
      [PERSONAL]: {
        events: {
          e1: event instanceof Response ? event : Response.json(event ?? invitationFixture()),
        },
      },
    });
    const patches = patchEventsFake(confirmed());
    const response = await respondCall(f);
    if (setting === "allow") await expectError(response, code, message);
    else {
      const id = (await answer(response)).approval as string;
      expect((await page(f, id)).state).toMatchObject({
        kind: "waiting",
        shown: false,
        digest: null,
      });
      const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
      expect(html).not.toMatch(/>Approve</);
    }
    expect(patches).toEqual([]);
    if (kind === "no primary" || kind === "literal primary") expect(reads).toEqual([]);
  },
);

it("does not answer when Google gives no etag to tie the write to its read", async () => {
  const f = await eventsFixture("respond_to_event");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({
    [PERSONAL]: { events: { e1: Response.json(invitationFixture({ etag: undefined })) } },
  });
  const patches = patchEventsFake(confirmed());
  await expectError(await respondCall(f), "google_unavailable", /Google could not complete/);
  expect(patches).toEqual([]);
});

it.each([412, 404, 410, 400, 403, 429, 500, 503, 302])(
  "maps a patch refusal %s without retrying and keeps 412 a known outcome",
  async (status) => {
    const f = await eventsFixture("respond_to_event");
    calendarFake(list(PRIMARY_CALENDAR));
    eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
    const patches = patchEventsFake(new Response(null, { status }));
    const code = status === 404 || status === 410 ? "not_found" : "google_unavailable";
    const unknown = status < 400 || status >= 500;
    await expectError(
      await respondCall(f),
      code,
      status === 412
        ? /event changed.*Google did not change.*Call again/
        : status === 404 || status === 410
          ? /No event/
          : unknown
            ? unconfirmedMessage(PERSONAL)
            : /Google could not complete/,
    );
    expect(patches).toHaveLength(1);
    expect((await callRows()).at(-1)).toMatchObject({
      outcome: unknown ? null : code === "not_found" ? "refused" : "failed",
      reason: unknown ? null : code,
    });
  },
);

it.each([
  { kind: "lost response", answer: () => HttpResponse.error() },
  { kind: "no attendees", answer: () => Response.json({}) },
  {
    kind: "no self",
    answer: () => Response.json({ attendees: [{ email: PERSONAL, responseStatus: "accepted" }] }),
  },
  {
    kind: "room self only",
    answer: () =>
      Response.json({ attendees: [{ self: true, resource: true, responseStatus: "accepted" }] }),
  },
  { kind: "different response", answer: () => confirmed("tentative") },
  { kind: "missing status", answer: () => Response.json({ attendees: [{ self: true }] }) },
  {
    kind: "two human self entries",
    answer: () =>
      Response.json({
        attendees: [
          { self: true, responseStatus: "accepted" },
          { self: true, responseStatus: "accepted" },
        ],
      }),
  },
  {
    kind: "malformed attendee",
    answer: () => Response.json({ attendees: [{ self: true, responseStatus: 42 }] }),
  },
  { kind: "malformed JSON", answer: () => new Response("not JSON") },
])(
  "reports an unknown outcome for $kind instead of claiming the requested response",
  async ({ answer: reply }) => {
    const f = await eventsFixture("respond_to_event");
    calendarFake(list(PRIMARY_CALENDAR));
    eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
    const patches = patchEventsFake(reply);
    await expectError(await respondCall(f), "google_unavailable", unconfirmedMessage(PERSONAL));
    expect(patches).toHaveLength(1);
    expect((await callRows()).at(-1)).toMatchObject({ outcome: null });
  },
);

it("sends no answer when the setting turns deny after the call's checks", async () => {
  const f = await eventsFixture("respond_to_event");
  await setTool(f, "list_calendars", "allow");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({ [PERSONAL]: { events: { e1: Response.json(invitationFixture()) } } });
  const patches = patchEventsFake(() => Response.json({ attendees: [] }));
  let checks = 0;
  const db = observeStatements(env.DB, async (sql) => {
    if (/AS ask\s+FROM accounts a/.test(sql) && ++checks === 2)
      await setTool(f, "respond_to_event", "deny");
  });
  await expectError(
    await toolCall(
      f.mcp,
      "respond_to_event",
      { account: PERSONAL, event: "e1", response: "accepted" },
      testEnv({ DB: db }),
    ),
    "tool_not_allowed",
    /has not allowed/,
  );
  expect(checks).toBe(2);
  expect(patches).toHaveLength(0);
});

it("keeps an unreadable patch body unknown and passes the abort signal to each request", async () => {
  const controller = new AbortController();
  const sent: Request[] = [];
  const answers = [
    list(PRIMARY_CALENDAR),
    Response.json(invitationFixture()),
    new Response(
      new ReadableStream({
        start(body) {
          body.error(new Error("lost response body"));
        },
      }),
    ),
  ];
  const send: Send = (build) => {
    sent.push(build("test-token", controller.signal));
    return Effect.succeed(answers.shift()!);
  };
  const result = await Effect.runPromise(
    Effect.result(
      invitation(send, { account: PERSONAL, event: "e1" }).pipe(
        Effect.flatMap((found) =>
          answerInvitation(send as Sending, found, {
            account: PERSONAL,
            event: "e1",
            response: "accepted",
          }),
        ),
      ),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "google_unavailable", unknown: true },
  });
  expect(sent.map((request) => request.method)).toEqual(["GET", "GET", "PATCH"]);
  controller.abort();
  expect(sent.every((request) => request.signal.aborted)).toBe(true);
});

it.each([
  { id: "series_20261120T140000Z", repeating: { recurringEventId: "series" } },
  { id: "series", repeating: { recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] } },
  { id: "e".repeat(1024), repeating: {} },
])(
  "patches exactly the supplied occurrence, series or maximum-length ID $id",
  async ({ id, repeating }) => {
    const f = await eventsFixture("respond_to_event");
    calendarFake(list(PRIMARY_CALENDAR));
    eventsFake({
      [PERSONAL]: { events: { [id]: Response.json(invitationFixture({ id, ...repeating })) } },
    });
    const patches = patchEventsFake(confirmed("declined"));
    expect(await answer(await respondCall(f, { event: id, response: "declined" }))).toEqual({
      account: PERSONAL,
      event: id,
      my_response: "declined",
    });
    expect(patches).toHaveLength(1);
    expect(new URL(patches[0]!.url).pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events/${id}`,
    );
  },
);

it.each([
  new Response(null, { status: 503 }),
  new Response("not JSON"),
  Response.json({ items: [{ summary: "No ID" }] }),
])("fails before patching when the calendar list cannot be read %#", async (response) => {
  const f = await eventsFixture("respond_to_event");
  calendarFake(response);
  const patches = patchEventsFake(confirmed());
  await expectError(await respondCall(f), "google_unavailable", /Google could not complete/);
  expect(patches).toEqual([]);
});

it("publishes the primary-calendar, note readers and note clearing contract with a closed input", async () => {
  const f = await eventsFixture("respond_to_event");
  const listed = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  const tool = listed.find((entry) => entry.name === "respond_to_event")!;
  for (const text of [
    "primary calendar",
    "Google emails the answer and the note to the organizer.",
    "people the organizer's calendar is shared with, can read them",
    "An answer without `note` removes the note of an earlier answer.",
    "replaces answers given before to single occurrences",
    "Google may email the organizer again",
  ])
    expect(tool.description).toContain(text);
  expect(tool.inputSchema).toMatchObject({
    type: "object",
    required: ["account", "event", "response"],
    additionalProperties: false,
    properties: {
      account: { type: "string" },
      event: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9_-]+$" },
      response: { enum: ["accepted", "declined", "tentative"] },
      note: { type: "string" },
    },
  });
});

it("writes nothing for an empty approved page, even when the run cannot build one either", async () => {
  let checks = 0;
  let writes = 0;
  const result = await Effect.runPromise(
    Effect.result(
      runChange(
        Effect.succeed({
          values: [],
          write: () => {
            writes++;
            return Effect.succeed({ account: PERSONAL, event: "e1", my_response: "accepted" });
          },
        }),
        {
          confirm: {
            late: (() => Effect.die("unused")) as unknown as Send,
            check: Effect.sync(() => {
              checks++;
              return (() => Effect.die("unused")) as unknown as Sending;
            }),
          },
          approved: [],
        },
      ),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "google_unavailable" } });
  expect(checks).toBe(0);
  expect(writes).toBe(0);
});
