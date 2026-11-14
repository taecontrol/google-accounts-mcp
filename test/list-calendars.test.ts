import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer, approve, get, page } from "./support/approvals";
import { CALENDAR_LIST, CALENDAR_SCOPES, calendarFake } from "./support/calendar";
import { callRows, expectError, fixture, PERSONAL, toolCall } from "./support/permissions";
import { setTool } from "./support/uploads";

const calendarFixture = async (setting: "ask" | "allow" = "allow") => {
  const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES) });
  await setTool(f, "list_calendars", setting);
  return f;
};
const list = (f: Awaited<ReturnType<typeof fixture>>, account = PERSONAL) =>
  toolCall(f.mcp, "list_calendars", { account });
const calendarsOf = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await answer(await list(f))) as unknown as {
    account: string;
    calendars: Array<{
      calendar: string;
      name: string;
      primary: boolean;
      access: string;
      time_zone?: string;
    }>;
    omitted?: number;
    note?: string;
  };

it("maps every Calendar role, chooses bounded names, and orders primary, access, name, and ID", async () => {
  const f = await calendarFixture();
  const requests = calendarFake(
    Response.json({
      items: [
        { id: "busy", summary: "A busy calendar", accessRole: "freeBusyReader" },
        { id: "unknown", summary: "Z unknown", accessRole: "futureRole" },
        { id: "missing" },
        { id: "reader", summary: "Read", accessRole: "reader", timeZone: "Europe/Madrid" },
        {
          id: "writer-b",
          summary: "Original",
          summaryOverride: "Write",
          accessRole: "writerWithoutPrivateAccess",
        },
        { id: "writer-a", summary: "Write", summaryOverride: "", accessRole: "writer" },
        { id: "owner", summary: "x".repeat(101), accessRole: "owner" },
        {
          id: "primary",
          summary: "My primary",
          primary: true,
          accessRole: "reader",
          timeZone: "America/Argentina/Buenos_Aires",
          description: "PRIVATE_EXTRA",
        },
        { id: "override-only", summaryOverride: "Only override", accessRole: "reader" },
      ],
    }),
  );
  expect(await calendarsOf(f)).toEqual({
    account: PERSONAL,
    calendars: [
      {
        calendar: "primary",
        name: "My primary",
        primary: true,
        access: "reader",
        time_zone: "America/Argentina/Buenos_Aires",
      },
      { calendar: "owner", name: "x".repeat(99) + "…", primary: false, access: "owner" },
      { calendar: "writer-a", name: "Write", primary: false, access: "writer" },
      { calendar: "writer-b", name: "Write", primary: false, access: "writer" },
      { calendar: "override-only", name: "Only override", primary: false, access: "reader" },
      {
        calendar: "reader",
        name: "Read",
        primary: false,
        access: "reader",
        time_zone: "Europe/Madrid",
      },
      { calendar: "busy", name: "A busy calendar", primary: false, access: "free_busy" },
      { calendar: "unknown", name: "Z unknown", primary: false, access: "free_busy" },
      { calendar: "missing", name: "missing", primary: false, access: "free_busy" },
    ],
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe(`${CALENDAR_LIST}?maxResults=250`);
  expect(requests[0]!.method).toBe("GET");
  expect(requests[0]!.redirect).toBe("manual");
  expect(requests[0]!.headers.get("Authorization")).toMatch(/^Bearer /);
  expect((await callRows()).at(-1)).toMatchObject({
    tool: "list_calendars",
    account_id: f.personal.id,
    outcome: "success",
    reason: null,
  });
});

it("follows nextPageToken before sorting the whole list", async () => {
  const f = await calendarFixture();
  const requests = calendarFake(
    Response.json({
      items: [{ id: "other", summary: "Other", accessRole: "owner" }],
      nextPageToken: "next+/=",
    }),
    Response.json({ items: [{ id: "mine", summary: "Mine", primary: true, accessRole: "owner" }] }),
  );
  expect((await calendarsOf(f)).calendars.map((c) => c.calendar)).toEqual(["mine", "other"]);
  expect(requests.map((r) => new URL(r.url).searchParams.get("pageToken"))).toEqual([
    null,
    "next+/=",
  ]);
  for (const request of requests) {
    const params = new URL(request.url).searchParams;
    expect(params.get("maxResults")).toBe("250");
    expect(params.has("showHidden")).toBe(false);
    expect(params.has("showDeleted")).toBe(false);
  }
});

it("orders calendar names and tied IDs without locale collation", async () => {
  const f = await calendarFixture();
  calendarFake(
    Response.json({
      items: [
        { id: "umlaut", summary: "ä" },
        { id: "lower", summary: "a" },
        { id: "upper", summary: "Z" },
        { id: "a@example.com", summary: "Same" },
        { id: "Z@example.com", summary: "Same" },
      ],
    }),
  );
  expect((await calendarsOf(f)).calendars.map((calendar) => calendar.calendar)).toEqual([
    "Z@example.com",
    "a@example.com",
    "upper",
    "lower",
    "umlaut",
  ]);
});

it("cuts at one hundred sorted calendars and counts only the omitted entries", async () => {
  const f = await calendarFixture();
  calendarFake(
    Response.json({
      items: Array.from({ length: 102 }, (_, i) => ({
        id: String(101 - i).padStart(3, "0"),
        summary: "Calendar",
      })),
    }),
  );
  const out = await calendarsOf(f);
  expect(out.calendars).toHaveLength(100);
  expect(out.calendars[0]!.calendar).toBe("000");
  expect(out.calendars.at(-1)!.calendar).toBe("099");
  expect(out.omitted).toBe(2);
  expect(out.note).toContain("first 100");
  expect(out.note).toContain("ID still works");
});

it("cuts at thirty thousand serialized characters before the count cap", async () => {
  const f = await calendarFixture();
  calendarFake(
    Response.json({
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `${String(i).padStart(3, "0")}${"x".repeat(900)}`,
        summary: '"'.repeat(100),
        timeZone: "Etc/UTC",
      })),
    }),
  );
  const out = await calendarsOf(f);
  expect(out.calendars.length).toBeGreaterThan(0);
  expect(out.calendars.length).toBeLessThan(100);
  expect(JSON.stringify(out.calendars).length).toBeLessThanOrEqual(30_000);
  expect(JSON.stringify([...out.calendars, out.calendars[0]]).length).toBeGreaterThan(30_000);
  expect(out.omitted).toBe(100 - out.calendars.length);
  expect(out.note).toContain(`first ${out.calendars.length}`);
});

it("stops after eight pages and explains both the page cap and the result cut", async () => {
  const f = await calendarFixture();
  const requests = calendarFake(
    ...Array.from({ length: 8 }, (_, page) =>
      Response.json({
        items: Array.from({ length: 250 }, (_, i) => ({ id: `${page}-${i}` })),
        nextPageToken: `page-${page + 1}`,
      }),
    ),
  );
  const out = await calendarsOf(f);
  expect(requests).toHaveLength(8);
  expect(out.calendars).toHaveLength(100);
  expect(out.omitted).toBe(1900);
  expect(out.note).toContain("more calendars than the server counted");
  expect(out.note).toContain("first 100");
  expect(out.note).toContain("ID still works");
});

it("returns an empty calendar list without omitted or note", async () => {
  const f = await calendarFixture();
  calendarFake(Response.json({}));
  expect(await calendarsOf(f)).toEqual({ account: PERSONAL, calendars: [] });
});

it.each([
  new Response(null, { status: 503 }),
  new Response("not JSON"),
  Response.json({ items: [{ summary: "No ID" }] }),
])("fails the whole call if a later calendar page fails %#", async (response) => {
  const f = await calendarFixture();
  const requests = calendarFake(
    Response.json({ items: [{ id: "first" }], nextPageToken: "next" }),
    response,
  );
  await expectError(await list(f), "google_unavailable", /Google could not complete/);
  expect(requests).toHaveLength(2);
  expect((await callRows()).at(-1)).toMatchObject({
    outcome: "failed",
    reason: "google_unavailable",
  });
});

it("asks to list the calendars of the account with no values and runs only after approval", async () => {
  const f = await calendarFixture("ask");
  const requests = calendarFake(Response.json({ items: [{ id: "mine", summary: "Mine" }] }));
  const id = (await answer(await list(f))).approval as string;
  const view = await page(f, id);
  expect(view.request.tool.action).toBe("list the calendars");
  expect(view.request.tool.joiner).toBe("of");
  expect(view.request.values).toEqual([]);
  expect(requests).toEqual([]);
  await approve(f, id);
  expect((await get(f, id)).result).toEqual({
    account: PERSONAL,
    calendars: [{ calendar: "mine", name: "Mine", primary: false, access: "free_busy" }],
  });
  expect(requests).toHaveLength(1);
});

it("defaults Calendar permission to deny and hides an account with no permissions", async () => {
  const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES) });
  await expectError(await list(f), "account_not_available", /No account/);
  await setTool(f, "list_labels", "allow");
  await expectError(await list(f), "tool_not_allowed", /has not allowed list_calendars/);
  expect(
    (await callRows()).filter((c) => c.tool === "list_calendars").map((c) => c.reason),
  ).toEqual(["account_not_available", "tool_not_allowed"]);
});
