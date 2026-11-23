# ADR-0006: Use the calendar list to decide event access

Date: 2026-11-23
Status: Accepted

## Context

Google Calendar can return a 403 for a rate or quota limit as well as an access problem. An event request's status alone cannot establish which calendars are listed for the connected account or what role the account has. [Google Calendar error responses](https://developers.google.com/workspace/calendar/api/guides/errors)

## Decision

Use the account's calendar list to establish membership and access for events. Read up to eight pages of 250 entries. Leave `showHidden` and `showDeleted` unset so Google excludes hidden and deleted entries. Apply the read and write role checks to the returned entries.

## Consequences

A listed ID can work even if the shorter `list_calendars` result omitted it. A calendar outside the list read by the server is unavailable to event tools even if it exists in Google. Free/busy queries can separately accept unlisted IDs and use Google's free/busy result.
