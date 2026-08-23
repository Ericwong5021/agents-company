import type { CompanyProjectDetail } from "../../shared/company-contract"
import type { WorkRoomContextVM } from "../types/work-room"

export function toWorkRoomContext(detail?: CompanyProjectDetail): WorkRoomContextVM {
  if (!detail) return { tasks: [], approvals: [], artifacts: [], execution: [] }
  const agentNames = Object.fromEntries(detail.recruitment.candidates.map(agent => [agent.id, agent.name]))
  return {
    tasks: detail.workItems
      .filter(item => ["running", "blocked", "failed", "pending_review"].includes(item.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
        owner: item.ownerAgentID ? agentNames[item.ownerAgentID] ?? item.ownerAgentID : "待分配",
        updatedAt: item.updatedAt,
      })),
    approvals: detail.gates
      .filter(gate => !gate.decidedAt)
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .map(gate => ({ id: gate.id, title: gate.title, summary: gate.summary, status: gate.status, requestedAt: gate.requestedAt })),
    artifacts: [...detail.artifacts]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(artifact => ({ id: artifact.id, title: artifact.title, kind: artifact.kind, createdAt: artifact.createdAt })),
    execution: [...detail.workAttempts]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 8)
      .map(attempt => ({
        id: attempt.id,
        label: detail.workItems.find(item => item.id === attempt.workItemID)?.title ?? attempt.workItemID,
        status: attempt.status,
        occurredAt: attempt.finishedAt ?? attempt.startedAt,
      })),
  }
}
