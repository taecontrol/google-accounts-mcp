import { http } from "msw";
import { network } from "./network";
import { fixture, PERSONAL, toolCall } from "./permissions";
import { setTool } from "./uploads";
import type { AccountRow } from "./accounts";

// Google's documented calendarList and OAuth contracts, independent of production constants.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];
export const CALENDAR_LIST = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
export type CalendarRequest = Pick<Request, "url" | "method" | "headers" | "redirect" | "signal">;
export function calendarFake(
  ...answers: Array<Response | ((request: CalendarRequest) => Response)>
) {
  const requests: CalendarRequest[] = [];
  network.use(
    http.get(CALENDAR_LIST, ({ request }) => {
      requests.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("Unexpected calendar page");
      return typeof answer === "function" ? answer(request) : answer;
    }),
  );
  return requests;
}

type EventAnswer = Response | ((request: CalendarRequest) => Response | Promise<Response>);
export interface CalendarEvents {
  list?: EventAnswer;
  events?: Record<string, EventAnswer>;
}
/** Independent Google fixtures keyed by the calendar and event actually named in the URL. */
export function eventsFake(answers: Record<string, CalendarEvents>) {
  const requests: CalendarRequest[] = [];
  network.use(
    http.get("https://www.googleapis.com/calendar/v3/calendars/*", ({ request }) => {
      requests.push(request);
      const parts = new URL(request.url).pathname.split("/");
      const calendar = decodeURIComponent(parts[4]!);
      const event = parts[6] === undefined ? undefined : decodeURIComponent(parts[6]);
      const answer =
        event === undefined ? answers[calendar]?.list : answers[calendar]?.events?.[event];
      if (!answer)
        throw new Error(`Unexpected Calendar events request: ${calendar}/${event ?? "list"}`);
      return typeof answer === "function" ? answer(request) : answer.clone();
    }),
  );
  return requests;
}

export const PRIMARY_CALENDAR = {
  id: PERSONAL,
  summary: "Personal",
  primary: true,
  accessRole: "owner",
  timeZone: "America/Bogota",
};
export const SECONDARY_CALENDAR = {
  id: "team@group.calendar.google.com",
  summary: "Team",
  accessRole: "reader",
  timeZone: "Asia/Tokyo",
};
// Observed API shape on 2026-11-14. An organizer has no attendee entry unless Google supplied one.
export const eventFixture = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  status: "confirmed",
  summary: "Planning",
  start: { dateTime: "2026-11-20T14:00:00Z" },
  end: { dateTime: "2026-11-20T15:00:00Z" },
  organizer: { email: PERSONAL, self: true },
  htmlLink: "https://calendar.google.com/calendar/event?eid=test",
  ...overrides,
});
export const eventsFixture = async (
  tool = "search_events",
  setting: "ask" | "allow" = "allow",
  overrides: Partial<AccountRow> = {},
) => {
  const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES), ...overrides });
  await setTool(f, tool, setting);
  return f;
};
export const searchCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = {},
) =>
  toolCall(f.mcp, "search_events", {
    account: PERSONAL,
    from: "2026-11-20",
    to: "2026-11-21",
    ...args,
  });
export const readEventCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = {},
) => toolCall(f.mcp, "read_event", { account: PERSONAL, event: "e1", ...args });
