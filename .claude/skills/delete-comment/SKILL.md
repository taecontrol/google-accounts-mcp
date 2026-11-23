---
name: delete-comment
description: Audit and remove code comments, optionally in a named path.
argument-hint: "[path]"
disable-model-invocation: true
---

# Delete comments

## 1. Set the scope

From the repository root, set `scope` to the existing file or directory in `$ARGUMENTS`, or `.` if omitted. Migration SQL is exempt.

```sh
git ls-files -- '*.css' '*.jsonc' '.github/workflows/*.yaml' '.github/workflows/*.yml'
```

Record the lint target, every listed file in scope, and every in-scope key in `lint/comment-baseline.json`.

## 2. Inventory comments

Remove the in-scope baseline entries, then run the lint command.

```sh
vp lint "$scope" --no-error-on-unmatched-pattern
```

Use the `repo/no-comments` diagnostics, including the line named in any directive diagnostic. Keep the directives exempted by `lint/comments.ts`. Read each selected CSS, JSONC, and workflow YAML file in full and identify comments by its syntax. Save the original files before editing. List every ordinary comment with its file and original line range, and count the entries.

## 3. Classify each comment

Read the code each comment describes.

- **Tautology.** The code, names, types, or tests already show it, or the same reason appears in `README.md`, `AGENTS.md`, an ADR, or a test name.
- **Excuse.** The comment justifies a workaround or flaw you can confirm in the code. If the code is sound, classify a suspected Excuse as a Tautology.
- **Stale.** The code contradicts the comment.
- **Decision Record.** The comment explains a consequential, non-obvious decision a future contributor would undo without that reason.

Assign exactly one category to every entry.

## 4. File issues, record decisions, and delete comments

Group Excuses by cause. File one GitHub issue in this repository per cause with the `garden` label. State the problem and leave the fix open. Quote each comment and add a permalink to its lines at the commit before deletion.

Group Decision Records by decision and verify the reason. Extend the ADR for that decision if one exists. Otherwise, create one using the format and numbering in `docs/adr/`.

Delete all inventoried comments once each Excuse has an issue and each Decision Record has an ADR.

## 5. Verify the edit

Rerun the inventory lint with the scoped entries still absent. Add a baseline entry only for a linted file in scope with remaining ordinary comments. Use the exact count for that file.

For each file edited to remove comments, strip ordinary comments from both versions using the file's syntax. Ignore only whitespace left by those comments, preserving token boundaries and significant line breaks. Every stripped pair must match. Run the project gates in `AGENTS.md` and confirm they all pass.

## 6. Report to the owner

Give the count for every category, links to all issues filed and ADRs added or changed, and the final contents of `lint/comment-baseline.json`.
