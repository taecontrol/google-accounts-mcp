# ADR-0012: Limit bulk Allowed to the confirmed set

Date: 2026-11-23
Status: Accepted

## Context

The owner can set all tools for an account to Allowed, giving a connection permission to act without asking. The confirmation counts tools whose setting changes and names those with irreversible effects. A tool that looks Allowed on a stale page may have had that permission revoked since the page loaded.

## Decision

For bulk Allowed, submit only the tools the page shows at another setting and includes in the confirmation. The backend applies the change to that explicit list. Ask first and Not allowed apply to every tool shown on the account page.

## Consequences

A stale page leaves a revocation in place for a tool the confirmation excluded. The owner may need to reload to see that an account still has mixed settings.
