import { expect, it } from "vite-plus/test";
import { TOOLS } from "../src/mcp/tools";

const expectsOf = (name: string) => {
  const tool = TOOLS.find((tool) => tool.name === name);
  if (tool?.kind !== "account") throw new Error(`Missing account tool: ${name}`);
  return tool.expects;
};

it.each(["read_event", "update_event", "delete_event"])(
  "%s keeps the exact calendar and event field expectations",
  (name) => {
    expect(expectsOf(name)).toMatchObject({
      calendar:
        "a calendar ID from list_calendars, 1 to 254 characters without line breaks or control characters",
      event: "an event ID of 1 to 1,024 letters, digits, hyphens, or underscores",
    });
  },
);

it("create_event keeps its writable-calendar suffix", () => {
  expect(expectsOf("create_event").calendar).toBe(
    "a calendar ID from list_calendars, 1 to 254 characters without line breaks or control characters, with access owner or writer",
  );
});

it.each(["send_message", "forward_message"])(
  "%s keeps required and optional mailbox expectations distinct",
  (name) => {
    expect(expectsOf(name)).toMatchObject({
      to: "a list of at least one mailbox, each an address or Name <address>",
      cc: "a list of mailboxes, each an address or Name <address>",
      bcc: "a list of mailboxes, each an address or Name <address>",
    });
  },
);

it.each(["send_reply", "forward_message"])(
  "%s keeps the exact source-message expectation",
  (name) => {
    expect(expectsOf(name).message).toBe(
      "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
    );
  },
);

it("keeps the different invitation, draft, and update-time expectations", () => {
  expect(expectsOf("respond_to_event").event).toBe(
    "an event ID from this account's primary calendar of 1 to 1,024 letters, digits, hyphens, or underscores",
  );
  expect(expectsOf("create_draft")).toMatchObject({
    to: "a list of mailboxes, empty or absent when reply_all is true",
    cc: "a list of mailboxes, empty or absent when reply_all is true",
    bcc: "a list of mailboxes, empty or absent when reply_all is true",
    reply_to:
      "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account; a reply requires an empty or absent subject",
  });
  expect(expectsOf("update_event")).toMatchObject({
    start:
      "a valid date or date-time in years 1900 to 2999: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:00], with an optional Z or ±HH:MM offset; fractions are not allowed",
    end: "a valid date or date-time in years 1900 to 2999: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:00], with an optional Z or ±HH:MM offset; fractions are not allowed",
  });
});
