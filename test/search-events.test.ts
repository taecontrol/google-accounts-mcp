import "./support/account-checks";
import { expect, it, vi } from "vite-plus/test";
import { answer, rows } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
  searchCall,
  CALENDAR_SCOPES,
  readEventCall,
} from "./support/calendar";
import {
  callRows,
  expectError,
  fixture,
  PERSONAL,
  problemCases,
  unavailableMessage,
} from "./support/permissions";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";
import { deferred, google } from "./support/google";
import { setTool } from "./support/uploads";
import { statementFailingDb } from "./support/db";
import { testEnv } from "./support/worker";

interface CalendarResult {
  calendar: string;
  events?: Array<Record<string, unknown>>;
  error?: { code: string; message: string };
  next_page?: string;
  not_read?: boolean;
}
interface SearchResult {
  account: string;
  time_zone: string;
  calendars: CalendarResult[];
  note?: string;
}
const resultOf = async (response: Response) => (await answer(response)) as unknown as SearchResult;
const paths = () =>
  requests
    .filter((url) => url.startsWith("https://www.googleapis.com/calendar/v3/"))
    .map((url) => new URL(url).pathname);
const list = (...items: object[]) => Response.json({ items });
const unlistedMessage =
  "No such calendar in the account's Google Calendar list; leave calendars out to use the primary calendar, or use IDs from list_calendars.";

it("maps the agenda in requested calendar order, with occurrences, all-day dates and local times, and omits cancelled and out-of-range events", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR, { id: "broken", accessRole: "reader" }));
  const eventRequests = eventsFake({
    [PERSONAL]: {
      list: Response.json({
        items: [
          eventFixture({
            id: "all-day",
            summary: "Holiday",
            start: { date: "2026-11-20" },
            end: { date: "2026-11-22" },
          }),
          // A moved occurrence retains its ID and originalStartTime, but the agenda uses start.
          eventFixture({
            id: "series_20261120T130000Z",
            recurringEventId: "series",
            originalStartTime: { dateTime: "2026-11-20T13:00:00Z" },
            start: { dateTime: "2026-11-20T15:00:00Z" },
            end: { dateTime: "2026-11-20T16:00:00Z" },
          }),
          {
            id: "cancelled",
            status: "cancelled",
            recurringEventId: "series",
            originalStartTime: { dateTime: "2026-11-20T13:00:00Z" },
          },
          eventFixture({
            id: "ends-at-from",
            start: { dateTime: "2026-11-20T04:00:00Z" },
            end: { dateTime: "2026-11-20T05:00:00Z" },
          }),
          eventFixture({
            id: "starts-at-to",
            start: { dateTime: "2026-11-21T05:00:00Z" },
            end: { dateTime: "2026-11-21T06:00:00Z" },
          }),
        ],
      }),
    },
    [SECONDARY_CALENDAR.id]: {
      list: Response.json({
        items: [
          eventFixture({
            summary: undefined,
            organizer: undefined,
            start: { dateTime: "2026-11-20T23:00:00+09:00" },
            end: { dateTime: "2026-11-21T00:00:00+09:00" },
          }),
        ],
      }),
    },
    broken: { list: new Response(null, { status: 503 }) },
  });
  const result = await resultOf(
    await searchCall(f, {
      calendars: [SECONDARY_CALENDAR.id, PERSONAL, "broken"],
      query: "planning",
    }),
  );
  expect(result).toEqual({
    account: PERSONAL,
    time_zone: "America/Bogota",
    calendars: [
      {
        calendar: SECONDARY_CALENDAR.id,
        events: [
          {
            event: "e1",
            title: "",
            start: "2026-11-20T09:00:00-05:00",
            end: "2026-11-20T10:00:00-05:00",
            all_day: false,
            guest_count: 0,
          },
        ],
      },
      {
        calendar: PERSONAL,
        events: [
          {
            event: "all-day",
            title: "Holiday",
            start: "2026-11-20",
            end: "2026-11-22",
            all_day: true,
            organizer: PERSONAL,
            guest_count: 0,
          },
          {
            event: "series_20261120T130000Z",
            title: "Planning",
            start: "2026-11-20T10:00:00-05:00",
            end: "2026-11-20T11:00:00-05:00",
            all_day: false,
            organizer: PERSONAL,
            series: "series",
            guest_count: 0,
          },
        ],
      },
      {
        calendar: "broken",
        error: { code: "google_unavailable", message: unavailableMessage(PERSONAL) },
      },
    ],
  });
  expect(paths()).toEqual([
    "/calendar/v3/users/me/calendarList",
    ...[SECONDARY_CALENDAR.id, PERSONAL, "broken"].map(
      (id) => `/calendar/v3/calendars/${encodeURIComponent(id)}/events`,
    ),
  ]);
  for (const request of eventRequests) {
    const params = new URL(request.url).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "25",
      q: "planning",
      timeMin: "2026-11-20T05:00:00Z",
      timeMax: "2026-11-21T05:00:00Z",
      timeZone: "America/Bogota",
    });
    expect(params.getAll("eventTypes")).toEqual([
      "default",
      "outOfOffice",
      "focusTime",
      "birthday",
      "fromGmail",
    ]);
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("Authorization")).toMatch(/^Bearer /);
  }
  expect((await callRows()).at(-1)).toMatchObject({
    outcome: "success",
    reason: null,
    tool: "search_events",
  });
});

it("sends the call zone for an all-day edge in another calendar's zone and filters an extra all-day event locally", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      list: Response.json({
        items: [
          eventFixture({ id: "today", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }),
          eventFixture({
            id: "yesterday",
            start: { date: "2026-11-19" },
            end: { date: "2026-11-20" },
          }),
        ],
      }),
    },
  });
  const result = await resultOf(
    await searchCall(f, {
      calendars: [SECONDARY_CALENDAR.id],
      from: "2026-11-20T00:00",
      to: "2026-11-20T02:00",
      time_zone: "America/Bogota",
    }),
  );
  expect(result.calendars[0]!.events!.map((event) => event.event)).toEqual(["today"]);
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toMatchObject({
    timeZone: "America/Bogota",
    timeMin: "2026-11-20T05:00:00Z",
    timeMax: "2026-11-20T07:00:00Z",
  });
});

it("uses an explicit zone across DST rather than either calendar's zone", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      list: Response.json({
        items: [
          eventFixture({
            start: { dateTime: "2026-03-08T06:30:00Z" },
            end: { dateTime: "2026-03-08T07:30:00Z" },
          }),
        ],
      }),
    },
  });
  const result = await resultOf(
    await searchCall(f, {
      calendars: [SECONDARY_CALENDAR.id],
      from: "2026-03-08",
      to: "2026-03-09",
      time_zone: "America/New_York",
    }),
  );
  expect(result.time_zone).toBe("America/New_York");
  expect(result.calendars[0]!.events![0]).toMatchObject({
    start: "2026-03-08T01:30:00-05:00",
    end: "2026-03-08T03:30:00-04:00",
  });
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toMatchObject({
    timeMin: "2026-03-08T05:00:00Z",
    timeMax: "2026-03-09T04:00:00Z",
    timeZone: "America/New_York",
  });
});

it("keeps empty Google pages with next_page and passes only Google's token with the same range and query", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR), list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      list: (request) =>
        new URL(request.url).searchParams.has("pageToken")
          ? Response.json({ items: [eventFixture()] })
          : Response.json({ nextPageToken: "next+/=" }),
    },
  });
  expect(
    (await resultOf(await searchCall(f, { query: "annual planning", limit: 50 }))).calendars,
  ).toEqual([{ calendar: PERSONAL, events: [], next_page: "next+/=" }]);
  expect(
    (
      await resultOf(
        await searchCall(f, {
          query: "annual planning",
          limit: 50,
          calendars: [PERSONAL],
          page: "next+/=",
        }),
      )
    ).calendars[0]!.events,
  ).toHaveLength(1);
  const first = new URL(sent[0]!.url);
  const second = new URL(sent[1]!.url);
  expect(second.searchParams.get("pageToken")).toBe("next+/=");
  second.searchParams.delete("pageToken");
  expect(second.href).toBe(first.href);
});

it("refuses unlisted calendars, primary and busy-only calendars without sending an events request for any of them", async () => {
  const f = await eventsFixture();
  calendarFake(
    list(
      PRIMARY_CALENDAR,
      { id: "busy", summary: "Busy", accessRole: "freeBusyReader" },
      { id: "future", accessRole: "futureRole" },
    ),
  );
  eventsFake({ [PERSONAL]: { list: Response.json({}) } });
  const result = await resultOf(
    await searchCall(f, {
      calendars: [PERSONAL, "primary", "colleague@example.com", "public", "busy", "future"],
    }),
  );
  expect(result.calendars.slice(1, 4)).toEqual(
    ["primary", "colleague@example.com", "public"].map((calendar) => ({
      calendar,
      error: { code: "not_found", message: unlistedMessage },
    })),
  );
  for (const entry of result.calendars.slice(4))
    expect(entry.error).toEqual({
      code: "invalid_arguments",
      message: expect.stringMatching(/calendar field.*only busy times.*check_availability/),
    });
  expect(paths()).toEqual([
    "/calendar/v3/users/me/calendarList",
    `/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events`,
  ]);
});

it.each([
  { calendars: ["absent", "primary"], status: 200, code: "not_found", message: /No such calendar/ },
  {
    calendars: ["absent", "busy"],
    status: 200,
    code: "invalid_arguments",
    message: /only busy times/,
  },
  {
    calendars: ["busy", PERSONAL],
    status: 503,
    code: "google_unavailable",
    message: /Google could not complete/,
  },
  { calendars: ["absent", PERSONAL], status: 404, code: "not_found", message: /No such calendar/ },
])(
  "chooses $code when every calendar fails: $calendars",
  async ({ calendars, status, code, message }) => {
    const f = await eventsFixture();
    calendarFake(list(PRIMARY_CALENDAR, { id: "busy", accessRole: "freeBusyReader" }));
    eventsFake({ [PERSONAL]: { list: new Response(null, { status }) } });
    await expectError(await searchCall(f, { calendars }), code, message);
  },
);

it.each([
  new Response(null, { status: 403 }),
  new Response("not JSON"),
  Response.json({ items: [{ id: "e1", status: "confirmed" }] }),
])(
  "keeps a calendar-local refusal or malformed answer alongside a success %#",
  async (response) => {
    const f = await eventsFixture();
    calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
    eventsFake({
      [PERSONAL]: { list: Response.json({}) },
      [SECONDARY_CALENDAR.id]: { list: response },
    });
    expect(
      (await resultOf(await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] })))
        .calendars[1]!.error,
    ).toEqual({ code: "google_unavailable", message: unavailableMessage(PERSONAL) });
  },
);

it("fails the whole call for api_not_enabled even alongside a successful calendar", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  eventsFake({
    [PERSONAL]: { list: Response.json({ items: [eventFixture()] }) },
    [SECONDARY_CALENDAR.id]: {
      list: Response.json(
        {
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SERVICE_DISABLED",
                domain: "googleapis.com",
              },
            ],
          },
        },
        { status: 403 },
      ),
    },
  });
  await expectError(
    await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] }),
    "api_not_enabled",
    /Google Calendar API is not enabled/,
  );
});

it("fails the whole call for a server failure persisting a token after another calendar answered", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const answered = deferred();
  eventsFake({
    [PERSONAL]: {
      list: () => {
        answered.resolve();
        return Response.json({ items: [eventFixture()] });
      },
    },
    [SECONDARY_CALENDAR.id]: {
      list: async () => {
        await answered.promise;
        return new Response(null, { status: 401 });
      },
    },
  });
  const db = statementFailingDb(/UPDATE accounts AS a SET access_token/);
  await expectError(
    await f.mcp.call("tools/call", testEnv({ DB: db }), {
      name: "search_events",
      arguments: {
        account: PERSONAL,
        calendars: [PERSONAL, SECONDARY_CALENDAR.id],
        from: "2026-11-20",
        to: "2026-11-21",
      },
    }),
    "server_unavailable",
    /server could not complete/,
  );
});

it.each([
  { answer: 503, code: "google_unavailable", message: /Google could not complete/ },
  { answer: "invalid_grant", code: "account_needs_reconnect", message: /reconnect.*https:\/\// },
  { answer: "admin_policy_enforced", code: "account_blocked_by_admin", message: /admin blocked/ },
] as const)(
  "fails the whole call for a token failure $code after a calendar answered",
  async ({ answer: refreshAnswer, code, message }) => {
    const f = await eventsFixture();
    calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
    google.refreshAnswers.push(refreshAnswer);
    const answered = deferred();
    eventsFake({
      [PERSONAL]: {
        list: () => {
          answered.resolve();
          return Response.json({ items: [eventFixture()] });
        },
      },
      [SECONDARY_CALENDAR.id]: {
        list: async () => {
          await answered.promise;
          return new Response(null, { status: 401 });
        },
      },
    });
    await expectError(
      await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] }),
      code,
      message,
    );
    expect(google.refreshTokens).toHaveLength(1);
  },
);

it.each([
  {
    items: [SECONDARY_CALENDAR],
    args: { time_zone: "UTC" },
    code: "not_found",
    message: /No such calendar/,
  },
  { items: [SECONDARY_CALENDAR], args: {}, code: "invalid_arguments", message: /time_zone field/ },
  {
    items: [{ ...PRIMARY_CALENDAR, timeZone: "BST" }],
    args: {},
    code: "invalid_arguments",
    message: /time_zone field/,
  },
])(
  "uses no alias or fallback zone when the primary calendar or its zone is unavailable %#",
  async ({ items, args, code, message }) => {
    const f = await eventsFixture();
    calendarFake(list(...items));
    await expectError(await searchCall(f, args), code, message);
    expect(paths()).toEqual(["/calendar/v3/users/me/calendarList"]);
  },
);

it("reads a listed calendar past list_calendars' output limit and on a later list page", async () => {
  const f = await eventsFixture();
  calendarFake(
    Response.json({
      items: [PRIMARY_CALENDAR, ...Array.from({ length: 249 }, (_, i) => ({ id: `c${i}` }))],
      nextPageToken: "list-next",
    }),
    list(SECONDARY_CALENDAR),
  );
  eventsFake({ [SECONDARY_CALENDAR.id]: { list: Response.json({}) } });
  expect(
    (await resultOf(await searchCall(f, { calendars: [SECONDARY_CALENDAR.id] }))).calendars,
  ).toEqual([{ calendar: SECONDARY_CALENDAR.id, events: [] }]);
  expect(paths()).toEqual([
    "/calendar/v3/users/me/calendarList",
    "/calendar/v3/users/me/calendarList",
    `/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events`,
  ]);
});

it("maps my_response by self in the primary calendar and by normalized email elsewhere, without inventing an organizer attendee", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  eventsFake({
    [PERSONAL]: {
      list: Response.json({
        items: [
          eventFixture({
            id: "alias",
            organizer: { email: "host@example.com" },
            attendees: [
              { email: "alias@example.com", self: true, responseStatus: "accepted" },
              { email: "room@example.com", resource: true },
            ],
          }),
          eventFixture({ id: "organizer", guestsCanSeeOtherGuests: false }),
          eventFixture({ id: "omitted", attendeesOmitted: true }),
        ],
      }),
    },
    [SECONDARY_CALENDAR.id]: {
      list: Response.json({
        items: [
          eventFixture({
            organizer: { email: "other@example.com", self: true },
            attendees: [
              { email: "other@example.com", self: true, responseStatus: "declined" },
              { email: PERSONAL.toUpperCase(), responseStatus: "needsAction" },
            ],
            guestsCanSeeOtherGuests: false,
          }),
        ],
      }),
    },
  });
  const result = await resultOf(
    await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] }),
  );
  expect(result.calendars[0]!.events![0]).toMatchObject({
    my_response: "accepted",
    guest_count: 1,
  });
  expect(result.calendars[0]!.events![1]).not.toHaveProperty("my_response");
  expect(result.calendars[0]!.events![1]).not.toHaveProperty("guests_hidden");
  expect(result.calendars[0]!.events![2]).toMatchObject({ guests_hidden: true, guest_count: 0 });
  expect(result.calendars[1]!.events![0]).toMatchObject({
    my_response: "needs_action",
    guest_count: 2,
    guests_hidden: true,
  });
});

it("maps each requested special event type without labeling regular events", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({
    [PERSONAL]: {
      list: Response.json({
        items: ["default", "outOfOffice", "focusTime", "birthday", "fromGmail"].map(
          (eventType, i) => eventFixture({ id: `e${i}`, eventType }),
        ),
      }),
    },
  });
  expect(
    (await resultOf(await searchCall(f))).calendars[0]!.events!.map((event) => event.type),
  ).toEqual([undefined, "out_of_office", "focus_time", "birthday", "from_gmail"]);
});

it("ends a per-calendar timeout and preserves another calendar's answer", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const entered = deferred();
  eventsFake({
    [PERSONAL]: { list: Response.json({}) },
    [SECONDARY_CALENDAR.id]: {
      list: (request) => {
        entered.resolve();
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await resultOf(await pending)).calendars).toEqual([
    { calendar: PERSONAL, events: [] },
    {
      calendar: SECONDARY_CALENDAR.id,
      error: { code: "google_unavailable", message: unavailableMessage(PERSONAL) },
    },
  ]);
});

it("reads the calendar list alone, refreshes once, and completes twenty calendars with at most five requests at once", async () => {
  const f = await eventsFixture("search_events", "allow", { access_expires_at: Date.now() - 1 });
  const ids = Array.from({ length: 20 }, (_, i) => `calendar-${i}`);
  let listDone = false;
  calendarFake(() => {
    expect(google.refreshTokens).toHaveLength(1);
    listDone = true;
    return list(PRIMARY_CALENDAR, ...ids.map((id) => ({ id, accessRole: "reader" })));
  });
  let active = 0;
  let peak = 0;
  const sent = eventsFake(
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          list: async () => {
            expect(listDone).toBe(true);
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            return Response.json({});
          },
        },
      ]),
    ),
  );
  const before = performance.now();
  const result = await resultOf(await searchCall(f, { calendars: ids }));
  expect(performance.now() - before).toBeLessThan(20_000);
  expect(result.calendars).toEqual(ids.map((calendar) => ({ calendar, events: [] })));
  expect(sent).toHaveLength(20);
  expect(peak).toBe(5);
  expect(google.refreshTokens).toHaveLength(1);
});

const largeEvent = (i: number) =>
  eventFixture({
    id: String(i).padStart(1024, "a"),
    recurringEventId: "s".repeat(1024),
    summary: '"'.repeat(200),
    location: "\\".repeat(200),
    organizer: { email: `${"e".repeat(242)}@example.com` },
  });
it("fits fifty short events from each of two calendars below thirty thousand characters without a size cut", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const items = Array.from({ length: 50 }, (_, i) =>
    eventFixture({ id: `e${i}`, summary: "Planning with the project team" }),
  );
  const sent = eventsFake({
    [PERSONAL]: { list: Response.json({ items }) },
    [SECONDARY_CALENDAR.id]: { list: Response.json({ items }) },
  });
  const rpc = await rpcResult(
    await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id], limit: 50 }),
  );
  expect(rpc.isError).toBeUndefined();
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(text.length).toBeLessThan(30_000);
  const result = JSON.parse(text) as SearchResult;
  expect(result.calendars.map((calendar) => calendar.events?.length)).toEqual([50, 50]);
  expect(
    result.calendars.every(
      (calendar) => calendar.not_read === undefined && calendar.next_page === undefined,
    ),
  ).toBe(true);
  expect(result.note).toBeUndefined();
  expect(sent).toHaveLength(2);
});

it.each([
  'next"page',
  "next\\page",
  "next\npage",
  "nextpage\n",
  "next\u0000page",
  "next\u007fpage",
  "nextépage",
])(
  "treats an escaped or non-printable-ASCII Google page token as a malformed answer: %j",
  async (token) => {
    const f = await eventsFixture();
    calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
    eventsFake({
      [PERSONAL]: { list: Response.json({ items: [eventFixture()] }) },
      [SECONDARY_CALENDAR.id]: { list: Response.json({ nextPageToken: token }) },
    });
    const result = await resultOf(
      await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id] }),
    );
    expect(result.calendars[1]).toEqual({
      calendar: SECONDARY_CALENDAR.id,
      error: { code: "google_unavailable", message: unavailableMessage(PERSONAL) },
    });
  },
);

it("accepts a maximum-length Google token containing every permitted printable ASCII character", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  const token = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
    .filter((character) => character !== '"' && character !== "\\")
    .join("")
    .repeat(22)
    .slice(0, 2000);
  expect(token).toHaveLength(2000);
  expect(JSON.stringify(token).length).toBe(2002);
  eventsFake({ [PERSONAL]: { list: Response.json({ nextPageToken: token }) } });
  expect((await resultOf(await searchCall(f))).calendars).toEqual([
    { calendar: PERSONAL, events: [], next_page: token },
  ]);
});

it("reserves the next_page property as well as its token when the original page has no continuation", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  const token = "p".repeat(2000);
  const ids = Array.from({ length: 29 }, (_, i) => String(i).padEnd(825, "a"));
  const expectedEvent = (event: string) => ({
    event,
    title: "Planning",
    start: "2026-11-20T09:00:00-05:00",
    end: "2026-11-20T10:00:00-05:00",
    all_day: false,
    organizer: PERSONAL,
    guest_count: 0,
  });
  const candidate = {
    account: PERSONAL,
    time_zone: "America/Bogota",
    calendars: [
      {
        calendar: PERSONAL,
        events: [...ids.map(expectedEvent), expectedEvent("z")],
        next_page: token,
      },
    ],
    note: "The result reached its size limit; call again for each calendar with next_page or not_read.",
  };
  // This last ID makes a 30-event continuation exactly five characters too large.
  const lastId = "z".padEnd(1 + 32_005 - JSON.stringify(candidate).length, "b");
  expect(lastId.length).toBeGreaterThan(1);
  expect(lastId.length).toBeLessThanOrEqual(1024);
  candidate.calendars[0]!.events[29] = expectedEvent(lastId);
  expect(JSON.stringify(candidate).length).toBe(32_005);
  const items = [...ids, lastId, "would-not-fit"].map((id) => eventFixture({ id }));
  const sent = eventsFake({
    [PERSONAL]: {
      list: (request) =>
        new URL(request.url).searchParams.get("maxResults") === "50"
          ? Response.json({ items })
          : Response.json({ nextPageToken: token }),
    },
  });
  const rpc = await rpcResult(await searchCall(f, { limit: 50 }));
  expect(rpc.isError).toBeUndefined();
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(text.length).toBeLessThanOrEqual(32_000);
  const result = JSON.parse(text) as SearchResult;
  expect(result.calendars[0]!.events).toHaveLength(29);
  expect(result.calendars[0]!.next_page).toBe(token);
  expect(sent).toHaveLength(2);
  expect(new URL(sent[1]!.url).searchParams.get("maxResults")).toBe("29");
});
it("cuts the serialized result, counts filtered items in the one re-request, and returns Google's continuation with later calendars not_read", async () => {
  const f = await eventsFixture();
  const ids = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(254, "c"));
  calendarFake(list(PRIMARY_CALENDAR, ...ids.map((id) => ({ id, accessRole: "reader" }))));
  const items = [
    { id: "cancelled", status: "cancelled" },
    eventFixture({ id: "filtered", start: { date: "2026-11-18" }, end: { date: "2026-11-19" } }),
    ...Array.from({ length: 48 }, (_, i) => largeEvent(i)),
  ];
  const sent = eventsFake(
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          list: (request) =>
            new URL(request.url).searchParams.get("maxResults") === "50"
              ? Response.json({ items, nextPageToken: "google-next-token" })
              : Response.json({ nextPageToken: "p".repeat(2000) }),
        },
      ]),
    ),
  );
  const rpc = await rpcResult(
    await searchCall(f, { calendars: ids, limit: 50, query: "q".repeat(500) }),
  );
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(rpc.isError).toBeUndefined();
  expect(text.length).toBeLessThanOrEqual(32_000);
  const result = JSON.parse(text) as SearchResult;
  const first = result.calendars[0]!;
  expect(first.events!.length).toBeGreaterThan(0);
  expect(first.events!.length).toBeLessThan(48);
  expect(first.next_page).toBe("p".repeat(2000));
  expect(result.calendars.slice(1)).toEqual(
    ids.slice(1).map((calendar) => ({ calendar, not_read: true })),
  );
  expect(result.note).toMatch(/size limit.*next_page or not_read/);
  const retry = sent.filter(
    (request) => new URL(request.url).searchParams.get("maxResults") !== "50",
  );
  expect(retry).toHaveLength(1);
  expect(new URL(retry[0]!.url).searchParams.get("maxResults")).toBe(
    String(first.events!.length + 2),
  );
  expect(new URL(retry[0]!.url).searchParams.has("pageToken")).toBe(false);
  for (const event of first.events!) {
    expect(JSON.stringify(event.title).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(event.location).length).toBeLessThanOrEqual(200);
    expect(String(event.title)).toMatch(/…$/);
  }
});

it("marks a calendar not_read without re-requesting when its first Google item cannot fit", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR, { id: "later", accessRole: "reader" }));
  const sent = eventsFake({
    [PERSONAL]: {
      list: Response.json({ items: Array.from({ length: 10 }, (_, i) => largeEvent(i)) }),
    },
    [SECONDARY_CALENDAR.id]: { list: Response.json({ items: [largeEvent(99)] }) },
    later: { list: Response.json({}) },
  });
  const result = await resultOf(
    await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id, "later"] }),
  );
  expect(result.calendars[0]!.events).toHaveLength(10);
  expect(result.calendars.slice(1)).toEqual([
    { calendar: SECONDARY_CALENDAR.id, not_read: true },
    { calendar: "later", not_read: true },
  ]);
  expect(sent).toHaveLength(3);
  expect(result.note).toBeDefined();
});

it("fails as a tool error if the size-cut re-request leaves every calendar in error", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({
    [PERSONAL]: {
      list: (request) =>
        new URL(request.url).searchParams.get("maxResults") === "50"
          ? Response.json({ items: Array.from({ length: 50 }, (_, i) => largeEvent(i)) })
          : new Response(null, { status: 503 }),
    },
  });
  await expectError(
    await searchCall(f, { limit: 50 }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect(sent).toHaveLength(2);
});

it("reserves escaped calendar errors and marks later calendars not_read when the envelopes fill the result", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = eventsFake({ [PERSONAL]: { list: Response.json({}) } });
  const ids = Array.from({ length: 19 }, (_, i) => String(i).padEnd(254, "\u0000"));
  const rpc = await rpcResult(await searchCall(f, { calendars: [PERSONAL, ...ids] }));
  expect(rpc.isError).toBeUndefined();
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(text.length).toBeLessThanOrEqual(32_000);
  const result = JSON.parse(text) as SearchResult;
  expect(result.calendars[0]).toEqual({ calendar: PERSONAL, events: [] });
  expect(result.calendars.some((calendar) => calendar.error?.code === "not_found")).toBe(true);
  expect(result.calendars.at(-1)).toMatchObject({ not_read: true });
  expect(result.note).toMatch(/size limit/);
  expect(sent).toHaveLength(1);
});

it("keeps twenty 254-character unlisted IDs below the MCP result budget without any events request", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  const text = await expectError(
    await searchCall(f, {
      calendars: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(254, '"')),
    }),
    "not_found",
    unlistedMessage,
  );
  expect(text.length).toBeLessThanOrEqual(32_000);
  expect(paths()).toEqual(["/calendar/v3/users/me/calendarList"]);
});

it.each([
  { field: "account", value: 1 },
  { field: "calendars", value: [] },
  { field: "calendars", value: [""] },
  { field: "calendars", value: ["c".repeat(255)] },
  { field: "calendars", value: Array.from({ length: 21 }, () => PERSONAL) },
  { field: "from", value: "2026-02-30" },
  { field: "to", value: "1899-01-01" },
  { field: "time_zone", value: "+05:00" },
  { field: "query", value: "" },
  { field: "query", value: "q".repeat(501) },
  { field: "limit", value: 0 },
  { field: "limit", value: 51 },
  { field: "limit", value: 1.5 },
  { field: "page", value: "" },
  { field: "page", value: "p".repeat(2001) },
])("refuses invalid $field before creating an approval %#", async ({ field, value }) => {
  const f = await eventsFixture("search_events", "ask");
  await expectError(
    await searchCall(f, { [field]: value }),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(await rows()).toEqual([]);
  expect(paths()).toEqual([]);
});

it.each([
  { from: "2026-11-21", to: "2026-11-20" },
  { from: "2026-11-20T15:00", to: "2026-11-20T14:00" },
  { from: "2026-11-20T15:00Z", to: "2026-11-20T16:00+02:00" },
  { from: "2026-11-20T15:00", to: "2026-11-20T19:00Z", time_zone: "America/Bogota" },
])("refuses an inverted range before an approval exists %#", async (args) => {
  const f = await eventsFixture("search_events", "ask");
  await expectError(await searchCall(f, args), "invalid_arguments", /The to field/);
  expect(await rows()).toEqual([]);
  expect(paths()).toEqual([]);
});

it("checks a mixed floating and instant range after reading the primary zone", async () => {
  const f = await eventsFixture();
  calendarFake(list(PRIMARY_CALENDAR));
  await expectError(
    await searchCall(f, { from: "2026-11-20T15:00", to: "2026-11-20T19:00Z" }),
    "invalid_arguments",
    /The to field/,
  );
  expect(paths()).toEqual(["/calendar/v3/users/me/calendarList"]);
});

it("refuses page with several calendars before approval, and a page Google refuses names page", async () => {
  const f = await eventsFixture("search_events", "ask");
  await expectError(
    await searchCall(f, { calendars: [PERSONAL, SECONDARY_CALENDAR.id], page: "next" }),
    "invalid_arguments",
    /The page field/,
  );
  expect(await rows()).toEqual([]);
  await setTool(f, "search_events", "allow");
  calendarFake(list(PRIMARY_CALENDAR));
  eventsFake({ [PERSONAL]: { list: new Response(null, { status: 400 }) } });
  await expectError(
    await searchCall(f, { page: "refused" }),
    "invalid_arguments",
    "The page field must be the next_page value of an earlier result.",
  );
});

it.each(["search_events", "read_event"])(
  "defaults %s to deny and distinguishes an unavailable account from a denied tool",
  async (tool) => {
    const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES) });
    const call = () => (tool === "search_events" ? searchCall(f) : readEventCall(f));
    await expectError(await call(), "account_not_available", /No account/);
    await setTool(f, "list_calendars", "allow");
    await expectError(await call(), "tool_not_allowed", new RegExp(`has not allowed ${tool}`));
    expect(paths()).toEqual([]);
  },
);

it.each(
  ["search_events", "read_event"].flatMap((tool) =>
    problemCases.map((problem) => ({ tool, ...problem })),
  ),
)("refuses $tool at Calendar status $status before Google", async ({ tool, row, status }) => {
  const f = await eventsFixture(tool, "allow", row);
  await expectError(
    tool === "search_events" ? await searchCall(f) : await readEventCall(f),
    `account_${status}`,
    status === "missing_access"
      ? /no Calendar access/
      : new RegExp(
          status === "needs_reconnect"
            ? "reconnect"
            : status === "blocked_by_admin"
              ? "admin blocked"
              : "stored access",
        ),
  );
  expect(paths()).toEqual([]);
});
