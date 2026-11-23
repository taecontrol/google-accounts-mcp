import { Schema } from "effect";

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    details: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});
const ErrorInfo = Schema.Struct({
  "@type": Schema.Literal("type.googleapis.com/google.rpc.ErrorInfo"),
  reason: Schema.Literal("SERVICE_DISABLED"),
  domain: Schema.Literal("googleapis.com"),
});
const LegacyError = Schema.Struct({ reason: Schema.Literal("accessNotConfigured") });
const BadRequest = Schema.Struct({
  "@type": Schema.Literal("type.googleapis.com/google.rpc.BadRequest"),
  fieldViolations: Schema.Array(Schema.Struct({ field: Schema.String })),
});
const MAX_ERROR_BYTES = 16 * 1024;

export async function errorText(response: Response): Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return null;
    const bytes = new Uint8Array(MAX_ERROR_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_ERROR_BYTES - size) return null;
      bytes.set(value, size);
      size += value.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, size));
  } catch {
    return null;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

async function errorBody(response: Response) {
  const text = await errorText(response);
  if (text === null) return null;
  try {
    const parsed = Schema.decodeUnknownOption(ErrorBody)(JSON.parse(text));
    return parsed._tag === "Some" ? parsed.value.error : null;
  } catch {
    return null;
  }
}

export async function apiNotEnabled(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const error = await errorBody(response);
  return (
    error !== null &&
    ((error.details ?? []).some(Schema.is(ErrorInfo)) ||
      (error.errors ?? []).some(Schema.is(LegacyError)))
  );
}

export async function refusedField(response: Response, field: string): Promise<boolean> {
  const error = await errorBody(response);
  return (error?.details ?? []).some(
    (detail) =>
      Schema.is(BadRequest)(detail) &&
      detail.fieldViolations.some((violation) => violation.field === field),
  );
}
