import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import { descriptionSize, eventPoints, writeEvent } from "../src/google/event-write";
import { ToolFailure } from "../src/mcp/failures";
import type { Send } from "../src/mcp/tools";

it.each([
  ["é", 2],
  ["x\ny", 4],
  ["x\ty", 4],
  ['"', 2],
  ["\\", 2],
  ["<", 17],
  ["&", 18],
  ["<\n&", 26],
] as const)(
  "counts the description %j after encoding, with JSON-sensitive characters counted twice",
  (text, bytes) => {
    expect(descriptionSize(text)).toBe(bytes);
  },
);

it.each(["PATCH", "DELETE"] as const)(
  "%s encodes paths, keeps headers, and forces guest updates",
  async (method) => {
    const requests: Request[] = [];
    const send: Send = (build) =>
      Effect.sync(() => {
        requests.push(build("test", new AbortController().signal));
        return new Response(null, { status: 204 });
      });
    expect(
      await Effect.runPromise(
        writeEvent(send, {
          method,
          calendar: "a/b@example.com",
          event: "id/?",
          headers: { "If-Match": '"etag"' },
          query: { sendUpdates: "none", conferenceDataVersion: "1" },
          refused: () => new ToolFailure({ code: "not_found" }),
        }),
      ),
    ).toBeNull();
    expect(requests[0]!.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.com/events/id%2F%3F?sendUpdates=all&conferenceDataVersion=1",
    );
    expect(requests[0]!.headers.get("If-Match")).toBe('"etag"');
  },
);

it.each([false, true])("412 goes to refused only when added to refusals: %s", async (extra) => {
  const send: Send = () => Effect.succeed(new Response(null, { status: 412 }));
  const result = await Effect.runPromise(
    Effect.result(
      writeEvent(send, {
        method: "PATCH",
        calendar: "calendar",
        refusals: extra ? [412] : [],
        refused: () => new ToolFailure({ code: "invalid_arguments" }),
      }),
    ),
  );
  expect(Result.isFailure(result) && result.failure).toMatchObject(
    extra ? { code: "invalid_arguments" } : { code: "google_unavailable", unknown: true },
  );
});

it("all-day date order is independent of a zone that skipped a whole day", () => {
  const result = eventPoints({ start: "2011-12-30", end: "2011-12-31" }, "Pacific/Apia");
  expect(Result.isSuccess(result) && result.success).toEqual({
    start: { date: "2011-12-30" },
    end: { date: "2011-12-31" },
  });
});

it.each([302, 401, 408, 409, 412, 500])(
  "shared writes mark status %s as unknown",
  async (status) => {
    const send: Send = () => Effect.succeed(new Response(null, { status }));
    const result = await Effect.runPromise(
      Effect.result(
        writeEvent(send, {
          method: "POST",
          calendar: "calendar",
          refused: () => new ToolFailure({ code: "invalid_arguments" }),
        }),
      ),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "google_unavailable",
      unknown: true,
    });
  },
);
