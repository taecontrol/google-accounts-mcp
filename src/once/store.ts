import { Effect, Schema } from "effect";
import { CALL_DEADLINE, RUN_DEADLINE } from "../approvals/model";
import { Unavailable, WriteUncertain } from "../db";
import type { Identity } from "./identity";

export const WINDOW = 7 * 24 * 3_600_000;
export const STALE = Math.max(CALL_DEADLINE, RUN_DEADLINE) + 5_000;
export type Claim = {
  readonly identity: Identity;
  readonly value: string;
  readonly key: string;
  readonly __claim: unique symbol;
};
export type Repeat =
  | { kind: "done"; result: unknown; at: number }
  | { kind: "running" }
  | { kind: "unknown"; key: string; at: number; until: number; checked?: Check };
export type Check = "missing" | "failed";
export type Entered = { kind: "run"; claim: Claim } | Repeat;
type OnceContext = { db: D1Database };
const Row = Schema.Struct({
  state: Schema.Literals(["running", "done", "unknown"]),
  taken_at: Schema.Int,
  expires_at: Schema.Int,
  request_key: Schema.String,
  result: Schema.NullOr(Schema.String),
});
const decodeRepeat = (raw: unknown, now: number): Repeat | null => {
  if (raw === undefined) return null;
  const row = Schema.decodeUnknownSync(Row)(raw);
  if (row.expires_at <= now) return null;
  if (row.state === "done") {
    if (row.result === null) throw new WriteUncertain();
    return { kind: "done", at: row.taken_at, result: JSON.parse(row.result) as unknown };
  }
  return row.state === "running" && row.taken_at + STALE > now
    ? { kind: "running" }
    : { kind: "unknown", key: row.request_key, at: row.taken_at, until: row.expires_at };
};
export const decodeRow = (result: D1Result, now: number): Repeat | null =>
  decodeRepeat(result.results[0], now);
export const liveRowWhere = (identity: string, now: string) =>
  `EXISTS (SELECT 1 FROM once WHERE identity = ${identity} AND expires_at > ${now})`;
export const rowStatement = (db: D1Database, identity: Identity) =>
  db.prepare("SELECT * FROM once WHERE identity = ?1").bind(identity);
export const cleanupStatement = (db: D1Database, now: number) =>
  db.prepare("DELETE FROM once WHERE expires_at <= ?1").bind(now);

export const take = (
  ctx: OnceContext,
  identity: Identity,
  now: number,
): Effect.Effect<Entered, WriteUncertain> =>
  Effect.tryPromise({
    try: async (): Promise<Entered> => {
      const value = crypto.randomUUID();
      const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const results = await ctx.db.batch([
        ctx.db
          .prepare("DELETE FROM once WHERE identity = ?1 AND expires_at <= ?2")
          .bind(identity, now),
        ctx.db
          .prepare(`INSERT INTO once (identity,state,claim,request_key,taken_at,expires_at)
          VALUES (?1,'running',?2,?3,?4,?5) ON CONFLICT DO NOTHING RETURNING identity`)
          .bind(identity, value, key, now, now + WINDOW),
        rowStatement(ctx.db, identity),
      ]);
      if (results[1]!.results.length)
        return { kind: "run", claim: { identity, value, key } as Claim };
      const repeat = decodeRepeat(results[2]!.results[0], now);
      if (!repeat) throw new WriteUncertain();
      return repeat;
    },
    catch: () => new WriteUncertain(),
  });
export const settle = (
  ctx: OnceContext,
  claim: Claim,
  now: number,
  outcome: { kind: "done"; result: unknown } | { kind: "unknown" },
): Effect.Effect<void, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      if (outcome.kind === "done")
        await ctx.db
          .prepare(`UPDATE once SET state = 'done', result = ?3, expires_at = ?4
          WHERE identity = ?1 AND claim = ?2 AND state IN ('running','unknown')`)
          .bind(claim.identity, claim.value, JSON.stringify(outcome.result), now + WINDOW)
          .run();
      else
        await ctx.db
          .prepare(`UPDATE once SET state = 'unknown', expires_at = ?3
          WHERE identity = ?1 AND claim = ?2 AND state = 'running'`)
          .bind(claim.identity, claim.value, now + WINDOW)
          .run();
    },
    catch: () => new Unavailable(),
  });
export const release = (ctx: OnceContext, claim: Claim): Effect.Effect<void, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      await ctx.db
        .prepare("DELETE FROM once WHERE identity = ?1 AND claim = ?2 AND state <> 'done'")
        .bind(claim.identity, claim.value)
        .run();
    },
    catch: () => new Unavailable(),
  });

export const confirm = (
  ctx: OnceContext,
  identity: Identity,
  key: string,
  stored: unknown,
  now: number,
): Effect.Effect<boolean, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      const result = await ctx.db
        .prepare(`UPDATE once SET state = 'done', result = ?3, expires_at = ?4
          WHERE identity = ?1 AND request_key = ?2 AND state IN ('running','unknown')`)
        .bind(identity, key, JSON.stringify(stored), now + WINDOW)
        .run();
      return result.meta.changes > 0;
    },
    catch: () => new Unavailable(),
  });
