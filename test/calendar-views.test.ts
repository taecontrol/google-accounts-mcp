import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
import { TOOLS } from "../src/mcp/tools";
import { answer, approve, decided, digest, get, page, post } from "./support/approvals";
import {
  calendarFake,
  eventsFake,
  eventsFixture,
  eventFixture,
  PRIMARY_CALENDAR,
  SECONDARY_CALENDAR,
  readEventCall,
  searchCall,
} from "./support/calendar";
import { expectError, PERSONAL } from "./support/permissions";
import { requests } from "./support/network";
import { observeStatements } from "./support/db";
import { testEnv, textOf } from "./support/worker";

const list = (...items: object[]) => Response.json({ items });
const calendarPaths = () =>
  requests
    .filter((url) => url.startsWith("https://www.googleapis.com/calendar/v3/"))
    .map((url) => new URL(url).pathname);
const repeatList = (...items: object[]) =>
  calendarFake(...Array.from({ length: 10 }, () => () => list(...items)));

it.each(
  ["search_events", "read_event"].flatMap((tool) =>
    (["allow", "ask"] as const).flatMap((setting) =>
      [false, true].map((explicit) => ({ tool, setting, explicit })),
    ),
  ),
)(
  "$tool excludes Google's literal primary entry at $setting, explicit ID: $explicit",
  async ({ tool, setting, explicit }) => {
    const f = await eventsFixture(tool, setting);
    repeatList({ id: "primary", primary: true, accessRole: "owner", timeZone: "UTC" });
    const sent = eventsFake({
      primary: { list: Response.json({}), events: { e1: Response.json(eventFixture()) } },
    });
    const response =
      tool === "search_events"
        ? await searchCall(f, explicit ? { calendars: ["primary"] } : {})
        : await readEventCall(f, explicit ? { calendar: "primary" } : {});
    if (setting === "allow") await expectError(response, "not_found", /No such calendar/);
    else {
      const definition = TOOLS.find((entry) => entry.kind === "account" && entry.name === tool)!;
      if (definition.kind !== "account") throw new Error("Missing Calendar tool");
      const viewFailures: string[] = [];
      const values = definition.view.values;
      vi.spyOn(definition.view, "values").mockImplementation((...args) =>
        values(...args).pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => {
              viewFailures.push(failure._tag === "ToolFailure" ? failure.code : "ViewUnavailable");
            }),
          ),
        ),
      );
      const id = (await answer(response)).approval as string;
      const view = await page(f, id);
      if (tool === "search_events" && explicit) {
        expect(view.request.values).toContainEqual({
          name: "Not calendars of this account",
          text: "primary",
          from: "agent",
        });
        await approve(f, id);
        expect((await get(f, id)).error).toMatchObject({ code: "not_found" });
      } else {
        expect(view.state).toMatchObject({ kind: "waiting", shown: false });
        expect(viewFailures).toEqual(["not_found"]);
      }
    }
    expect(sent).toEqual([]);
    expect(calendarPaths().length).toBeGreaterThan(0);
    expect(calendarPaths().every((path) => path === "/calendar/v3/users/me/calendarList")).toBe(
      true,
    );
  },
);

it.each(["search_events", "read_event"])(
  "unfolds calendar names and event titles in the %s approval view",
  async (tool) => {
    const f = await eventsFixture(tool, "ask");
    repeatList(
      { ...PRIMARY_CALENDAR, summary: "Personal\nFake heading" },
      { id: "busy", summary: "Busy\nAnother heading", accessRole: "freeBusyReader" },
    );
    eventsFake({
      [PERSONAL]: {
        events: { e1: Response.json(eventFixture({ summary: "Planning\nAnother action" })) },
      },
    });
    const id = (
      await answer(
        tool === "search_events"
          ? await searchCall(f, { calendars: [PERSONAL, "busy"] })
          : await readEventCall(f),
      )
    ).approval as string;
    const view = await page(f, id);
    expect(view.state).toMatchObject({ kind: "waiting", shown: true });
    if (tool === "search_events") {
      expect(view.request.values).toContainEqual({
        name: "Calendars",
        text: `Personal Fake heading (${PERSONAL})`,
        from: "calendar",
      });
      expect(view.request.values).toContainEqual({
        name: "Only busy times visible",
        text: "Busy Another heading (busy)",
        from: "calendar",
      });
    } else {
      expect(view.request.values).toContainEqual({
        name: "Calendar",
        text: `Personal Fake heading (${PERSONAL})`,
        from: "calendar",
      });
      expect(view.request.values).toContainEqual({
        name: "Event",
        text: "Planning Another action",
        from: "calendar",
      });
    }
    expect(
      view.request.values
        .filter((value) => value.from === "calendar")
        .every((value) => !value.text.includes("\n")),
    ).toBe(true);
  },
);

it("shows an all-day event's own zone as Google gave it, including an alias", async () => {
  const f = await eventsFixture("read_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            start: { date: "2026-11-20", timeZone: "Japan" },
            end: { date: "2026-11-21", timeZone: "Japan" },
          }),
        ),
      },
    },
  });
  const id = (await answer(await readEventCall(f))).approval as string;
  expect((await page(f, id)).request.values).toContainEqual({
    name: "Starts",
    text: "Nov 20, 2026 (all day); event's own zone: Japan",
    from: "calendar",
  });
});

it.each([
  { name: "a line break", zone: "Europe/Madrid\nFake action" },
  { name: "5,000 characters", zone: "x".repeat(5000) },
  { name: "a difference in case only", zone: "america/bogota" },
  { name: "an alias of the call's zone", zone: "US/Eastern", callZone: "America/New_York" },
])("omits the event's own zone from the view for $name", async ({ zone, callZone }) => {
  const f = await eventsFixture("read_event", "ask");
  repeatList(PRIMARY_CALENDAR);
  eventsFake({
    [PERSONAL]: {
      events: {
        e1: Response.json(
          eventFixture({
            start: { dateTime: "2026-11-20T14:00:00Z", timeZone: zone },
            end: { dateTime: "2026-11-20T15:00:00Z", timeZone: zone },
          }),
        ),
      },
    },
  });
  const id = (await answer(await readEventCall(f, callZone ? { time_zone: callZone } : {})))
    .approval as string;
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
  expect(view.request.values).toContainEqual({
    name: "Starts",
    text: callZone
      ? "Nov 20, 2026 at 09:00 (America/New_York)"
      : "Nov 20, 2026 at 09:00 (America/Bogota)",
    from: "calendar",
  });
});

it("seals search strings, builds the view without events, labels Calendar text, and returns the approved result through get_approval", async () => {
  const f = await eventsFixture("search_events", "ask");
  repeatList(PRIMARY_CALENDAR, SECONDARY_CALENDAR, {
    id: "busy",
    summary: "Busy",
    accessRole: "freeBusyReader",
  });
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: { list: Response.json({ items: [eventFixture()] }) },
  });
  const id = (
    await answer(
      await searchCall(f, {
        calendars: [SECONDARY_CALENDAR.id, "primary", "busy"],
        from: "2026-11-20",
        to: "2026-11-27",
        query: "planning",
        limit: 10,
        page: undefined,
      }),
    )
  ).approval as string;
  expect(calendarPaths()).toEqual([]);
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
  expect(view.request.tool).toMatchObject({ action: "search the calendar events", joiner: "of" });
  expect(view.request.values).toEqual([
    { name: "Calendars", text: `Team (${SECONDARY_CALENDAR.id})`, from: "calendar" },
    { name: "Not calendars of this account", text: "primary", from: "agent" },
    { name: "Only busy times visible", text: "Busy (busy)", from: "calendar" },
    {
      name: "Range",
      text: "Nov 20, 2026 at 00:00 to Nov 27, 2026 at 00:00 (America/Bogota)",
      from: "agent",
    },
    { name: "Query", text: "planning", from: "agent" },
    { name: "Limit", text: "10", from: "agent" },
  ]);
  expect(sent).toEqual([]);
  const html = textOf(await (await f.mcp.browser.get(`/approvals/${id}`)).text());
  expect(html).toContain("the server read the rest from Google Calendar");
  expect(html).toContain("read from Google Calendar");
  expect(html).not.toContain("read the rest from Gmail");
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const collected = await get(f, id);
  expect(collected.status).toBe("success");
  expect(collected.result).toMatchObject({
    account: PERSONAL,
    time_zone: "America/Bogota",
    calendars: [
      { calendar: SECONDARY_CALENDAR.id, events: [expect.objectContaining({ event: "e1" })] },
      {
        calendar: "primary",
        error: { code: "not_found", message: expect.stringMatching(/No such calendar/) },
      },
      {
        calendar: "busy",
        error: { code: "invalid_arguments", message: expect.stringMatching(/only busy times/) },
      },
    ],
  });
  expect(sent).toHaveLength(1);
  expect(new Set(calendarPaths())).toEqual(
    new Set([
      "/calendar/v3/users/me/calendarList",
      `/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events`,
    ]),
  );
});

it("gives a next-page search its own approval and shows Page from the sealed arguments", async () => {
  const f = await eventsFixture("search_events", "ask");
  repeatList(PRIMARY_CALENDAR);
  const sent = eventsFake({ [PERSONAL]: { list: Response.json({}) } });
  const id = (await answer(await searchCall(f, { page: "next+/=", limit: 1, time_zone: "UTC" })))
    .approval as string;
  expect(sent).toEqual([]);
  expect((await page(f, id)).request.values).toEqual([
    { name: "Calendars", text: `Personal (${PERSONAL})`, from: "calendar" },
    { name: "Range", text: "Nov 20, 2026 at 00:00 to Nov 21, 2026 at 00:00 (UTC)", from: "agent" },
    { name: "Limit", text: "1", from: "agent" },
    { name: "Page", text: "next+/=", from: "agent" },
  ]);
  await approve(f, id);
  expect((await get(f, id)).result).toMatchObject({ time_zone: "UTC" });
  expect(new URL(sent[0]!.url).searchParams.get("pageToken")).toBe("next+/=");
  expect(new URL(sent[0]!.url).searchParams.get("maxResults")).toBe("1");
});

it("creates read_event approval without a read, shows a floating event in the call zone, and runs after approval", async () => {
  const f = await eventsFixture("read_event", "ask");
  repeatList(PRIMARY_CALENDAR, SECONDARY_CALENDAR);
  const sent = eventsFake({
    [SECONDARY_CALENDAR.id]: {
      events: {
        e1: Response.json(
          eventFixture({
            start: { dateTime: "2026-11-20T15:00:00", timeZone: "Europe/Madrid" },
            end: { dateTime: "2026-11-20T16:00:00", timeZone: "Europe/Madrid" },
          }),
        ),
      },
    },
  });
  const id = (
    await answer(
      await readEventCall(f, { calendar: SECONDARY_CALENDAR.id, time_zone: "America/Bogota" }),
    )
  ).approval as string;
  expect(calendarPaths()).toEqual([]);
  const view = await page(f, id);
  expect(view.state).toMatchObject({ kind: "waiting", shown: true });
  expect(view.request.tool).toMatchObject({ action: "read a calendar event", joiner: "in" });
  expect(view.request.values).toEqual([
    { name: "Calendar", text: `Team (${SECONDARY_CALENDAR.id})`, from: "calendar" },
    { name: "Event", text: "Planning", from: "calendar" },
    {
      name: "Starts",
      text: "Nov 20, 2026 at 09:00 (America/Bogota); event's own zone: Europe/Madrid",
      from: "calendar",
    },
  ]);
  expect(sent).toHaveLength(1);
  const html = textOf(await (await f.mcp.browser.get(`/approvals/${id}`)).text());
  expect(html).toContain(
    "The server read the shaded text below from Google Calendar. The agent did not write it.",
  );
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect((await get(f, id)).result).toMatchObject({
    calendar: SECONDARY_CALENDAR.id,
    time_zone: "America/Bogota",
    event: "e1",
    start: "2026-11-20T09:00:00-05:00",
  });
  for (const request of sent)
    expect(new URL(request.url).searchParams.get("timeZone")).toBe("America/Bogota");
  expect(new Set(calendarPaths())).toEqual(
    new Set([
      "/calendar/v3/users/me/calendarList",
      `/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events/e1`,
    ]),
  );
});

it.each(["missing", "cancelled", "unlisted", "busy"])(
  "offers only rejection when the read_event view cannot be built: %s",
  async (kind) => {
    const f = await eventsFixture("read_event", "ask");
    repeatList(PRIMARY_CALENDAR, { id: "busy", accessRole: "freeBusyReader" });
    const sent = eventsFake({
      [PERSONAL]: {
        events: {
          e1:
            kind === "missing"
              ? new Response(null, { status: 404 })
              : Response.json({ id: "e1", status: "cancelled" }),
        },
      },
    });
    const id = (
      await answer(
        await readEventCall(f, kind === "unlisted" || kind === "busy" ? { calendar: kind } : {}),
      )
    ).approval as string;
    expect(calendarPaths()).toEqual([]);
    const view = await page(f, id);
    expect(view.state).toMatchObject({ kind: "waiting", shown: false, digest: null });
    const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
    expect(html).not.toMatch(/>Approve</);
    const rejected = await decided(await post(f, id, "reject"));
    expect(rejected.state.kind).toBe("rejected");
    expect((await get(f, id)).status).toBe("rejected");
    if (kind === "unlisted" || kind === "busy") expect(sent).toEqual([]);
    expect(new Set(calendarPaths())).toEqual(
      new Set([
        "/calendar/v3/users/me/calendarList",
        ...(kind === "missing" || kind === "cancelled"
          ? [`/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events/e1`]
          : []),
      ]),
    );
  },
);

it.each(["search_events", "read_event"])(
  "rechecks the list in the approved run of %s after a calendar was removed",
  async (tool) => {
    const f = await eventsFixture(tool, "ask");
    let removed = false;
    calendarFake(
      ...Array.from(
        { length: 10 },
        () => () => list(PRIMARY_CALENDAR, ...(removed ? [] : [SECONDARY_CALENDAR])),
      ),
    );
    const sent = eventsFake({
      [SECONDARY_CALENDAR.id]: {
        list: Response.json({}),
        events: { e1: Response.json(eventFixture()) },
      },
    });
    const pending =
      tool === "search_events"
        ? await searchCall(f, { calendars: [SECONDARY_CALENDAR.id] })
        : await readEventCall(f, { calendar: SECONDARY_CALENDAR.id });
    const id = (await answer(pending)).approval as string;
    const shown = await digest(f, id);
    const before = sent.length;
    const db = observeStatements(env.DB, (sql) => {
      if (sql.startsWith("UPDATE approvals SET state = 'approved'")) removed = true;
    });
    expect(
      (await decided(await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })))).state
        .kind,
    ).toBe("failed");
    expect(removed).toBe(true);
    expect((await get(f, id)).error).toEqual({
      code: "not_found",
      message: expect.stringMatching(/No such calendar/),
    });
    // The decision rebuilds the view once, then the run's fresh list prevents a further event read.
    expect(sent).toHaveLength(before + (tool === "read_event" ? 1 : 0));
    expect(new Set(calendarPaths())).toEqual(
      new Set([
        "/calendar/v3/users/me/calendarList",
        ...(tool === "read_event"
          ? [`/calendar/v3/calendars/${encodeURIComponent(SECONDARY_CALENDAR.id)}/events/e1`]
          : []),
      ]),
    );
  },
);

it("cannot build an approval view for a mixed range that becomes inverted in the primary zone", async () => {
  const f = await eventsFixture("search_events", "ask");
  repeatList(PRIMARY_CALENDAR);
  const id = (
    await answer(await searchCall(f, { from: "2026-11-20T15:00", to: "2026-11-20T19:00Z" }))
  ).approval as string;
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
  expect(calendarPaths()).toEqual(["/calendar/v3/users/me/calendarList"]);
});
