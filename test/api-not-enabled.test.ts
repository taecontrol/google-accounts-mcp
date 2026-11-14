import "./support/account-checks";
import { expect, it } from "vite-plus/test";
import { answer } from "./support/approvals";
import { CALENDAR_SCOPES, calendarFake } from "./support/calendar";
import { callRows, expectError, fixture, PERSONAL, toolCall } from "./support/permissions";
import { draftCall, draftFixture, onceRows } from "./support/draft";
import { google } from "./support/google";
import { setTool } from "./support/uploads";
import { textOf } from "./support/worker";

// Documented Google error shapes. Values are made up; this has not been observed live.
const errorInfo = {
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason: "SERVICE_DISABLED",
  domain: "googleapis.com",
  metadata: { service: "calendar-json.googleapis.com", consumer: "projects/123" },
};
const legacy = {
  message: "Google Calendar API has not been used in project 123 before or it is disabled.",
  domain: "usageLimits",
  reason: "accessNotConfigured",
  extendedHelp: "https://console.developers.google.com",
};
const disabled = (marker: "ErrorInfo" | "legacy") =>
  Response.json(
    {
      error: {
        code: 403,
        message: legacy.message,
        status: "PERMISSION_DENIED",
        ...(marker === "ErrorInfo" ? { details: [errorInfo] } : { errors: [legacy] }),
      },
    },
    { status: 403 },
  );

it.each(["ErrorInfo", "legacy"] as const)(
  "names the use's API for Gmail and Calendar %s refusals, audits them, and labels Activity",
  async (marker) => {
    const f = await fixture({ scopes: JSON.stringify(CALENDAR_SCOPES) });
    await setTool(f, "list_calendars", "allow");
    await setTool(f, "list_labels", "allow", f.northwind);
    calendarFake(disabled(marker));
    // Deliberately names Calendar in the body of a Gmail refusal: the use owns the API name.
    google.labelAnswers.push(() => disabled(marker));
    for (const [tool, account, api] of [
      ["list_labels", f.northwind.email, "Gmail API"],
      ["list_calendars", PERSONAL, "Google Calendar API"],
    ]) {
      await expectError(
        await toolCall(f.mcp, tool!, { account }),
        "api_not_enabled",
        `The ${api} is not enabled in the owner's Google Cloud project, so Google refused the request for ${account}. Ask the owner to enable it in Google Cloud and try again.`,
      );
    }
    expect(
      (await callRows()).slice(-2).map((c) => ({ outcome: c.outcome, reason: c.reason })),
    ).toEqual([
      { outcome: "failed", reason: "api_not_enabled" },
      { outcome: "failed", reason: "api_not_enabled" },
    ]);
    expect(textOf(await (await f.mcp.browser.get("/activity")).text())).toContain(
      "Google API not enabled",
    );
  },
);

it.each([
  { name: "no marker", body: JSON.stringify({ error: { code: 403, message: legacy.message } }) },
  {
    name: "wrong domain",
    body: JSON.stringify({ error: { details: [{ ...errorInfo, domain: "other.example" }] } }),
  },
  {
    name: "wrong type",
    body: JSON.stringify({
      error: { details: [{ ...errorInfo, "@type": "type.googleapis.com/other.Error" }] },
    }),
  },
  {
    name: "wrong reason",
    body: JSON.stringify({ error: { details: [{ ...errorInfo, reason: "ACCESS_DENIED" }] } }),
  },
  { name: "not JSON", body: "<html>Forbidden</html>" },
  {
    name: "too large",
    body: JSON.stringify({ padding: "x".repeat(16_384), error: { details: [errorInfo] } }),
  },
])("leaves a 403 $name as google_unavailable", async ({ body }) => {
  const f = await draftFixture();
  google.draftCreateAnswers.push(() => new Response(body, { status: 403 }));
  await expectError(await draftCall(f), "google_unavailable", /Google could not complete/);
  expect(await onceRows()).toEqual([]);
});

it("does not classify a SERVICE_DISABLED marker on a non-403 response", async () => {
  const f = await draftFixture();
  google.draftCreateAnswers.push(() =>
    Response.json({ error: { details: [errorInfo] } }, { status: 400 }),
  );
  await expectError(await draftCall(f), "google_unavailable", /Google could not complete/);
});

it("releases the same-call claim after an API refusal so a repeat runs again", async () => {
  const f = await draftFixture();
  google.draftCreateAnswers.push(() => disabled("ErrorInfo"));
  await expectError(await draftCall(f), "api_not_enabled", /Gmail API is not enabled/);
  expect(await onceRows()).toEqual([]);
  expect((await answer(await draftCall(f))).draft).toEqual(expect.any(String));
  expect(google.draftCreates).toHaveLength(2);
});

it("keeps a lost creating response unknown and never creates again on repeat", async () => {
  const f = await draftFixture();
  google.draftCreateAnswers.push(() => {
    throw new Error("lost response");
  });
  await expectError(await draftCall(f), "outcome_unknown", /does not know/);
  await expectError(await draftCall(f), "outcome_unknown", /does not know/);
  expect(google.draftCreates).toHaveLength(1);
});
