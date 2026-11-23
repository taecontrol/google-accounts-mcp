# ADR-0019: Look up members only for the 50 most recent conversations

Date: 2026-11-23
Status: Accepted

## Context

Google Chat's list of spaces names a direct message but not who it is with. The other person comes only from a separate member list, one request per direct message. A direct call has 20 seconds. Measured from the owner's machine against a real Workspace account on 2026-11-23, a page of spaces took 236 to 306 ms and a member list 523 to 702 ms (median 585 ms). Fifty member lists, five at a time as ADR-0001 requires, take about 7 seconds; a hundred take about 15 seconds, too close to the deadline. Google does not document the order of the space list, so the most recent conversations can be on any page read.

## Decision

Read at most five pages of 1,000 spaces, sort them by last activity, keep the 50 most recent, and look up members only for the direct messages among those 50. One member list per direct message, with no second page. A failed member list fails the whole call instead of returning a list with gaps.

## Consequences

A call makes at most 5 space requests and 50 member requests, under half the deadline at the measured speeds. An agent cannot get more than 50 conversations, or an older one, from this tool; older conversations are for the planned Chat search and direct-message tools. An account with more than 5,000 conversations may have a recent one on an unread page. A direct message whose first member page holds only the account comes without the other person. One slow or failing member list costs the whole call, and the agent retries it. Raising the count of 50 needs new latency evidence or a different way to name the other person.
