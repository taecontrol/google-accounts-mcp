import { Data, Effect } from "effect";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import type { Config } from "../config";
import { normalizeEmail } from "../email";

export class AccessMissing extends Data.TaggedError("AccessMissing") {}
export class AccessRejected extends Data.TaggedError("AccessRejected") {}
export class AccessUnavailable extends Data.TaggedError("AccessUnavailable") {}
export interface AccessIdentity {
  readonly email: string;
}

const CERTS_TIMEOUT = 5_000;
const CACHE_MAX_AGE = 10 * 60_000;
const MIN_MODULUS_BITS = 2048;
type Keys = ReturnType<typeof createLocalJWKSet>;
let cached: { issuer: string; keys: Keys; fetchedAt: number } | undefined;

function modulusBits(n: string): number {
  const significant = atob(n.replaceAll("-", "+").replaceAll("_", "/")).replace(/^\0+/, "");
  if (!significant) return 0;
  return (significant.length - 1) * 8 + (32 - Math.clz32(significant.charCodeAt(0)));
}

function usableKeySet(body: unknown): JSONWebKeySet {
  const keys: unknown = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new AccessUnavailable();
  for (const key of keys as Array<Record<string, unknown> | null>) {
    if (
      key?.kty !== "RSA" ||
      (key.use !== undefined && key.use !== "sig") ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      typeof key.kid !== "string" ||
      !key.kid ||
      typeof key.n !== "string" ||
      !key.n ||
      typeof key.e !== "string" ||
      !key.e ||
      modulusBits(key.n) < MIN_MODULUS_BITS
    )
      throw new AccessUnavailable();
  }
  return { keys: keys as JSONWebKeySet["keys"] };
}

async function fetchKeys(issuer: string): Promise<Keys> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CERTS_TIMEOUT);
  try {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) throw new AccessUnavailable();
    const keys = createLocalJWKSet(usableKeySet(await response.json()));
    cached = { issuer, keys, fetchedAt: Date.now() };
    return keys;
  } catch {
    throw new AccessUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export const verifyAccess = (request: Request, access: Config["access"], now: number) =>
  Effect.tryPromise({
    try: async (): Promise<AccessIdentity> => {
      const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!assertion) throw new AccessMissing();
      const { payload } = await jwtVerify(
        assertion,
        async (header, token) => {
          if (typeof header.kid !== "string" || !header.kid) throw new AccessRejected();
          const warm = cached?.issuer === access.issuer && now < cached.fetchedAt + CACHE_MAX_AGE;
          let keys = warm && cached ? cached.keys : await fetchKeys(access.issuer);
          try {
            return await keys(header, token);
          } catch (error) {
            if (!(error instanceof errors.JWKSNoMatchingKey)) {
              if (cached?.keys === keys) cached = undefined;
              throw new AccessUnavailable();
            }
            if (!warm) throw new AccessRejected();
          }
          keys = await fetchKeys(access.issuer);
          try {
            return await keys(header, token);
          } catch (error) {
            if (error instanceof errors.JWKSNoMatchingKey) throw new AccessRejected();
            if (cached?.keys === keys) cached = undefined;
            throw new AccessUnavailable();
          }
        },
        {
          algorithms: ["RS256"],
          issuer: access.issuer,
          audience: access.audience,
          requiredClaims: ["exp", "nbf", "email"],
          currentDate: new Date(now),
        },
      );
      const email = normalizeEmail(payload.email);
      if (!email) throw new AccessRejected();
      return { email };
    },
    catch: (error) =>
      error instanceof AccessMissing || error instanceof AccessUnavailable
        ? error
        : new AccessRejected(),
  });
