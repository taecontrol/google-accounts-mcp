# ADR-0001: Bound work per Google call

Date: 2026-11-23
Status: Accepted

## Context

Mail changes and attachment processing can issue a Google or KV request for each item, with additional reads to build an approval. A direct call has 20 seconds and an approved run has 25. A Worker invocation can have only six outbound connections waiting for response headers. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)

## Decision

Cap a call at 100 message or thread changes, 100 forwarded attachments, or 100 supplied attachments as applicable. Run batches of Google requests at most five at a time to leave one connection available for work such as token refresh or storage.

## Consequences

The cap bounds the number of requests and keeps a single call from starting a large burst. Fitting 100 items within the deadlines and Gmail's per-user quota is an estimate. Reassess it when a limit rises or an item requires more requests.
