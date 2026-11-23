# ADR-0015: Derive test expectations independently

Date: 2026-11-23
Status: Accepted

## Context

A test can repeat an encryption or identity bug if it uses the implementation to compute the expected result. Simplified Google responses can miss fields and pagination behavior. Server-rendered text is present even if browser code fails to load.

## Decision

Use an independent AES-GCM encoder for token fixtures so production encryption cannot hide a token bug. For the call identity test, pin the HKDF/HMAC result computed outside the implementation using an empty HKDF salt and the canonical JSON input. Keep that expected value for the same inputs even if the implementation returns something different.

Keep the Calendar request URLs and OAuth scopes in the fixtures independent of production constants. Write out the UI service counts so the fixtures can catch errors in scope counting. Have the test MCP client obtain grants and tokens over HTTP. Observe the approval store's actual return value when a test needs a winning approval and capture Calendar request bodies at the HTTP stub.

## Consequences

- Gmail fixtures use invented data in the shapes observed on a real account on 2026-11-11 for issue #23. The shapes include escaped snippets, oldest-first messages, and dates in milliseconds. The fixtures also include documented visibility fields and other fields the tools must omit. [Gmail label responses](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list#response-body)
- Calendar fixtures use the event shape observed on 2026-11-14, which allows an organizer to have no attendee entry. The pagination tests model a stable data set where Google can return fewer items than requested, even for the same starting token. [Calendar event pagination](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- Keep inputs that distinguish the intended behavior from a plausible mistake. The API-disabled fixture names Calendar in a Gmail refusal so the test checks that the tool supplies the API name. A 2041-bit RSA modulus still takes 256 bytes. The late-approval test restores the clock to within the deadline and checks that a stored unknown outcome still rejects a late result.
- Exercise an interactive control to prove hydration works. Test the shared approval layout at phone and desktop widths with representative cases for many values, long names or captions, and both note types. Add a view only when it exercises a structure the suite has yet to cover.
