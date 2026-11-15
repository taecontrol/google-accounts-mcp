import { Effect, Schema } from "effect";
import type { ViewValue } from "../approvals/model";
import { normalizeEmail } from "../email";
import { Duplicate, duplicateValue } from "../mcp/duplicate";
import { creating, ToolFailure } from "../mcp/failures";
import type { Send, Sending } from "../mcp/tools";
import { unfold } from "./bounds";
import {
  CALENDAR_API,
  CalendarId,
  readCalendarList,
  writableCalendar,
  type CalendarContext,
} from "./calendar";
import { TimeText, ZoneName } from "./calendar-time";
import {
  Title,
  Location,
  Description,
  Guests,
  guestKey,
  windowIssue,
  eventPoints,
  checkedDescription,
  timeValues,
  guestsValue,
  writeEvent,
  readWrittenEvent,
  type WrittenEvent,
} from "./event-write";
import { Repeat, repeatIssue, repeatRule } from "./repeat";

export const CreateEventInput = Schema.Struct({
  account: Schema.String,
  calendar: Schema.optionalKey(CalendarId),
  title: Title,
  start: TimeText,
  end: TimeText,
  time_zone: Schema.optionalKey(ZoneName),
  location: Schema.optionalKey(Location),
  repeat: Schema.optionalKey(Repeat),
  description: Schema.optionalKey(Description),
  guests: Schema.optionalKey(Guests),
  meet: Schema.optionalKey(Schema.Boolean),
  duplicate: Schema.optionalKey(Duplicate),
}).check(
  Schema.makeFilter((args) => {
    const issue = windowIssue(args);
    if (issue !== true) return issue;
    if (
      args.guests?.some(
        (address) => guestKey(address) === guestKey(normalizeEmail(args.account) ?? args.account),
      )
    )
      return { path: ["guests"], issue: "without the account's own address" };
    return repeatIssue(args);
  }),
);
type CreateEventArgs = typeof CreateEventInput.Type;
export const CreatedEvent = Schema.Struct({
  calendar: Schema.NonEmptyString,
  event: Schema.NonEmptyString,
  link: Schema.optionalKey(Schema.String),
  meet: Schema.optionalKey(Schema.String),
  meet_status: Schema.optionalKey(Schema.Literals(["pending", "failure", "none"])),
  cancelled: Schema.optionalKey(Schema.Literal(true)),
});
const eventResult = (event: WrittenEvent, calendar: string): typeof CreatedEvent.Type => ({
  calendar,
  event: event.id,
  ...(event.link === undefined ? {} : { link: event.link }),
  ...(event.meet === undefined ? {} : { meet: event.meet }),
  ...(event.meetStatus === undefined ? {} : { meet_status: event.meetStatus }),
  ...(event.status === "cancelled" ? { cancelled: true as const } : {}),
});
/** One calendar-list snapshot supplies both the approved values and the request. */
export const createEventPlan = (args: CreateEventArgs, ctx: CalendarContext) =>
  Effect.gen(function* () {
    const calendar = yield* Effect.fromResult(writableCalendar(ctx, args.calendar));
    const points = yield* Effect.fromResult(eventPoints(args, ctx.zone));
    const repeat = yield* Effect.fromResult(repeatRule(args, ctx.zone, ctx.primary?.time_zone));
    const description = yield* checkedDescription(args.description ?? "");
    const calendarText = `${unfold(calendar.name)} (${calendar.calendar})`;
    const values: ViewValue[] = [
      { name: "Calendar", text: calendarText, from: "calendar" },
      ...(!calendar.primary
        ? [{ name: "Guests see the organizer as", text: calendarText, from: "calendar" as const }]
        : []),
      { name: "Title", text: args.title, from: "agent" },
      ...timeValues(args.start, args.end, ctx.zone),
      ...(repeat ? [{ name: "Repeats", text: repeat.text, from: "agent" as const }] : []),
      ...(args.guests?.length
        ? [
            guestsValue(
              args.guests,
              repeat ? "one invitation for the whole series" : "the invitation",
              "agent",
            ),
          ]
        : []),
      ...(args.meet
        ? [
            {
              name: "Google Meet",
              text: "Asks Google to add a Google Meet link",
              from: "agent" as const,
            },
          ]
        : []),
      ...(args.location ? [{ name: "Location", text: args.location, from: "agent" as const }] : []),
      ...duplicateValue(args.duplicate),
      ...(args.description
        ? [{ name: "Description", text: args.description, from: "agent" as const }]
        : []),
    ];
    return { calendar, points, repeat, description, values };
  });
type CreateEventPlan = Effect.Success<ReturnType<typeof createEventPlan>>;
export const insertEvent = (
  sending: Sending,
  plan: CreateEventPlan,
  args: CreateEventArgs,
  key: string,
): Effect.Effect<typeof CreatedEvent.Type, ToolFailure> =>
  Effect.gen(function* () {
    const event = yield* creating(
      writeEvent(sending, {
        method: "POST",
        calendar: plan.calendar.calendar,
        query: args.meet ? { conferenceDataVersion: "1" } : {},
        body: {
          id: key,
          summary: args.title,
          ...plan.points,
          ...(plan.repeat ? { recurrence: [plan.repeat.line] } : {}),
          ...(args.location ? { location: args.location } : {}),
          ...(plan.description ? { description: plan.description } : {}),
          ...(args.guests?.length ? { attendees: args.guests.map((email) => ({ email })) } : {}),
          ...(args.meet
            ? {
                conferenceData: {
                  createRequest: {
                    requestId: key,
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                  },
                },
              }
            : {}),
        },
        refused: (status) =>
          status === 400
            ? new ToolFailure({ code: "invalid_arguments" })
            : status === 404
              ? new ToolFailure({
                  code: "not_found",
                  missing: { kind: "calendar", id: plan.calendar.calendar },
                })
              : new ToolFailure({ code: "google_unavailable" }),
      }),
    );
    if (event === null)
      return yield* Effect.fail(new ToolFailure({ code: "outcome_unknown", unknown: true }));
    return eventResult(event, plan.calendar.calendar);
  });
export const settleEvent = (
  read: Send,
  args: CreateEventArgs,
  key: string,
): Effect.Effect<typeof CreatedEvent.Type | null, ToolFailure> =>
  Effect.gen(function* () {
    const calendar =
      args.calendar ??
      (yield* readCalendarList(read)).calendars.find((entry) => entry.primary)?.calendar;
    if (calendar === undefined || calendar === "primary")
      return yield* Effect.fail(new ToolFailure({ code: "not_found" }));
    const response = yield* read(
      (token, signal) =>
        new Request(
          `${CALENDAR_API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(key)}`,
          { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal },
        ),
    );
    if (response.status === 404 || response.status === 410) return null;
    if (response.status !== 200)
      return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
    return eventResult(yield* readWrittenEvent(response, args.meet ?? false), calendar);
  });
