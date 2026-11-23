# ADR-0002: Screen token clients before provider fetches

Date: 2026-11-23
Status: Accepted

## Context

The OAuth provider can fetch the URL in a client ID as a client metadata document and fetch its signing keys. The token endpoint takes client IDs from unauthenticated requests, so checking the supported-client list after the provider runs would allow requests to trigger fetches to arbitrary hosts.

## Decision

Check the client ID against the fixed allowlist before handing a token request to the provider. A request can supply the ID as a form field or as the issuer of a client assertion. If it supplies both, they must agree. The issuer only selects the allowed fetch destination. The provider still verifies the assertion's signature for authentication.

## Consequences

Unknown and ambiguous client IDs are refused before the provider can fetch metadata or keys. Supporting another client requires adding its exact ID to the allowlist.
