# ADR-0007: Keep ambiguous Google writes unconfirmed

Date: 2026-11-23
Status: Accepted

## Context

Google may apply a write before its response is lost or becomes unreadable. If the server says nothing happened, an agent may repeat an irreversible action such as sending mail or creating an event.

## Decision

Once a write has been sent, report it as refused only when Google explicitly refuses the operation. The Gmail helpers pass 4xx responses to each operation to classify. A 404 from the send request for a staged draft becomes `outcome_unknown`. Calendar event creation recognizes 400, 403, 404, and 429 as refusals. A 409 can mean that an event with the chosen ID already exists. Redirects, 5xx responses, lost responses, and unusable success bodies leave the outcome unconfirmed.

## Consequences

An unconfirmed result may take longer to resolve. A repeat of an unconfirmed event creation can look up the original event ID without issuing another insert. When the server cannot confirm an irreversible send, the agent must avoid a fresh write until the outcome is checked.
