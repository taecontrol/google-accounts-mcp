import { Schema } from "effect";
import type { ViewValue } from "../approvals/model";

export const MAX_DUPLICATE = 100;
export const Duplicate = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: MAX_DUPLICATE }));
export const DUPLICATE_EXPECTS = `a whole number from 2 to ${MAX_DUPLICATE}`;
export const nextDuplicate = (duplicate?: number): number | null => {
  const next = (duplicate ?? 1) + 1;
  return next <= MAX_DUPLICATE ? next : null;
};
export const duplicateValue = (duplicate?: number): ViewValue[] =>
  duplicate === undefined
    ? []
    : [
        {
          name: "Duplicate",
          text: `${duplicate} (a deliberate copy of an earlier call)`,
          from: "agent",
        },
      ];
