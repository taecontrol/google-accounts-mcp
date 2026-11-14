import { Effect, Schema } from "effect";
import type { Confirm, Send } from "../mcp/tools";
import { notFound, ToolFailure } from "../mcp/failures";
import { readCalendarList } from "./calendar";
import { Attendee, findEvent } from "./events";

export const EventResponse = Schema.Literals(["accepted", "declined", "tentative"]);
export const WHOLE_SERIES =
  "Every occurrence of a repeating event (the whole series). It also replaces answers given before to single occurrences.";

const invalidEvent = (expects: string) =>
  new ToolFailure({ code: "invalid_arguments", field: { name: "event", expects } });

/** The view and the write resolve the same invitation and refuse the same unsafe targets. */
export const invitation = (send: Send, input: { account: string; event: string }) =>
  Effect.gen(function* () {
    const { calendars } = yield* readCalendarList(send);
    const calendar = calendars.find((entry) => entry.primary);
    if (!calendar || calendar.calendar === "primary")
      return yield* Effect.fail(
        new ToolFailure({
          code: "not_found",
          said: "No primary calendar ID is available in this account's Google Calendar list.",
        }),
      );
    // Reading in UTC needs no primary zone. Only the approval view formats the event's times.
    const event = yield* findEvent(send, calendar, input.event, {
      account: input.account,
      zone: "UTC",
    });
    if (event.eventType !== undefined && event.eventType !== "default")
      return yield* Effect.fail(
        invalidEvent(
          "a regular invitation, not an out of office, focus time, working location, birthday, or Gmail event",
        ),
      );
    if (event.organizer?.email === undefined)
      return yield* Effect.fail(
        invalidEvent("an invitation with an organizer address from Google"),
      );
    if (event.organizer.self === true)
      return yield* Effect.fail(
        invalidEvent("an invitation organized by someone else; this account is the organizer"),
      );
    const own = (event.attendees ?? []).filter((guest) => guest.self === true && !guest.resource);
    if (own.length !== 1)
      return yield* Effect.fail(
        invalidEvent(
          "an invitation with exactly one guest entry marked as this account's own by Google; invitations received only through a Google Group cannot be answered",
        ),
      );
    const mine = own[0]!;
    if (mine.organizer === true)
      return yield* Effect.fail(
        invalidEvent("an invitation organized by someone else; this account is the organizer"),
      );
    if (mine.email === undefined)
      return yield* Effect.fail(
        invalidEvent("an invitation with an address on this account's own guest entry from Google"),
      );
    return { calendar, event, mine, organizer: event.organizer.email };
  });

const PatchAnswer = Schema.Struct({ attendees: Schema.optionalKey(Schema.Array(Attendee)) });
export const respondToEvent = (
  send: Send,
  confirm: Confirm,
  input: { account: string; event: string; response: typeof EventResponse.Type; note?: string },
) =>
  Effect.gen(function* () {
    const { calendar, event, mine } = yield* invitation(send, input);
    // Google always gives an etag. Without one the write could not be tied to this read.
    const etag = event.etag;
    if (etag === undefined)
      return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
    // Only Confirm may send a Calendar write: it checks the setting again just before it.
    const sending = yield* confirm.check;
    const response = yield* sending(
      (token, signal) =>
        new Request(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.calendar)}/events/${encodeURIComponent(input.event)}?sendUpdates=all`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "If-Match": etag,
            },
            redirect: "manual",
            signal,
            body: JSON.stringify({
              attendeesOmitted: true,
              attendees: [
                { email: mine.email, responseStatus: input.response, comment: input.note ?? "" },
              ],
            }),
          },
        ),
    );
    if (response.status === 404 || response.status === 410)
      return yield* Effect.fail(notFound("event", input.event));
    if (!response.ok)
      return yield* Effect.fail(
        new ToolFailure({
          code: "google_unavailable",
          // As with other writes, redirects and server errors cannot confirm the outcome.
          ...(response.status < 400 || response.status >= 500 ? { unknown: true } : {}),
          ...(response.status === 412
            ? {
                said: "The event changed after it was read, so Google did not change the answer. Call again to read the event and answer it.",
              }
            : {}),
        }),
      );
    const uncertain = () => new ToolFailure({ code: "google_unavailable", unknown: true });
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: uncertain });
    const body = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: uncertain });
    const patched = yield* Schema.decodeUnknownEffect(PatchAnswer)(body).pipe(
      Effect.mapError(uncertain),
    );
    const own = (patched.attendees ?? []).filter((guest) => guest.self === true && !guest.resource);
    if (own.length !== 1 || own[0]!.responseStatus !== input.response)
      return yield* Effect.fail(uncertain());
    return { account: input.account, event: input.event, my_response: own[0]!.responseStatus };
  });
