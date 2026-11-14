import { Schema } from "effect";

export const SERVICES = ["gmail", "calendar"] as const;
export type Service = (typeof SERVICES)[number];
export const GMAIL_SCOPES = ["gmail.readonly", "gmail.compose", "gmail.send", "gmail.modify"]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .concat("https://mail.google.com/");
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];
export const serviceInfo = {
  gmail: { name: "Gmail", api: "Gmail API", scopes: GMAIL_SCOPES },
  calendar: { name: "Calendar", api: "Google Calendar API", scopes: CALENDAR_SCOPES },
} satisfies Record<Service, { name: string; api: string; scopes: readonly string[] }>;
export const ChosenServices = Schema.Array(Schema.Literals(SERVICES)).check(
  Schema.isMinLength(1),
  Schema.isUnique(),
);
export const parseServices = (value: unknown): readonly Service[] | null => {
  const parsed = Schema.decodeUnknownOption(ChosenServices)(value);
  return parsed._tag === "Some" ? parsed.value : null;
};
export const scopesOf = (services: readonly Service[]): string[] =>
  services.flatMap((service) => serviceInfo[service].scopes);
/** Keep only access the owner chose, even if Google returns an earlier, wider grant. */
export const chosenScopes = (granted: readonly string[], services: readonly Service[]): string[] =>
  scopesOf(services).filter((scope) => granted.includes(scope));
