import type { CompanyProjectDetail } from "./company-contract"

export type TaskFlowMode = "flow" | "responsibility" | "change"

export type TaskFlowNode = CompanyProjectDetail["workItems"][number] & {
  ownerName: string
  artifactCount: number
  gateCount: number
  runStartedAt?: number
}

export type TaskFlowEdge = {
  id: string
  source: string
  target: string
  state: "completed" | "active" | "blocked" | "pending"
}

export function taskFlowProjection(
  detail: CompanyProjectDetail,
  workItems: CompanyProjectDetail["workItems"],
  ownerNames: Record<string, string>,
  activeOnly: boolean,
) {
  const itemIDs = new Set(workItems.map(item => item.id))
  const edges = workItems.flatMap(item => item.dependsOn
    .filter(id => itemIDs.has(id))
    .map(source => ({
      id: `${source}:${item.id}`,
      source,
      target: item.id,
      state: item.status === "blocked"
        ? "blocked" as const
        : item.status === "running"
          ? "active" as const
          : item.status === "completed"
            ? "completed" as const
            : "pending" as const,
    })))
  const visibleIDs = activeOnly ? activeTaskFlowIDs(workItems, edges) : itemIDs
  return {
    nodes: workItems
      .filter(item => visibleIDs.has(item.id))
      .map(item => ({
        ...item,
        ownerName: item.ownerAgentID ? ownerNames[item.ownerAgentID] ?? item.ownerAgentID : "尚未分配负责人",
        artifactCount: detail.artifacts.filter(artifact => artifact.workItemID === item.id).length,
        gateCount: detail.gates.filter(gate => gate.workItemID === item.id && gate.status === "pending").length,
        runStartedAt: detail.agentRuns
          .filter(run => run.workItemID === item.id && run.state === "running")
          .toSorted((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))[0]?.startedAt,
      })),
    edges: edges.filter(edge => visibleIDs.has(edge.source) && visibleIDs.has(edge.target)),
  }
}

function activeTaskFlowIDs(
  items: CompanyProjectDetail["workItems"],
  edges: TaskFlowEdge[],
) {
  const active = new Set(items
    .filter(item => ["running", "blocked", "failed"].includes(item.status))
    .map(item => item.id))
  if (!active.size) items.filter(item => item.status === "pending").slice(0, 1).forEach(item => active.add(item.id))
  if (!active.size) return new Set(items.map(item => item.id))
  const visible = new Set(active)
  const includeAncestors = () => {
    const size = visible.size
    edges.forEach((edge) => {
      if (visible.has(edge.target)) visible.add(edge.source)
    })
    if (visible.size !== size) includeAncestors()
  }
  includeAncestors()
  edges.filter(edge => active.has(edge.source)).forEach(edge => visible.add(edge.target))
  return visible
}

export function taskFlowPurposeLabel(value?: string) {
  return ({
    discovery: "边界确认",
    first_slice: "首个切片",
    delivery: "交付执行",
    verification: "独立验证",
    recovery: "恢复处理",
    closeout: "交付收口",
  } as Record<string, string>)[value ?? ""] ?? "执行任务"
}

export function taskFlowStatusLabel(value: string) {
  return ({
    pending: "待开始",
    running: "进行中",
    blocked: "受阻",
    failed: "失败",
    completed: "已完成",
    superseded: "已替代",
    cancelled: "已取消",
  } as Record<string, string>)[value] ?? value
}
