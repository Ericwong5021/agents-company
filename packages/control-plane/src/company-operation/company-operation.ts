import z from "zod"
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "@/storage"
import { Database } from "@/storage"
import { AgentRunEventTable, AgentRunTable } from "@/agent-run/agent-run.sql"
import { AuditEventTable } from "@/audit-event/audit-event.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyID } from "@/company/schema"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemTable,
} from "@/company-project/company-project.sql"
import { CompanyOperationTable } from "./company-operation.sql"

export const Category = z.enum(["governance", "work", "runtime", "quality", "delivery", "organization", "system"])
export const Severity = z.enum(["info", "warning", "error"])
export const Importance = z.enum(["primary", "normal", "diagnostic"])

export const Cursor = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator < 1 || separator === decoded.length - 1) return false
    const occurredAt = Number(decoded.slice(0, separator))
    return /^\d+$/.test(decoded.slice(0, separator)) && Number.isSafeInteger(occurredAt) && occurredAt >= 0
  }, "Invalid cursor")

export const Query = z
  .object({
    company_id: CompanyID,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Cursor.optional(),
    category: Category.optional(),
    severity: Severity.optional(),
    importance: Importance.optional(),
    project_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: "from must be less than or equal to to",
  })
export type Query = z.infer<typeof Query>

export const SummaryQuery = z.object({ company_id: CompanyID }).strict()
export type SummaryQuery = z.infer<typeof SummaryQuery>

export const Ref = z
  .object({
    rootNeedID: z.string().optional(),
    projectID: z.string().optional(),
    threadID: z.string().optional(),
    agentID: z.string().optional(),
    runID: z.string().optional(),
    workItemID: z.string().optional(),
  })
  .strict()

export const Context = z
  .object({
    project: z.object({ id: z.string(), title: z.string() }).strict().optional(),
    agent: z.object({ id: z.string(), name: z.string() }).strict().optional(),
    run: z.object({ id: z.string(), state: z.string() }).strict().optional(),
    workItem: z.object({ id: z.string(), title: z.string() }).strict().optional(),
  })
  .strict()

export const Detail = z.object({ label: z.string(), value: z.string() }).strict()

export const Item = z
  .object({
    id: z.string(),
    category: Category,
    severity: Severity,
    importance: Importance,
    eventType: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    occurredAt: z.number().int(),
    source: z.object({ kind: z.string(), id: z.string() }).strict(),
    refs: Ref,
    context: Context,
    href: z.string(),
    details: z.array(Detail).optional(),
  })
  .strict()
  .meta({ ref: "CompanyOperationItem" })
export type Item = z.infer<typeof Item>

export const Summary = z
  .object({
    total24h: z.number().int().nonnegative(),
    errors24h: z.number().int().nonnegative(),
    warnings24h: z.number().int().nonnegative(),
    recoveries24h: z.number().int().nonnegative(),
  })
  .strict()

export const Page = z
  .object({ items: z.array(Item), nextCursor: z.string().optional() })
  .strict()
  .meta({ ref: "CompanyOperationPage" })
export type Page = z.infer<typeof Page>

const statusLabels: Record<string, string> = {
  queued: "已排队",
  starting: "正在启动",
  running: "执行中",
  interrupting: "正在中断",
  awaiting_recovery: "等待恢复",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  pending: "等待处理",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
  expired: "已过期",
  blocked: "受阻",
  paused: "已暂停",
}

const eventTitles: Record<string, string> = {
  "project.created": "创建了一项工作",
  "project.status_changed": "工作状态发生变化",
  "plan.created": "形成了新的执行计划",
  "work_item.running": "工作项开始执行",
  "work_attempt.started": "开始了一次执行尝试",
  "work_attempt.finished": "结束了一次执行尝试",
  "work_attempt.stopped": "停止了一次执行尝试",
  "work_item.retry_scheduled": "安排了工作项重试",
  "work_item.rework_scheduled": "安排了工作项返工",
  "work_item.reassigned": "重新分配了工作项",
  "work_item.recovered": "工作项已恢复",
  "work_item.delivery_ready_for_review": "工作项交付已进入复核",
  "dispatch.paused": "暂停了新任务派发",
  "dispatch.resumed": "恢复了任务派发",
  "dispatch.aborted": "中止了一次派发",
  "dispatch.claim_recovered": "恢复了失效的派发占用",
  "delivery.ready": "交付已准备完成",
  "artifact.created": "产生了一项成果",
  "outcome_signal.recorded": "记录了结果信号",
  "validation_gate.evaluated": "完成了一次验证评估",
  "acceptance_fact.recorded": "记录了一项验收事实",
  "attention.opened": "产生了需要关注的事项",
  "attention.closed": "关闭了关注事项",
  "project_action.applied": "执行了人工调整",
  "project_action.rejected": "拒绝了人工调整",
  "project_action.dispatch_failed": "人工调整派发失败",
  "project_assignment.assigned": "分配了项目责任",
  "project_assignment.reassigned": "调整了项目责任",
  "project_assignment.released": "释放了项目责任",
  "board_closeout.recorded": "记录了董事会收口决定",
  "team_selection.selected": "选择了一名项目成员",
  "team_selection.rejected": "拒绝了一名项目候选成员",
  "team_selection.released": "释放了一名项目成员",
}

const safeEventTypes = new Set([
  ...Object.keys(eventTitles),
  "lifecycle.queued",
  "lifecycle.starting",
  "lifecycle.running",
  "lifecycle.interrupting",
  "lifecycle.awaiting_recovery",
  "lifecycle.completed",
  "lifecycle.failed",
  "lifecycle.stopped",
  "usage.recorded",
  "approval.pending",
  "approval.approved",
  "approval.rejected",
  "approval.cancelled",
  "approval.expired",
  "signal.conclusion",
  "signal.decision",
  "signal.plan",
  "signal.status",
  "signal.risk",
  "signal.approval",
  "signal.delivery",
  "signal.intervention",
])

function statusLabel(value: string) {
  return statusLabels[value] ?? "未知状态"
}

function title(eventType: string) {
  if (eventTitles[eventType]) return eventTitles[eventType]
  if (eventType.startsWith("lifecycle.") && statusLabels[eventType.slice("lifecycle.".length)])
    return `Agent Run ${statusLabel(eventType.slice("lifecycle.".length))}`
  if (eventType === "usage.recorded") return "记录了 Agent Run 用量"
  if (eventType.startsWith("approval.") && statusLabels[eventType.slice("approval.".length)])
    return `审批${statusLabel(eventType.slice("approval.".length))}`
  if (eventType.startsWith("signal.")) {
    return ({
      conclusion: "形成了一项结论",
      decision: "形成了一项决定",
      plan: "发布了一项计划",
      status: "发布了一项状态更新",
      risk: "报告了一项风险",
      approval: "发布了一项审批信号",
      delivery: "发布了一项交付信号",
      intervention: "记录了一次人工介入",
    } as Record<string, string>)[eventType.slice("signal.".length)] ?? "记录了一项高信号协作事件"
  }
  if (eventType.startsWith("validation")) return eventType.includes("failed") ? "验证未通过" : "记录了验证结果"
  if (eventType.startsWith("acceptance")) return eventType.includes("failed") ? "验收未通过" : "记录了验收事实"
  if (eventType.startsWith("audit.")) return "记录了一项权限与访问审计"
  if (eventType.startsWith("agent_performance.")) return "记录了一次 Agent 绩效结果"
  if (eventType.startsWith("employment_review.")) return "记录了一次任职评审"
  if (eventType.startsWith("department.")) return "部门状态发生变化"
  return "记录了一项公司运营事件"
}

function safeEventType(eventType: string) {
  if (safeEventTypes.has(eventType)) return eventType
  if (eventType.startsWith("audit.")) return "audit.recorded"
  if (eventType.startsWith("agent_performance.")) return "agent_performance.recorded"
  if (eventType.startsWith("employment_review.")) return "employment_review.recorded"
  if (eventType.startsWith("department.")) return "department.changed"
  if (eventType.startsWith("validation")) return eventType.includes("failed") ? "validation.failed" : "validation.recorded"
  if (eventType.startsWith("acceptance")) return eventType.includes("failed") ? "acceptance.failed" : "acceptance.recorded"
  return "system.recorded"
}

function realSourceID(row: typeof CompanyOperationTable.$inferSelect) {
  if (row.source_kind !== "approval_gate") return row.source_id
  const suffix = row.source_id.lastIndexOf(`:${row.occurred_at}`)
  if (suffix < 1) return row.source_id
  const stateSeparator = row.source_id.lastIndexOf(":", suffix - 1)
  if (stateSeparator < 1) return row.source_id
  const state = row.source_id.slice(stateSeparator + 1, suffix)
  return ["pending", "approved", "rejected", "cancelled", "expired"].includes(state)
    ? row.source_id.slice(0, stateSeparator)
    : row.source_id
}

function decodeCursor(cursor: string) {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8")
  const separator = decoded.indexOf(":")
  return { occurredAt: Number(decoded.slice(0, separator)), id: decoded.slice(separator + 1) }
}

function encodeCursor(row: typeof CompanyOperationTable.$inferSelect) {
  return Buffer.from(`${row.occurred_at}:${row.id}`).toString("base64url")
}

function refs(row: typeof CompanyOperationTable.$inferSelect) {
  return Ref.parse({
    rootNeedID: row.root_need_id ?? undefined,
    projectID: row.project_id ?? undefined,
    threadID: row.thread_id ?? undefined,
    agentID: row.agent_id ?? undefined,
    runID: row.run_id ?? undefined,
    workItemID: row.work_item_id ?? undefined,
  })
}

function detailRows(row: typeof CompanyOperationTable.$inferSelect, context: z.infer<typeof Context>) {
  return [
    { label: "事件类型", value: safeEventType(row.event_type) },
    { label: "来源", value: row.source_kind },
    context.project ? { label: "工作", value: `${context.project.title} · ${context.project.id}` } : undefined,
    context.workItem ? { label: "工作项", value: `${context.workItem.title} · ${context.workItem.id}` } : undefined,
    context.agent ? { label: "Agent", value: `${context.agent.name} · ${context.agent.id}` } : undefined,
    context.run ? { label: "Run", value: `${context.run.id} · ${statusLabel(context.run.state)}` } : undefined,
  ].filter((entry): entry is { label: string; value: string } => entry !== undefined)
}

function hydrate(rows: (typeof CompanyOperationTable.$inferSelect)[], includeDetails = false) {
  const projectIDs = [...new Set(rows.flatMap((row) => row.project_id ? [row.project_id] : []))]
  const agentIDs = [...new Set(rows.flatMap((row) => row.agent_id ? [row.agent_id] : []))]
  const runIDs = [...new Set(rows.flatMap((row) => row.run_id ? [row.run_id] : []))]
  const workItemIDs = [...new Set(rows.flatMap((row) => row.work_item_id ? [row.work_item_id] : []))]
  const projectEventIDs = rows.filter((row) => row.source_kind === "project_event").map(realSourceID)
  const runEventIDs = rows.filter((row) => row.source_kind === "agent_run_event").map(realSourceID)
  const approvalIDs = rows.filter((row) => row.source_kind === "approval_gate").map(realSourceID)
  const artifactIDs = rows.filter((row) => row.source_kind === "artifact").map(realSourceID)
  const auditIDs = rows.filter((row) => row.source_kind === "audit_event").map(realSourceID)
  const data = Database.use((db) => ({
    projects: projectIDs.length
      ? db.select({ id: CompanyProjectTable.id, title: CompanyProjectTable.title }).from(CompanyProjectTable).where(inArray(CompanyProjectTable.id, projectIDs)).all()
      : [],
    agents: agentIDs.length
      ? db.select({ id: CompanyAgentTable.id, name: CompanyAgentTable.name }).from(CompanyAgentTable).where(inArray(CompanyAgentTable.id, agentIDs)).all()
      : [],
    runs: runIDs.length
      ? db.select({ id: AgentRunTable.id, state: AgentRunTable.state }).from(AgentRunTable).where(inArray(AgentRunTable.id, runIDs)).all()
      : [],
    workItems: workItemIDs.length
      ? db.select({ id: CompanyWorkItemTable.id, title: CompanyWorkItemTable.title }).from(CompanyWorkItemTable).where(inArray(CompanyWorkItemTable.id, workItemIDs)).all()
      : [],
    projectEvents: projectEventIDs.length
      ? db
          .select({
            id: CompanyProjectEventTable.id,
            from: sql<string | null>`CASE WHEN json_valid(${CompanyProjectEventTable.data_json}) THEN json_extract(${CompanyProjectEventTable.data_json}, '$.from') END`,
            to: sql<string | null>`CASE WHEN json_valid(${CompanyProjectEventTable.data_json}) THEN json_extract(${CompanyProjectEventTable.data_json}, '$.to') END`,
            previousStatus: sql<string | null>`CASE WHEN json_valid(${CompanyProjectEventTable.data_json}) THEN json_extract(${CompanyProjectEventTable.data_json}, '$.previous_status') END`,
          })
          .from(CompanyProjectEventTable)
          .where(inArray(CompanyProjectEventTable.id, projectEventIDs))
          .all()
      : [],
    runEvents: runEventIDs.length
      ? db
          .select({
            id: AgentRunEventTable.id,
            inputTokens: sql<number | null>`CASE WHEN json_valid(${AgentRunEventTable.payload_json}) THEN json_extract(${AgentRunEventTable.payload_json}, '$.inputTokens') END`,
            outputTokens: sql<number | null>`CASE WHEN json_valid(${AgentRunEventTable.payload_json}) THEN json_extract(${AgentRunEventTable.payload_json}, '$.outputTokens') END`,
            reasoningTokens: sql<number | null>`CASE WHEN json_valid(${AgentRunEventTable.payload_json}) THEN json_extract(${AgentRunEventTable.payload_json}, '$.reasoningTokens') END`,
            cacheReadTokens: sql<number | null>`CASE WHEN json_valid(${AgentRunEventTable.payload_json}) THEN json_extract(${AgentRunEventTable.payload_json}, '$.cacheReadTokens') END`,
            cacheWriteTokens: sql<number | null>`CASE WHEN json_valid(${AgentRunEventTable.payload_json}) THEN json_extract(${AgentRunEventTable.payload_json}, '$.cacheWriteTokens') END`,
          })
          .from(AgentRunEventTable)
          .where(inArray(AgentRunEventTable.id, runEventIDs))
          .all()
      : [],
    approvals: approvalIDs.length
      ? db.select({ id: CompanyApprovalGateTable.id, title: CompanyApprovalGateTable.title }).from(CompanyApprovalGateTable).where(inArray(CompanyApprovalGateTable.id, approvalIDs)).all()
      : [],
    artifacts: artifactIDs.length
      ? db.select({ id: CompanyArtifactTable.id, title: CompanyArtifactTable.title, kind: CompanyArtifactTable.kind }).from(CompanyArtifactTable).where(inArray(CompanyArtifactTable.id, artifactIDs)).all()
      : [],
    audits: auditIDs.length
      ? db.select({ id: AuditEventTable.id, kind: AuditEventTable.kind, granted: AuditEventTable.granted }).from(AuditEventTable).where(inArray(AuditEventTable.id, auditIDs)).all()
      : [],
  }))
  const projects = new Map(data.projects.map((row) => [row.id, row]))
  const agents = new Map(data.agents.map((row) => [row.id, row]))
  const runs = new Map(data.runs.map((row) => [row.id, row]))
  const workItems = new Map(data.workItems.map((row) => [row.id, row]))
  const projectEvents = new Map(data.projectEvents.map((row) => [row.id, row]))
  const runEvents = new Map(data.runEvents.map((row) => [row.id, row]))
  const approvals = new Map(data.approvals.map((row) => [row.id, row]))
  const artifacts = new Map(data.artifacts.map((row) => [row.id, row]))
  const audits = new Map(data.audits.map((row) => [row.id, row]))

  return rows.map((row) => {
    const project = row.project_id ? projects.get(row.project_id) : undefined
    const agent = row.agent_id ? agents.get(row.agent_id) : undefined
    const run = row.run_id ? runs.get(row.run_id) : undefined
    const workItem = row.work_item_id ? workItems.get(row.work_item_id) : undefined
    const context = Context.parse({ project, agent, run, workItem })
    const sourceID = realSourceID(row)
    const projectEvent = row.source_kind === "project_event" ? projectEvents.get(sourceID) : undefined
    const runEvent = row.source_kind === "agent_run_event" ? runEvents.get(sourceID) : undefined
    const approval = row.source_kind === "approval_gate" ? approvals.get(sourceID) : undefined
    const artifact = row.source_kind === "artifact" ? artifacts.get(sourceID) : undefined
    const audit = row.source_kind === "audit_event" ? audits.get(sourceID) : undefined
    const transition = projectEvent?.from && projectEvent.to
      ? `${statusLabel(projectEvent.from)} → ${statusLabel(projectEvent.to)}`
      : projectEvent?.previousStatus
        ? `此前状态：${statusLabel(projectEvent.previousStatus)}`
        : undefined
    const usage = row.event_type === "usage.recorded" && runEvent
      ? [
          runEvent.inputTokens !== null ? `输入 ${runEvent.inputTokens}` : undefined,
          runEvent.outputTokens !== null ? `输出 ${runEvent.outputTokens}` : undefined,
          runEvent.reasoningTokens !== null ? `推理 ${runEvent.reasoningTokens}` : undefined,
          runEvent.cacheReadTokens !== null ? `缓存读取 ${runEvent.cacheReadTokens}` : undefined,
          runEvent.cacheWriteTokens !== null ? `缓存写入 ${runEvent.cacheWriteTokens}` : undefined,
        ].filter((value): value is string => value !== undefined).join(" · ") + " tokens"
      : undefined
    const summary = (row.event_type === "project.status_changed" ? transition : undefined)
      ?? usage
      ?? (approval && row.event_type.startsWith("approval.") ? `${approval.title} · ${statusLabel(row.event_type.slice("approval.".length))}` : undefined)
      ?? (artifact ? `${artifact.title} · ${artifact.kind}` : undefined)
      ?? (audit ? `${audit.kind} · ${audit.granted === false ? "未授权" : audit.granted === true ? "已授权" : "已记录"}` : undefined)
      ?? (workItem ? workItem.title : project?.title)
    return Item.parse({
      id: row.id,
      category: row.category,
      severity: row.severity,
      importance: row.importance,
      eventType: safeEventType(row.event_type),
      title: title(row.event_type),
      summary,
      occurredAt: row.occurred_at,
      source: { kind: row.source_kind, id: realSourceID(row) },
      refs: refs(row),
      context,
      href: row.project_id ? `/work/${encodeURIComponent(row.project_id)}` : "/company",
      details: includeDetails ? detailRows(row, context) : undefined,
    })
  })
}

export function list(input: Query): Page {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
  const conditions = [
    eq(CompanyOperationTable.company_id, input.company_id),
    input.category ? eq(CompanyOperationTable.category, input.category) : undefined,
    input.severity ? eq(CompanyOperationTable.severity, input.severity) : undefined,
    input.importance ? eq(CompanyOperationTable.importance, input.importance) : undefined,
    input.project_id ? eq(CompanyOperationTable.project_id, input.project_id) : undefined,
    input.agent_id ? eq(CompanyOperationTable.agent_id, input.agent_id) : undefined,
    input.from !== undefined ? gte(CompanyOperationTable.occurred_at, input.from) : undefined,
    input.to !== undefined ? lte(CompanyOperationTable.occurred_at, input.to) : undefined,
    cursor
      ? or(
          lt(CompanyOperationTable.occurred_at, cursor.occurredAt),
          and(eq(CompanyOperationTable.occurred_at, cursor.occurredAt), lt(CompanyOperationTable.id, cursor.id)),
        )
      : undefined,
  ].filter((condition) => condition !== undefined)
  const rows = Database.use((db) =>
    db
      .select()
      .from(CompanyOperationTable)
      .where(and(...conditions))
      .orderBy(desc(CompanyOperationTable.occurred_at), desc(CompanyOperationTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  const visible = rows.slice(0, input.limit)
  return Page.parse({
    items: hydrate(visible),
    nextCursor: rows.length > input.limit && visible.length ? encodeCursor(visible.at(-1)!) : undefined,
  })
}

export function summary(input: SummaryQuery): z.infer<typeof Summary> {
  const row = Database.use((db) =>
    db
      .select({
        total24h: sql<number>`count(*)`,
        errors24h: sql<number>`coalesce(sum(case when ${CompanyOperationTable.severity} = 'error' then 1 else 0 end), 0)`,
        warnings24h: sql<number>`coalesce(sum(case when ${CompanyOperationTable.severity} = 'warning' then 1 else 0 end), 0)`,
        recoveries24h: sql<number>`coalesce(sum(case when ${CompanyOperationTable.event_type} like '%recovered%' or ${CompanyOperationTable.event_type} = 'lifecycle.completed' then 1 else 0 end), 0)`,
      })
      .from(CompanyOperationTable)
      .where(and(eq(CompanyOperationTable.company_id, input.company_id), gte(CompanyOperationTable.occurred_at, Date.now() - 24 * 60 * 60 * 1_000)))
      .get(),
  )
  return Summary.parse(row ?? { total24h: 0, errors24h: 0, warnings24h: 0, recoveries24h: 0 })
}

export function get(companyID: z.infer<typeof CompanyID>, operationID: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(CompanyOperationTable)
      .where(and(eq(CompanyOperationTable.company_id, companyID), eq(CompanyOperationTable.id, operationID)))
      .get(),
  )
  return row ? hydrate([row], true)[0] : undefined
}
