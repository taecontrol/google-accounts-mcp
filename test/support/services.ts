import type { AccountStatus, AccountView } from "../../src/accounts/model";

export const services = (
  gmail = 5,
  calendar = 0,
  status: AccountStatus["kind"] = "ready",
  chat = 0,
): AccountView["services"] => ({
  gmail: {
    status: { kind: status === "ready" && gmail < 5 ? "missing_access" : status },
    granted: gmail,
    required: 5,
  },
  calendar: {
    status: { kind: status === "ready" && calendar < 3 ? "missing_access" : status },
    granted: calendar,
    required: 3,
  },
  chat: {
    status: { kind: status === "ready" && chat < 6 ? "missing_access" : status },
    granted: chat,
    required: 6,
  },
});
