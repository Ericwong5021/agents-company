import type {
  AssignmentSummary,
  DiscoverySummary,
  ExperienceSourceRef,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"

export const graphDecisionLabels = {
  accept: "接受结果",
  retry: "带证据重试",
  expand: "新增工作",
  rewire: "调整依赖",
  supersede: "替换旧工作",
  request_capability: "补充能力",
  request_attention: "请求决定",
  quiesce: "确认收敛",
} as const

export const graphStatusLabels = {
  proposed: "已提出",
  validated: "已验证",
  applied: "已应用",
  rejected: "已拒绝",
  superseded: "已替代",
} as const

export const assignmentStatusLabels = {
  assigned: "已分配",
  active: "工作中",
  released: "已释放",
} as const

export const validationStatusLabels = {
  pending: "待运行",
  running: "验证中",
  passed: "已通过",
  failed: "未通过",
  superseded: "已替代",
} as const

export function availableAssignments(projection?: OrganizationProjection) {
  if (projection?.availability !== "available") return []
  return projection.assignments.filter(
    (assignment): assignment is Extract<AssignmentSummary, { availability: "available" }> =>
      assignment.availability === "available",
  )
}

export function assignmentsForAgent(
  projections: OrganizationProjection[],
  agentID: string,
) {
  return projections.flatMap(availableAssignments).filter((assignment) => assignment.agent.id === agentID)
}

export function receiptIDs(projection?: GraphChangeSummary) {
  if (projection?.availability !== "available") return []
  return [...new Set(projection.changes.map((change) => change.triggerReceiptId))]
}

export function graphOperationTotal(
  change: Extract<GraphChangeSummary, { availability: "available" }>["changes"][number],
) {
  return Object.values(change.operationCounts).reduce((total, count) => total + count, 0)
}

export function discoverySignalCount(projection: DiscoverySummary) {
  if (projection.availability !== "available") return 0
  return (
    projection.confirmedFacts.length +
    projection.invalidatedAssumptions.length +
    projection.unknowns.length +
    projection.blockers.length +
    projection.capabilityGaps.length +
    projection.questions.length
  )
}

export function diagnosticsCount(
  graph?: GraphChangeSummary,
  validation?: ValidationSummary,
) {
  const graphCount = graph?.availability === "available" ? graph.changes.length : graph ? 1 : 0
  const validationCount =
    validation?.availability === "available" ? validation.gates.length : validation ? 1 : 0
  return graphCount + validationCount
}

export function sourceRefLabel(source: ExperienceSourceRef) {
  const labels: Record<ExperienceSourceRef["kind"], string> = {
    project: "Project",
    project_event: "Event",
    goal_brief: "Goal Brief",
    legacy_charter: "Charter",
    work_item: "Work item",
    approval_gate: "Approval",
    artifact: "Artifact",
    delivery: "Delivery",
    conversation: "Conversation",
    goal_request: "Goal request",
    user: "User",
    work_attempt: "Attempt",
    work_receipt: "Receipt",
    graph_mutation: "Graph change",
    project_assignment: "Assignment",
    validation_gate: "Validation",
  }
  return `${labels[source.kind]} · ${source.id}`
}
