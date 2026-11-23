# ADR-0004: Keep validated tool inputs in their JSON form

Date: 2026-11-23
Status: Accepted

## Context

An Ask first call stores its validated arguments as sealed JSON. When the owner opens or approves the request, the server decodes the stored arguments with the same tool input schema. A schema that converts a time string to an object would give the second decode a shape it never accepted.

## Decision

Use tool input schemas to validate values while preserving the JSON form the schema accepts. Parse values into domain representations after validation, when preparing the view or running the call.

## Consequences

Direct and approved calls start with the same validated values. Approval storage can round-trip those values through JSON without maintaining a separate representation for each tool.
