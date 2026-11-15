import { Effect, Result, Schema } from "effect";
import type { ViewValue } from "../approvals/model";
import { ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { canonicalZone, instantOf, parseTime, viewTime, zonedIso } from "./calendar-time";
import { htmlToText } from "./html";

export const MAX_TITLE = 1_000;
export const MAX_LOCATION = 1_000;
export const MAX_DESCRIPTION = 8_000;
export const MAX_GUESTS = 50;
/** The only statuses after which Google created nothing; every other answer is uncertain. */
export const NOT_CREATED: readonly number[] = [400, 403, 404, 429];
export const DESCRIPTION_EXPECTS =
  "plain text of at most 8,000 UTF-8 bytes after HTML encoding, counting each line break, tab, quote, and backslash as 2, without other control characters";
const noControls = Schema.isPattern(/^[^\p{Cc}]*$/u);
export const Title = Schema.String.check(Schema.isBetweenLength(1, MAX_TITLE), noControls);
export const Location = Schema.String.check(Schema.isMaxLength(MAX_LOCATION), noControls);

/** This is the sole encoding of agent text into Google's HTML-capable description. */
export const descriptionForGoogle = (text: string): string =>
  /[<>&]/.test(text)
    ? `<span>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</span>`
    : text;
export const descriptionSize = (text: string): number => {
  const sent = descriptionForGoogle(text);
  return new TextEncoder().encode(sent).byteLength + (sent.match(/[\n\t"\\]/g)?.length ?? 0);
};
export const Description = Schema.String.check(
  Schema.makeFilter((text) => !/\p{Cc}/u.test(text.replaceAll("\n", "").replaceAll("\t", ""))),
  Schema.makeFilter((text) => descriptionSize(text) <= MAX_DESCRIPTION),
);
/**
 * Refuse any conversion that would make the invitation differ from the approved text. Text sent
 * unchanged needs no check: it holds no "<", so read_event returns it as it is.
 */
export const checkedDescription = (text: string): Effect.Effect<string, ToolFailure> =>
  descriptionForGoogle(text) === text
    ? Effect.succeed(text)
    : Effect.tryPromise({
        try: () => htmlToText(descriptionForGoogle(text)),
        catch: () => new ToolFailure({ code: "google_unavailable" }),
      }).pipe(
        Effect.flatMap((roundTrip) =>
          roundTrip === text
            ? Effect.succeed(descriptionForGoogle(text))
            : Effect.fail(
                new ToolFailure({
                  code: "invalid_arguments",
                  field: {
                    name: "description",
                    expects:
                      "text that Google Calendar can keep exactly: remove tabs, repeated spaces, leading or trailing whitespace, and line breaks that collapse in HTML",
                  },
                }),
              ),
        ),
      );
export const GuestAddress = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^[^@\s\p{Cc}\p{Cf}<>()[\],;:"\\]+@[^@\s\p{Cc}\p{Cf}<>()[\],;:"\\]+\.[^@\s\p{Cc}\p{Cf}<>()[\],;:"\\]+$/u,
  ),
);
export const guestKey = (address: string): string => address.toLowerCase();
export const Guests = Schema.Array(GuestAddress).check(
  Schema.isMaxLength(MAX_GUESTS),
  Schema.makeFilter((addresses) => new Set(addresses.map(guestKey)).size === addresses.length),
);
type Window = { start: string; end: string; time_zone?: string };
export const windowIssue = (a: Window): true | { path: [string]; issue: string } => {
  for (const field of ["start", "end"] as const) {
    const seconds = /T\d{2}:\d{2}:(\d{2})(\.\d+)?/.exec(a[field]);
    if (seconds && (seconds[1] !== "00" || seconds[2] !== undefined))
      return {
        path: [field],
        issue: "a time with no fractions and seconds omitted or 00, as shown in the approval",
      };
  }
  const start = parseTime(a.start);
  const end = parseTime(a.end);
  if ((start.kind === "date") !== (end.kind === "date"))
    return { path: ["end"], issue: "a date when start is a date, or a time when start is a time" };
  if (start.kind === "date" && a.time_zone !== undefined)
    return { path: ["time_zone"], issue: "left out for an all-day event" };
  if (start.kind === end.kind && end.ms <= start.ms) return { path: ["end"], issue: "after start" };
  return true;
};
export type GooglePoint = { date: string } | { dateTime: string; timeZone: string };
export const eventPoints = (
  a: Window,
  zone: string,
): Result.Result<{ start: GooglePoint; end: GooglePoint }, ToolFailure> => {
  zone = a.time_zone ?? zone;
  const points = { start: parseTime(a.start), end: parseTime(a.end) };
  const allDay = points.start.kind === "date" && points.end.kind === "date";
  const instants = allDay
    ? { start: points.start.ms, end: points.end.ms }
    : { start: instantOf(points.start, zone), end: instantOf(points.end, zone) };
  for (const field of ["start", "end"] as const) {
    if (
      points[field].kind === "local" &&
      zonedIso(instants[field], zone).slice(0, 19) !==
        new Date(points[field].ms).toISOString().slice(0, 19)
    )
      return Result.fail(
        new ToolFailure({
          code: "invalid_arguments",
          field: {
            name: field,
            expects: `a time that exists in ${zone}; ${a[field]} does not exist in ${zone}; give another time or an offset`,
          },
        }),
      );
  }
  if (instants.end <= instants.start)
    return Result.fail(
      new ToolFailure({
        code: "invalid_arguments",
        field: { name: "end", expects: "after start in the call's time zone" },
      }),
    );
  // Google accepts the canonical spelling; the view keeps the caller's.
  const timeZone = canonicalZone(zone) ?? zone;
  return Result.succeed(
    allDay
      ? { start: { date: a.start }, end: { date: a.end } }
      : {
          start: { dateTime: zonedIso(instants.start, zone), timeZone },
          end: { dateTime: zonedIso(instants.end, zone), timeZone },
        },
  );
};
export type WrittenEvent = {
  id: string;
  link?: string;
  status?: string;
  meet?: string;
  meetStatus?: "pending" | "failure" | "none";
};
const GoogleWrittenEvent = Schema.Struct({
  id: Schema.NonEmptyString,
  htmlLink: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  hangoutLink: Schema.optionalKey(Schema.String),
  conferenceData: Schema.optionalKey(
    Schema.Struct({
      createRequest: Schema.optionalKey(
        Schema.Struct({
          status: Schema.optionalKey(Schema.Struct({ statusCode: Schema.String })),
        }),
      ),
      entryPoints: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            entryPointType: Schema.String,
            uri: Schema.String,
          }),
        ),
      ),
    }),
  ),
});
const uncertain = () => new ToolFailure({ code: "google_unavailable", unknown: true });
/** Both an insert answer and a recovery GET carry the same Google event shape. */
export const readWrittenEvent = (
  response: Response,
  meet: boolean,
): Effect.Effect<WrittenEvent, ToolFailure> =>
  Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: uncertain }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(GoogleWrittenEvent)(raw).pipe(Effect.mapError(uncertain)),
    ),
    Effect.map((event) => {
      const status = event.conferenceData?.createRequest?.status?.statusCode;
      const link =
        status === "success"
          ? (event.hangoutLink ??
            event.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video")
              ?.uri)
          : undefined;
      return {
        id: event.id,
        ...(event.htmlLink === undefined ? {} : { link: event.htmlLink }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(link === undefined ? {} : { meet: link }),
        ...(status === "pending" || status === "failure"
          ? { meetStatus: status }
          : meet && event.conferenceData === undefined
            ? { meetStatus: "none" as const }
            : {}),
      };
    }),
  );
export const writeEvent = (
  send: Send,
  r: {
    method: "POST" | "PATCH" | "DELETE";
    calendar: string;
    event?: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
    refused: (status: number) => ToolFailure;
    refusals?: readonly number[];
  },
): Effect.Effect<WrittenEvent | null, ToolFailure> =>
  Effect.gen(function* () {
    const query = new URLSearchParams({ ...r.query, sendUpdates: "all" });
    const path = `calendars/${encodeURIComponent(r.calendar)}/events${r.event === undefined ? "" : `/${encodeURIComponent(r.event)}`}`;
    const response = yield* send(
      (token, signal) =>
        new Request(`https://www.googleapis.com/calendar/v3/${path}?${query}`, {
          method: r.method,
          headers: {
            ...r.headers,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) {
      if (![...NOT_CREATED, ...(r.refusals ?? [])].includes(response.status))
        return yield* Effect.fail(uncertain());
      let failure = r.refused(response.status);
      if (response.status === 400 && failure.code === "invalid_arguments") {
        const message = yield* Effect.tryPromise({
          try: (): Promise<unknown> => response.json(),
          catch: () => null,
        }).pipe(
          Effect.flatMap((raw) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ error: Schema.Struct({ message: Schema.NonEmptyString }) }),
            )(raw),
          ),
          Effect.map((body) => body.error.message),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (message !== null)
          failure = new ToolFailure({ code: "invalid_arguments", said: message });
      }
      return yield* Effect.fail(failure);
    }
    if (response.status === 204) return null;
    const meet = typeof r.body === "object" && r.body !== null && "conferenceData" in r.body;
    return yield* readWrittenEvent(response, meet);
  });
/** An all-day end is exclusive, so the page names the last day the event covers. */
export const timeValues = (start: string, end: string, zone: string): ViewValue[] =>
  parseTime(start).kind === "date"
    ? [
        { name: "Starts", text: viewTime(start, zone), from: "agent" },
        {
          name: "Last day",
          text: viewTime(new Date(Date.parse(end) - 86_400_000).toISOString().slice(0, 10), zone),
          from: "agent",
        },
      ]
    : [
        { name: "Starts", text: viewTime(start, zone), from: "agent" },
        { name: "Ends", text: viewTime(end, zone), from: "agent" },
      ];
export const guestsValue = (
  addresses: readonly string[],
  what:
    | "the invitation"
    | "one invitation for the whole series"
    | "the change"
    | "the cancellation",
  from: ViewValue["from"],
): ViewValue => ({
  name: `Google emails ${what} to ${addresses.length === 1 ? "this address" : `these ${addresses.length} addresses`}`,
  text: addresses.join("\n"),
  from,
});
