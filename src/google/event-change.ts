import { Effect, Result, Schema } from "effect";
import type { ViewValue } from "../approvals/model";
import type { Confirm, Send, Sending } from "../mcp/tools";
import { notFound, ToolFailure } from "../mcp/failures";
import { CalendarId, calendarContext, get, writableCalendar } from "./calendar";
import {
  canonicalZone,
  EventPoint,
  eventInstant,
  eventTime,
  type EventTime,
  instantOf,
  parseTime,
  TimeText,
  viewTime,
  ZoneName,
} from "./calendar-time";
import {
  Description,
  descriptionForGoogle,
  eventPoints,
  Guests,
  guestKey,
  guestsValue,
  Location,
  timeValues,
  Title,
  writeEvent,
  type GooglePoint,
} from "./event-write";
import { EventId } from "./events";
import { unfold } from "./bounds";
import { htmlToText } from "./html";

const ChangeTime = TimeText.check(
  Schema.makeFilter(
    (text) => !text.includes("T") || /T\d{2}:\d{2}(?::00)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text),
  ),
);
export const DeleteEventInput = Schema.Struct({
  account: Schema.String,
  calendar: Schema.optionalKey(CalendarId),
  event: EventId,
});
export const UpdateEventInput = Schema.Struct({
  ...DeleteEventInput.fields,
  title: Schema.optionalKey(Title),
  start: Schema.optionalKey(ChangeTime),
  end: Schema.optionalKey(ChangeTime),
  time_zone: Schema.optionalKey(ZoneName),
  location: Schema.optionalKey(Location),
  description: Schema.optionalKey(Description),
  add_guests: Schema.optionalKey(Guests),
  remove_guests: Schema.optionalKey(Guests),
}).check(
  Schema.makeFilter((args) => {
    if (
      [args.title, args.start, args.end, args.time_zone, args.location, args.description].every(
        (value) => value === undefined,
      ) &&
      !(args.add_guests?.length || args.remove_guests?.length)
    )
      return { path: ["title"], issue: "requires at least one change" };
    const added = new Set((args.add_guests ?? []).map(guestKey));
    if ((args.remove_guests ?? []).some((address) => added.has(guestKey(address))))
      return { path: ["remove_guests"], issue: "an address cannot be in both lists" };
    return true;
  }),
);
type ChangeInput = typeof DeleteEventInput.Type & { readonly time_zone?: string };
type UpdateInput = typeof UpdateEventInput.Type;
const Attendee = Schema.StructWithRest(Schema.Struct({ email: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const ChangeEvent = Schema.Struct({
  id: EventId,
  etag: Schema.NonEmptyString,
  status: Schema.Literals(["confirmed", "tentative"]),
  start: EventPoint,
  end: EventPoint,
  summary: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  organizer: Schema.optionalKey(
    Schema.Struct({
      email: Schema.optionalKey(Schema.String),
      self: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  attendees: Schema.optionalKey(Schema.Array(Attendee)),
  attendeesOmitted: Schema.optionalKey(Schema.Boolean),
  guestsCanSeeOtherGuests: Schema.optionalKey(Schema.Boolean),
  recurringEventId: Schema.optionalKey(EventId),
  recurrence: Schema.optionalKey(Schema.Array(Schema.String)),
  hangoutLink: Schema.optionalKey(Schema.String),
  htmlLink: Schema.optionalKey(Schema.String),
  eventType: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((event) => "date" in event.start === "date" in event.end));
type ChangeEvent = typeof ChangeEvent.Type;
const GoogleEvent = Schema.Union([
  Schema.Struct({ id: EventId, status: Schema.Literal("cancelled") }),
  ChangeEvent,
]);
const invalid = (name: string, expects: string) =>
  new ToolFailure({ code: "invalid_arguments", field: { name, expects } });
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
const wholeSeries = (event: ChangeEvent) =>
  event.recurrence !== undefined && event.recurringEventId === undefined;
const readForChange = (send: Send, input: ChangeInput) =>
  Effect.gen(function* () {
    const ctx = yield* calendarContext(send, input.time_zone);
    const calendar = yield* Effect.fromResult(writableCalendar(ctx, input.calendar));
    const event = yield* get(
      send,
      `calendars/${encodeURIComponent(calendar.calendar)}/events/${encodeURIComponent(input.event)}?${new URLSearchParams({ timeZone: canonicalZone(ctx.zone) })}`,
      GoogleEvent,
      (status) =>
        status === 404 || status === 410 ? notFound("event", input.event) : unavailable(),
    );
    if (event.status === "cancelled") return yield* Effect.fail(notFound("event", input.event));
    if (!event.organizer)
      return yield* Effect.fail(
        invalid(
          "event",
          "an event whose organizer can be identified; the tool cannot tell who organizes this event",
        ),
      );
    if (event.organizer.self !== true)
      return yield* Effect.fail(
        invalid(
          "event",
          "the organizer's copy; the account is a guest of this event; use respond_to_event to decline it",
        ),
      );
    if (event.eventType !== undefined && event.eventType !== "default")
      return yield* Effect.fail(
        invalid("event", "a regular event; only regular events can be changed or deleted"),
      );
    return { ctx, calendar, event };
  });
type ReadChange = Effect.Success<ReturnType<typeof readForChange>>;
const baseValues = ({ ctx, calendar, event }: ReadChange): ViewValue[] => [
  { name: "Calendar", text: `${unfold(calendar.name)} (${calendar.calendar})`, from: "calendar" },
  {
    name: "Event",
    text: `${unfold(event.summary ?? "")}\n${viewTime(eventTime(event.start, event.end, ctx.zone).start, ctx.zone)}`,
    from: "calendar",
  },
];
const guestEntries = (event: ChangeEvent, account: string) =>
  (event.attendees ?? []).filter(
    (attendee) =>
      attendee.resource !== true &&
      attendee.self !== true &&
      guestKey(attendee.email) !== guestKey(account),
  );
const unknownGuests = (): ViewValue => ({
  name: "Guest emails",
  text: "Google will email the guests. The number of guests is not known.",
  from: "calendar",
});

/** Local inputs use the call's zone; the event's own zone is a separate written field. */
interface ChangedTimes {
  before: EventTime;
  after: EventTime;
  beforeZone: string | undefined;
  afterZone: string | undefined;
  body: Record<string, unknown> | undefined;
}
const timeChange = (
  event: ChangeEvent,
  input: UpdateInput,
  zone: string,
): Result.Result<ChangedTimes, ToolFailure> => {
  const before = eventTime(event.start, event.end, zone);
  const beforeZone = event.start.timeZone;
  const unchanged = { before, after: before, beforeZone, afterZone: beforeZone, body: undefined };
  if (input.start === undefined && input.end === undefined && input.time_zone === undefined)
    return Result.succeed(unchanged);
  if ((input.start === undefined) !== (input.end === undefined)) {
    const given = parseTime((input.start ?? input.end)!);
    if ((given.kind === "date") !== before.all_day)
      return Result.fail(
        invalid("end", "given together with start to change between all-day dates and times"),
      );
  }
  const start = input.start ?? ("date" in event.start ? event.start.date : event.start.dateTime);
  let end = input.end ?? ("date" in event.end ? event.end.date : event.end.dateTime);
  if (input.start !== undefined && input.end === undefined) {
    end = before.all_day
      ? new Date(Date.parse(start) + Date.parse(before.end) - Date.parse(before.start))
          .toISOString()
          .slice(0, 10)
      : new Date(
          instantOf(parseTime(start), zone) +
            eventInstant(event.end, zone) -
            eventInstant(event.start, zone),
        ).toISOString();
  }
  const points = eventPoints(
    { start, end, ...(input.time_zone === undefined ? {} : { time_zone: input.time_zone }) },
    zone,
  );
  if (Result.isFailure(points)) return Result.fail(points.failure);
  const after = eventTime(points.success.start, points.success.end, zone);
  const afterZone = after.all_day ? undefined : (input.time_zone ?? beforeZone ?? zone);
  const sameTime =
    before.all_day === after.all_day &&
    (before.all_day
      ? before.start === after.start && before.end === after.end
      : eventInstant(event.start, zone) === eventInstant(points.success.start, zone) &&
        eventInstant(event.end, zone) === eventInstant(points.success.end, zone));
  if (sameTime && (input.time_zone === undefined || input.time_zone === beforeZone))
    return Result.succeed(unchanged);
  const complete = (point: GooglePoint) =>
    "date" in point
      ? { date: point.date, dateTime: null, timeZone: null }
      : { dateTime: point.dateTime, timeZone: afterZone!, date: null };
  return Result.succeed({
    before,
    after,
    beforeZone,
    afterZone,
    body: { start: complete(points.success.start), end: complete(points.success.end) },
  });
};
const guestChange = (event: ChangeEvent, input: UpdateInput) => {
  if (
    event.attendeesOmitted &&
    (input.add_guests !== undefined || input.remove_guests !== undefined)
  )
    return Result.fail(
      invalid(
        "event",
        "an event with the complete guest list before guests can be added or removed",
      ),
    );
  const entries = event.attendees ?? [];
  const before = guestEntries(event, input.account).map((attendee) => attendee.email);
  const beforeKeys = new Set(before.map(guestKey));
  for (const field of ["add_guests", "remove_guests"] as const) {
    for (const address of input[field] ?? []) {
      const key = guestKey(address);
      if (
        key === guestKey(input.account) ||
        entries.some((entry) => guestKey(entry.email) === key && entry.self === true)
      )
        return Result.fail(invalid(field, "guest addresses other than the account's own address"));
      if (entries.some((entry) => guestKey(entry.email) === key && entry.resource === true))
        return Result.fail(invalid(field, "guest addresses other than meeting rooms or resources"));
    }
  }
  const remove = new Set((input.remove_guests ?? []).map(guestKey));
  const added = (input.add_guests ?? []).filter((address) => !beforeKeys.has(guestKey(address)));
  const removed = before.filter((address) => remove.has(guestKey(address)));
  const staying = before.filter((address) => !remove.has(guestKey(address)));
  const values: ViewValue[] = [
    ...(input.add_guests ?? [])
      .filter((address) => beforeKeys.has(guestKey(address)))
      .map((text) => ({ name: "Already a guest", text, from: "agent" as const })),
    ...(input.remove_guests ?? [])
      .filter((address) => !beforeKeys.has(guestKey(address)))
      .map((text) => ({ name: "Not a guest", text, from: "agent" as const })),
  ];
  const emails: ViewValue[] = [];
  if (event.attendeesOmitted) emails.push(unknownGuests());
  else {
    if (added.length) emails.push(guestsValue(added, "the invitation", "agent"));
    if (staying.length) emails.push(guestsValue(staying, "the change", "calendar"));
    if (removed.length) emails.push(guestsValue(removed, "the cancellation", "calendar"));
  }
  return Result.succeed({
    values,
    emails,
    attendees:
      added.length || removed.length
        ? [
            ...entries.filter((entry) => !remove.has(guestKey(entry.email))),
            ...added.map((email) => ({ email })),
          ]
        : undefined,
  });
};
const plainDescription = (text: string) =>
  /<\/?(?:br|p|div|span|a|b|i|u|ul|ol|li)(?:\s|\/?>)/i.test(text)
    ? Effect.tryPromise({ try: () => htmlToText(text), catch: unavailable })
    : Effect.succeed(text);
interface ChangeResult {
  account: string;
  calendar: string;
  event: string;
  link?: string;
}
interface ChangePlan {
  values: ViewValue[];
  write: (sending: Sending) => Effect.Effect<ChangeResult, ToolFailure>;
}
const changedWhileRunning = () =>
  new ToolFailure({
    code: "google_unavailable",
    said: "The event changed in Google while this call ran. Nothing was changed. Calling again is safe.",
  });
const writeChange = (
  sending: Sending,
  read: ReadChange,
  input: ChangeInput,
  body?: Record<string, unknown>,
) =>
  writeEvent(sending, {
    method: body === undefined ? "DELETE" : "PATCH",
    calendar: read.calendar.calendar,
    event: input.event,
    headers: { "If-Match": read.event.etag },
    ...(body === undefined ? {} : { body }),
    refusals: [412],
    refused: (status) =>
      status === 412
        ? changedWhileRunning()
        : status === 404
          ? notFound("event", input.event)
          : unavailable(),
  }).pipe(
    Effect.mapError((failure) => {
      if (!failure.unknown) return failure;
      const data: ConstructorParameters<typeof ToolFailure>[0] = failure;
      return new ToolFailure({
        ...data,
        said:
          body === undefined
            ? `Google did not confirm the deletion for ${input.account}. A later not_found means the event is gone.`
            : `Google did not confirm the change for ${input.account}. The change may have been made. Calling again is safe.`,
      });
    }),
  );

export const updatePlan = (
  send: Send,
  input: UpdateInput,
): Effect.Effect<ChangePlan, ToolFailure> =>
  Effect.gen(function* () {
    const read = yield* readForChange(send, input);
    const { event, ctx, calendar } = read;
    if (wholeSeries(event))
      return yield* Effect.fail(
        invalid(
          "event",
          "one event or one occurrence; a whole series cannot be changed with this tool; change occurrences one at a time, or ask the owner to change the series in Google Calendar",
        ),
      );
    const times = yield* Effect.fromResult(timeChange(event, input, ctx.zone));
    const guests = yield* Effect.fromResult(guestChange(event, input));
    const oldDescription =
      input.description === undefined ? "" : yield* plainDescription(event.description ?? "");
    const body: Record<string, unknown> = {};
    const values = baseValues(read);
    values.push({
      name: "Changes",
      text:
        event.recurringEventId === undefined
          ? "A single event"
          : "One occurrence of a series. The rest of the series stays as it is.",
      from: "agent",
    });
    const field = (
      key: string,
      name: string,
      before: string,
      after: string | undefined,
      written = after,
    ) => {
      if (after === undefined || before === after) return;
      body[key] = written;
      values.push(
        { name: `${name} now`, text: before || "(none)", from: "calendar" },
        { name: `New ${name.toLowerCase()}`, text: after || "(removed)", from: "agent" },
      );
    };
    field("summary", "Title", event.summary ?? "", input.title);
    if (times.body) {
      Object.assign(body, times.body);
      const before = timeValues(times.before.start, times.before.end, ctx.zone);
      const after = timeValues(times.after.start, times.after.end, ctx.zone);
      for (const [index, name] of ["start", "end"].entries())
        values.push(
          { ...before[index]!, name: `${before[index]!.name} now`, from: "calendar" },
          { ...after[index]!, name: `New ${name}`, from: "agent" },
        );
    }
    if (
      (times.beforeZone !== undefined && times.beforeZone !== ctx.zone) ||
      times.beforeZone !== times.afterZone
    )
      values.push(
        { name: "Event's own zone now", text: times.beforeZone ?? "(none)", from: "calendar" },
        { name: "New event's own zone", text: times.afterZone ?? "(none)", from: "agent" },
      );
    field("location", "Location", event.location ?? "", input.location);
    field(
      "description",
      "Description",
      oldDescription,
      input.description,
      input.description === undefined ? undefined : descriptionForGoogle(input.description),
    );
    if (guests.attendees !== undefined) body.attendees = guests.attendees;
    values.push(...guests.values);
    if (Object.keys(body).length) values.push(...guests.emails);
    const result = { account: input.account, calendar: calendar.calendar, event: input.event };
    return {
      values,
      write: (sending) =>
        Object.keys(body).length === 0
          ? Effect.succeed({ ...result, link: event.htmlLink ?? "" })
          : writeChange(sending, read, input, body).pipe(
              Effect.map((written) => ({ ...result, link: written?.link ?? "" })),
            ),
    };
  });
const pastSeries = () =>
  invalid(
    "event",
    'a series without past occurrences; this series has occurrences in the past; delete occurrences one at a time, or ask the owner to use "This and following events" in Google Calendar',
  );
export const deletePlan = (
  send: Send,
  input: ChangeInput,
): Effect.Effect<ChangePlan, ToolFailure> =>
  Effect.gen(function* () {
    const read = yield* readForChange(send, input);
    const { event, ctx, calendar } = read;
    if (wholeSeries(event)) {
      const now = Date.now();
      if (eventInstant(event.start, ctx.zone) <= now) return yield* Effect.fail(pastSeries());
      const params = new URLSearchParams({
        timeMax: new Date(now).toISOString(),
        maxResults: "1",
        showDeleted: "false",
      });
      const instances = yield* get(
        send,
        `calendars/${encodeURIComponent(calendar.calendar)}/events/${encodeURIComponent(input.event)}/instances?${params}`,
        Schema.Struct({
          items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
          nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
        }),
        (status) =>
          status === 404 || status === 410 ? notFound("event", input.event) : unavailable(),
      );
      if (instances.items?.length || instances.nextPageToken !== undefined)
        return yield* Effect.fail(pastSeries());
    }
    const values = baseValues(read);
    values.push({
      name: "Deletes",
      text:
        event.recurringEventId !== undefined
          ? "One occurrence of a series. The rest of the series stays."
          : wholeSeries(event)
            ? "The whole series: every occurrence."
            : "This event",
      from: "agent",
    });
    const guests = guestEntries(event, input.account).map((entry) => entry.email);
    if (event.attendeesOmitted) values.push(unknownGuests());
    else if (guests.length) values.push(guestsValue(guests, "the cancellation", "calendar"));
    return {
      values,
      write: (sending) =>
        writeChange(sending, read, input).pipe(
          Effect.map(() => ({
            account: input.account,
            calendar: calendar.calendar,
            event: input.event,
          })),
        ),
    };
  });

/** The plan and its write share one read; only the confirmed channel can write it. */
export const runChange = (
  plan: Effect.Effect<ChangePlan, ToolFailure>,
  { confirm, approved }: { confirm: Confirm; approved: ReadonlyArray<ViewValue> | null },
) =>
  Effect.gen(function* () {
    const current = yield* plan;
    if (
      approved !== null &&
      (approved.length !== current.values.length ||
        current.values.some((value, index) => {
          const before = approved[index]!;
          return (
            value.name !== before.name || value.text !== before.text || value.from !== before.from
          );
        }))
    )
      return yield* Effect.fail(
        new ToolFailure({
          code: "google_unavailable",
          said: "The event changed after the approval. Nothing was changed. Call again.",
        }),
      );
    const sending = yield* confirm.check;
    return yield* current.write(sending);
  });
