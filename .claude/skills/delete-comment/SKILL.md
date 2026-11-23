---
name: delete-comment
description: Audit and remove code comments, optionally in a named path.
argument-hint: "[path]"
disable-model-invocation: true
---

# Delete comments

1. Audit the path in `$ARGUMENTS` if supplied. Otherwise, audit the baseline paths in `lint/comment-baseline.json` plus `src/styles.css`, `wrangler.jsonc`, and YAML files in `.github/workflows/`. Skip migration SQL. Keep permitted compiler and lint directives.
2. For linted files in scope, temporarily remove their baseline entries, locate comments with `vp lint <paths>`, and restore the entries before editing. Use `rg` to find comment markers in CSS (`/*`), JSONC (`//` and `/*`), and workflow YAML (`#`).
3. Read the code around each comment and check the symbols it names before classifying it. Preserve code behavior when removing it.
   - **Tautology.** The code, names, types, or tests already show it. Delete it.
   - **Excuse.** It lets a workaround or flawed implementation stand. Delete it and file a GitHub issue in this repository with the `garden` label. State the problem and leave the fix open.
   - **Stale.** It no longer matches the code. Delete it.
   - **Decision Record.** It gives the reason for a consequential, non-obvious decision that a future contributor might otherwise undo. Verify the reason and move it to a new ADR in `docs/adr/` or an existing ADR for the same decision. Delete the comment.
4. Lower each affected baseline count to the remaining ordinary comments. Remove the entry at zero. Run the project gates listed in `AGENTS.md`.
