import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer } from "./support/approvals";
import {
  chatFake,
  chatFixture,
  directMessage,
  human,
  listConversations,
  membersOf,
} from "./support/chat";
import { callRows, expectError, PERSONAL } from "./support/permissions";

type Entry = { conversation: string; last_active?: string };
const room = (n: number) => ({
  name: `spaces/room${n}`,
  spaceType: "SPACE",
  displayName: `Room ${n}`,
  lastActiveTime: `2026-11-22T10:0${n}:00Z`,
});
const fieldsOf = (url: URL) =>
  (url.searchParams.get("fields") ?? "")
    .replace(/spaces\(([^)]*)\)/, (_, inner: string) =>
      inner
        .split(",")
        .map((field) => `spaces.${field}`)
        .join(","),
    )
    .split(",")
    .sort();

it.each([
  { pages: 1, last: "", capped: false },
  { pages: 5, last: "", capped: false },
  { pages: 5, last: "more", capped: true },
])(
  "reads $pages one-space pages that end with token '$last' and warns only when pages remain",
  async ({ pages, last, capped }) => {
    const f = await chatFixture();
    const log = chatFake(
      Array.from({ length: pages }, (_, i) =>
        Response.json({ spaces: [room(i + 1)], nextPageToken: i + 1 < pages ? `p${i + 2}` : last }),
      ),
    );
    const result = await answer(await listConversations(f));
    expect((result.conversations as Entry[]).map((entry) => entry.conversation)).toEqual(
      Array.from({ length: pages }, (_, i) => `spaces/room${pages - i}`),
    );
    expect(result.omitted).toBeUndefined();
    expect(result.note ?? "").not.toMatch(/1,000/);
    expect(result.note).toEqual(
      capped
        ? expect.stringMatching(/pages it did not read may hold more recent conversations/)
        : undefined,
    );
    expect(log.spaces.map((url) => url.searchParams.get("pageToken"))).toEqual(
      Array.from({ length: pages }, (_, i) => (i ? `p${i + 1}` : null)),
    );
    for (const url of log.spaces) {
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(fieldsOf(url)).toEqual([
        "nextPageToken",
        "spaces.displayName",
        "spaces.lastActiveTime",
        "spaces.name",
        "spaces.singleUserBotDm",
        "spaces.spaceType",
      ]);
    }
  },
);

it("names each direct message after the other member and looks up members only where needed", async () => {
  const f = await chatFixture();
  const log = chatFake(
    [
      Response.json({
        spaces: [
          { ...directMessage("bea", "2026-11-22T10:07:00Z"), displayName: "Old label" },
          directMessage("email", "2026-11-22T10:06:00Z"),
          directMessage("nameonly", "2026-11-22T10:05:00Z"),
          directMessage("bot", "2026-11-22T10:04:00Z"),
          { ...directMessage("app", "2026-11-22T10:03:00Z"), singleUserBotDm: true },
          { ...room(2), name: "spaces/launch", displayName: "Launch" },
          { name: "spaces/group", spaceType: "GROUP_CHAT", lastActiveTime: "2026-11-22T10:01:00Z" },
        ],
      }),
    ],
    {
      "spaces/bea": membersOf(human("bea@example.org", "Bea")),
      "spaces/email": membersOf(human("dee@example.org")),
      "spaces/nameonly": membersOf({ member: { type: "HUMAN", displayName: "Cy" } }),
      "spaces/bot": membersOf({ member: { type: "BOT", displayName: "Helper" } }),
      "spaces/app": membersOf({ member: { type: "BOT", displayName: "Helper" } }),
    },
  );
  const dm = (id: string, minute: number) => ({
    conversation: `spaces/${id}`,
    kind: "direct_message",
    last_active: `2026-11-22T10:0${minute}:00Z`,
  });
  expect(await answer(await listConversations(f))).toEqual({
    account: PERSONAL,
    conversations: [
      { ...dm("bea", 7), name: "Bea", with: { name: "Bea", email: "bea@example.org" } },
      { ...dm("email", 6), with: { email: "dee@example.org" } },
      dm("nameonly", 5),
      { ...dm("bot", 4), with: { app: true } },
      { ...dm("app", 3), with: { app: true } },
      {
        conversation: "spaces/launch",
        kind: "space",
        name: "Launch",
        last_active: "2026-11-22T10:02:00Z",
      },
      { conversation: "spaces/group", kind: "group", last_active: "2026-11-22T10:01:00Z" },
    ],
  });
  expect(log.members.sort()).toEqual([
    "spaces/bea",
    "spaces/bot",
    "spaces/email",
    "spaces/nameonly",
  ]);
});

it("returns the latest 50 by exact time within five pages and one member read each", async () => {
  const f = await chatFixture();
  const minute = (i: number) => String(i).padStart(2, "0");
  const newer = Array.from({ length: 49 }, (_, i) =>
    directMessage(`n${minute(i + 10)}`, `2026-11-22T13:${minute(i + 10)}:00Z`),
  );
  const older = Array.from({ length: 49 }, (_, i) =>
    directMessage(`o${minute(i + 10)}`, `2026-11-21T13:${minute(i + 10)}:00Z`),
  );
  const all = [
    directMessage("A", "2026-11-22T12:00:00.123001Z"),
    ...newer,
    ...older,
    directMessage("Z", "2026-11-22T12:00:00.123999Z"),
  ];
  const log = chatFake(
    [
      ...Array.from({ length: 5 }, (_, page) =>
        Response.json({ spaces: all.slice(page * 20, page * 20 + 20), nextPageToken: `p${page}` }),
      ),
      Response.json({ spaces: [] }),
    ],
    Object.fromEntries(
      all.map((space) => [space.name, membersOf(human(`${space.name.slice(7)}@example.org`))]),
    ),
  );
  const expected = [...newer.reverse(), all.at(-1)!].map((space) => space.name);
  const result = await answer(await listConversations(f));
  expect((result.conversations as Entry[]).map((entry) => entry.conversation)).toEqual(expected);
  expect((result.conversations as Entry[])[49]).toEqual({
    conversation: "spaces/Z",
    kind: "direct_message",
    last_active: "2026-11-22T12:00:00.123999Z",
    with: { email: "z@example.org" },
  });
  expect(result.omitted).toBe(50);
  expect(log.spaces).toHaveLength(5);
  for (const url of log.spaces) expect(url.searchParams.get("pageSize")).toBe("1000");
  expect(log.members.sort()).toEqual(expected.sort());
  expect(log.peak).toBe(5);
});

it("keeps the newest entries that fit 30,000 serialized characters and counts the rest", async () => {
  const f = await chatFixture();
  const people = Array.from({ length: 50 }, (_, i) => {
    const id = `p${String(i).padStart(2, "0")}`;
    return {
      id,
      time: `2026-11-22T10:${String(59 - i).padStart(2, "0")}:00Z`,
      name: `"${id}" ${'A long "quoted" name '.repeat(15)}`,
      email: `${id}.${"x".repeat(55)}@${"long-domain-".repeat(5)}example.org`,
    };
  });
  chatFake(
    [Response.json({ spaces: people.map((p) => directMessage(p.id, p.time)) })],
    Object.fromEntries(people.map((p) => [`spaces/${p.id}`, membersOf(human(p.email, p.name))])),
  );
  const expected = people.map((p) => ({
    conversation: `spaces/${p.id}`,
    kind: "direct_message",
    name: p.name,
    last_active: p.time,
    with: { name: p.name, email: p.email },
  }));
  const result = await answer(await listConversations(f));
  const kept = result.conversations as typeof expected;
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(50);
  expect(kept).toEqual(expected.slice(0, kept.length));
  expect(JSON.stringify(kept).length).toBeLessThanOrEqual(30_000);
  expect(JSON.stringify(expected.slice(0, kept.length + 1)).length).toBeGreaterThan(30_000);
  expect(result.omitted).toBe(50 - kept.length);
  expect(result.note).toContain(`holds the ${kept.length} most recent`);
});

it("fails the whole list when a member read finds the Google Chat API disabled", async () => {
  const f = await chatFixture();
  chatFake(
    [
      Response.json({
        spaces: [
          { ...room(3), name: "spaces/launch", displayName: "Launch" },
          directMessage("bea", "2026-11-22T10:02:00Z"),
          directMessage("off", "2026-11-22T10:01:00Z"),
        ],
      }),
    ],
    {
      "spaces/bea": membersOf(human("bea@example.org", "Bea")),
      "spaces/off": Response.json(
        {
          error: {
            code: 403,
            message: "Google Chat API has not been used in project 123 before or it is disabled.",
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SERVICE_DISABLED",
                domain: "googleapis.com",
                metadata: { service: "chat.googleapis.com", consumer: "projects/123" },
              },
            ],
          },
        },
        { status: 403 },
      ),
    },
  );
  await expectError(
    await listConversations(f),
    "api_not_enabled",
    `The Google Chat API is not enabled in the owner's Google Cloud project, so Google refused the request for ${PERSONAL}. Ask the owner to enable it in Google Cloud and try again.`,
  );
  expect((await callRows()).at(-1)).toMatchObject({
    tool: "list_conversations",
    account_id: f.personal.id,
    outcome: "failed",
    reason: "api_not_enabled",
  });
});
