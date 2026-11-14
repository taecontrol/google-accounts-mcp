import "./support/account-checks";
import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import type { TestEnv } from "./env";
import { take, confirm, release, WINDOW } from "../src/once/store";
import { identityOf } from "../src/once/identity";
import { parseAccountTool } from "../src/mcp/tools";
import { parseConnectionId } from "../src/connections/model";
import { readConfig } from "../src/config";
import { answer } from "./support/approvals";
import { draftCall, draftFixture } from "./support/draft";
import { PERSONAL, toolCall } from "./support/permissions";
import { setTool } from "./support/uploads";
import { testEnv } from "./support/worker";
import { google } from "./support/google";

it("migration 0012 preserves done mail with and without a draft, running, and unknown, and repeats decode it", async () => {
  const f = await draftFixture();
  await setTool(f, "send_message", "allow");
  const draft = await answer(await draftCall(f));
  const mailArgs = { account: PERSONAL, to: ["guest@example.com"], subject: "Test", body: "Body" };
  const sent = await answer(await toolCall(f.mcp, "send_message", mailArgs));
  const original = (
    await env.DB.prepare("SELECT * FROM once ORDER BY rowid").all<{
      identity: string;
      state: string;
      claim: string;
      taken_at: number;
      expires_at: number;
      result: string;
    }>()
  ).results;
  const migrations = (env as TestEnv).TEST_MIGRATIONS;
  const old = migrations.find((m) => m.name === "0006_same_call.sql")!;
  await env.DB.prepare("DROP TABLE once").run();
  await env.DB.batch(old.queries.slice(0, 2).map((sql) => env.DB.prepare(sql)));
  for (const row of original) {
    const value = JSON.parse(row.result) as { draft?: string; message: string; thread: string };
    await env.DB.prepare(
      "INSERT INTO once (identity,state,claim,taken_at,expires_at,draft_id,message_id,thread_id) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(
        row.identity,
        row.state,
        row.claim,
        row.taken_at,
        row.expires_at,
        value.draft ?? null,
        value.message,
        value.thread,
      )
      .run();
  }
  for (const state of ["running", "unknown"])
    await env.DB.prepare(
      "INSERT INTO once (identity,state,claim,taken_at,expires_at) VALUES (?,?,?,1,9999999999999)",
    )
      .bind(state, state, `claim-${state}`)
      .run();
  const migration = migrations.find((m) => m.name === "0012_once_result.sql")!;
  expect(migration).toBeDefined();
  await env.DB.batch(migration.queries.map((sql) => env.DB.prepare(sql)));
  const copied = (
    await env.DB.prepare("SELECT * FROM once ORDER BY rowid").all<Record<string, unknown>>()
  ).results;
  expect(copied).toHaveLength(4);
  for (const [i, row] of copied.entries()) {
    expect(row.request_key).toMatch(/^[0-9a-f]{32}$/);
    expect(row).not.toHaveProperty("message_id");
    expect(row).not.toHaveProperty("draft_id");
    expect(row).not.toHaveProperty("thread_id");
    if (i < 2) {
      const prior = original[i]!;
      expect(row).toMatchObject({
        identity: prior.identity,
        claim: prior.claim,
        taken_at: prior.taken_at,
        expires_at: prior.expires_at,
      });
      expect(JSON.parse(row.result as string)).toEqual(JSON.parse(prior.result));
    } else
      expect(row).toMatchObject({
        identity: i === 2 ? "running" : "unknown",
        result: null,
        taken_at: 1,
        expires_at: 9999999999999,
      });
  }
  expect(new Set(copied.map((row) => row.request_key)).size).toBe(4);
  expect(
    (
      await env.DB.prepare("PRAGMA table_list").all<{ name: string; strict: number }>()
    ).results.find((table) => table.name === "once")?.strict,
  ).toBe(1);
  expect(JSON.parse(copied[1]!.result as string)).not.toHaveProperty("draft");
  expect(
    (await env.DB.prepare("PRAGMA table_info(approvals)").all<{ name: string }>()).results.some(
      (c) => c.name === "identity",
    ),
  ).toBe(true);
  expect(
    (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'once_expiry'",
      ).all()
    ).results,
  ).toHaveLength(1);
  expect(await answer(await draftCall(f))).toMatchObject({
    ...draft,
    repeat_of: expect.any(String),
  });
  expect(await answer(await toolCall(f.mcp, "send_message", mailArgs))).toMatchObject({
    ...sent,
    repeat_of: expect.any(String),
  });
  expect(google.draftCreates).toHaveLength(2);
  expect(google.sends).toHaveLength(1);
});

it("only the matching request key confirms a running row, and release cannot delete a confirmed result", async () => {
  const f = await draftFixture();
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw config.failure;
  const identity = await identityOf(config.success.tokenKey, {
    connection: parseConnectionId(f.connection.id)!,
    account: f.personal.id,
    tool: parseAccountTool("create_draft")!,
    args: {},
    defaults: {},
  });
  const at = Date.now();
  const entered = await Effect.runPromise(take({ db: env.DB }, identity, at));
  if (entered.kind !== "run") throw new Error("Expected claim");
  const stored = { calendar: "calendar", event: entered.claim.key };
  expect(
    await Effect.runPromise(confirm({ db: env.DB }, identity, "wrong-key", stored, at + 1)),
  ).toBe(false);
  expect(
    await Effect.runPromise(confirm({ db: env.DB }, identity, entered.claim.key, stored, at + 2)),
  ).toBe(true);
  await Effect.runPromise(release({ db: env.DB }, entered.claim));
  expect(await env.DB.prepare("SELECT state, result, expires_at FROM once").first()).toEqual({
    state: "done",
    result: JSON.stringify(stored),
    expires_at: at + 2 + WINDOW,
  });
  expect(
    await Effect.runPromise(
      confirm({ db: env.DB }, identity, entered.claim.key, { different: true }, at + 3),
    ),
  ).toBe(false);
});
