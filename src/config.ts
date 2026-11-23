import { Data, Result } from "effect";
import { normalizeEmail, type OwnerEmail } from "./email.ts";

export const CONFIG_NAMES = [
  "OWNER_EMAIL",
  "ACCESS_ISSUER",
  "ACCESS_AUDIENCE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_KEY",
] as const;
export type ConfigName = (typeof CONFIG_NAMES)[number];
export class Incomplete extends Data.TaggedError("Incomplete")<{
  readonly names: ConfigName[];
}> {}
export type AccessIssuer = string & { readonly __accessIssuer: unique symbol };
export type TokenKey = Uint8Array<ArrayBuffer> & { readonly __tokenKey: unique symbol };
export interface Config {
  readonly google: { readonly clientId: string; readonly clientSecret: string };
  readonly tokenKey: TokenKey;
  readonly ownerEmail: OwnerEmail;
  readonly access: { readonly issuer: AccessIssuer; readonly audience: string };
}

const hex64 = (value: unknown) => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);

export const CONFIG_CHECKS: Record<ConfigName, (value: unknown) => boolean> = {
  OWNER_EMAIL: (value) => normalizeEmail(value) !== null,
  ACCESS_ISSUER: (value) =>
    typeof value === "string" &&
    /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(value),
  ACCESS_AUDIENCE: hex64,
  GOOGLE_CLIENT_ID: (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value),
  GOOGLE_CLIENT_SECRET: (value) =>
    typeof value === "string" && value.length > 0 && value === value.trim(),
  TOKEN_KEY: hex64,
};

export function readConfig(env: Env): Result.Result<Config, Incomplete> {
  const names = CONFIG_NAMES.filter((name) => !CONFIG_CHECKS[name](env[name]));
  if (names.length > 0) return Result.fail(new Incomplete({ names }));
  return Result.succeed({
    ownerEmail: normalizeEmail(env.OWNER_EMAIL)!,
    access: { issuer: env.ACCESS_ISSUER as AccessIssuer, audience: env.ACCESS_AUDIENCE },
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    tokenKey: Uint8Array.from(env.TOKEN_KEY.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    ) as TokenKey,
  });
}
