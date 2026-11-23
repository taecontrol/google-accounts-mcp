# ADR-0017: Avoid writes when scheduled cleanup has no work

Date: 2026-11-23
Status: Accepted

## Context

Cleanup runs every ten minutes, including on an idle deploy. D1 counts writes by affected rows, so repeatedly updating a row to its current state still consumes the write budget. [D1 billing metrics](https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics)

## Decision

Make cleanup update or delete only rows that need a transition or purge. A scheduled run with nothing due must change zero rows.

## Consequences

Cleanup can run repeatedly without adding writes once the database is clean. The approval storage tests measure this by summing D1's reported row changes on repeat runs.
