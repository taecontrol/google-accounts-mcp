import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { Result } from "effect";
import { availabilityEntries } from "../src/google/availability";
import { answer, approve, get, page, rows } from "./support/approvals";
import {
  calendarFake,
  eventsFixture,
  freeBusyFake,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
} from "./support/calendar";
import {
  callRows,
  expectError,
  fixture,
  PERSONAL,
  toolCall,
  unavailableMessage,
} from "./support/permissions";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";
import { google } from "./support/google";

interface AvailabilityResult {
  account: string;
  time_zone: string;
  calendars: Array<{
    calendar: string;
    busy?: Array<{ start: string; end: string }>;
    error?: { code: string; message: string };
  }>;
}
const call = (f: Awaited<ReturnType<typeof fixture>>, args: Record<string, unknown> = {}) =>
  toolCall(f.mcp, "check_availability", {
    account: PERSONAL,
    from: "2026-11-20",
    to: "2026-11-21",
    ...args,
  });
const resultOf = async (response: Response) =>
  (await answer(response)) as unknown as AvailabilityResult;
const list = (...items: object[]) => Response.json({ items });
const calendarPaths = () =>
  requests
    .filter((url) => url.startsWith("https://www.googleapis.com/calendar/v3/"))
    .map((url) => new URL(url).pathname);
const body = (calendars: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  timeMin: "2026-01-01T00:00:00Z",
  timeMax: "2027-01-01T00:00:00Z",
  calendars,
  ...overrides,
});
const missingMessage =
  "Google's answer has no entry for this exact ID. Use the ID as list_calendars returns it, or the person's address.";
const inaccessibleMessage =
  "Google cannot check this calendar: it does not exist, or this account cannot see its busy times.";
const unlistedMessage =
  "No such calendar in the account's Google Calendar list; leave calendars out to use the primary calendar, or use IDs from list_calendars.";
const groupMessage =
  "This ID is a group; check_availability does not expand groups. Name each person's address instead.";
const budgetMessage =
  "Too many busy times to fit in one result (at most 150). Shorten the range or name fewer calendars. Name the calendars that matter most first.";
const mapped = (answer: unknown, ids = ["good", "bad"]) => {
  const result = availabilityEntries(
    answer,
    ids,
    { from: Date.parse("2026-11-20T05:00:00Z"), to: Date.parse("2026-11-21T05:00:00Z") },
    PERSONAL,
    "America/Bogota",
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const busyTimes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    start: new Date(Date.UTC(2026, 10, 20, 6, i)).toISOString(),
    end: new Date(Date.UTC(2026, 10, 20, 6, i, 30)).toISOString(),
  }));

it("defaults to the primary's real ID and zone, clips both ends, sorts busy times, and returns no event details", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  const sent = freeBusyFake(
    Response.json(
      body(
        {
          [PERSONAL]: {
            busy: [
              { start: "2026-11-21T04:00:00Z", end: "2026-11-21T06:00:00Z" },
              { start: "2026-11-20T13:00:12Z", end: "2026-11-20T14:00:34Z", title: "Private" },
              { start: "2026-11-20T04:00:00Z", end: "2026-11-20T05:30:00Z" },
              { start: "2026-11-20T04:00:00Z", end: "2026-11-20T05:00:00Z" },
              { start: "2026-11-21T05:00:00Z", end: "2026-11-21T06:00:00Z" },
            ],
            summary: "Never disclose this calendar's events",
          },
        },
        { timeMin: "2026-11-20T05:00:00Z", timeMax: "2026-11-21T05:00:00Z" },
      ),
    ),
  );
  expect(await resultOf(await call(f))).toEqual({
    account: PERSONAL,
    time_zone: "America/Bogota",
    calendars: [
      {
        calendar: PERSONAL,
        busy: [
          { start: "2026-11-20T00:00:00-05:00", end: "2026-11-20T00:30:00-05:00" },
          { start: "2026-11-20T08:00:12-05:00", end: "2026-11-20T09:00:34-05:00" },
          { start: "2026-11-20T23:00:00-05:00", end: "2026-11-21T00:00:00-05:00" },
        ],
      },
    ],
  });
  expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList", "/calendar/v3/freeBusy"]);
  expect(sent).toHaveLength(1);
  expect(await sent[0]!.json()).toEqual({
    timeMin: "2026-11-20T05:00:00.000Z",
    timeMax: "2026-11-21T05:00:00.000Z",
    items: [{ id: PERSONAL }],
  });
  expect(sent[0]!.method).toBe("POST");
  expect(sent[0]!.redirect).toBe("manual");
  expect(sent[0]!.headers.get("Authorization")).toMatch(/^Bearer /);
  expect(sent[0]!.headers.get("Content-Type")).toBe("application/json");
  expect((await callRows()).at(-1)).toMatchObject({
    tool: "check_availability",
    account_id: f.personal.id,
    connection_id: f.connection.id,
    outcome: "success",
    reason: null,
  });
});

it("sends busy-only and unlisted IDs in call order, excludes primary, and ignores unnamed calendars and group members", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(
    list(PRIMARY_CALENDAR, { id: "busy", summary: "Busy", accessRole: "freeBusyReader" }),
  );
  const sent = freeBusyFake(
    Response.json(
      body(
        {
          member: { busy: [] },
          busy: { busy: [] },
          "sam@work.example.com": { busy: [] },
          "SAM@work.example.com": { busy: [] },
        },
        { groups: { unrequested: { calendars: ["member"] } } },
      ),
    ),
  );
  const result = await resultOf(
    await call(f, {
      calendars: ["sam@work.example.com", "SAM@work.example.com", "primary", "busy"],
    }),
  );
  expect(result.calendars).toEqual([
    { calendar: "sam@work.example.com", busy: [] },
    { calendar: "SAM@work.example.com", busy: [] },
    { calendar: "primary", error: { code: "not_found", message: unlistedMessage } },
    { calendar: "busy", busy: [] },
  ]);
  expect(await sent[0]!.json()).toMatchObject({
    items: [{ id: "sam@work.example.com" }, { id: "SAM@work.example.com" }, { id: "busy" }],
  });
  expect(sent).toHaveLength(1);
});

it.each([
  {
    name: "a group key even when calendars has the same key",
    entry: { busy: [] },
    groups: { bad: { calendars: ["member"] } },
    code: "invalid_arguments",
    message: groupMessage,
  },
  { name: "a missing exact key", code: "not_found", message: missingMessage },
  {
    name: "a key in another case",
    extra: { BAD: { busy: [] } },
    code: "not_found",
    message: missingMessage,
  },
  {
    name: "notFound among other errors",
    entry: {
      errors: [
        { domain: "global", reason: "internalError" },
        { domain: "global", reason: "groupTooBig" },
        { domain: "global", reason: "notFound" },
      ],
    },
    code: "not_found",
    message: inaccessibleMessage,
  },
  {
    name: "an unknown reason",
    entry: { errors: [{ domain: "global", reason: "futureReason" }], busy: busyTimes(1) },
    code: "google_unavailable",
  },
  {
    name: "errors next to busy times",
    entry: { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
    code: "not_found",
    message: inaccessibleMessage,
  },
  {
    name: "groupTooBig before a malformed busy list",
    entry: { errors: [{ domain: "global", reason: "groupTooBig" }], busy: "bad" },
    code: "invalid_arguments",
    message: groupMessage,
  },
  {
    name: "notFound without a domain, as the observation recorded it",
    entry: { errors: [{ reason: "notFound" }], busy: [] },
    code: "not_found",
    message: inaccessibleMessage,
  },
  {
    name: "an impossible busy date that date arithmetic would move into the range",
    entry: { busy: [{ start: "2026-10-51T06:00:00Z", end: "2026-11-20T07:00:00Z" }] },
    code: "google_unavailable",
  },
  { name: "missing busy", entry: {}, code: "google_unavailable" },
  { name: "a malformed calendar", entry: null, code: "google_unavailable" },
  { name: "malformed errors", entry: { errors: "bad", busy: [] }, code: "google_unavailable" },
  { name: "a malformed busy list", entry: { busy: {} }, code: "google_unavailable" },
  {
    name: "an unparseable busy instant",
    entry: { busy: [{ start: "not a time", end: "2026-11-20T07:00:00Z" }] },
    code: "google_unavailable",
  },
  {
    name: "a floating busy time",
    entry: { busy: [{ start: "2026-11-20T06:00:00", end: "2026-11-20T07:00:00Z" }] },
    code: "google_unavailable",
  },
  {
    name: "an inverted busy interval even outside the requested range",
    entry: { busy: [{ start: "2026-11-19T07:00:00Z", end: "2026-11-19T06:00:00Z" }] },
    code: "google_unavailable",
  },
  {
    name: "an empty busy interval",
    entry: { busy: [{ start: "2026-11-20T06:00:00Z", end: "2026-11-20T06:00:00Z" }] },
    code: "google_unavailable",
  },
])("never reads $name as free", ({ entry, extra, groups, code, message }) => {
  expect(
    mapped(
      body(
        {
          good: { errors: [], busy: [] },
          ...(entry === undefined ? {} : { bad: entry }),
          ...extra,
        },
        groups === undefined ? {} : { groups },
      ),
    ),
  ).toEqual([
    { calendar: "good", busy: [] },
    { calendar: "bad", error: { code, message: message ?? unavailableMessage(PERSONAL) } },
  ]);
});

it("widens busy times with fractions of a second to whole seconds instead of shrinking them", () => {
  expect(
    mapped(
      body({
        good: { busy: [{ start: "2026-11-20T06:00:00.100Z", end: "2026-11-20T06:00:00.900Z" }] },
        bad: { busy: [{ start: "2026-11-20T07:00:00.000Z", end: "2026-11-20T07:30:00.000001Z" }] },
      }),
    ),
  ).toEqual([
    {
      calendar: "good",
      busy: [{ start: "2026-11-20T01:00:00-05:00", end: "2026-11-20T01:00:01-05:00" }],
    },
    {
      calendar: "bad",
      busy: [{ start: "2026-11-20T02:00:00-05:00", end: "2026-11-20T02:30:01-05:00" }],
    },
  ]);
});

it.each([
  { timeMin: "2026-11-20T05:00:00.5Z" },
  { timeMax: "2026-11-21T04:59:59.999Z" },
  { timeMin: "2026-11-20T05:00:01Z" },
  { timeMax: "2026-11-21T04:59:59Z" },
  { timeMin: "2026-11-20T05:00:00" },
  { timeMax: "invalid" },
  { calendars: null },
  { calendars: [] },
  { calendars: undefined },
  { groups: null },
])("fails the call for an incomplete range or malformed envelope %#", async (overrides) => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  freeBusyFake(Response.json(body({ [PERSONAL]: { busy: [] } }, overrides)));
  await expectError(await call(f), "google_unavailable", unavailableMessage(PERSONAL));
});

it("fills the busy-time budget in call order after clipping, skips whole calendars, and still fits a later smaller one", () => {
  const outside = Array.from({ length: 60 }, () => ({
    start: "2026-11-19T06:00:00Z",
    end: "2026-11-19T07:00:00Z",
  }));
  const result = mapped(
    body({
      first: { busy: [...outside, ...busyTimes(100)] },
      second: { busy: busyTimes(51) },
      third: { busy: busyTimes(50) },
    }),
    ["first", "second", "third"],
  );
  expect(result[0]).toMatchObject({ calendar: "first", busy: expect.any(Array) });
  expect("busy" in result[0]! && result[0].busy).toHaveLength(100);
  expect(result[1]).toEqual({
    calendar: "second",
    error: { code: "invalid_arguments", message: budgetMessage },
  });
  expect("busy" in result[2]! && result[2].busy).toHaveLength(50);
});

it.each([
  {
    calendars: { first: { errors: [{ domain: "global", reason: "notFound" }] } },
    code: "not_found",
    message: inaccessibleMessage,
  },
  {
    calendars: { second: { errors: [{ domain: "global", reason: "groupTooBig" }] } },
    code: "invalid_arguments",
    message: groupMessage,
  },
  {
    calendars: { second: {} },
    code: "google_unavailable",
    message: unavailableMessage(PERSONAL),
  },
  {
    calendars: { first: {}, second: { errors: [{ domain: "global", reason: "notFound" }] } },
    code: "google_unavailable",
    message: unavailableMessage(PERSONAL),
  },
  {
    calendars: {
      first: { errors: [{ domain: "global", reason: "groupTooBig" }] },
      second: { errors: [{ domain: "global", reason: "notFound" }] },
    },
    code: "invalid_arguments",
    message: groupMessage,
  },
  {
    calendars: {
      first: { busy: busyTimes(151) },
      second: { errors: [{ domain: "global", reason: "groupTooBig" }] },
    },
    code: "invalid_arguments",
    message: budgetMessage,
  },
])(
  "returns a tool error with $code when every calendar fails %#",
  async ({ calendars, code, message }) => {
    const f = await eventsFixture("check_availability");
    calendarFake(list(PRIMARY_CALENDAR));
    freeBusyFake(Response.json(body(calendars)));
    await expectError(await call(f, { calendars: ["first", "second"] }), code, message);
  },
);

it("uses an explicit call zone across DST for busy instants without sending the zone to Google", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  const sent = freeBusyFake(
    Response.json(
      body({
        [SECONDARY_CALENDAR.id]: {
          busy: [{ start: "2026-03-08T06:30:00Z", end: "2026-03-08T07:30:00Z" }],
        },
      }),
    ),
  );
  expect(
    await resultOf(
      await call(f, {
        from: "2026-03-08",
        to: "2026-03-09",
        time_zone: "America/New_York",
        calendars: [SECONDARY_CALENDAR.id],
      }),
    ),
  ).toEqual({
    account: PERSONAL,
    time_zone: "America/New_York",
    calendars: [
      {
        calendar: SECONDARY_CALENDAR.id,
        busy: [{ start: "2026-03-08T01:30:00-05:00", end: "2026-03-08T03:30:00-04:00" }],
      },
    ],
  });
  expect(await sent[0]!.json()).toEqual({
    timeMin: "2026-03-08T05:00:00.000Z",
    timeMax: "2026-03-09T04:00:00.000Z",
    items: [{ id: SECONDARY_CALENDAR.id }],
  });
});

it("converts Google UTC and offset busy times to the call's zone and keeps its spelling", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  freeBusyFake(
    Response.json(
      body({
        [PERSONAL]: {
          busy: [
            { start: "2026-11-20T06:00:00Z", end: "2026-11-20T06:00:30Z" },
            { start: "2026-11-20T16:00:00+09:00", end: "2026-11-20T16:00:30+09:00" },
          ],
        },
      }),
    ),
  );
  const result = await resultOf(await call(f, { time_zone: "america/new_york" }));
  expect(result.time_zone).toBe("america/new_york");
  expect(result.calendars[0]!.busy).toEqual([
    { start: "2026-11-20T01:00:00-05:00", end: "2026-11-20T01:00:30-05:00" },
    { start: "2026-11-20T02:00:00-05:00", end: "2026-11-20T02:00:30-05:00" },
  ]);
});

it("converts an all-day busy interval in another calendar's zone without aligning it to the call's days", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR, SECONDARY_CALENDAR));
  freeBusyFake(
    Response.json(
      body({
        [SECONDARY_CALENDAR.id]: {
          busy: [{ start: "2026-11-20T00:00:00+09:00", end: "2026-11-21T00:00:00+09:00" }],
        },
      }),
    ),
  );
  expect(
    await resultOf(
      await call(f, {
        from: "2026-11-19",
        to: "2026-11-21",
        calendars: [SECONDARY_CALENDAR.id],
      }),
    ),
  ).toEqual({
    account: PERSONAL,
    time_zone: "America/Bogota",
    calendars: [
      {
        calendar: SECONDARY_CALENDAR.id,
        busy: [{ start: "2026-11-19T10:00:00-05:00", end: "2026-11-20T10:00:00-05:00" }],
      },
    ],
  });
});

it.each(["America/New_York", "UTC"])(
  "checks a 31-day instant range on the primary's %s wall clock at run time",
  async (zone) => {
    const f = await eventsFixture("check_availability");
    calendarFake(list({ ...PRIMARY_CALENDAR, timeZone: zone }));
    const sent = freeBusyFake(Response.json(body({ [PERSONAL]: { busy: [] } })));
    const response = await call(f, { from: "2026-10-15T04:00:00Z", to: "2026-11-15T05:00:00Z" });
    if (zone === "America/New_York") {
      expect(await resultOf(response)).toEqual({
        account: PERSONAL,
        time_zone: zone,
        calendars: [{ calendar: PERSONAL, busy: [] }],
      });
      expect(sent).toHaveLength(1);
    } else {
      await expectError(
        response,
        "invalid_arguments",
        "The to field must be at most 31 days after from.",
      );
      expect(sent).toEqual([]);
    }
  },
);

it.each([
  { field: "account", value: 1 },
  { field: "calendars", value: [] },
  { field: "calendars", value: [""] },
  { field: "calendars", value: ["c".repeat(255)] },
  { field: "calendars", value: Array.from({ length: 21 }, (_, i) => `c${i}`) },
  { field: "calendars", value: [PERSONAL, PERSONAL] },
  { field: "calendars", value: ["sam@work.example.com\nbob@work.example.com"] },
  { field: "calendars", value: ["sam@work.example.com\u2028bob@work.example.com"] },
  { field: "calendars", value: ["sam@work.example.com\u0000"] },
  { field: "from", value: "2026-02-30" },
  { field: "to", value: "3000-01-01" },
  { field: "time_zone", value: "Unknown/Zone" },
  { field: "time_zone", value: "+05:00" },
])("refuses invalid $field before creating an approval %#", async ({ field, value }) => {
  const f = await eventsFixture("check_availability", "ask");
  await expectError(
    await call(f, { [field]: value }),
    "invalid_arguments",
    new RegExp(`The ${field} field`),
  );
  expect(await rows()).toEqual([]);
  expect(calendarPaths()).toEqual([]);
});

it.each([
  { from: "2026-11-21", to: "2026-11-20" },
  { from: "2026-11-20T15:00", to: "2026-11-20T14:00" },
  { from: "2026-11-20T15:00Z", to: "2026-11-20T16:00+02:00" },
  { from: "2026-11-20T15:00", to: "2026-11-20T19:00Z", time_zone: "America/Bogota" },
  { from: "2026-11-20", to: "2026-12-22" },
  { from: "2026-11-20", to: "2026-12-21T00:00:01" },
  { from: "2026-10-15T04:00Z", to: "2026-11-15T05:00Z", time_zone: "UTC" },
  { from: "2026-02-20", to: "2026-03-23T00:00:01", time_zone: "America/New_York" },
])("refuses an inverted or oversized zone-independent range before approval %#", async (args) => {
  const f = await eventsFixture("check_availability", "ask");
  await expectError(await call(f, args), "invalid_arguments", /The to field/);
  expect(await rows()).toEqual([]);
  expect(calendarPaths()).toEqual([]);
});

it("accepts exactly 31 wall-clock days across fall DST before approval, even with 745 elapsed hours", async () => {
  const f = await eventsFixture("check_availability", "ask");
  const pending = await answer(
    await call(f, {
      from: "2026-10-15T04:00:00Z",
      to: "2026-11-15T05:00:00Z",
      time_zone: "America/New_York",
    }),
  );
  expect(pending.status).toBe("pending");
  expect(await rows()).toHaveLength(1);
  expect(calendarPaths()).toEqual([]);
});

it.each([
  { from: "2026-11-20T15:00", to: "2026-11-20T19:00Z", message: /The to field.*after from/ },
  { from: "2026-11-20", to: "2026-12-21T06:00:00Z", message: /The to field.*at most 31 days/ },
])(
  "checks mixed local and instant ranges after reading the primary zone %#",
  async ({ message, ...args }) => {
    const f = await eventsFixture("check_availability");
    calendarFake(list(PRIMARY_CALENDAR));
    await expectError(await call(f, args), "invalid_arguments", message);
    expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList"]);
  },
);

it("refuses primary without a freebusy request even if Google lists that literal alias", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR, { id: "primary", primary: false, accessRole: "owner" }));
  await expectError(await call(f, { calendars: ["primary"] }), "not_found", unlistedMessage);
  expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList"]);
});

it.each([
  { args: { time_zone: "UTC" }, code: "not_found", message: unlistedMessage },
  { args: {}, code: "invalid_arguments", message: /The time_zone field/ },
])(
  "preserves the missing-primary error $code without a busy request",
  async ({ args, code, message }) => {
    const f = await eventsFixture("check_availability");
    calendarFake(list(SECONDARY_CALENDAR));
    await expectError(await call(f, args), code, message);
    expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList"]);
  },
);

it("shows listed calendars and other IDs with their sources at ask, reads no busy times until approval, and records the approved result", async () => {
  const f = await eventsFixture("check_availability", "ask");
  calendarFake(
    ...Array.from(
      { length: 5 },
      () => () =>
        list(
          { ...PRIMARY_CALENDAR, summary: "Personal\nFake heading" },
          { id: "busy", summary: "Busy\nAnother heading", accessRole: "freeBusyReader" },
        ),
    ),
  );
  const sent = freeBusyFake(
    Response.json(
      body({
        [PERSONAL]: { busy: [] },
        busy: { busy: [] },
        "sam@work.example.com": { busy: busyTimes(1) },
      }),
    ),
  );
  const pending = await answer(
    await call(f, { calendars: ["sam@work.example.com", "busy", "primary", PERSONAL] }),
  );
  expect(pending.status).toBe("pending");
  const id = pending.approval as string;
  expect(calendarPaths()).toEqual([]);
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
  expect(view.request.tool).toMatchObject({ action: "check the busy times", joiner: "of" });
  expect(view.request.values).toEqual([
    {
      name: "Calendars",
      text: `Busy Another heading (busy)\nPersonal Fake heading (${PERSONAL})`,
      from: "calendar",
    },
    { name: "Other calendars and people", text: "sam@work.example.com\nprimary", from: "agent" },
    {
      name: "Range",
      text: "Nov 20, 2026 at 00:00 to Nov 21, 2026 at 00:00 (America/Bogota)",
      from: "agent",
    },
  ]);
  expect(sent).toEqual([]);
  expect((await callRows()).find((row) => row.tool === "check_availability")).toMatchObject({
    outcome: "pending",
  });
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect(await get(f, id)).toMatchObject({
    status: "success",
    result: {
      account: PERSONAL,
      time_zone: "America/Bogota",
      calendars: [
        {
          calendar: "sam@work.example.com",
          busy: [{ start: "2026-11-20T01:00:00-05:00", end: "2026-11-20T01:00:30-05:00" }],
        },
        { calendar: "busy", busy: [] },
        { calendar: "primary", error: { code: "not_found", message: unlistedMessage } },
        { calendar: PERSONAL, busy: [] },
      ],
    },
  });
  expect(sent).toHaveLength(1);
  expect((await callRows()).find((row) => row.tool === "check_availability")).toMatchObject({
    outcome: "success",
    reason: null,
  });
});

it("shows an ID that differs from a listed one only in case as the agent gave it", async () => {
  const f = await eventsFixture("check_availability", "ask");
  calendarFake(list(PRIMARY_CALENDAR));
  const id = (await answer(await call(f, { calendars: [PERSONAL.toUpperCase()] })))
    .approval as string;
  expect((await page(f, id)).request.values.slice(0, 1)).toEqual([
    { name: "Other calendars and people", text: PERSONAL.toUpperCase(), from: "agent" },
  ]);
});

it("shows the default primary calendar in the approval view", async () => {
  const f = await eventsFixture("check_availability", "ask");
  calendarFake(list(PRIMARY_CALENDAR));
  const id = (await answer(await call(f))).approval as string;
  expect((await page(f, id)).request.values).toEqual([
    { name: "Calendars", text: `Personal (${PERSONAL})`, from: "calendar" },
    {
      name: "Range",
      text: "Nov 20, 2026 at 00:00 to Nov 21, 2026 at 00:00 (America/Bogota)",
      from: "agent",
    },
  ]);
  expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList"]);
});

it("defers a zone-dependent 31-day refusal until an approved run, with no busy request", async () => {
  const f = await eventsFixture("check_availability", "ask");
  calendarFake(
    ...Array.from({ length: 4 }, () => () => list({ ...PRIMARY_CALENDAR, timeZone: "UTC" })),
  );
  const id = (
    await answer(await call(f, { from: "2026-10-15T04:00:00Z", to: "2026-11-15T05:00:00Z" }))
  ).approval as string;
  expect((await approve(f, id)).state.kind).toBe("failed");
  expect((await get(f, id)).error).toEqual({
    code: "invalid_arguments",
    message: "The to field must be at most 31 days after from.",
  });
  expect(calendarPaths().every((path) => path === "/calendar/v3/users/me/calendarList")).toBe(true);
});

it.each([
  {
    response: new Response(null, { status: 404 }),
    code: "google_unavailable",
    message: unavailableMessage(PERSONAL),
  },
  {
    response: new Response(null, { status: 503 }),
    code: "google_unavailable",
    message: unavailableMessage(PERSONAL),
  },
  {
    response: new Response("not JSON"),
    code: "google_unavailable",
    message: unavailableMessage(PERSONAL),
  },
  {
    response: Response.json(
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
    code: "api_not_enabled",
    message: /Google Calendar API is not enabled/,
  },
])("records $code when the freebusy request fails %#", async ({ response, code, message }) => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  freeBusyFake(response);
  await expectError(await call(f), code, message);
  expect((await callRows()).at(-1)).toMatchObject({ outcome: "failed", reason: code });
});

it("rebuilds the POST with a fresh token after a 401", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  let count = 0;
  const sent = freeBusyFake(() =>
    ++count === 1
      ? new Response(null, { status: 401 })
      : Response.json(body({ [PERSONAL]: { busy: [] } })),
  );
  expect((await resultOf(await call(f))).calendars).toEqual([{ calendar: PERSONAL, busy: [] }]);
  expect(sent).toHaveLength(2);
  expect(await sent[0]!.json()).toEqual(await sent[1]!.json());
  expect(google.refreshTokens).toHaveLength(1);
});

it("fits 20 maximum-length calendar IDs and 150 busy times below 25,000 JSON characters", async () => {
  const f = await eventsFixture("check_availability");
  calendarFake(list(PRIMARY_CALENDAR));
  const ids = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(254, "c"));
  freeBusyFake(
    Response.json(
      body(Object.fromEntries(ids.map((id, i) => [id, { busy: busyTimes(i < 10 ? 8 : 7) }]))),
    ),
  );
  const rpc = await rpcResult(await call(f, { calendars: ids }));
  expect(rpc.isError).toBeUndefined();
  const text = (rpc.content as Array<{ text: string }>)[0]!.text;
  expect(text.length).toBeLessThan(25_000);
  const result = JSON.parse(text) as AvailabilityResult;
  expect(result.calendars.map((entry) => entry.calendar)).toEqual(ids);
  expect(result.calendars.reduce((count, entry) => count + entry.busy!.length, 0)).toBe(150);
});
