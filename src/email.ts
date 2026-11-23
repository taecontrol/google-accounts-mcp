export type OwnerEmail = string & { readonly __ownerEmail: unique symbol };
export function normalizeEmail(raw: unknown): OwnerEmail | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? (email as OwnerEmail) : null;
}
