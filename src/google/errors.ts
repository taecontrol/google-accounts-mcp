import { Schema } from "effect";

const DisabledError = Schema.Struct({
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

export async function apiNotEnabled(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const text = await errorText(response);
  if (text === null) return false;
  try {
    const parsed = Schema.decodeUnknownOption(DisabledError)(JSON.parse(text));
    return (
      parsed._tag === "Some" &&
      ((parsed.value.error.details ?? []).some(Schema.is(ErrorInfo)) ||
        (parsed.value.error.errors ?? []).some(Schema.is(LegacyError)))
    );
  } catch {
    return false;
  }
}
