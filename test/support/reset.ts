import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../env";

export async function resetBindings(): Promise<void> {
  await Promise.all([
    env.DB.prepare("SELECT 1").run(),
    env.OAUTH_KV.list({ limit: 1 }),
    env.FILES_KV.list({ limit: 1 }),
  ]);
  await reset();
  await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
}
