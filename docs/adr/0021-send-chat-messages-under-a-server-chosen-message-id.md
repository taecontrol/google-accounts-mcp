# ADR-0021: Send Chat messages under a server-chosen message ID

Date: 2026-11-23
Status: Accepted

## Context

People in a Chat conversation can see a message the moment Google accepts it, and they may receive a notification. Deleting the message later cannot take back a notification they already received. The response to the create request can be lost after Google applied it, and a Worker can stop between the request and its record. The same-call design (#28) already keeps one row per identical call and never resends on its own. ADR-0007 keeps a write unconfirmed unless Google explicitly refuses it. Google's create request accepts a caller-chosen ID, `client-…`, and a `requestId`. In a spike on 2026-11-23 (#101), a repeated request with the same ID returned the same message, the conversation held one copy, and a read by the `client-…` ID returned the message Google had named.

## Decision

Each `send_chat_message` call sends its claim key as `messageId=client-<key>`. When the outcome is unknown, a repeat of the call reads `<conversation>/messages/client-<key>` through the read-only transport and never posts again. No `requestId` is sent: the claim already prevents a second post, and a `requestId` alone could not resolve an unknown outcome. A post that returns a readable message gives the agent that message's ID, and the server then tries to record it as the call's result. If that record fails, the call stays running: a repeat reports it as running until the claim is stale, then reads the message by its `client-…` ID. A post refused with 400, 403, 404, or 429 releases the claim, as Calendar event creation does. Any other answer, including a success the server cannot read, leaves the outcome unknown. The send guard recognizes the post and `spaces:setup` as writes, so no Chat write can happen before the final permission check.

## Consequences

A lost answer resolves to the real message, or to "Chat does not show it", without a second notification. A 404 on that read does not prove the post had no effect, so the agent asks the owner before sending a deliberate copy with `duplicate`. Resending under the same ID, which Google would deduplicate, stays off because it could deliver a late first message after a Worker stop. The stored result names Google's message ID, not the `client-…` alias.

## Alternatives considered

- **`requestId` only.** Google deduplicates the post, but an unknown outcome has no ID to read, so the server could not tell the agent whether the message went out.
- **Resend on repeat.** Simpler, but it is a fresh write after an unknown outcome, which #28 rule 6 and ADR-0007 rule out.
