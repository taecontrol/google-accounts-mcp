# ADR-0005: Show approved write values and their sources

Date: 2026-11-23
Status: Accepted

## Context

The owner decides what may be written from the approval page. Formatting can hide a material difference in a value, and words chosen by an agent or read from Google can resemble a server instruction.

## Decision

Build the approval view and the write from the same normalized values. Show the relevant values the write will send and add exact text where the display format loses precision, such as seconds in an event update. Explain a repeating event using the same rule sent to Google. Where approval binds the displayed values, require a new decision if they change.

Reserve unshaded notes for text authored by the server and computed before reading Google. Shade values supplied by the agent or read from Gmail, a draft, or Calendar, and identify the source. Refuse control characters and line separators in Calendar identifiers that the page displays one per line, so one ID cannot appear as several lines.

## Consequences

The owner can see what a write means and who supplied its text. A tool that builds its request and display separately can introduce a difference that the owner cannot see. Sending a Gmail draft as it is uses a distinct approval contract. The page discloses that it will send the current draft even if it changes.
