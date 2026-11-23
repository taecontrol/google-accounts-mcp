import { http } from "msw";
import { network } from "./network";
import { fixture, PERSONAL, toolCall } from "./permissions";
import { setTool } from "./uploads";
import type { AccountRow } from "./accounts";
import { testEnv } from "./worker";

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

export type EventRequest = CalendarRequest & { body?: unknown };
type EventAnswer = Response | ((request: EventRequest) => Response | Promise<Response>);
export interface CalendarEvents {
  list?: EventAnswer;
  events?: Record<string, EventAnswer>;
  patch?: Record<string, EventAnswer>;
  delete?: Record<string, EventAnswer>;
  instances?: Record<string, EventAnswer>;
}
export function eventsFake(answers: Record<string, CalendarEvents>) {
  const requests: EventRequest[] = [];
  network.use(
    http.all("https://www.googleapis.com/calendar/v3/calendars/*", async ({ request }) => {
      const recorded: EventRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body === null ? {} : { body: await request.clone().json() }),
      };
      requests.push(recorded);
      const parts = new URL(request.url).pathname.split("/");
      const calendar = decodeURIComponent(parts[4]!);
      const event = parts[6] === undefined ? undefined : decodeURIComponent(parts[6]);
      const entry = answers[calendar];
      const answer =
        event === undefined
          ? entry?.list
          : request.method === "PATCH"
            ? entry?.patch?.[event]
            : request.method === "DELETE"
              ? entry?.delete?.[event]
              : parts[7] === "instances"
                ? entry?.instances?.[event]
                : entry?.events?.[event];
      if (!answer)
        throw new Error(`Unexpected Calendar events request: ${calendar}/${event ?? "list"}`);
      return typeof answer === "function" ? answer(recorded) : answer.clone();
    }),
  );
  return requests;
}

type FreeBusyRequest = CalendarRequest & Pick<Request, "json">;
export function freeBusyFake(
  answer: Response | ((request: FreeBusyRequest) => Response | Promise<Response>),
) {
  const requests: FreeBusyRequest[] = [];
  network.use(
    http.post("https://www.googleapis.com/calendar/v3/freeBusy", ({ request }) => {
      requests.push(request.clone());
      return typeof answer === "function" ? answer(request) : answer.clone();
    }),
  );
  return requests;
}

export interface CalendarPatchRequest extends CalendarRequest {
  readonly body: string;
}
export function patchEventsFake(
  ...answers: Array<Response | ((request: CalendarPatchRequest) => Response | Promise<Response>)>
) {
  const requests: CalendarPatchRequest[] = [];
  network.use(
    http.patch("https://www.googleapis.com/calendar/v3/calendars/*", async ({ request }) => {
      const recorded = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
        signal: request.signal,
        body: await request.text(),
      };
      requests.push(recorded);
      const answer = answers.shift();
      if (!answer) throw new Error("Unexpected Calendar patch");
      return typeof answer === "function" ? answer(recorded) : answer;
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
export const eventFixture = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  etag: '"version-1"',
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

export const invitationFixture = (overrides: Record<string, unknown> = {}) =>
  eventFixture({
    etag: '"invitation-v1"',
    eventType: "default",
    organizer: { email: "host@example.com" },
    attendees: [{ email: PERSONAL, self: true, responseStatus: "needsAction" }],
    ...overrides,
  });
export const respondCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = {},
) =>
  toolCall(f.mcp, "respond_to_event", {
    account: PERSONAL,
    event: "e1",
    response: "accepted",
    ...args,
  });
export const eventChangeCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  tool: "update_event" | "delete_event",
  args: Record<string, unknown> = {},
  workerEnv = testEnv(),
) => toolCall(f.mcp, tool, { account: PERSONAL, event: "e1", ...args }, workerEnv);
