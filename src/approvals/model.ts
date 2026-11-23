import type { AccountId } from "../accounts/model";
import type { ConnectionId, App } from "../connections/model";
import type { WonBrand } from "./store";
import type { AccountTool } from "../mcp/tools";
import type { FileRef } from "../files/store";
import type { Sealed } from "../seal";

export type ApprovalId = string & { readonly __approvalId: unique symbol };
export const parseApprovalId = (value: unknown): ApprovalId | null =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? (value as ApprovalId)
    : null;
export const APPROVAL_LIFETIME = 3_600_000;
export const RESULT_LIFETIME = 3_600_000;
export const CALL_DEADLINE = 20_000;
export const RUN_DEADLINE = 25_000;
export const OUTCOME_WINDOW = 30_000;
export const WAITING_LIMIT = 20;
export interface Use {
  account: AccountId;
  tool: AccountTool;
}
export interface ApprovalAccount {
  id: AccountId;
  name: string;
  email: string;
  hd: string | null;
}
interface Common {
  id: ApprovalId;
  connection: { id: ConnectionId; name: string; app: App };
  accounts: readonly ApprovalAccount[];
  uses: readonly Use[];
  tool: AccountTool;
  call: number;
  createdAt: number;
  expiresAt: number;
}
export type Approval = Common &
  (
    | { state: "waiting"; arguments: Sealed }
    | { state: "running"; decidedAt: number }
    | {
        state: "finished";
        decidedAt: number;
        outcome: "success" | "failed" | "unknown";
        result: Sealed | null;
      }
    | { state: "rejected"; decidedAt: number }
    | { state: "expired" }
    | { state: "refused"; endedBy: "tool" | "connection" | "account" }
  );
export type Won = {
  readonly id: ApprovalId;
  readonly at: number;
  readonly claim: string;
} & WonBrand;
export type Target =
  | { connection: ConnectionId }
  | { account: AccountId }
  | { connection: ConnectionId; account: AccountId; tool: AccountTool };
export interface ApprovalRequest {
  connection: { id: string; name: string; app: string };
  account: { name: string; email: string; workspace: boolean };
  tool: { label: string; action: string; joiner: string; empty: string };
  also?: ReadonlyArray<{
    label: string;
    action: string;
    joiner: string;
    name: string;
    email: string;
    workspace: boolean;
  }>;
  notes: ReadonlyArray<ViewNote>;
  values: ReadonlyArray<ViewValue>;
}
export interface ViewNote {
  text: string;
  warning: boolean;
}
export interface ViewValue {
  name: string;
  text: string;
  from: "agent" | "gmail" | "draft" | "calendar";
}
export const sameValues = (approved: readonly ViewValue[], current: readonly ViewValue[]) =>
  approved.length > 0 &&
  approved.length === current.length &&
  current.every((value, index) => {
    const before = approved[index]!;
    return value.name === before.name && value.text === before.text && value.from === before.from;
  });
export type ApprovalState =
  | { kind: "waiting"; shown: boolean; changed: boolean; digest: string | null }
  | { kind: "running" }
  | { kind: "succeeded" }
  | { kind: "failed"; message: string | null }
  | { kind: "unknown"; message?: string }
  | { kind: "rejected" }
  | { kind: "expired" }
  | { kind: "ended"; by: "tool" | "connection" | "account" };
export interface ApprovalPageProps {
  _tag: "Approval";
  id: string;
  request: ApprovalRequest;
  times: {
    asked: string;
    askedOn: string;
    expires: string;
    expiresOn: string;
    minutesSinceAsked: number;
    minutesLeft: number;
    decidedOn: string | null;
  };
  state: ApprovalState;
  unconfirmed?: boolean;
}
export type StoredPayload =
  | { result: unknown; file?: FileRef }
  | { error: { code: string; message: string } };
export const isoSeconds = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
export const viewDate = (at: number): string => {
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(at);
  return `${date} at ${time} UTC`;
};
const byteCount = (bytes: number) =>
  `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
export const filesText = (files: ReadonlyArray<{ size: number }>) =>
  `${files.length} ${files.length === 1 ? "file" : "files"}, ${byteCount(files.reduce((n, file) => n + file.size, 0))} in all`;
export const fileText = (file: { filename: string; type: string; size: number }) =>
  `${file.filename || "(no name)"} (${file.type}, ${byteCount(file.size)})`;
