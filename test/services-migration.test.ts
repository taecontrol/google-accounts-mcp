import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { TestEnv } from "./env";
import { accounts, NOW, seedAccount } from "./support/accounts";
import { CALENDAR_SCOPES } from "./support/calendar";
import { SCOPES } from "./support/google";

it("keeps only previously granted Gmail scopes on every legacy row without changing credentials", async () => {
  await seedAccount({ scopes: JSON.stringify(["openid", ...SCOPES, ...CALENDAR_SCOPES, "email"]) });
  await seedAccount({
    email: "partial@example.com",
    created_at: NOW + 1,
    scopes: JSON.stringify([CALENDAR_SCOPES[0], SCOPES[0], "other"]),
  });
  await seedAccount({
    email: "removed@example.com",
    created_at: NOW + 2,
    state: "removed",
    refresh_token: null,
    access_token: null,
    scopes: JSON.stringify(CALENDAR_SCOPES),
  });
  const before = await accounts();
  const migration = (env as TestEnv).TEST_MIGRATIONS.find(
    (m) => m.name === "0011_account_services.sql",
  );
  expect(migration).toBeDefined();
  await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)));
  const after = await accounts();
  expect(after.map(({ scopes: _scopes, ...row }) => row)).toEqual(
    before.map(({ scopes: _scopes, ...row }) => row),
  );
  expect(after.map((row) => JSON.parse(row.scopes))).toEqual([SCOPES, [SCOPES[0]], []]);
});
