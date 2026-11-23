export type OwnerState = "unpinned" | "pinned" | "resetting";

export interface ResetPlan {
  readonly generation: number;
  readonly resuming: boolean;
  readonly statements: ReadonlyArray<string>;
}

export type ResetOutcome = "done" | "overtaken" | "unknown";

const OWNER_TABLES = [
  "connections",
  "accounts",
  "permissions",
  "calls",
  "call_accounts",
  "approvals",
  "once",
  "uploads",
];

export const resetPlan = (row: { state: OwnerState; generation: number }): ResetPlan => {
  const resuming = row.state === "resetting";
  const generation = row.generation + (resuming ? 0 : 1);
  const from = row.state === "pinned" ? "pinned" : "unpinned";
  if (!Number.isSafeInteger(generation))
    throw new Error("Reset generation must be a safe integer.");
  const guard = `EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state = 'resetting' AND generation = ${generation})`;
  return {
    generation,
    resuming,
    statements: [
      ...(resuming
        ? []
        : [
            `UPDATE owner SET state = 'resetting', generation = ${generation} WHERE id = 1 AND generation = ${row.generation} AND state = '${from}' RETURNING generation`,
          ]),
      ...OWNER_TABLES.map((table) => `DELETE FROM ${table} WHERE ${guard}`),
      `UPDATE owner SET state = 'unpinned', email = NULL WHERE id = 1 AND state = 'resetting' AND generation = ${generation} RETURNING generation`,
    ],
  };
};

export const resetOutcome = (
  plan: ResetPlan,
  results: ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>,
): ResetOutcome => {
  if (!plan.resuming && results[0]?.results.length === 0) return "overtaken";
  if (results.length === plan.statements.length && results.at(-1)?.results.length) return "done";
  return "unknown";
};
