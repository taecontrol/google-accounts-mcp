---
name: delete-comment
description: Audit and remove code comments in the lint baseline or a path you name.
argument-hint: "[path]"
disable-model-invocation: true
---

# Delete comments

1. Audit the path in `$ARGUMENTS` if supplied. Otherwise, audit the paths in `lint/comment-baseline.json` and stop if it is empty. Keep compiler and lint directives. Use `vp lint <paths>` to locate ordinary comments in linted files. Temporarily remove the scoped baseline entries to see the allowed comments, then restore the entries before editing.
2. Read the code around each comment and check the symbols it names before classifying it. Preserve code behavior when removing it.
   - **Tautology.** The code, names, types, or tests already show it. Delete it.
   - **Excuse.** It lets a workaround or flawed implementation stand. Delete it and file a GitHub issue in this repository with the `garden` label. State the problem and leave the fix open.
   - **Stale.** It no longer matches the code. Delete it.
   - **Decision Record.** It gives the reason for a consequential, non-obvious decision that a future contributor might otherwise undo. Verify the reason and move it to a new ADR in `docs/adr/` or an existing ADR for the same decision. Delete the comment.
3. Lower each affected baseline count to the remaining ordinary comments. Remove the entry at zero. Run the project gates listed in `AGENTS.md`.
