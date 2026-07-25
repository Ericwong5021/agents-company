import { channel } from "node:diagnostics_channel"
import type { CompanySnapshot } from "../../shared/company-contract"

export type AgentCompanyWorkspaceMode = "real" | "demo"

export function snapshotObservation(
  snapshot: CompanySnapshot,
  workspaceMode: AgentCompanyWorkspaceMode = "real",
) {
  const outcome = workspaceMode === "demo"
    ? "demo"
    : snapshot.issue?.kind === "service_error"
      ? "service_error"
      : snapshot.connection === "disconnected"
        ? "disconnected"
        : snapshot.connection === "degraded"
          ? "degraded"
          : snapshot.agents.length + snapshot.work.length + snapshot.messages.length + snapshot.projects.length === 0
            ? "empty_workspace"
            : "ready"
  return {
    schemaVersion: 1,
    event: "agent_company.snapshot",
    workspaceMode,
    outcome,
    connection: snapshot.connection,
    issueKind: snapshot.issue?.kind ?? null,
    unavailable: [...(snapshot.issue?.unavailable ?? [])].sort(),
    counts: {
      agents: snapshot.agents.length,
      work: snapshot.work.length,
      messages: snapshot.messages.length,
      projects: snapshot.projects.length,
    },
  }
}

export function observeSnapshot(
  snapshot: CompanySnapshot,
  workspaceMode: AgentCompanyWorkspaceMode = "real",
) {
  const observation = snapshotObservation(snapshot, workspaceMode)
  console.info(JSON.stringify(observation))
  channel("agent-company.snapshot").publish(observation)
  return snapshot
}
