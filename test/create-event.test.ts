import "./support/account-checks";
import { Effect } from "effect";
import { TOOLS } from "../src/mcp/tools";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import { answer, approve, get, rows } from "./support/approvals";
import { eventsFixture, PRIMARY_CALENDAR } from "./support/calendar";
import { createEventCall, eventWriter, primaryList, repeatCalendars } from "./support/event-write";
import { callRows, expectError, PERSONAL } from "./support/permissions";
import { setTool } from "./support/uploads";
import { onceRows } from "./support/draft";
import { STALE } from "../src/once/store";
import { observeStatements } from "./support/db";
import { testEnv } from "./support/worker";

it.each(["allow", "ask", "ask then allow"] as const)(
  "%s returns the first event after a lost server answer, without another insert",
  async (mode) => {
    const f = await eventsFixture("create_event", mode === "allow" ? "allow" : "ask");
    primaryList();
    const google = eventWriter();
    let first: Record<string, unknown>;
    if (mode === "allow") first = await answer(await createEventCall(f));
    else {
      const pending = await answer(await createEventCall(f));
      if (mode === "ask then allow") await setTool(f, "create_event", "allow");
      expect(await answer(await createEventCall(f))).toEqual(pending);
      expect(google.inserts).toHaveLength(0);
      await approve(f, pending.approval as string);
      first = (await get(f, pending.approval as string)).result as Record<string, unknown>;
    }
    const repeat = await answer(await createEventCall(f));
    expect(first).toEqual({
      account: PERSONAL,
      calendar: PERSONAL,
      event: google.inserts[0]!.body.id,
      link: expect.any(String),
    });
    expect(repeat).toMatchObject({ ...first, repeat_of: expect.any(String) });
    expect(repeat.note).toMatch(/Nothing was created again.*duplicate: 2/);
    expect(google.inserts).toHaveLength(1);
    expect((await callRows()).at(-1)).toMatchObject({ outcome: "repeat" });
  },
);

it.each([
  "abort",
  "500",
  "409",
  "412",
  "408",
  "401",
  "redirect",
  "non JSON",
  "wrong shape",
  "broken stream",
])(
  "keeps an unknown row after %s and settles by its chosen ID without a second insert",
  async (failure) => {
    const f = await eventsFixture("create_event");
    primaryList();
    const google = eventWriter();
    google.fake.insert = () => {
      if (failure === "abort") return HttpResponse.error();
      if (failure === "non JSON") return new Response("not json");
      if (failure === "wrong shape") return Response.json({ summary: "no id" });
      if (failure === "broken stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("lost body"));
            },
          }),
        );
      return new Response(null, { status: failure === "redirect" ? 302 : Number(failure) });
    };
    const at = Date.now();
    await expectError(
      await createEventCall(f),
      "outcome_unknown",
      /Call again with exactly the same arguments in a minute.*checks Google Calendar.*never creates it twice/,
    );
    expect((await onceRows())[0]).toMatchObject({ state: "unknown" });
    const stored = await env.DB.prepare("SELECT request_key FROM once").first<{
      request_key: string;
    }>();
    expect(stored!.request_key).toMatch(/^[0-9a-f]{32}$/);
    expect(google.inserts[0]!.body.id).toBe(stored!.request_key);
    vi.mocked(Date.now).mockReturnValue(at + 60_000);
    expect(await answer(await createEventCall(f))).toMatchObject({
      event: stored!.request_key,
      repeat_of: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    expect(google.reads).toHaveLength(1);
    expect(decodeURIComponent(new URL(google.reads[0]!.url).pathname)).toBe(
      `/calendar/v3/calendars/${PERSONAL}/events/${stored!.request_key}`,
    );
    expect(google.inserts).toHaveLength(1);
    expect((await onceRows())[0]).toMatchObject({ state: "done" });
  },
);

it.each(["cancelled", "404", "410", "500", "unreadable", "abort"])(
  "settling %s reports the outcome and never inserts again",
  async (status) => {
    const f = await eventsFixture("create_event");
    primaryList();
    const google = eventWriter();
    google.fake.insert = () => new Response(null, { status: 503 });
    await expectError(await createEventCall(f), "outcome_unknown", /Call again/);
    const saved = [...google.events.values()][0]!;
    google.fake.read = () =>
      status === "cancelled"
        ? Response.json({ ...saved, status: "cancelled" })
        : status === "unreadable"
          ? Response.json({ no: "id" })
          : status === "abort"
            ? HttpResponse.error()
            : new Response(null, { status: Number(status) });
    if (status === "cancelled") {
      const repeat = await answer(await createEventCall(f));
      expect(repeat.note).toMatch(/created the event.*no longer in the calendar.*duplicate: 2/);
      expect(repeat).not.toHaveProperty("cancelled");
      expect((await onceRows())[0]!.state).toBe("done");
    } else if (status === "404" || status === "410") {
      await expectError(
        await createEventCall(f),
        "outcome_unknown",
        /Google Calendar does not show the event\. Ask the owner to look in Google Calendar.*If the owner says.*missing.*duplicate: 2/,
      );
      expect((await onceRows())[0]!.state).toBe("unknown");
    } else {
      // A failed read proves nothing, so the agent tries again before it bothers the owner.
      const error = await createEventCall(f);
      await expectError(
        error,
        "outcome_unknown",
        /could not check Google Calendar.*Call again with exactly the same arguments in a minute.*If this keeps happening, ask the owner/,
      );
      expect(JSON.stringify(error)).not.toMatch(/does not show|duplicate/);
      expect((await onceRows())[0]!.state).toBe("unknown");
    }
    expect(google.inserts).toHaveLength(1);
  },
);

it("answers with the event Google showed even when recording it fails, and reads again next time", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  google.fake.insert = () => new Response(null, { status: 503 });
  await expectError(await createEventCall(f), "outcome_unknown", /Call again/);
  const db = observeStatements(env.DB, (sql) => {
    if (/request_key = \?2/.test(sql)) throw new Error("D1 write lost");
  });
  const event = google.inserts[0]!.body.id;
  expect(await answer(await createEventCall(f, {}, testEnv({ DB: db })))).toMatchObject({
    event,
    repeat_of: expect.any(String),
  });
  expect((await onceRows())[0]!.state).toBe("unknown");
  expect(await answer(await createEventCall(f))).toMatchObject({ event });
  expect((await onceRows())[0]!.state).toBe("done");
  expect(google.reads).toHaveLength(2);
  expect(google.inserts).toHaveLength(1);
});

it.each([false, true])("settles an unknown repeat under ask, stale running: %s", async (stale) => {
  const f = await eventsFixture("create_event", "ask");
  primaryList();
  const google = eventWriter();
  google.fake.insert = () => new Response(null, { status: 500 });
  const id = (await answer(await createEventCall(f))).approval as string;
  await approve(f, id);
  if (stale) {
    await env.DB.prepare("UPDATE once SET state = 'running'").run();
    vi.mocked(Date.now).mockReturnValue(Date.now() + STALE + 1);
  }
  expect(await answer(await createEventCall(f))).toMatchObject({
    event: google.inserts[0]!.body.id,
    repeat_of: expect.any(String),
  });
  expect(google.inserts).toHaveLength(1);
  expect(google.reads).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
});

it("settles an explicit calendar after access falls to reader without needing its zone", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  google.fake.insert = () => new Response(null, { status: 500 });
  await expectError(
    await createEventCall(f, { calendar: PERSONAL }),
    "outcome_unknown",
    /Call again/,
  );
  const lists = repeatCalendars({ ...PRIMARY_CALENDAR, accessRole: "reader", timeZone: "invalid" });
  expect(await answer(await createEventCall(f, { calendar: PERSONAL }))).toMatchObject({
    event: google.inserts[0]!.body.id,
  });
  expect(lists).toHaveLength(0);
  expect(google.inserts).toHaveLength(1);
});

it.each([400, 403, 404, 429])(
  "releases an insert refused with %s so the identical call can try again",
  async (status) => {
    const f = await eventsFixture("create_event");
    primaryList();
    const google = eventWriter();
    google.fake.insert = () =>
      Response.json({ error: { message: "Google's readable reason" } }, { status });
    await expectError(
      await createEventCall(f),
      status === 400 ? "invalid_arguments" : status === 404 ? "not_found" : "google_unavailable",
      status === 400
        ? /Google's readable reason/
        : status === 404
          ? /calendar/
          : /Google could not complete/,
    );
    expect(await onceRows()).toEqual([]);
    google.fake.insert = undefined;
    await answer(await createEventCall(f));
    expect(google.inserts).toHaveLength(2);
    expect(google.inserts[0]!.body.id).not.toBe(google.inserts[1]!.body.id);
  },
);

it("duplicate creates another event and its retry returns that event", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  const first = await answer(await createEventCall(f));
  const second = await answer(await createEventCall(f, { duplicate: 2 }));
  expect(second.event).not.toBe(first.event);
  expect(await answer(await createEventCall(f, { duplicate: 2 }))).toMatchObject({
    ...second,
    repeat_of: expect.any(String),
  });
  expect(google.inserts).toHaveLength(2);
});

it.each(["success", "video", "pending", "failure", "none", "unconfirmed link"])(
  "requests Meet and returns only a confirmed link for %s, keeping notes on repeats",
  async (status) => {
    const f = await eventsFixture("create_event");
    primaryList();
    const google = eventWriter();
    const meet = "https://meet.google.com/abc-defg-hij";
    google.fake.insert = ({ body }) =>
      Response.json({
        id: body.id,
        htmlLink: "https://calendar.google.com/event/test",
        ...(status === "none"
          ? {}
          : {
              conferenceData: {
                createRequest: {
                  status: {
                    statusCode:
                      status === "video"
                        ? "success"
                        : status === "unconfirmed link"
                          ? "pending"
                          : status,
                  },
                },
                ...(status === "video"
                  ? { entryPoints: [{ entryPointType: "video", uri: meet }] }
                  : {}),
              },
              ...(status === "video" ? {} : { hangoutLink: meet }),
            }),
      });
    const first = await answer(await createEventCall(f, { meet: true }));
    expect(first).not.toHaveProperty("meet_status");
    const requested = google.inserts[0]!;
    expect(requested.body.conferenceData).toEqual({
      createRequest: {
        requestId: requested.body.id,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    });
    expect(new URL(requested.request.url).searchParams.get("conferenceDataVersion")).toBe("1");
    expect(new URL(requested.request.url).searchParams.get("sendUpdates")).toBe("all");
    expect(requested.body).not.toHaveProperty("reminders");
    expect(requested.body).not.toHaveProperty("attachments");
    expect(requested.body).not.toHaveProperty("colorId");
    if (status === "success" || status === "video") {
      expect(first.meet).toBe(meet);
      expect(first).not.toHaveProperty("note");
    } else {
      expect(first).not.toHaveProperty("meet");
      expect(first.note).toMatch(
        status === "pending" || status === "unconfirmed link"
          ? /has not given the Meet link yet.*read_event/
          : /event exists without a Meet link/,
      );
    }
    const repeat = await answer(await createEventCall(f, { meet: true }));
    expect(repeat).toMatchObject({
      ...first,
      note: expect.any(String),
      repeat_of: expect.any(String),
    });
    if (first.note) expect(repeat.note).toContain(first.note);
    expect(google.inserts).toHaveLength(1);
  },
);

it("treats explicit defaults as the same call", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  const first = await answer(await createEventCall(f));
  expect(
    await answer(
      await createEventCall(f, { location: "", description: "", guests: [], meet: false }),
    ),
  ).toMatchObject({ ...first, repeat_of: expect.any(String) });
  expect(google.inserts).toHaveLength(1);
});

it("checks deny before any recovery read or stored answer", async () => {
  const f = await eventsFixture("create_event");
  await setTool(f, "list_calendars", "allow");
  primaryList();
  const google = eventWriter();
  google.fake.insert = () => new Response(null, { status: 500 });
  await expectError(await createEventCall(f), "outcome_unknown", /Call again/);
  await setTool(f, "create_event", "deny");
  await expectError(await createEventCall(f), "tool_not_allowed", /has not allowed/);
  expect(google.inserts).toHaveLength(1);
  expect(google.reads).toHaveLength(0);
});

it.each(["unknown", "done"] as const)(
  "answers no %s repeat when the setting turns deny just before the approval batch",
  async (state) => {
    const f = await eventsFixture("create_event");
    await setTool(f, "list_calendars", "allow");
    primaryList();
    const google = eventWriter();
    if (state === "unknown") {
      google.fake.insert = () => new Response(null, { status: 500 });
      await expectError(await createEventCall(f), "outcome_unknown", /Call again/);
    } else await answer(await createEventCall(f));
    await setTool(f, "create_event", "ask");
    let denied = false;
    const db = observeStatements(env.DB, async (sql) => {
      if (!denied && /^INSERT INTO approvals\b/.test(sql)) {
        denied = true;
        await setTool(f, "create_event", "deny");
      }
    });
    await expectError(
      await createEventCall(f, {}, testEnv({ DB: db })),
      "account_not_available",
      /./,
    );
    expect(denied).toBe(true);
    expect(google.inserts).toHaveLength(1);
    expect(google.reads).toHaveLength(0);
  },
);

it("fails closed on a stored event result that does not match the tool's schema", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  await answer(await createEventCall(f));
  await env.DB.prepare('UPDATE once SET result = \'{"message":"mail","thread":"thread"}\'').run();
  await expectError(await createEventCall(f), "server_unavailable", /server could not complete/);
  expect(google.inserts).toHaveLength(1);
});

it("recovery sends can only read the call's own account", async () => {
  const f = await eventsFixture("create_event");
  primaryList();
  const google = eventWriter();
  google.fake.insert = () => new Response(null, { status: 500 });
  await expectError(await createEventCall(f), "outcome_unknown", /Call again/);
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === "create_event")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing creating tool");
  vi.spyOn(tool, "settle").mockImplementation((read) =>
    read(
      (token, signal) =>
        new Request(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(PERSONAL)}/events`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: '{"id":"unapproved"}',
            signal,
          },
        ),
    ).pipe(Effect.as(null)),
  );
  await expectError(await createEventCall(f), "outcome_unknown", /could not check Google Calendar/);
  expect(google.inserts).toHaveLength(1);
  expect(google.reads).toHaveLength(0);
});
