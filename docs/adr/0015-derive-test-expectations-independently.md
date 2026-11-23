# ADR-0015: Derive test expectations independently

Date: 2026-11-23
Status: Accepted

## Context

Tests can pass with the same defect as production if they use the production code to compute what should happen. Simplified service responses and assertions on server-rendered text can also miss the behavior under test.

## Decision

Derive expected values and fixture state from an independent source. Use documented or observed Google responses with invented data, including fields the server must omit. Observe real return values and outgoing request bodies, so tests check the code's actual output.

## Consequences

- Token tests seal their own fixtures, and the call identity test pins an independently computed HKDF/HMAC answer. Changes to the identity derivation require a deliberate version change. Calendar scope URLs and UI service counts are explicit in fixtures, and the test MCP client obtains grants over HTTP.
- Gmail fixtures preserve documented visibility fields and observations such as escaped snippets, oldest-first messages, and millisecond dates. Calendar fixtures include organizers missing from attendee lists and pages shorter than requested. These shapes catch omissions and pagination assumptions that minimal responses would miss. [Gmail label responses](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list#response-body), [Calendar event pagination](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- Keep inputs that distinguish the intended behavior from a plausible mistake. The API-disabled fixture names Calendar in a Gmail refusal so the test checks that the tool supplies the API name. A 2041-bit RSA modulus still takes 256 bytes. The late-approval test restores the clock to within the deadline and checks that a stored unknown outcome still rejects a late result.
- Exercise an interactive control to prove hydration works because server-rendered text is already present. Test the shared approval layout at phone and desktop widths with representative cases for many values, long names or captions, and both note types. Add another layout case when it exercises a different structure.
