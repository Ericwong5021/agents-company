import type { CompanyConnection } from "./company-contract"

export type CompanyConnectionEvent =
  | { type: "request_started" }
  | { type: "snapshot_received"; connection: "ready" | "degraded" | "disconnected" }
  | { type: "request_failed" }

export function transitionCompanyConnection(
  current: CompanyConnection,
  event: CompanyConnectionEvent,
): CompanyConnection {
  if (event.type === "request_failed") return "disconnected"
  if (event.type === "snapshot_received") return event.connection
  if (current === "connecting") return "connecting"
  return "recovering"
}

export function companyReconnectDelay(attempt: number) {
  return Math.min(15_000, 2_000 * 2 ** Math.max(0, attempt))
}
