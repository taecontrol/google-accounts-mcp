import type { AccountStatus, AccountView } from "../../src/accounts/model";

/** Explicit UI fixtures, independent of production scope counting. */
export const services = (
  gmail = 5,
  calendar = 0,
  status: AccountStatus["kind"] = "ready",
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
});
