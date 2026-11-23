# ADR-0008: Reserve trash and restore for their own tools

Date: 2026-11-23
Status: Accepted

## Context

Gmail can move mail into or out of the trash or spam through changes to system labels. The owner sets permissions for organizing mail, trashing messages, and restoring messages separately.

## Decision

Keep `change_labels` from adding or removing `TRASH` or `SPAM`, and from adding `INBOX`, which can also take mail out of the trash or spam. Keep trash and restore behind the permissions for `trash_messages` and `restore_messages`.

## Consequences

Access to label changes cannot bypass the owner's trash and restore settings. Removing `INBOX` still supports archiving.
