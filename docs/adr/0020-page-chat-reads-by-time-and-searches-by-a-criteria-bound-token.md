# ADR-0020: Page Chat reads by time and searches by a criteria-bound token

Date: 2026-11-23
Status: Accepted

## Context

`read_conversation` and `search_messages` return at most 32,000 JSON characters per result, so a page can end before Google's page does. Observed against a real Workspace account on 2026-11-23: Google's message list is strictly newest first, and `createTime < "<a message's exact time>"` starts exactly after that message. Search results are not in time order (2 inversions in 12 results, 11 in 44), and Google returns short pages that still have a next page. Google's search reference says a page token sent with other parameters gives unexpected results. Catching up on Chat needs two searches open at once, one for unread messages and one for mentions, because Google refuses `OR` between them, so an agent can easily send one search's token with the other's criteria.

## Decision

A read pages by its own cursor: the `time` of the last message returned, sent back as a `createTime <` filter. When a page is cut for size, the next page starts right after the last message kept, with no repeat and no gap, and new messages do not move older pages.

A search passes Google's page token through, prefixed with 16 hexadecimal characters of the SHA-256 digest of the account, the filter sent, and the limit. A token whose digest does not match the call is refused before any request. Search pages are sized so that they never need a cut: 15 messages with texts cut to 1,000 JSON characters, so no result is dropped before Google's token.

The digest is unkeyed. It catches the live case, an agent that mixes up the tokens of its two searches. It does not stop an agent that forges a digest on purpose, pairing one search's token with other criteria; what Google returns for that was not observed.

## Consequences

Read pages stay exact while messages arrive, but two messages with the same `createTime`, to the microsecond, on both sides of a cut lose the second; none were observed in 51 messages. One message whose JSON alone exceeds a page comes alone with its text cut, and the rest of it cannot be read; supporting it needs a cursor with a text offset, as Gmail's `read_thread` has.

Search pages can miss or repeat messages that arrive, or change unread state, while an agent pages, and the description tells agents to dedupe. A Google token longer than 1,983 characters would exceed the 2,000-character `page` input; storing tokens on the server would remove that limit. Making the digest a keyed signature, with a key derived from `TOKEN_KEY`, would also refuse forged digests.
