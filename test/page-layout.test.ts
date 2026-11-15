import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { previews } from "../src/pages/previews";
import { renderPage } from "../src/pages/render";
import type { TestEnv } from "./env";
import { ORIGIN } from "./support/worker";

// Each page state hydrates once in Chromium, with no errors and no horizontal overflow, at phone
// and desktop widths.
const approvalStates = [
  "approval-waiting-long-names",
  "approval-cannot-show",
  "approval-changed",
  "approval-succeeded",
  "approval-failed",
  "approval-unconfirmed",
];
const toolViews = [
  "approval-create-event",
  "approval-create-event-repeat",
  "approval-create-event-repeat-no-end",
  "approval-update-event",
  "approval-delete-event",
  "approval-waiting-thread",
  "approval-waiting-search",
  "approval-waiting-notes",
  "approval-waiting-labels",
  "approval-waiting-labels-many",
  "approval-waiting-draft",
  "approval-waiting-reply",
  "approval-waiting-attachment",
  "approval-waiting-send",
  "approval-waiting-send-reply",
  "approval-waiting-forward",
  "approval-waiting-send-draft",
  "approval-waiting-delete",
  "approval-respond-to-event",
  "connection-some-allowed",
];
const cases = [...approvalStates, ...toolViews].flatMap((name) =>
  [390, 1280].map((width) => ({ name, width })),
);

it.each(cases)(
  "renders $name at $width px without overflow",
  async ({ name, width }) => {
    const response = renderPage(previews[name]!);
    const hydrated = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/__pages/${name}`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          width,
          layout: true,
        }),
      })
    ).json<{ clientLoads: number; overflow: boolean; errors: string[] }>();
    expect(hydrated.errors).toEqual([]);
    expect(hydrated.clientLoads).toBe(1);
    expect(hydrated.overflow).toBe(false);
  },
  30_000,
);
