import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { previews } from "../src/pages/previews";
import { renderPage } from "../src/pages/render";
import type { TestEnv } from "./env";
import { ORIGIN } from "./support/worker";

// Each page state hydrates once in Chromium, with no errors and no horizontal overflow, at phone
// and desktop widths. Every waiting tool shares one approval layout, so three views stand for the
// rest: the most values, the longest labels and lines, and both kinds of note. Add a view only when
// it brings a structure this layout does not cover.
const pages = [
  "approval-waiting-long-names",
  "approval-cannot-show",
  "approval-changed",
  "approval-succeeded",
  "approval-failed",
  "approval-unconfirmed",
  "approval-waiting-labels-many",
  "approval-create-event-repeat",
  "approval-respond-to-event",
  "connection-some-allowed",
];
const cases = pages.flatMap((name) => [390, 1280].map((width) => ({ name, width })));

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
