import { expect, it, vi } from "vite-plus/test";
import { apiNotEnabled } from "../src/google/errors";

it("cancels a 403 clone after sixteen KiB without consuming the original response", async () => {
  const original = new Response("the tool still owns this body", { status: 403 });
  const cancel = vi.fn();
  const clone = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(16_385)));
      },
      cancel,
    }),
    { status: 403 },
  );
  vi.spyOn(original, "clone").mockReturnValue(clone);
  expect(await apiNotEnabled(original)).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(original.bodyUsed).toBe(false);
  expect(await original.text()).toBe("the tool still owns this body");
});

it("passes on a 403 whose cloned body cannot be read", async () => {
  const original = new Response("Forbidden", { status: 403 });
  vi.spyOn(original, "clone").mockReturnValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body lost"));
        },
      }),
      { status: 403 },
    ),
  );
  expect(await apiNotEnabled(original)).toBe(false);
  expect(await original.text()).toBe("Forbidden");
});

it.each([200, 400, 401, 429, 503])(
  "never clones a non-403 response with status %s",
  async (status) => {
    const response = new Response("unread", { status });
    const clone = vi.spyOn(response, "clone");
    expect(await apiNotEnabled(response)).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  },
);
