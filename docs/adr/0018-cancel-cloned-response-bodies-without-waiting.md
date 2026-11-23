# ADR-0018: Cancel cloned response bodies without waiting

Date: 2026-11-23
Status: Accepted

## Context

The server checks a cloned Google 403 response for an API-disabled error. Cloning splits the body stream into two branches. Cancelling the clone can wait for the original branch, which the caller reads only after the check returns. [Streams Standard on teeing](https://streams.spec.whatwg.org/#rs-tee)

## Decision

Start cancellation of the clone and release its reader without waiting for cancellation to settle. Handle any rejected cancellation promise without blocking the check.

## Consequences

The check returns even when the clone has unread data. The caller remains free to read the original body.
