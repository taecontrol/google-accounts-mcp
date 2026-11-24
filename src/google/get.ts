import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";

const unavailable = () => new ToolFailure({ code: "google_unavailable" });

export const decodeResponse = <A>(
  response: Response,
  schema: Schema.Codec<A, unknown>,
  refused: (status: number) => ToolFailure = unavailable,
) =>
  Effect.gen(function* () {
    if (!response.ok) return yield* Effect.fail(refused(response.status));
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    const body = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: unavailable });
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(unavailable));
  });

export const getFrom =
  (base: string) =>
  <A>(
    send: Send,
    path: string,
    schema: Schema.Codec<A, unknown>,
    refused: (status: number) => ToolFailure = unavailable,
  ) =>
    send(
      (token, signal) =>
        new Request(`${base}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        }),
    ).pipe(Effect.flatMap((response) => decodeResponse(response, schema, refused)));
