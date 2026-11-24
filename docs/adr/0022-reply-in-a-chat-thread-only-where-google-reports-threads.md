# ADR-0022: Reply in a Chat thread only where Google reports threads

Date: 2026-11-23
Status: Accepted

## Context

Read tools give every Chat message a `thread`, also in spaces whose `spaceThreadingState` is `UNTHREADED_MESSAGES`, where each message is its own thread. Google documents the reply option as supported only in named spaces, and a reply in such a space was never observed, so a reply there may land as a new top-level message while the owner approved "reply in thread". About half of the owner's spaces are in that state (#101). A reply was observed only in a `THREADED_MESSAGES` direct message.

## Decision

Before a reply, the server reads the conversation and sends only when `spaceThreadingState` is `THREADED_MESSAGES`. Every other value, or none, refuses the call with `invalid_arguments` naming `thread`, before any post and before Ask first can be approved. When the approval's binding read of the conversation happens, the same read serves this check.

## Consequences

A reply costs one extra read when the tool is Allowed. The result never claims a thread Google did not use. Replies in `GROUPED_MESSAGES` spaces are refused though they may work; allowing them needs an observed reply in that state.
