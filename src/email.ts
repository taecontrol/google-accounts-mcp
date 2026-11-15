// No relative imports: `scripts/deploy.ts` runs `src/config.ts`, and this module, in plain Node.
export type OwnerEmail = string & { readonly __ownerEmail: unique symbol };
export function normalizeEmail(raw: unknown): OwnerEmail | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? (email as OwnerEmail) : null;
}
