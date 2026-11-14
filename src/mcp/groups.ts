import type { Service } from "../google/services";

export const GROUP_SERVICE = {
  "Find and read": "gmail",
  Draft: "gmail",
  Send: "gmail",
  Organize: "gmail",
  "Trash and delete": "gmail",
  "Download attachments": "gmail",
  "See calendars and events": "calendar",
  "Create and change events": "calendar",
  "Respond to invitations": "calendar",
} as const satisfies Record<string, Service>;
export type Group = keyof typeof GROUP_SERVICE;
export const GROUPS = Object.keys(GROUP_SERVICE) as Group[];
