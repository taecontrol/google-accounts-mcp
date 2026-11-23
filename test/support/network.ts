import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
export const unhandledFrames: Array<string> = [];
network.configure({
  onUnhandledFrame: () => {
    unhandledFrames.push("Unexpected outbound request");
    throw new Error("Unexpected outbound request");
  },
});

export const requests: string[] = [];
network.events.on("request:start", ({ request }) => requests.push(request.url));
