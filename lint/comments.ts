import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, type Comment } from "vite-plus/lint/plugins";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = "lint/comment-baseline.json";
const allowedComments = JSON.parse(readFileSync(join(root, baselinePath), "utf8")) as Record<
  string,
  number
>;
const baseline = new Map(Object.entries(allowedComments));

for (const [file, count] of baseline) {
  if (!statSync(join(root, file), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Remove "${file}" from ${baselinePath}. The file no longer exists.`);
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      `Use a positive comment count for "${file}" in ${baselinePath}, or remove the entry.`,
    );
  }
}

function isDirective({ type, value }: Comment): boolean {
  if (/^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)/u.test(value)) return true;
  if (type === "Line" && /^\/\s*<reference\s+[^<>]+\/>\s*$/u.test(value)) return true;

  const compilerText =
    type === "Line"
      ? value.replace(/^\//u, "")
      : value
          .split(/[\r\n\u2028\u2029]/u)
          .at(-1)!
          .replace(/^\s*[/*]*/u, "");
  return /^\s*@ts-(?:expect-error|ignore)(?=\s|:|$)/u.test(compilerText);
}

export default definePlugin({
  meta: { name: "repo" },
  rules: {
    "no-comments": {
      create(context) {
        return {
          Program() {
            const file = relative(root, context.filename).replaceAll(sep, "/");
            const allowed = baseline.get(file) ?? 0;
            const comments = context.sourceCode
              .getAllComments()
              .filter((comment) => !isDirective(comment));
            if (comments.length > allowed) {
              const message =
                allowed === 0
                  ? "Remove this comment. Record decisions in docs/adr/."
                  : `Remove the added comments. This file has ${comments.length} comments and ${baselinePath} allows ${allowed}.`;
              for (const comment of comments) context.report({ loc: comment.loc, message });
            } else if (comments.length < allowed) {
              const message =
                comments.length === 0
                  ? `Remove "${file}" from ${baselinePath}. No ordinary comments remain.`
                  : `Lower "${file}" in ${baselinePath} from ${allowed} to ${comments.length}.`;
              context.report({ loc: { line: 1, column: 0 }, message });
            }
          },
        };
      },
    },
  },
});
