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
  released: "执行分配已结束",
} as const

export const permissionModeLabels = {
  read_only: "只读",
  workspace_write: "可写入工作区",
  full_access: "完整访问",
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
    project: "工作",
    project_event: "工作事件",
    goal_brief: "目标摘要",
    legacy_charter: "项目范围",
    work_item: "工作项",
    approval_gate: "审批",
    artifact: "成果",
    delivery: "交付",
    conversation: "讨论",
    goal_request: "目标请求",
    user: "用户",
    work_attempt: "执行尝试",
    work_receipt: "执行回执",
    agent_run: "Agent 运行",
    graph_mutation: "工作调整",
    project_assignment: "责任分配",
    validation_gate: "验收检查",
    acceptance_criterion: "验收标准",
    acceptance_fact: "验收事实",
  }
  return `${labels[source.kind]} · ${source.id}`
}

export function sourceRefTypeLabel(source: ExperienceSourceRef) {
  const labels: Record<ExperienceSourceRef["kind"], string> = {
    project: "工作",
    project_event: "工作事件",
    goal_brief: "目标摘要",
    legacy_charter: "工作章程",
    work_item: "工作项",
    approval_gate: "审批",
    artifact: "成果记录",
    delivery: "交付",
    conversation: "讨论",
    goal_request: "目标请求",
    user: "用户",
    work_attempt: "执行尝试",
    work_receipt: "执行回执",
    agent_run: "Agent 运行",
    graph_mutation: "工作调整",
    project_assignment: "责任分配",
    validation_gate: "验证",
    acceptance_criterion: "验收标准",
    acceptance_fact: "验收事实",
  }
  return `${labels[source.kind]}（已记录）`
}

export function selectionEvidenceLabel(value: string) {
  return value
    .replace(
      /入选：符合 0 项任务能力；历史交付证据尚未覆盖本任务，全部能力将在本项目中逐项复核。/g,
      "入选：历史交付证据尚未覆盖本任务；所需能力将在本项目中逐项执行并独立复核。",
    )
    .replace(
      /能力证据强度 (\d+)（仅表示历史可核验记录，不代表能力上限）/g,
      "历史可核验记录 $1（不代表能力上限）",
    )
    .replace(/负载可用性/g, "当前可投入程度")
}
