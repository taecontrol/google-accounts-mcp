# ADR-0009: Store scopes only for chosen services

Date: 2026-11-23
Status: Accepted

## Context

Google can return scopes the owner granted to the same OAuth client earlier. On a new connection or reconnect, the returned scopes can therefore exceed the services the owner chose this time.

## Decision

Store the intersection of Google's granted scopes and the scopes for the selected services. Use the stored scopes to determine which services the account can provide to agents.

## Consequences

An earlier grant cannot add a service to the server's permissions for an account. If the owner omits a service on reconnect, the stored scopes for it are removed. If Google omits some requested scopes, the server records only those actually granted.
