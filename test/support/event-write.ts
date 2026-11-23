import { http } from "msw";
import { network } from "./network";
import { calendarFake, PRIMARY_CALENDAR, type CalendarRequest } from "./calendar";
import { PERSONAL, toolCall } from "./permissions";
import type { Fixture } from "./approvals";
import { testEnv } from "./worker";

export const createEventCall = (
  f: Fixture,
  args: Record<string, unknown> = {},
  workerEnv = testEnv(),
) =>
  toolCall(
    f.mcp,
    "create_event",
    {
      account: PERSONAL,
      title: "Planning",
      start: "2026-11-20T09:00",
      end: "2026-11-20T10:00",
      ...args,
    },
    workerEnv,
  );
export const repeatCalendars = (...items: object[]) =>
  calendarFake(...Array.from({ length: 20 }, () => () => Response.json({ items })));
export const primaryList = () => repeatCalendars(PRIMARY_CALENDAR);

type Event = Record<string, unknown>;
type Insert = { request: CalendarRequest; body: Event; bodyText: string; calendar: string };
export function eventWriter() {
  const inserts: Insert[] = [];
  const reads: CalendarRequest[] = [];
  const events = new Map<string, Event>();
  const fake: {
    insert?: (insert: Insert) => Response | Promise<Response>;
    read?: (request: CalendarRequest) => Response | Promise<Response>;
  } = {};
  network.use(
    http.post("https://www.googleapis.com/calendar/v3/calendars/*", async ({ request }) => {
      const bodyText = await request.clone().text();
      const body = (await request.json()) as Event;
      const calendar = decodeURIComponent(new URL(request.url).pathname.split("/")[4]!);
      const entry = { request, body, bodyText, calendar };
      inserts.push(entry);
      const event = {
        id: body.id,
        status: "confirmed",
        htmlLink: `https://calendar.google.com/calendar/event?eid=${String(body.id)}`,
        ...body,
      };
      events.set(`${calendar}/${String(body.id)}`, event);
      return fake.insert ? fake.insert(entry) : Response.json(event);
    }),
    http.get("https://www.googleapis.com/calendar/v3/calendars/*", ({ request }) => {
      reads.push(request);
      if (fake.read) return fake.read(request);
      const parts = new URL(request.url).pathname.split("/");
      const event = events.get(`${decodeURIComponent(parts[4]!)}/${decodeURIComponent(parts[6]!)}`);
      return event ? Response.json(event) : new Response(null, { status: 404 });
    }),
  );
  return { inserts, reads, events, fake };
}
