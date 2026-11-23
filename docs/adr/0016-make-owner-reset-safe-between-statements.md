# ADR-0016: Make owner reset safe between statements

Date: 2026-11-23
Status: Accepted

## Context

The owner reset submits all its SQL in one remote D1 call. Safety cannot depend on that call committing atomically. The reset can stop partway, or the owner state read before confirmation can change before a statement runs.

## Decision

Make each reset statement safe on its own. Begin only if the owner state and generation still match. Enter a resetting state before deleting data, and guard every delete and the final unpin on that specific reset generation.

## Consequences

The Worker refuses requests while the reset is incomplete, and the operator can resume the same generation. Delayed statements cannot clear a newer generation's data. Tests run resets both as a batch and one statement at a time to exercise that guarantee.
