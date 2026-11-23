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

const lintDisable = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)/u;
const ruleName = /^(?:(?:@[\w-]+\/)?[\w-]+\/)?\w[\w-]*$/u;
const fileStart = { line: 1, column: 0 };

function isDirective({ type, value }: Comment, commentRule: string): boolean {
  if (type !== "Line") return false;
  if (/^\/\s*<reference\s+[^<>]+\/>\s*$/u.test(value)) return true;
  if (/^\/?\s*@ts-expect-error(?=\s|:|$)/u.test(value)) return true;

  const prefix = lintDisable.exec(value)?.[0];
  if (!prefix) return false;
  const [names = ""] = value.slice(prefix.length).split(/\s+--\s+/u, 1);
  return names.split(",").every((name) => {
    const rule = name.trim();
    return ruleName.test(rule) && rule !== commentRule;
  });
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
              .filter((comment) => !isDirective(comment, context.id));
            if (comments.length > allowed) {
              const message =
                allowed === 0
                  ? "Remove this comment. Record decisions in docs/adr/."
                  : `Remove the added comments. This file has ${comments.length} comments and ${baselinePath} allows ${allowed}.`;
              for (const comment of comments) {
                if (lintDisable.test(comment.value)) {
                  context.report({
                    loc: fileStart,
                    message: `Fix the lint directive on line ${comment.loc.start.line}. List the rules to disable in a line comment and keep ${context.id} enabled.`,
                  });
                } else {
                  context.report({ loc: comment.loc, message });
                }
              }
            } else if (comments.length < allowed) {
              const message =
                comments.length === 0
                  ? `Remove "${file}" from ${baselinePath}. No ordinary comments remain.`
                  : `Lower "${file}" in ${baselinePath} from ${allowed} to ${comments.length}.`;
              context.report({ loc: fileStart, message });
            }
          },
        };
      },
    },
  },
});
