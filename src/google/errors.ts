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

/** Inspect only small 403 bodies and leave the original response readable by the tool. */
export async function apiNotEnabled(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return false;
    const bytes = new Uint8Array(MAX_ERROR_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_ERROR_BYTES - size) return false;
      bytes.set(value, size);
      size += value.byteLength;
    }
    const parsed = Schema.decodeUnknownOption(DisabledError)(
      JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))),
    );
    return (
      parsed._tag === "Some" &&
      ((parsed.value.error.details ?? []).some(Schema.is(ErrorInfo)) ||
        (parsed.value.error.errors ?? []).some(Schema.is(LegacyError)))
    );
  } catch {
    return false;
  } finally {
    // A tee's cancellation can wait for the original branch; that branch still belongs to the tool.
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
