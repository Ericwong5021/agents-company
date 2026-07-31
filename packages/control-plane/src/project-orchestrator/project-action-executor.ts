import { Cause, Context, Effect, Exit, Layer, Semaphore } from "effect"
import { and, asc, eq, inArray, ne } from "drizzle-orm"
import z from "zod"
import { AgentRun } from "@/agent-run/agent-run"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { CompanyRecruitment } from "@/company-recruitment"
import {
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "@/company-recruitment/company-recruitment.sql"
import { CompanyID } from "@/company/schema"
import * as CompanyAttention from "@/company-project/attention"
import { CompanyProject } from "@/company-project/company-project"
import * as CompanyProjectDirection from "@/company-project/direction"
import { goalBriefCharter } from "@/goal-brief/project-charter"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorktreeRunTable,
} from "@/company-project/company-project.sql"
import {
  ProjectActionRequest,
  type ProjectActionRecord as ProjectActionRecordValue,
  type ProjectActionRequest as ProjectActionRequestValue,
} from "@/company-project/schema"
import { ChannelTable, Conversation } from "@/conversation"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { WorkflowRuntime } from "@/workflow/runtime"
import { DispatchCoordinator } from "./dispatch"
import { authorizeDiscoveryBuilder } from "./seed-team"

const RuntimeAction = z.enum([
  "pause_work",
  "resume_work",
  "stop_work",
  "retry",
  "resolve_blocker",
  "adjust_brief",
  "accept_delivery",
  "request_change",
  "archive",
  "restore",
  "apply_founder_direction",
  "restore_direction_checkpoint",
])
type RuntimeAction = z.infer<typeof RuntimeAction>

const ReasonPayload = z
  .object({
    reason: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict()

const RetryPayload = ReasonPayload.extend({
  work_item_ids: z.array(z.string().trim().min(1)).max(500).optional(),
}).strict()

const AcceptDeliveryPayload = z
  .object({
    delivery_id: z.string().trim().min(1),
    accepted_criterion_ids: z.array(z.string().trim().min(1)).min(1).max(200),
    note: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict()

const RequestChangePayload = z
  .object({
    delivery_id: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(8_000),
  })
  .strict()

const ArchivePayload = z.object({}).strict()
const RestorePayload = z.object({}).strict()

const ResolveBlockerPayload = z
  .object({
    resolution: z.string().trim().min(1).max(8_000),
    approval_gate_id: z.string().trim().min(1).optional(),
    decision: z.enum(["approve", "reject"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.approval_gate_id && !value.decision)
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Approval Gate resolution requires a decision",
      })
    if (!value.approval_gate_id && value.decision)
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "A decision is only valid for an Approval Gate",
      })
  })

export type Boundary = "after_request" | "after_claim" | "after_effect" | "after_apply"

export type Hooks = {
  onBoundary?: (boundary: Boundary, action: ProjectActionRecordValue) => void
}

export type ExecutionResult = {
  action: ProjectActionRecordValue
  replayed: boolean
}

export type RecoveryReport = {
  idempotency_key: string
  project_ids: string[]
  assignment_ids: string[]
  attention_ids: string[]
  action_ids: string[]
  applied_action_ids: string[]
  rejected_action_ids: string[]
  replayed: boolean
}

type StopEffectKind = "dispatch_pause" | "workflow_cancel" | "agent_supervisor_stop" | "agent_run_transition"

class StopRecoveryRequired extends Error {}

export interface Interface {
  readonly execute: (input: ProjectActionRequestValue) => Effect.Effect<ExecutionResult>
  readonly recover: () => Effect.Effect<RecoveryReport>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ProjectActionExecutor") {}

function eventData(row: typeof CompanyProjectEventTable.$inferSelect) {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(row.data_json))
}

function event(
  db: Database.TxOrDb,
  project_id: string,
  type: string,
  data: Record<string, unknown>,
  actor_id: string | null = "user",
) {
  const id = Identifier.ascending("event")
  db.insert(CompanyProjectEventTable)
    .values({
      id,
      project_id,
      type,
      actor_id,
      data_json: JSON.stringify(data),
      created_at: Date.now(),
    })
    .run()
  return id
}

function actionEffectResultWithDatabase(db: Database.TxOrDb, action_id: string) {
  const row = db
    .select()
    .from(CompanyProjectEventTable)
    .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
    .all()
    .find((candidate) => {
      if (candidate.type !== "project_action.effect_applied") return false
      return eventData(candidate).action_id === action_id
    })
  return row ? z.record(z.string(), z.unknown()).parse(eventData(row).result) : undefined
}

function actionEffectResult(action_id: string) {
  return Database.use((db) => actionEffectResultWithDatabase(db, action_id))
}

const revisionReferences = (value: string) =>
  new Set([...value.matchAll(/D(?:10|[1-9])/gi)].map((match) => match[0]!.toUpperCase()))

const revisionTopicRules = [
  /预算|金额|小计|总计|结余|预备金|单价|成本|报价|budget|subtotal|total|cost/i,
  /参与者|家庭|人群|需求|participant|audience/i,
  /流程|时段|时间轴|签到|排队|schedule|timeline/i,
  /职责|岗位|志愿者|替补|交接|role|staff/i,
  /风险|剪针|儿童|拥挤|卫生|火灾|用电|risk|safety/i,
  /Go\/No-Go|放行|停止判断|检查清单|checklist/i,
  /假设|待确认|法规|场地规则|供应商|assumption/i,
  /报名|采购|付款|外部联系|发布|external action/i,
  /最终成果|活动包|交付版本|验收映射|可打开|final artifact|delivery/i,
]

function revisionWorkItemIDs(input: {
  reason: string
  delivery_work_item_ids: string[]
  work_items: (typeof CompanyWorkItemTable.$inferSelect)[]
  dependencies: (typeof CompanyWorkItemDependencyTable.$inferSelect)[]
}) {
  const delivered = new Set(input.delivery_work_item_ids)
  const deliveryItems = input.work_items.filter((item) => delivered.has(item.id))
  const requestedReferences = revisionReferences(input.reason)
  let roots = requestedReferences.size
    ? deliveryItems.filter((item) => {
        const references = revisionReferences(
          `${item.title}\n${item.description}\n${item.acceptance_criteria_json}`,
        )
        return [...requestedReferences].some((reference) => references.has(reference))
      })
    : []
  if (!roots.length) {
    const topics = revisionTopicRules.filter((pattern) => pattern.test(input.reason))
    if (topics.length)
      roots = deliveryItems.filter((item) => {
        const text = `${item.title}\n${item.description}\n${item.acceptance_criteria_json}`
        return topics.some((pattern) => pattern.test(text))
      })
  }
  if (!roots.length) roots = deliveryItems
  const selected = new Set(roots.map((item) => item.id))
  let changed = true
  while (changed) {
    changed = false
    input.work_items
      .filter(
        (item) =>
          item.kind === "reviewer" &&
          item.parent_id &&
          selected.has(item.parent_id) &&
          !["superseded", "cancelled"].includes(item.status),
      )
      .forEach((item) => {
        if (selected.has(item.id)) return
        selected.add(item.id)
        changed = true
      })
    input.dependencies.forEach((dependency) => {
      if (!selected.has(dependency.depends_on_id) || selected.has(dependency.work_item_id)) return
      const item = input.work_items.find((candidate) => candidate.id === dependency.work_item_id)
      if (!item || !["worker", "reviewer"].includes(item.kind) || ["superseded", "cancelled"].includes(item.status))
        return
      selected.add(item.id)
      changed = true
    })
  }
  return input.work_items.filter((item) => selected.has(item.id)).map((item) => item.id)
}

function stopEffectAppliedWithDatabase(
  db: Database.TxOrDb,
  action: ProjectActionRecordValue,
  kind: StopEffectKind,
  target_id: string,
) {
  return db
    .select()
    .from(CompanyProjectEventTable)
    .where(
      and(
        eq(CompanyProjectEventTable.project_id, action.project_id),
        eq(CompanyProjectEventTable.type, "project_action.effect_step_applied"),
      ),
    )
    .all()
    .some((candidate) => {
      const data = eventData(candidate)
      return data.action_id === action.id && data.kind === kind && data.target_id === target_id
    })
}

function stopEffectApplied(action: ProjectActionRecordValue, kind: StopEffectKind, target_id: string) {
  return Database.use((db) => stopEffectAppliedWithDatabase(db, action, kind, target_id))
}

function saveStopEffect(action: ProjectActionRecordValue, kind: StopEffectKind, target_id: string) {
  return Database.transaction(
    (db) => {
      if (stopEffectAppliedWithDatabase(db, action, kind, target_id)) return
      event(db, action.project_id, "project_action.effect_step_applied", {
        action_id: action.id,
        kind,
        target_id,
      })
    },
    { behavior: "immediate" },
  )
}

function retainStopForRecovery(action: ProjectActionRecordValue, error: string) {
  return Database.transaction(
    (db) => {
      const current = db
        .select()
        .from(CompanyProjectActionTable)
        .where(eq(CompanyProjectActionTable.id, action.id))
        .get()
      if (!current) throw new Error(`Project action not found: ${action.id}`)
      if (current.status !== "claimed") return CompanyAttention.actionFromRow(current)
      event(db, action.project_id, "project_action.retry_scheduled", {
        action_id: action.id,
        error,
      })
      return CompanyAttention.actionFromRow(current)
    },
    { behavior: "immediate" },
  )
}

function assertRevision(action: ProjectActionRecordValue) {
  const project = Database.use((db) =>
    db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, action.project_id)).get(),
  )
  if (!project) throw new Error(`Company project not found: ${action.project_id}`)
  if (action.expected_revision !== undefined && action.expected_revision !== project.graph_revision)
    throw new Error(`project_revision_conflict:${action.expected_revision}:${project.graph_revision}`)
  return project
}

function safeProjectActionError(error: string) {
  if (/no_retryable_work_items|has no retryable work items/i.test(error))
    return "当前没有可重试的工作项，请刷新后使用页面提供的可用操作。"
  if (/project_revision_conflict/i.test(error))
    return "工作状态已更新，本次操作未执行。请刷新后按最新状态重试。"
  if (/(?:^|\n)\s*at\s|\/(?:Users|home|private|Volumes)\/|[A-Za-z]:\\/i.test(error))
    return "当前操作遇到内部错误，业务状态已保留。请刷新后重试。"
  return error
    .split(/\r?\n/, 1)[0]!
    .replace(/^(?:Error|RuntimeException):\s*/i, "")
    .slice(0, 800)
}

function saveEffectResult(db: Database.TxOrDb, action: ProjectActionRecordValue, result: Record<string, unknown>) {
  event(db, action.project_id, "project_action.effect_applied", {
    action_id: action.id,
    action: action.action,
    result,
  })
}

function reconcileAssignments() {
  return Database.transaction(
    (db) => {
      const recovered: string[] = []
      db.select()
        .from(CompanyProjectAssignmentTable)
        .orderBy(asc(CompanyProjectAssignmentTable.assigned_at), asc(CompanyProjectAssignmentTable.id))
        .all()
        .filter((assignment) => assignment.status === "assigned" || assignment.status === "active")
        .forEach((assignment) => {
          const item = db
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.id, assignment.work_item_id))
            .get()
          if (!item) return
          const next =
            item.status === "running"
              ? "active"
              : ["completed", "superseded", "cancelled"].includes(item.status)
                ? "released"
                : "assigned"
          if (next === assignment.status) return
          const now = Date.now()
          db.update(CompanyProjectAssignmentTable)
            .set({
              status: next,
              started_at: next === "active" ? (assignment.started_at ?? now) : assignment.started_at,
              released_at: next === "released" ? now : null,
              release_reason: next === "released" ? "work_item_terminal" : null,
            })
            .where(eq(CompanyProjectAssignmentTable.id, assignment.id))
            .run()
          event(
            db,
            assignment.project_id,
            "project_assignment.recovered",
            {
              assignment_id: assignment.id,
              work_item_id: assignment.work_item_id,
              from: assignment.status,
              to: next,
            },
            null,
          )
          recovered.push(assignment.id)
        })
      return recovered
    },
    { behavior: "immediate" },
  )
}

function resolveInternalAttention() {
  return Database.transaction(
    (db) => {
      const resolved: string[] = []
      db.select()
        .from(CompanyAttentionTable)
        .where(eq(CompanyAttentionTable.status, "open"))
        .orderBy(asc(CompanyAttentionTable.created_at), asc(CompanyAttentionTable.id))
        .all()
        .filter(
          (attention) =>
            !attention.material && attention.materiality === "internal" && attention.route === "automatic_recovery",
        )
        .forEach((attention) => {
          const now = Date.now()
          db.update(CompanyAttentionTable)
            .set({
              status: "resolved",
              resolution: "automatic_recovery_reconciled",
              version: attention.version + 1,
              updated_at: now,
              resolved_at: now,
            })
            .where(and(eq(CompanyAttentionTable.id, attention.id), eq(CompanyAttentionTable.status, "open")))
            .run()
          event(
            db,
            attention.project_id,
            "attention.closed",
            {
              attention_id: attention.id,
              version: attention.version + 1,
              resolution: "automatic_recovery_reconciled",
            },
            null,
          )
          resolved.push(attention.id)
        })
      return resolved
    },
    { behavior: "immediate" },
  )
}

function stopPlan(action: ProjectActionRecordValue) {
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.project_id, action.project_id))
        .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
        .all()
        .find((candidate) => {
          if (candidate.type !== "project_action.effect_planned") return false
          return eventData(candidate).action_id === action.id
        })
      if (existing)
        return z
          .object({
            work_item_ids: z.array(z.string()),
            attempt_ids: z.array(z.string()),
            workflow_run_ids: z.array(z.string()),
            agent_run_ids: z.array(z.string()),
          })
          .parse(eventData(existing).plan)
      const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, action.project_id)).get()
      if (!project) throw new Error(`Company project not found: ${action.project_id}`)
      if (action.expected_revision !== undefined && action.expected_revision !== project.graph_revision)
        throw new Error(`project_revision_conflict:${action.expected_revision}:${project.graph_revision}`)
      const work_item_ids = db
        .select()
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.project_id, action.project_id))
        .all()
        .filter((item) => ["pending", "running", "blocked", "failed"].includes(item.status))
        .map((item) => item.id)
        .sort()
      const attempts = db
        .select()
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.project_id, action.project_id))
        .all()
        .filter((attempt) => attempt.status === "running")
      const workflow_run_ids = [
        ...new Set([
          ...(project.active_run_id ? [project.active_run_id] : []),
          ...db
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.project_id, action.project_id))
            .all()
            .filter((item) => work_item_ids.includes(item.id) && item.workflow_run_id)
            .map((item) => item.workflow_run_id!),
        ]),
      ].sort()
      const plan = {
        work_item_ids,
        attempt_ids: attempts.map((attempt) => attempt.id).sort(),
        workflow_run_ids,
        agent_run_ids: db
          .select()
          .from(AgentRunTable)
          .where(eq(AgentRunTable.company_project_id, action.project_id))
          .all()
          .filter((run) => ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state))
          .map((run) => run.id)
          .sort(),
      }
      event(db, action.project_id, "project_action.effect_planned", {
        action_id: action.id,
        action: action.action,
        plan,
      })
      return plan
    },
    { behavior: "immediate" },
  )
}

export function makeLayer(hooks: Hooks = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const attention = yield* CompanyAttention.Service
      const dispatch = yield* DispatchCoordinator.Service
      const workflow = yield* WorkflowRuntime.Service
      const agentRuns = yield* AgentRun.Service
      const agentSupervisor = yield* AgentRunSupervisor.Service
      const conversation = yield* Conversation.Service
      const locks = new Map<string, Semaphore.Semaphore>()
      const lock = (project_id: string) => {
        const current = locks.get(project_id)
        if (current) return current
        const created = Semaphore.makeUnsafe(1)
        locks.set(project_id, created)
        return created
      }

      const recordActionUpdate = Effect.fn("ProjectActionExecutor.recordActionUpdate")(function* (input: {
        action: ProjectActionRecordValue
        body: string
        signalType: "status" | "intervention"
      }) {
        const project = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, input.action.project_id)).get(),
          ),
        )
        if (!project?.company_id) return
        yield* conversation.recordProjectUpdate({
          companyID: CompanyID.parse(project.company_id),
          projectScopeID: project.id,
          requestID: `project-control:${input.action.id}`,
          author: { kind: "user", id: "local_user" },
          body: input.body,
          signalType: input.signalType,
        }).pipe(Effect.catchCause(() => Effect.void))
      })

      const actionUpdate = (action: ProjectActionRecordValue) => {
        if (action.action === "pause_work") {
          const payload = ReasonPayload.parse(action.payload)
          return {
            body: [
              "已暂停新任务派发。已在运行的工作会继续到安全停点；调整方向时，系统会先安全停止在途工作。",
              payload.reason ? `说明：${payload.reason}` : undefined,
            ].filter(Boolean).join("\n"),
            signalType: "intervention" as const,
          }
        }
        if (action.action === "resume_work") {
          const payload = ReasonPayload.parse(action.payload)
          return {
            body: ["已恢复新任务派发。", payload.reason ? `说明：${payload.reason}` : undefined]
              .filter(Boolean)
              .join("\n"),
            signalType: "status" as const,
          }
        }
        if (action.action === "stop_work") {
          const payload = ReasonPayload.parse(action.payload)
          return {
            body: ["已停止项目执行；现有目标、记录与成果仍保留。", payload.reason ? `说明：${payload.reason}` : undefined]
              .filter(Boolean)
              .join("\n"),
            signalType: "intervention" as const,
          }
        }
        if (action.action === "retry") {
          const payload = RetryPayload.parse(action.payload)
          return {
            body: ["已请求恢复受阻工作并重新执行。", payload.reason ? `说明：${payload.reason}` : undefined]
              .filter(Boolean)
              .join("\n"),
            signalType: "intervention" as const,
          }
        }
        if (action.action === "resolve_blocker") {
          const payload = ResolveBlockerPayload.parse(action.payload)
          return {
            body: `已处理项目阻塞：${payload.resolution}`,
            signalType: "intervention" as const,
          }
        }
      }

      const dispatchReady = Effect.fn("ProjectActionExecutor.dispatchReady")(function* (
        action: ProjectActionRecordValue,
      ) {
        const outcome = yield* Effect.exit(dispatch.dispatchReady(action.project_id))
        if (Exit.isSuccess(outcome)) return
        yield* Effect.sync(() =>
          Database.transaction(
            (db) =>
              event(
                db,
                action.project_id,
                "project_action.dispatch_failed",
                {
                  action_id: action.id,
                  action: action.action,
                  error: safeProjectActionError(Cause.pretty(outcome.cause)),
                },
                null,
              ),
            { behavior: "immediate" },
          ),
        )
      })

      const authorizeBuilder = (project_id: string, work_item_id: string) =>
        Effect.gen(function* () {
          const projects = yield* CompanyProject.Service
          const recruitment = yield* CompanyRecruitment.Service
          const project = yield* projects.get(project_id)
          if (!project) return
          if (
            project.execution_strategy !== "seed_and_grow" ||
            project.seed_mode !== "discovery_first" ||
            (yield* projects.listWorkItems(project_id)).find((item) => item.id === work_item_id)?.purpose !==
              "first_slice"
          )
            return
          const builder = yield* authorizeDiscoveryBuilder({ project, projects, recruitment, work_item_id })
          if (!builder) return
          return (yield* recruitment.listAssignments({
            project_id,
            work_item_id: builder.id,
          })).findLast((assignment) => assignment.status === "assigned" || assignment.status === "active")?.id
        }).pipe(Effect.provide(CompanyProject.defaultLayer), Effect.provide(CompanyRecruitment.defaultLayer))

      const blockBuilderRecruitment = Effect.fn("ProjectActionExecutor.blockBuilderRecruitment")(function* (input: {
        project_id: string
        gate_id: string
        work_item_id: string
        error: string
      }) {
        yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              db.update(CompanyProjectTable)
                .set({ status: "blocked", orchestration_state: "blocked", updated_at: Date.now() })
                .where(eq(CompanyProjectTable.id, input.project_id))
                .run()
              event(db, input.project_id, "project.builder_recruitment_blocked", {
                gate_id: input.gate_id,
                work_item_id: input.work_item_id,
                error: input.error,
              })
            },
            { behavior: "immediate" },
          ),
        )
        yield* attention.create({
          project_id: input.project_id,
          idempotency_key: `builder-recruitment:${input.gate_id}`,
          issue: {
            issue_kind: "capability_gap",
            risk: "high",
            materiality: "internal",
          },
          title: "First Slice Builder 招募失败",
          summary: `ApprovalGate ${input.gate_id} 已批准，但 WorkItem ${input.work_item_id} 无法建立 Builder Assignment。`,
          source_refs: [
            { kind: "approval_gate", id: input.gate_id },
            { kind: "work_item", id: input.work_item_id },
          ],
        })
      })

      const adjustDirection = (input: CompanyProjectDirection.AdjustDirectionRequest) =>
        Effect.gen(function* () {
          const direction = yield* CompanyProjectDirection.Service
          return yield* direction.adjust(input)
        }).pipe(Effect.provide(CompanyProjectDirection.defaultLayer))

      const quiesceDirection = (action: ProjectActionRecordValue) =>
        Effect.gen(function* () {
          const project = yield* Effect.sync(() =>
            Database.use((db) =>
              db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, action.project_id)).get(),
            ),
          )
          if (!project?.dispatch_paused) return
          const runningItems = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(CompanyWorkItemTable)
                .where(eq(CompanyWorkItemTable.project_id, action.project_id))
                .all()
                .filter((item) => item.status === "running"),
            ),
          )
          const workflowRunIDs = [
            ...new Set(runningItems.flatMap((item) => item.workflow_run_id ? [item.workflow_run_id] : [])),
          ]
          const activeAgentRunIDs = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(AgentRunTable)
                .where(eq(AgentRunTable.company_project_id, action.project_id))
                .all()
                .filter((run) =>
                  ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state),
                )
                .map((run) => run.id),
            ),
          )
          yield* Effect.forEach(
            workflowRunIDs,
            (runID) => workflow.cancel({ runID }),
            { concurrency: 1, discard: true },
          )
          yield* Effect.forEach(
            activeAgentRunIDs,
            (runID) =>
              Effect.gen(function* () {
                yield* agentSupervisor.stop(runID).pipe(Effect.ignore)
                const current = yield* agentRuns.get(runID)
                if (
                  current &&
                  ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(current.state)
                )
                  yield* agentRuns.transition({ id: runID, state: "stopped", exitCode: 130 })
              }),
            { concurrency: 1, discard: true },
          )
          const projects = yield* CompanyProject.Service
          const remainingRunning = (yield* projects.listWorkItems(action.project_id)).filter(
            (item) => item.status === "running",
          )
          yield* Effect.forEach(
            remainingRunning,
            (item) => projects.blockWorkItem({ id: item.id, error: "方向调整前已安全暂停在途工作" }),
            { concurrency: 1, discard: true },
          )
        }).pipe(Effect.provide(CompanyProject.defaultLayer))

      const restoreDirectionCheckpoint = (
        input: CompanyProjectDirection.RestoreDirectionCheckpointRequest,
      ) =>
        Effect.gen(function* () {
          const direction = yield* CompanyProjectDirection.Service
          return yield* direction.restoreCheckpoint(input)
        }).pipe(Effect.provide(CompanyProjectDirection.defaultLayer))

      const applyFounderDirection = (
        input: CompanyProjectDirection.ApplyFounderDirectionRequest,
      ) =>
        Effect.gen(function* () {
          const direction = yield* CompanyProjectDirection.Service
          return yield* direction.applyFounderDirection(input)
        }).pipe(Effect.provide(CompanyProjectDirection.defaultLayer))

      const pause = Effect.fn("ProjectActionExecutor.pause")(function* (action: ProjectActionRecordValue) {
        const existing = actionEffectResult(action.id)
        if (existing) return existing
        const payload = ReasonPayload.parse(action.payload)
        const reason = payload.reason ?? "用户暂停执行"
        const barrier = yield* dispatch.pauseDispatch(action.project_id, reason)
        const result = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const replayed = actionEffectResultWithDatabase(db, action.id)
              if (replayed) return replayed
              const result = {
                barrier: barrier.barrier,
                barrier_changed: barrier.barrier_changed,
                barrier_event_id: barrier.barrier_event_id,
                reason,
              }
              event(db, action.project_id, "work.paused", {
                action_id: action.id,
                reason,
              })
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
        return result
      })

      const resume = Effect.fn("ProjectActionExecutor.resume")(function* (action: ProjectActionRecordValue) {
        const existing = actionEffectResult(action.id)
        if (existing) return existing
        const payload = ReasonPayload.parse(action.payload)
        const reason = payload.reason ?? "用户恢复执行"
        const barrier = yield* dispatch.resumeDispatch(action.project_id, reason)
        return yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const replayed = actionEffectResultWithDatabase(db, action.id)
              if (replayed) return replayed
              const result = {
                barrier: barrier.barrier,
                barrier_changed: barrier.barrier_changed,
                barrier_event_id: barrier.barrier_event_id,
                reason,
              }
              event(db, action.project_id, "work.resumed", {
                action_id: action.id,
                reason,
              })
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
      })

      const stop = Effect.fn("ProjectActionExecutor.stop")(function* (action: ProjectActionRecordValue) {
        const existing = actionEffectResult(action.id)
        if (existing) return existing
        const payload = ReasonPayload.parse(action.payload)
        const reason = payload.reason ?? "用户停止执行"
        const plan = yield* Effect.sync(() => stopPlan(action))
        const external = yield* Effect.exit(
          Effect.gen(function* () {
            if (!stopEffectApplied(action, "dispatch_pause", action.project_id)) {
              yield* dispatch.pauseDispatch(action.project_id, reason)
              yield* Effect.sync(() => saveStopEffect(action, "dispatch_pause", action.project_id))
            }
            yield* Effect.forEach(
              plan.workflow_run_ids,
              (runID) =>
                Effect.gen(function* () {
                  if (stopEffectApplied(action, "workflow_cancel", runID)) return
                  yield* workflow.cancel({ runID })
                  yield* Effect.sync(() => saveStopEffect(action, "workflow_cancel", runID))
                }),
              {
                concurrency: 1,
                discard: true,
              },
            )
            yield* Effect.forEach(
              plan.agent_run_ids,
              (runID) =>
                Effect.gen(function* () {
                  if (!stopEffectApplied(action, "agent_supervisor_stop", runID)) {
                    yield* agentSupervisor.stop(runID)
                    yield* Effect.sync(() => saveStopEffect(action, "agent_supervisor_stop", runID))
                  }
                  if (stopEffectApplied(action, "agent_run_transition", runID)) return
                  const current = yield* agentRuns.get(runID)
                  if (
                    current &&
                    ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(current.state)
                  )
                    yield* agentRuns.transition({ id: runID, state: "stopped", exitCode: 130 })
                  yield* Effect.sync(() => saveStopEffect(action, "agent_run_transition", runID))
                }),
              { concurrency: 1, discard: true },
            )
          }),
        )
        if (Exit.isFailure(external)) return yield* Effect.fail(new StopRecoveryRequired(Cause.pretty(external.cause)))
        const finalize = Effect.sync(() =>
          Database.transaction(
            (db) => {
              const replayed = actionEffectResultWithDatabase(db, action.id)
              if (replayed) return replayed
              const project = db
                .select()
                .from(CompanyProjectTable)
                .where(eq(CompanyProjectTable.id, action.project_id))
                .get()
              if (!project) throw new Error(`Company project not found: ${action.project_id}`)
              const items = plan.work_item_ids.length
                ? db
                    .select()
                    .from(CompanyWorkItemTable)
                    .where(inArray(CompanyWorkItemTable.id, plan.work_item_ids))
                    .all()
                    .filter((item) => ["pending", "running", "blocked", "failed"].includes(item.status))
                : []
              const attempts = plan.attempt_ids.length
                ? db
                    .select()
                    .from(CompanyWorkAttemptTable)
                    .where(inArray(CompanyWorkAttemptTable.id, plan.attempt_ids))
                    .all()
                    .filter((attempt) => attempt.status === "running")
                : []
              const now = Date.now()
              if (items.length)
                db.update(CompanyWorkItemTable)
                  .set({
                    status: "cancelled",
                    error: reason,
                    workflow_run_id: null,
                    completed_at: null,
                    updated_at: now,
                  })
                  .where(
                    inArray(
                      CompanyWorkItemTable.id,
                      items.map((item) => item.id),
                    ),
                  )
                  .run()
              if (attempts.length)
                db.update(CompanyWorkAttemptTable)
                  .set({
                    status: "stopped",
                    failure_kind: "environment",
                    safe_summary: reason,
                    finished_at: now,
                  })
                  .where(
                    inArray(
                      CompanyWorkAttemptTable.id,
                      attempts.map((attempt) => attempt.id),
                    ),
                  )
                  .run()
              const assignments = items.length
                ? db
                    .select()
                    .from(CompanyProjectAssignmentTable)
                    .where(
                      inArray(
                        CompanyProjectAssignmentTable.work_item_id,
                        items.map((item) => item.id),
                      ),
                    )
                    .all()
                    .filter((assignment) => assignment.status === "assigned" || assignment.status === "active")
                : []
              assignments.forEach((assignment) => {
                db.update(CompanyProjectAssignmentTable)
                  .set({
                    status: "released",
                    released_at: now,
                    release_reason: "project_stopped",
                  })
                  .where(eq(CompanyProjectAssignmentTable.id, assignment.id))
                  .run()
                event(
                  db,
                  action.project_id,
                  "project_assignment.released",
                  {
                    assignment_id: assignment.id,
                    work_item_id: assignment.work_item_id,
                    reason: "project_stopped",
                  },
                  null,
                )
              })
              items.forEach((item) =>
                event(
                  db,
                  action.project_id,
                  "work_item.cancelled",
                  {
                    work_item_id: item.id,
                    previous_status: item.status,
                    action_id: action.id,
                    error: reason,
                  },
                  null,
                ),
              )
              attempts.forEach((attempt) =>
                event(
                  db,
                  action.project_id,
                  "work_attempt.stopped",
                  {
                    attempt_id: attempt.id,
                    work_item_id: attempt.work_item_id,
                    action_id: action.id,
                    reason,
                  },
                  null,
                ),
              )
              const nextStatus = ["completed", "rejected"].includes(project.status) ? project.status : "blocked"
              db.update(CompanyProjectTable)
                .set({
                  status: nextStatus,
                  active_run_id: null,
                  dispatch_paused: true,
                  orchestration_state: "paused",
                  updated_at: now,
                })
                .where(eq(CompanyProjectTable.id, action.project_id))
                .run()
              if (project.status !== nextStatus)
                event(
                  db,
                  action.project_id,
                  "project.status_changed",
                  {
                    from: project.status,
                    to: nextStatus,
                    reason,
                    action_id: action.id,
                  },
                  null,
                )
              const result = {
                reason,
                cancelled_work_item_ids: items.map((item) => item.id).sort(),
                stopped_attempt_ids: attempts.map((attempt) => attempt.id).sort(),
                cancelled_workflow_run_ids: plan.workflow_run_ids,
                stopped_agent_run_ids: plan.agent_run_ids,
              }
              event(db, action.project_id, "work.cancelled", {
                action_id: action.id,
                ...result,
              })
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
        const outcome = yield* Effect.exit(finalize)
        if (Exit.isFailure(outcome)) return yield* Effect.fail(new StopRecoveryRequired(Cause.pretty(outcome.cause)))
        return outcome.value
      })

      const retry = Effect.fn("ProjectActionExecutor.retry")(function* (action: ProjectActionRecordValue) {
        const payload = RetryPayload.parse(action.payload)
        const persisted = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = actionEffectResultWithDatabase(db, action.id)
              if (existing) return existing
              const project = db
                .select()
                .from(CompanyProjectTable)
                .where(eq(CompanyProjectTable.id, action.project_id))
                .get()
              if (!project) throw new Error(`Company project not found: ${action.project_id}`)
              const requestedIDs = [...new Set(payload.work_item_ids ?? [])].sort()
              const projectItems = db
                .select()
                .from(CompanyWorkItemTable)
                .where(eq(CompanyWorkItemTable.project_id, action.project_id))
                .all()
              if (requestedIDs.some((id) => !projectItems.some((item) => item.id === id)))
                throw new Error("retry_work_item_project_mismatch")
              const retryable = projectItems
                .filter((item) => !requestedIDs.length || requestedIDs.includes(item.id))
                .filter((item) => item.status === "blocked" || item.status === "failed")
                .sort((left, right) => left.id.localeCompare(right.id))
              if (!retryable.length) throw new Error("no_retryable_work_items")
              const now = Date.now()
              retryable.forEach((item) =>
                db
                  .update(CompanyWorkItemTable)
                  .set({
                    status: "pending",
                    max_attempts: Math.max(item.max_attempts, item.attempt + 1),
                    error: null,
                    workflow_run_id: null,
                    completed_at: null,
                    updated_at: now,
                  })
                  .where(eq(CompanyWorkItemTable.id, item.id))
                  .run(),
              )
              retryable.forEach((item) =>
                event(
                  db,
                  action.project_id,
                  "work_item.retry_scheduled",
                  {
                    work_item_id: item.id,
                    attempt: item.attempt + 1,
                    reason: payload.reason ?? item.error ?? "用户请求重试",
                    action_id: action.id,
                  },
                  null,
                ),
              )
              const nextStatus = project.status === "blocked" ? "executing" : project.status
              db.update(CompanyProjectTable)
                .set({
                  status: nextStatus,
                  orchestration_state: project.dispatch_paused ? "paused" : "idle",
                  updated_at: now,
                })
                .where(eq(CompanyProjectTable.id, action.project_id))
                .run()
              if (nextStatus !== project.status)
                event(
                  db,
                  action.project_id,
                  "project.status_changed",
                  {
                    from: project.status,
                    to: nextStatus,
                    reason: payload.reason ?? "保留失败事实并重试可恢复节点",
                    action_id: action.id,
                  },
                  null,
                )
              const result = {
                retried_work_item_ids: retryable.map((item) => item.id),
                retained_attempt_ids: db
                  .select()
                  .from(CompanyWorkAttemptTable)
                  .where(eq(CompanyWorkAttemptTable.project_id, action.project_id))
                  .all()
                  .filter((attempt) => retryable.some((item) => item.id === attempt.work_item_id))
                  .map((attempt) => attempt.id)
                  .sort(),
              }
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
        yield* dispatchReady(action)
        return persisted
      })

      const decideDelivery = Effect.fn("ProjectActionExecutor.decideDelivery")(function* (
        action: ProjectActionRecordValue,
      ) {
        const accepted = action.action === "accept_delivery"
        const acceptedPayload = accepted ? AcceptDeliveryPayload.parse(action.payload) : undefined
        const changePayload = accepted ? undefined : RequestChangePayload.parse(action.payload)
        const deliveryID = acceptedPayload?.delivery_id ?? changePayload!.delivery_id
        const result = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = actionEffectResultWithDatabase(db, action.id)
              if (existing) return existing
              const events = db
                .select()
                .from(CompanyProjectEventTable)
                .where(eq(CompanyProjectEventTable.project_id, action.project_id))
                .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
                .all()
              const ready = events.findLast((candidate) => candidate.type === "delivery.ready")
              if (!ready) throw new Error("delivery_not_ready")
              const readyData = eventData(ready)
              if (readyData.delivery_id !== deliveryID) throw new Error("delivery_id_mismatch")
              const readyIndex = events.findIndex((candidate) => candidate.id === ready.id)
              if (
                events
                  .slice(readyIndex + 1)
                  .some(
                    (candidate) =>
                      candidate.type === "delivery.accepted" || candidate.type === "delivery.revision_requested",
                  )
              )
                throw new Error("delivery_already_decided")
              const deliveryWorkItemIDs = acceptedPayload
                ? []
                : [
                    ...new Set(
                      db
                        .select()
                        .from(CompanyArtifactTable)
                        .where(
                          inArray(
                            CompanyArtifactTable.id,
                            z
                              .object({ artifact_ids: z.array(z.string().trim().min(1)) })
                              .passthrough()
                              .parse(readyData).artifact_ids,
                          ),
                        )
                        .all()
                        .flatMap((artifact) => (artifact.work_item_id ? [artifact.work_item_id] : [])),
                    ),
                  ]
              const projectWorkItems = acceptedPayload
                ? []
                : db
                    .select()
                    .from(CompanyWorkItemTable)
                    .where(eq(CompanyWorkItemTable.project_id, action.project_id))
                    .orderBy(asc(CompanyWorkItemTable.created_at), asc(CompanyWorkItemTable.id))
                    .all()
              const projectDependencies = acceptedPayload
                ? []
                : db
                    .select()
                    .from(CompanyWorkItemDependencyTable)
                    .where(
                      inArray(
                        CompanyWorkItemDependencyTable.work_item_id,
                        projectWorkItems.map((item) => item.id),
                      ),
                    )
                    .all()
              const reworkWorkItemIDs = acceptedPayload
                ? []
                : revisionWorkItemIDs({
                    reason: changePayload!.reason,
                    delivery_work_item_ids: deliveryWorkItemIDs,
                    work_items: projectWorkItems,
                    dependencies: projectDependencies,
                  })
              if (!acceptedPayload && !reworkWorkItemIDs.length) throw new Error("delivery_has_no_reworkable_items")
              const reworkRows = acceptedPayload
                ? []
                : projectWorkItems.filter((item) => reworkWorkItemIDs.includes(item.id))
              const reviewerRows = reworkRows.filter((item) => item.kind === "reviewer")
              const reworkWorkerRows = reworkRows.filter((item) => item.kind === "worker")
              const result = acceptedPayload
                ? {
                    delivery_id: acceptedPayload.delivery_id,
                    accepted_criterion_ids: acceptedPayload.accepted_criterion_ids,
                    note: acceptedPayload.note,
                  }
                : {
                    delivery_id: changePayload!.delivery_id,
                    reason: changePayload!.reason,
                    rework_work_item_ids: reworkRows.map((item) => item.id).sort(),
                    rework_work_item_titles: reworkRows.map((item) => item.title),
                  }
              event(
                db,
                action.project_id,
                accepted ? "delivery.accepted" : "delivery.revision_requested",
                {
                  ...result,
                  action_id: action.id,
                },
              )
              if (acceptedPayload) {
                const now = Date.now()
                const assignments = db
                  .select()
                  .from(CompanyProjectAssignmentTable)
                  .where(eq(CompanyProjectAssignmentTable.project_id, action.project_id))
                  .all()
                  .filter((assignment) => assignment.status === "assigned" || assignment.status === "active")
                assignments.forEach((assignment) => {
                  db.update(CompanyProjectAssignmentTable)
                    .set({
                      status: "released",
                      released_at: now,
                      release_reason: "delivery_accepted",
                    })
                    .where(eq(CompanyProjectAssignmentTable.id, assignment.id))
                    .run()
                  db.update(CompanyTeamSelectionTable)
                    .set({ time_released: now, time_updated: now })
                    .where(eq(CompanyTeamSelectionTable.id, assignment.selection_id))
                    .run()
                  event(db, action.project_id, "project_assignment.released", {
                    assignment_id: assignment.id,
                    work_item_id: assignment.work_item_id,
                    reason: "delivery_accepted",
                  })
                })
              }
              if (!acceptedPayload) {
                const now = Date.now()
                const reviewerByParent = new Map(
                  reviewerRows.flatMap((reviewer) => (reviewer.parent_id ? [[reviewer.parent_id, reviewer] as const] : [])),
                )
                const supersededGates = db
                  .select()
                  .from(CompanyValidationGateTable)
                  .where(
                    and(
                      eq(CompanyValidationGateTable.project_id, action.project_id),
                      inArray(CompanyValidationGateTable.work_item_id, reworkWorkItemIDs),
                      ne(CompanyValidationGateTable.status, "superseded"),
                    ),
                  )
                  .all()
                if (supersededGates.length)
                  db.update(CompanyValidationGateTable)
                    .set({ status: "superseded" })
                    .where(
                      inArray(
                        CompanyValidationGateTable.id,
                        supersededGates.map((gate) => gate.id),
                      ),
                    )
                    .run()
                supersededGates.forEach((gate) =>
                  event(
                    db,
                    action.project_id,
                    "validation_gate.superseded",
                    {
                      gate_id: gate.id,
                      work_item_id: gate.work_item_id,
                      reason: "user_request_change",
                      action_id: action.id,
                    },
                    null,
                  ),
                )
                reworkRows.forEach((item) => {
                  db.update(CompanyWorkItemTable)
                    .set({
                      status: "pending",
                      review_status:
                        item.kind === "worker" && reviewerByParent.has(item.id) ? "pending" : item.review_status,
                      workflow_run_id: null,
                      error: null,
                      started_at: null,
                      completed_at: null,
                      max_attempts: Math.max(item.max_attempts, item.attempt + 1),
                      updated_at: now,
                    })
                    .where(eq(CompanyWorkItemTable.id, item.id))
                    .run()
                  const assignment = db
                    .select()
                    .from(CompanyProjectAssignmentTable)
                    .where(eq(CompanyProjectAssignmentTable.work_item_id, item.id))
                    .all()
                    .sort((left, right) => right.version - left.version)[0]
                  if (!assignment) throw new Error(`Work item ${item.id} has no ProjectAssignment to reopen`)
                  db.update(CompanyProjectAssignmentTable)
                    .set({
                      status: "assigned",
                      started_at: null,
                      released_at: null,
                      release_reason: null,
                    })
                    .where(eq(CompanyProjectAssignmentTable.id, assignment.id))
                    .run()
                  db.update(CompanyTeamSelectionTable)
                    .set({ time_released: null, time_updated: now })
                    .where(eq(CompanyTeamSelectionTable.id, assignment.selection_id))
                    .run()
                  event(
                    db,
                    action.project_id,
                    "project_assignment.recovered",
                    {
                      assignment_id: assignment.id,
                      work_item_id: item.id,
                      from: assignment.status,
                      to: "assigned",
                      reason: "user_request_change",
                    },
                    assignment.agent_id,
                  )
                })
                reworkWorkerRows.forEach((worker) =>
                  event(db, action.project_id, "work_item.rework_requested", {
                    worker_id: worker.id,
                    reviewer_id: reviewerByParent.get(worker.id)?.id,
                    origin: "user_request_change",
                    reason: changePayload!.reason,
                    delivery_id: changePayload!.delivery_id,
                    action_id: action.id,
                  }),
                )
                const project = db
                  .select()
                  .from(CompanyProjectTable)
                  .where(eq(CompanyProjectTable.id, action.project_id))
                  .get()
                if (!project) throw new Error(`Company project not found: ${action.project_id}`)
                db.update(CompanyProjectTable)
                  .set({
                    status: "executing",
                    orchestration_state: project.dispatch_paused ? "paused" : "idle",
                    active_run_id: null,
                    completed_at: null,
                    updated_at: now,
                  })
                  .where(eq(CompanyProjectTable.id, action.project_id))
                  .run()
                if (project.status !== "executing")
                  event(
                    db,
                    action.project_id,
                    "project.status_changed",
                    {
                      from: project.status,
                      to: "executing",
                      reason: changePayload!.reason,
                      action_id: action.id,
                    },
                    "user",
                  )
              }
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
        const project = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, action.project_id)).get(),
          ),
        )
        const revisionTitles = changePayload
          ? z
              .object({ rework_work_item_titles: z.array(z.string()) })
              .passthrough()
              .safeParse(result).data?.rework_work_item_titles ?? []
          : []
        if (changePayload) yield* dispatchReady(action)
        if (project?.company_id)
          yield* conversation.recordProjectUpdate({
            companyID: CompanyID.parse(project.company_id),
            projectScopeID: project.id,
            requestID: `project-delivery-decision:${action.id}`,
            author: { kind: "user", id: "local_user" },
            body: acceptedPayload
              ? `用户已验收交付；已核对 ${acceptedPayload.accepted_criterion_ids.length} 项验收标准。`
              : [
                  `用户已请求修改交付：${changePayload!.reason}`,
                  revisionTitles.length ? `本次重新执行范围：${revisionTitles.join("；")}` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
            signalType: "delivery",
          }).pipe(Effect.catchCause(() => Effect.void))
        return result
      })

      const archive = Effect.fn("ProjectActionExecutor.archive")(function* (
        action: ProjectActionRecordValue,
      ) {
        ArchivePayload.parse(action.payload)
        return yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = actionEffectResultWithDatabase(db, action.id)
              if (existing) return existing
              const project = db
                .select()
                .from(CompanyProjectTable)
                .where(eq(CompanyProjectTable.id, action.project_id))
                .get()
              if (!project) throw new Error(`Company project not found: ${action.project_id}`)
              const events = db
                .select()
                .from(CompanyProjectEventTable)
                .where(eq(CompanyProjectEventTable.project_id, action.project_id))
                .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
                .all()
              if (!events.some((candidate) =>
                candidate.type === "delivery.accepted" || candidate.type === "work.cancelled"))
                throw new Error("project_not_archivable")
              const lifecycleEvent = events.findLast((candidate) =>
                candidate.type === "project.archived" || candidate.type === "project.restored")
              const archivedAt = lifecycleEvent?.type === "project.archived"
                ? z.number().int().nonnegative().parse(eventData(lifecycleEvent).archived_at)
                : Date.now()
              if (lifecycleEvent?.type !== "project.archived")
                event(db, action.project_id, "project.archived", {
                  action_id: action.id,
                  archived_at: archivedAt,
                })
              db.update(ChannelTable)
                .set({
                  time_archived: archivedAt,
                  time_updated: archivedAt,
                })
                .where(
                  and(
                    eq(ChannelTable.kind, "project"),
                    eq(ChannelTable.scope_id, action.project_id),
                  ),
                )
                .run()
              const result = {
                archived: true,
                archived_at: archivedAt,
              }
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
      })

      const restore = Effect.fn("ProjectActionExecutor.restore")(function* (
        action: ProjectActionRecordValue,
      ) {
        RestorePayload.parse(action.payload)
        return yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = actionEffectResultWithDatabase(db, action.id)
              if (existing) return existing
              const project = db
                .select()
                .from(CompanyProjectTable)
                .where(eq(CompanyProjectTable.id, action.project_id))
                .get()
              if (!project) throw new Error(`Company project not found: ${action.project_id}`)
              const lifecycleEvent = db
                .select()
                .from(CompanyProjectEventTable)
                .where(eq(CompanyProjectEventTable.project_id, action.project_id))
                .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
                .all()
                .findLast((candidate) =>
                  candidate.type === "project.archived" || candidate.type === "project.restored")
              if (lifecycleEvent?.type !== "project.archived") throw new Error("project_not_archived")
              const restoredAt = Date.now()
              event(db, action.project_id, "project.restored", {
                action_id: action.id,
                restored_at: restoredAt,
              })
              db.update(ChannelTable)
                .set({
                  time_archived: null,
                  time_updated: restoredAt,
                })
                .where(
                  and(
                    eq(ChannelTable.kind, "project"),
                    eq(ChannelTable.scope_id, action.project_id),
                  ),
                )
                .run()
              const result = {
                restored: true,
                restored_at: restoredAt,
              }
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
      })

      const resolveBlocker = Effect.fn("ProjectActionExecutor.resolveBlocker")(function* (
        action: ProjectActionRecordValue,
      ) {
        const payload = ResolveBlockerPayload.parse(action.payload)
        if (!action.attention_id && !payload.approval_gate_id) throw new Error("resolve_blocker_requires_target")
        const persisted = yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = actionEffectResultWithDatabase(db, action.id)
              if (existing) return existing
              const project = db
                .select()
                .from(CompanyProjectTable)
                .where(eq(CompanyProjectTable.id, action.project_id))
                .get()
              if (!project) throw new Error(`Company project not found: ${action.project_id}`)
              const attention = action.attention_id
                ? db
                    .select()
                    .from(CompanyAttentionTable)
                    .where(
                      and(
                        eq(CompanyAttentionTable.id, action.attention_id),
                        eq(CompanyAttentionTable.project_id, action.project_id),
                      ),
                    )
                    .get()
                : undefined
              if (action.attention_id && !attention) throw new Error("attention_project_mismatch")
              if (
                attention &&
                attention.status !== "open" &&
                !(attention.status === "resolved" && attention.resolution === payload.resolution)
              )
                throw new Error("attention_not_open")
              const gate = payload.approval_gate_id
                ? db
                    .select()
                    .from(CompanyApprovalGateTable)
                    .where(
                      and(
                        eq(CompanyApprovalGateTable.id, payload.approval_gate_id),
                        eq(CompanyApprovalGateTable.project_id, action.project_id),
                      ),
                    )
                    .get()
                : undefined
              if (payload.approval_gate_id && !gate) throw new Error("approval_gate_project_mismatch")
              const desiredGateStatus =
                payload.decision === "approve" ? "approved" : payload.decision === "reject" ? "rejected" : undefined
              if (gate && gate.status !== "pending" && gate.status !== desiredGateStatus)
                throw new Error("approval_gate_already_decided_differently")
              if (gate?.kind === "risk_approval" && desiredGateStatus === "approved") {
                if (!gate.work_item_id) throw new Error(`Risk approval ${gate.id} has no WorkItem binding`)
                const item = db
                  .select()
                  .from(CompanyWorkItemTable)
                  .where(eq(CompanyWorkItemTable.id, gate.work_item_id))
                  .get()
                const plan = item
                  ? db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, item.plan_id)).get()
                  : undefined
                if (
                  !item ||
                  item.project_id !== gate.project_id ||
                  item.resource_scope_json !== gate.resource_scope_json ||
                  ["completed", "superseded", "cancelled"].includes(item.status) ||
                  plan?.status !== "active"
                )
                  throw new Error(`Risk approval ${gate.id} no longer matches an active WorkItem scope`)
              }
              const now = Date.now()
              if (attention?.status === "open") {
                db.update(CompanyAttentionTable)
                  .set({
                    status: "resolved",
                    resolution: payload.resolution,
                    version: attention.version + 1,
                    updated_at: now,
                    resolved_at: now,
                  })
                  .where(and(eq(CompanyAttentionTable.id, attention.id), eq(CompanyAttentionTable.status, "open")))
                  .run()
                event(db, action.project_id, "attention.closed", {
                  attention_id: attention.id,
                  version: attention.version + 1,
                  resolution: payload.resolution,
                  action_id: action.id,
                })
              }
              if (gate?.status === "pending" && desiredGateStatus) {
                db.update(CompanyApprovalGateTable)
                  .set({
                    status: desiredGateStatus,
                    decision_note: payload.resolution,
                    decided_at: now,
                  })
                  .where(and(eq(CompanyApprovalGateTable.id, gate.id), eq(CompanyApprovalGateTable.status, "pending")))
                  .run()
                if (gate.kind === "merge_approval" && gate.worktree_run_id)
                  db.update(CompanyWorktreeRunTable)
                    .set({
                      status: payload.decision === "approve" ? "approved" : "review_rejected",
                      updated_at: now,
                    })
                    .where(eq(CompanyWorktreeRunTable.id, gate.worktree_run_id))
                    .run()
                event(db, action.project_id, "gate.resolved", {
                  gate_id: gate.id,
                  kind: gate.kind,
                  decision: payload.decision,
                  note: payload.resolution,
                  action_id: action.id,
                })
              }
              const openMaterialAttention = db
                .select()
                .from(CompanyAttentionTable)
                .where(
                  and(
                    eq(CompanyAttentionTable.project_id, action.project_id),
                    eq(CompanyAttentionTable.status, "open"),
                    eq(CompanyAttentionTable.material, true),
                  ),
                )
                .get()
              const pendingGate = db
                .select()
                .from(CompanyApprovalGateTable)
                .where(
                  and(
                    eq(CompanyApprovalGateTable.project_id, action.project_id),
                    eq(CompanyApprovalGateTable.status, "pending"),
                  ),
                )
                .get()
              const unresolvedValidation = db
                .select()
                .from(CompanyValidationGateTable)
                .where(eq(CompanyValidationGateTable.project_id, action.project_id))
                .all()
                .some((candidate) => ["pending", "running", "failed"].includes(candidate.status))
              const otherClaimedAction = db
                .select()
                .from(CompanyProjectActionTable)
                .where(
                  and(
                    eq(CompanyProjectActionTable.project_id, action.project_id),
                    eq(CompanyProjectActionTable.status, "claimed"),
                    ne(CompanyProjectActionTable.id, action.id),
                  ),
                )
                .get()
              const rejected = payload.decision === "reject"
              const dispatch_resumed =
                !rejected &&
                !project.dispatch_paused &&
                !openMaterialAttention &&
                !pendingGate &&
                !unresolvedValidation &&
                !otherClaimedAction &&
                !["completed", "rejected"].includes(project.status)
              const nextStatus =
                rejected && gate?.kind === "risk_approval"
                  ? "rejected"
                  : dispatch_resumed && (project.status === "blocked" || project.status === "awaiting_approval")
                    ? "executing"
                    : project.status
              if (nextStatus !== project.status) {
                db.update(CompanyProjectTable)
                  .set({
                    status: nextStatus,
                    orchestration_state: dispatch_resumed ? "idle" : project.orchestration_state,
                    updated_at: now,
                  })
                  .where(eq(CompanyProjectTable.id, action.project_id))
                  .run()
                event(
                  db,
                  action.project_id,
                  "project.status_changed",
                  {
                    from: project.status,
                    to: nextStatus,
                    reason: payload.resolution,
                    action_id: action.id,
                  },
                  null,
                )
              }
              const result = {
                attention_id: action.attention_id,
                approval_gate_id: payload.approval_gate_id,
                decision: payload.decision,
                resolution: payload.resolution,
                dispatch_resumed,
              }
              saveEffectResult(db, action, result)
              return result
            },
            { behavior: "immediate" },
          ),
        )
        if (payload.decision === "approve" && payload.approval_gate_id) {
          const gate = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(CompanyApprovalGateTable)
                .where(eq(CompanyApprovalGateTable.id, payload.approval_gate_id!))
                .get(),
            ),
          )
          if (gate?.kind === "risk_approval") {
            if (!gate.work_item_id) throw new Error(`Risk approval ${gate.id} has no WorkItem binding`)
            const authorized = yield* Effect.exit(authorizeBuilder(action.project_id, gate.work_item_id))
            if (Exit.isFailure(authorized)) {
              yield* Effect.exit(
                blockBuilderRecruitment({
                  project_id: action.project_id,
                  gate_id: gate.id,
                  work_item_id: gate.work_item_id,
                  error: safeProjectActionError(Cause.pretty(authorized.cause)),
                }),
              )
              return {
                ...persisted,
                dispatch_resumed: false,
                builder_recruitment: "blocked",
              }
            }
          }
        }
        if (persisted.dispatch_resumed === true) yield* dispatchReady(action)
        return persisted
      })

      const perform = Effect.fn("ProjectActionExecutor.perform")(function* (action: ProjectActionRecordValue) {
        const kind = RuntimeAction.parse(action.action)
        if (!actionEffectResult(action.id) && kind !== "stop_work") assertRevision(action)
        if (kind === "pause_work") return yield* pause(action)
        if (kind === "resume_work") return yield* resume(action)
        if (kind === "stop_work") return yield* stop(action)
        if (kind === "retry") return yield* retry(action)
        if (kind === "accept_delivery" || kind === "request_change") return yield* decideDelivery(action)
        if (kind === "archive") return yield* archive(action)
        if (kind === "restore") return yield* restore(action)
        return yield* resolveBlocker(action)
      })

      const runClaimed = Effect.fn("ProjectActionExecutor.runClaimed")(function* (
        action: ProjectActionRecordValue,
        replayed: boolean,
      ) {
        if (action.action === "adjust_brief") {
          const payload = CompanyProjectDirection.AdjustDirectionPayload.parse(action.payload)
          if (action.status === "requested") yield* quiesceDirection(action)
          const result = yield* adjustDirection({
            project_id: action.project_id,
            attention_id: action.attention_id,
            idempotency_key: action.idempotency_key,
            expected_graph_revision: action.expected_revision!,
            ...payload,
          })
          if (result.status === "applied") {
            if (!dispatch.replanFromCharter) throw new Error("direction_replan_unavailable")
            yield* dispatch.replanFromCharter({
              project_id: action.project_id,
              plan_id: result.plan.id,
              charter: goalBriefCharter(result.brief),
            })
            yield* recordActionUpdate({
              action: result.action,
              body: `已调整方向。目标摘要版本 ${result.brief.version}，执行计划版本 ${result.plan.version}；系统正在按新方向重建后续任务。`,
              signalType: "intervention",
            })
          }
          return { action: result.action, replayed: replayed || result.replayed }
        }
        if (action.action === "restore_direction_checkpoint") {
          if (action.status === "applied" || action.status === "rejected") return { action, replayed: true }
          const claimed =
            action.status === "claimed" ? { record: action, replayed: true } : yield* attention.claimAction(action.id)
          if (claimed.record.status === "rejected") return { action: claimed.record, replayed }
          if (claimed.record.status !== "claimed")
            throw new Error(`Project action ${action.id} cannot execute from ${claimed.record.status}`)
          const payload = CompanyProjectDirection.RestoreDirectionCheckpointPayload.parse(claimed.record.payload)
          const result = yield* restoreDirectionCheckpoint({
            project_id: claimed.record.project_id,
            action_id: claimed.record.id,
            expected_graph_revision: claimed.record.expected_revision!,
            ...payload,
          })
          return { action: result.action, replayed: replayed || claimed.replayed || result.replayed }
        }
        if (action.action === "apply_founder_direction") {
          if (action.status === "applied" || action.status === "rejected") return { action, replayed: true }
          const claimed =
            action.status === "claimed" ? { record: action, replayed: true } : yield* attention.claimAction(action.id)
          if (claimed.record.status === "rejected") return { action: claimed.record, replayed }
          if (claimed.record.status !== "claimed")
            throw new Error(`Project action ${action.id} cannot execute from ${claimed.record.status}`)
          const payload = CompanyProjectDirection.ApplyFounderDirectionPayload.parse(claimed.record.payload)
          const result = yield* applyFounderDirection({
            project_id: claimed.record.project_id,
            action_id: claimed.record.id,
            expected_graph_revision: claimed.record.expected_revision!,
            ...payload,
          })
          return { action: result.action, replayed: replayed || claimed.replayed || result.replayed }
        }
        if (action.status === "applied" || action.status === "rejected") return { action, replayed: true }
        const claimed =
          action.status === "claimed" ? { record: action, replayed: true } : yield* attention.claimAction(action.id)
        if (claimed.record.status === "rejected") return { action: claimed.record, replayed }
        if (claimed.record.status !== "claimed")
          throw new Error(`Project action ${action.id} cannot execute from ${claimed.record.status}`)
        hooks.onBoundary?.("after_claim", claimed.record)
        const outcome = yield* Effect.exit(perform(claimed.record))
        if (Exit.isFailure(outcome)) {
          const error = Cause.squash(outcome.cause)
          if (error instanceof StopRecoveryRequired) {
            const retained = yield* Effect.sync(() => retainStopForRecovery(claimed.record, error.message))
            return { action: retained, replayed }
          }
          const rejected = yield* attention.rejectAction({
            id: claimed.record.id,
            error: safeProjectActionError(Cause.pretty(outcome.cause)),
          })
          return { action: rejected.record, replayed }
        }
        hooks.onBoundary?.("after_effect", claimed.record)
        const applied = yield* attention.applyAction({
          id: claimed.record.id,
          result: outcome.value,
        })
        const update = actionUpdate(applied.record)
        if (update) yield* recordActionUpdate({ action: applied.record, ...update })
        hooks.onBoundary?.("after_apply", applied.record)
        return { action: applied.record, replayed }
      })

      const execute = Effect.fn("ProjectActionExecutor.execute")(function* (raw: ProjectActionRequestValue) {
        const input = ProjectActionRequest.parse(raw)
        RuntimeAction.parse(input.action)
        if (input.expected_revision === undefined) throw new Error("expected_revision_required")
        const requested = yield* attention.requestAction(input)
        hooks.onBoundary?.("after_request", requested.record)
        return yield* lock(input.project_id).withPermits(1)(runClaimed(requested.record, requested.replayed))
      })

      const recover = Effect.fn("ProjectActionExecutor.recover")(function* () {
        const recoveredBuilders = yield* Effect.forEach(
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(CompanyApprovalGateTable)
                .where(
                  and(
                    eq(CompanyApprovalGateTable.kind, "risk_approval"),
                    eq(CompanyApprovalGateTable.status, "approved"),
                  ),
                )
                .all()
                .filter(
                  (gate): gate is typeof CompanyApprovalGateTable.$inferSelect & { project_id: string } => {
                    if (!gate.project_id) return false
                    const project = db
                      .select()
                      .from(CompanyProjectTable)
                      .where(eq(CompanyProjectTable.id, gate.project_id))
                      .get()
                    return (
                      Boolean(gate.work_item_id) &&
                      project?.execution_strategy === "seed_and_grow" &&
                      project.seed_mode === "discovery_first"
                    )
                  },
                ),
            ),
          ),
          (gate) =>
            Effect.gen(function* () {
              const authorized = yield* Effect.exit(authorizeBuilder(gate.project_id, gate.work_item_id!))
              if (Exit.isSuccess(authorized)) return authorized.value
              yield* Effect.exit(
                blockBuilderRecruitment({
                  project_id: gate.project_id,
                  gate_id: gate.id,
                  work_item_id: gate.work_item_id!,
                  error: safeProjectActionError(Cause.pretty(authorized.cause)),
                }),
              )
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
          { concurrency: 1 },
        )
        const assignment_ids = [
          ...new Set([
            ...recoveredBuilders.filter((id): id is string => Boolean(id)),
            ...(yield* Effect.sync(reconcileAssignments)),
          ]),
        ].sort()
        const attention_ids = yield* Effect.sync(resolveInternalAttention)
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyProjectActionTable)
              .orderBy(asc(CompanyProjectActionTable.created_at), asc(CompanyProjectActionTable.id))
              .all()
              .filter(
                (row) =>
                  (row.status === "requested" || row.status === "claimed") &&
                  RuntimeAction.safeParse(row.action).success,
              ),
          ),
        )
        const actions = yield* Effect.forEach(
          rows.map(CompanyAttention.actionFromRow),
          (action) => lock(action.project_id).withPermits(1)(runClaimed(action, true)),
          { concurrency: 1 },
        )
        return {
          idempotency_key: "project-action-recover:v1",
          project_ids: [
            ...new Set(
              rows
                .map((row) => row.project_id)
                .concat(
                  assignment_ids.flatMap((id) => {
                    const assignment = Database.use((db) =>
                      db
                        .select()
                        .from(CompanyProjectAssignmentTable)
                        .where(eq(CompanyProjectAssignmentTable.id, id))
                        .get(),
                    )
                    return assignment ? [assignment.project_id] : []
                  }),
                  attention_ids.flatMap((id) => {
                    const attention = Database.use((db) =>
                      db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, id)).get(),
                    )
                    return attention ? [attention.project_id] : []
                  }),
                ),
            ),
          ].sort(),
          assignment_ids,
          attention_ids,
          action_ids: actions.map((result) => result.action.id),
          applied_action_ids: actions
            .filter((result) => result.action.status === "applied")
            .map((result) => result.action.id),
          rejected_action_ids: actions
            .filter((result) => result.action.status === "rejected")
            .map((result) => result.action.id),
          replayed: !assignment_ids.length && !attention_ids.length && !actions.length,
        }
      })

      return Service.of({ execute, recover })
    }),
  ).pipe(Layer.provide(Conversation.defaultLayer))
}

export const layer = makeLayer()

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyAttention.defaultLayer),
  Layer.provide(DispatchCoordinator.defaultLayer),
  Layer.provide(WorkflowRuntime.defaultLayer),
  Layer.provide(AgentRun.defaultLayer),
  Layer.provide(AgentRunSupervisor.defaultLayer),
)

export * as ProjectActionExecutor from "./project-action-executor"
