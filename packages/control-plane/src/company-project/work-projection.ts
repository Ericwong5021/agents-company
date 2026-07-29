import { createHash } from "node:crypto"
import { asc, desc, eq } from "drizzle-orm"
import z from "zod"
import {
  DeliveryArtifactRef,
  ExperienceActionMutatesBusinessState,
  ExperienceAllowedActionTypes,
  ExperienceNeedsUserAction,
  ExperienceR0ImplementedMutationActions,
  WorkProjection,
  WorkProjectionList,
  type AttentionItem,
  type DeliverySummary,
  type ExperienceActionDescriptor,
  type ExperienceActionType,
  type ExperienceKnownReason,
  type ExperienceReason,
  type ExperienceSourceRef,
  type ExperienceUserStatus,
  type WorkProjection as WorkProjectionValue,
  type WorkProjectionDiagnostic,
} from "@agents-company/shared/experience"
import { Database } from "@/storage"
import { projectView as goalBriefProjectView } from "@/goal-brief/goal-brief"
import { CompanyArtifactTable, CompanyProjectEventTable, CompanyProjectTable } from "./company-project.sql"
import * as ExperienceArtifact from "./experience-artifact"
import { CompanyWorkProjectionTable } from "./work-projection.sql"

export const PROJECTOR_VERSION = 4
const MAX_PROJECTION_DIAGNOSTICS = 500
const MAX_PROJECTION_ITEMS = 500
const EventTimestamp = z.number().int().min(0).max(253_402_300_799_999)
const ProjectStatus = z.enum([
  "intake",
  "planning",
  "executing",
  "reviewing",
  "awaiting_approval",
  "completed",
  "rejected",
  "blocked",
])
const DefinitionFact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("goal_brief"),
      id: z.string().trim().min(1).max(240),
      version: z.number().int().positive(),
      blockingQuestionCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy_charter"),
      id: z.string().trim().min(1).max(240),
      version: z.number().int().positive(),
    })
    .strict(),
])
const PersistedArtifactFact = DeliveryArtifactRef.safeExtend({
  openable: z.boolean(),
}).strict()

export const WorkProjectionSeed = z
  .object({
    workId: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(240),
    goal: z.string().trim().min(1).max(8_000),
    status: ProjectStatus,
    ownerAgentId: z.string().trim().min(1).max(240).optional(),
    definition: DefinitionFact.default({ kind: "none" }),
    persistedArtifacts: z.array(PersistedArtifactFact).default([]),
    createdAt: EventTimestamp,
    updatedAt: EventTimestamp,
  })
  .strict()
export type WorkProjectionSeed = z.infer<typeof WorkProjectionSeed>

const ProjectionEvent = z
  .object({
    id: z.string().trim().min(1).max(240),
    projectId: z.string().trim().min(1).max(240),
    type: z.string().trim().min(1).max(240),
    actorId: z.string().trim().min(1).max(240).optional(),
    data: z.record(z.string(), z.unknown()),
    createdAt: EventTimestamp,
  })
  .strict()
type ProjectionEvent = z.infer<typeof ProjectionEvent>

const EventEnvelope = z
  .object({
    id: z.string().trim().min(1).max(240),
    projectId: z.string().trim().min(1).max(240),
    type: z.string().trim().min(1).max(240),
    actorId: z.string().trim().min(1).max(240).optional(),
    data: z.record(z.string(), z.unknown()),
    createdAt: z.unknown(),
  })
  .strict()

const knownNoopEvents = new Set([
  "project.created",
  "project.model_changed",
  "repository.created",
  "plan.created",
  "workflow.started",
  "workflow.finished",
  "work_item.source_task_key_set",
  "work_item.reassigned",
  "work_item.agent_selected",
  "project_assignment.assigned",
  "project_assignment.reassigned",
  "project_assignment.recovered",
  "project_assignment.released",
  "work_attempt.started",
  "work_attempt.finished",
  "work_attempt.stopped",
  "work_receipt.submitted",
  "work_receipt.processed",
  "work_receipt.claimed",
  "graph_decision.recorded",
  "graph_decision.resolved",
  "graph_mutation.applied",
  "graph_mutation.rejected",
  "graph.validation_gate.requested",
  "graph.capability.requested",
  "graph.user_decision.requested",
  "validation_gate.created",
  "validation_gate.evaluated",
  "validation_gate.recovered",
  "failure_diagnosis.recorded",
  "graph_repair.completed",
  "attention.requested",
  "attention.opened",
  "attention.closed",
  "dispatch.paused",
  "dispatch.resumed",
  "project_action.requested",
  "project_action.claimed",
  "project_action.effect_planned",
  "project_action.effect_applied",
  "project_action.dispatch_failed",
  "project_action.applied",
  "project_action.rejected",
  "work_item.recovered",
  "board_closeout.recorded",
  "worktree_run.created",
  "worktree_run.started",
  "worktree_run.verified",
  "worktree_run.merged",
])
const enabledR0ReadActions = new Set<ExperienceActionType>(["view_progress", "open_diagnostics"])
const implementedMutationActions = new Set<ExperienceActionType>(ExperienceR0ImplementedMutationActions)
const phaseByStatus: Record<ExperienceUserStatus, string> = {
  draft: "目标定义",
  needs_input: "目标定义",
  ready: "目标定义",
  running: "执行",
  paused: "执行",
  blocked: "执行",
  needs_approval: "审批",
  reviewing: "验证",
  revision: "验证",
  delivered: "交付",
  accepted: "交付",
  failed: "执行",
  cancelled: "交付",
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function canonical(value: unknown) {
  return JSON.stringify(normalized(value))
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function diagnostic(
  code: WorkProjectionDiagnostic["code"],
  text: string,
  identity: unknown,
  event?: ProjectionEvent,
): WorkProjectionDiagnostic {
  return {
    id: `diagnostic:${digest(identity).slice(0, 32)}`,
    code,
    message: text,
    eventId: event?.id,
    sourceRef: event
      ? {
          kind: "project_event",
          id: event.id,
          eventType: event.type,
        }
      : undefined,
  }
}

function boundDiagnostics(items: WorkProjectionDiagnostic[], fatalDiagnosticIDs: Set<string>) {
  const ordered = items.sort((left, right) => left.id.localeCompare(right.id))
  if (ordered.length <= MAX_PROJECTION_DIAGNOSTICS)
    return {
      diagnostics: ordered,
      fatalDiagnosticIDs: [...fatalDiagnosticIDs].sort(),
    }
  const overflow = diagnostic(
    "invalid_event",
    `诊断数量超过共享上限 ${MAX_PROJECTION_DIAGNOSTICS}；已确定性折叠 ${ordered.length - MAX_PROJECTION_DIAGNOSTICS + 1} 条，投影按不可用处理。`,
    {
      kind: "diagnostic_overflow",
      count: ordered.length,
      fingerprint: digest(ordered.map((item) => ({ id: item.id, code: item.code }))),
    },
  )
  const diagnostics = [
    ...ordered.filter((item) => item.id !== overflow.id).slice(0, MAX_PROJECTION_DIAGNOSTICS - 1),
    overflow,
  ].sort((left, right) => left.id.localeCompare(right.id))
  const returnedIDs = new Set(diagnostics.map((item) => item.id))
  return {
    diagnostics,
    fatalDiagnosticIDs: [
      ...new Set([...fatalDiagnosticIDs].filter((id) => returnedIDs.has(id)).concat(overflow.id)),
    ].sort(),
  }
}

function prepare(rawEvents: readonly unknown[]) {
  const groups = new Map<string, Map<string, ProjectionEvent>>()
  const invalid = new Map<string, WorkProjectionDiagnostic>()

  rawEvents.forEach((raw) => {
    const envelope = EventEnvelope.safeParse(raw)
    if (!envelope.success) {
      const timestamp =
        typeof raw === "object" && raw !== null && "createdAt" in raw
          ? EventTimestamp.safeParse(raw.createdAt)
          : undefined
      invalid.set(
        canonical(raw),
        diagnostic(
          timestamp && !timestamp.success ? "invalid_timestamp" : "invalid_event",
          timestamp && !timestamp.success
            ? "事件时间戳无效，无法确定当前用户状态。"
            : "事件结构无效，无法确定当前用户状态。",
          raw,
        ),
      )
      return
    }
    const parsed = ProjectionEvent.safeParse(envelope.data)
    if (!parsed.success) {
      invalid.set(canonical(raw), diagnostic("invalid_timestamp", "事件时间戳无效，无法确定当前用户状态。", raw))
      return
    }
    const variants = groups.get(parsed.data.id) ?? new Map<string, ProjectionEvent>()
    variants.set(canonical(parsed.data), parsed.data)
    groups.set(parsed.data.id, variants)
  })

  const duplicateDiagnostics: WorkProjectionDiagnostic[] = []
  const events = [...groups.entries()].flatMap(([id, variants]) => {
    const ordered = [...variants.entries()].sort(([left], [right]) => left.localeCompare(right))
    if (ordered.length > 1) {
      duplicateDiagnostics.push(
        diagnostic(
          "conflicting_duplicate",
          "同一事件 ID 存在冲突副本，无法确定哪一份事实有效。",
          { id, variants: ordered.map(([value]) => value) },
          ordered[0][1],
        ),
      )
      return []
    }
    return [ordered[0][1]]
  })

  return {
    events: events.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    diagnostics: [...invalid.values(), ...duplicateDiagnostics].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function stringValue(data: Record<string, unknown>, key: string, max = 240) {
  const value = data[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function numberValue(data: Record<string, unknown>, key: string) {
  const value = data[key]
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function positiveNumberValue(data: Record<string, unknown>, key: string) {
  const value = numberValue(data, key)
  return value && value > 0 ? value : undefined
}

function goalBriefFact(event: ProjectionEvent) {
  if (event.type !== "goal_brief.created" && event.type !== "goal_brief.versioned") return
  const briefID = stringValue(event.data, "brief_id")
  const version = positiveNumberValue(event.data, "version")
  const blockingQuestionCount = numberValue(event.data, "blocking_question_count")
  if (!briefID || !version || blockingQuestionCount === undefined) return
  return { briefID, version, blockingQuestionCount }
}

function stringArrayValue(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (!Array.isArray(value) || !value.length || value.length > 500) return undefined
  const parsed = z.array(z.string().trim().min(1).max(240)).safeParse(value)
  return parsed.success && new Set(parsed.data).size === parsed.data.length ? parsed.data : undefined
}

function sourceRef(event: ProjectionEvent): ExperienceSourceRef {
  return {
    kind: "project_event",
    id: event.id,
    eventType: event.type,
  }
}

function uniqueSourceRefs(refs: ExperienceSourceRef[]) {
  return [...new Map(refs.map((ref) => [canonical(ref), ref])).values()].sort((left, right) =>
    canonical(left).localeCompare(canonical(right)),
  )
}

function knownReason(text: string, sourceRefs: ExperienceSourceRef[]): ExperienceKnownReason {
  return {
    availability: "known",
    text,
    sourceRefs: uniqueSourceRefs(sourceRefs),
  }
}

function action(id: ExperienceActionType, targetRef: ExperienceSourceRef): ExperienceActionDescriptor {
  if (!ExperienceActionMutatesBusinessState[id] && enabledR0ReadActions.has(id)) return { id, targetRef, enabled: true }
  if (ExperienceActionMutatesBusinessState[id] && implementedMutationActions.has(id))
    return { id, targetRef, enabled: true }
  return {
    id,
    targetRef,
    enabled: false,
    disabledReason: ExperienceActionMutatesBusinessState[id]
      ? "当前 R0 尚未实现该变更动作的真实处理器。"
      : "当前 R0 尚未提供该查看动作的真实界面目标。",
  }
}

function actionsFor(status: ExperienceUserStatus, targetRef: ExperienceSourceRef) {
  return ExperienceAllowedActionTypes[status].map((id) => action(id, targetRef))
}

type AttentionFact = Omit<AttentionItem, "recommendedAction" | "allowedActions">

export function project(seedInput: unknown, rawEvents: readonly unknown[]): WorkProjectionValue {
  const seed = WorkProjectionSeed.parse(seedInput)
  const prepared = prepare(rawEvents)
  const diagnostics = new Map(prepared.diagnostics.map((item) => [item.id, item]))
  const fatalDiagnosticIDs = new Set(prepared.diagnostics.map((item) => item.id))
  const projectRef: ExperienceSourceRef = { kind: "project", id: seed.workId }
  const workItems = new Map<string, { title: string; status: string; source: ExperienceSourceRef }>()
  const artifactEvents = new Map<string, { kind: string; source: ExperienceSourceRef }>()
  const persistedArtifacts = new Map(seed.persistedArtifacts.map((artifact) => [artifact.id, artifact]))
  const attention = new Map<string, AttentionFact>()
  const goalBriefFacts = prepared.events
    .filter((event) => event.projectId === seed.workId && event.createdAt >= seed.createdAt)
    .flatMap((event) => {
      const fact = goalBriefFact(event)
      return fact ? [{ event, fact }] : []
    })
  const latestGoalBriefFact = [...goalBriefFacts]
    .sort(
      (left, right) =>
        left.fact.version - right.fact.version ||
        left.event.createdAt - right.event.createdAt ||
        left.event.id.localeCompare(right.event.id),
    )
    .at(-1)
  let updatedAt = Math.max(seed.createdAt, seed.updatedAt)
  let latestProjectStatus: { status: z.infer<typeof ProjectStatus>; event: ProjectionEvent } | undefined
  let hasExplicitOverride = false
  let state:
    | {
        userStatus: ExperienceUserStatus
        reason: ExperienceReason
        targetRef: ExperienceSourceRef
        sourceRefs: ExperienceSourceRef[]
      }
    | undefined
  let delivery:
    | {
        id: string
        version: number
        acceptanceState: DeliverySummary["acceptanceState"]
        artifacts: DeliveryArtifactRef[]
        reason: ExperienceKnownReason
        sourceRefs: ExperienceSourceRef[]
      }
    | undefined

  const addDiagnostic = (
    code: WorkProjectionDiagnostic["code"],
    text: string,
    identity: unknown,
    event?: ProjectionEvent,
    fatal = false,
  ) => {
    const item = diagnostic(code, text, identity, event)
    diagnostics.set(item.id, item)
    if (fatal) fatalDiagnosticIDs.add(item.id)
    return item
  }

  goalBriefFacts.reduce<Map<string, { event: ProjectionEvent; fact: NonNullable<ReturnType<typeof goalBriefFact>> }>>(
    (latestByBrief, current) => {
      const previous = latestByBrief.get(current.fact.briefID)
      if (previous && current.fact.version < previous.fact.version)
        addDiagnostic(
          "invalid_timestamp",
          "Goal Brief 事件版本随事件时间发生回退，无法确定当前版本。",
          { previous, current },
          current.event,
          true,
        )
      if (
        previous &&
        current.fact.version === previous.fact.version &&
        current.fact.blockingQuestionCount !== previous.fact.blockingQuestionCount
      )
        addDiagnostic(
          "conflicting_duplicate",
          "同一 Goal Brief 版本存在冲突事实，无法确定当前版本。",
          { previous, current },
          current.event,
          true,
        )
      if (!previous || current.fact.version > previous.fact.version) latestByBrief.set(current.fact.briefID, current)
      return latestByBrief
    },
    new Map(),
  )

  const unavailableReason = (text: string, identity: unknown, event?: ProjectionEvent): ExperienceReason => {
    const item = addDiagnostic("missing_fact", text, identity, event)
    return {
      availability: "unavailable",
      text: "当前原因不可用",
      diagnosticIds: [item.id],
    }
  }

  const markState = (
    userStatus: ExperienceUserStatus,
    reason: ExperienceReason,
    targetRef: ExperienceSourceRef,
    sourceRefs: ExperienceSourceRef[],
  ) => {
    state = {
      userStatus,
      reason,
      targetRef,
      sourceRefs: uniqueSourceRefs(sourceRefs),
    }
  }

  const markKnown = (
    userStatus: ExperienceUserStatus,
    text: string,
    event: ProjectionEvent,
    targetRef: ExperienceSourceRef = projectRef,
    extraSourceRefs: ExperienceSourceRef[] = [],
  ) => {
    const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event), ...extraSourceRefs])
    markState(userStatus, knownReason(text, sourceRefs), targetRef, sourceRefs)
  }

  const markDefinition = (event?: ProjectionEvent) => {
    const eventRefs = event ? [sourceRef(event)] : []
    if (seed.definition.kind === "none") {
      const sourceRefs = uniqueSourceRefs([projectRef, ...eventRefs])
      markState(
        "draft",
        knownReason("当前项目没有有效 Goal Brief 或可读取的历史 Charter。", sourceRefs),
        projectRef,
        sourceRefs,
      )
      return
    }
    const definitionRef: ExperienceSourceRef =
      seed.definition.kind === "goal_brief"
        ? { kind: "goal_brief", id: seed.definition.id, version: seed.definition.version }
        : { kind: "legacy_charter", id: seed.definition.id, version: seed.definition.version }
    const sourceRefs = uniqueSourceRefs([projectRef, definitionRef, ...eventRefs])
    if (seed.definition.kind === "legacy_charter") {
      markState(
        "ready",
        knownReason("数据库中的只读历史 Charter 已通过兼容视图验证。", sourceRefs),
        definitionRef,
        sourceRefs,
      )
      return
    }
    if (seed.definition.blockingQuestionCount > 0) {
      markState(
        "needs_input",
        knownReason(
          `Goal Brief v${seed.definition.version} 仍有 ${seed.definition.blockingQuestionCount} 个阻塞问题。`,
          sourceRefs,
        ),
        definitionRef,
        sourceRefs,
      )
      return
    }
    markState(
      "ready",
      knownReason(`Goal Brief v${seed.definition.version} 已验证且没有阻塞问题。`, sourceRefs),
      definitionRef,
      sourceRefs,
    )
  }

  const markSeedStatus = () => {
    if (seed.status === "intake") {
      markDefinition()
      return
    }
    if (seed.status === "completed") {
      addDiagnostic(
        "missing_fact",
        "项目记录为 completed，但没有满足 delivery.ready 契约的交付事实。",
        { workId: seed.workId, status: seed.status },
        undefined,
        true,
      )
      state = undefined
      return
    }
    const status =
      seed.status === "planning" || seed.status === "executing"
        ? "running"
        : seed.status === "awaiting_approval"
          ? "needs_approval"
          : seed.status === "rejected"
            ? "revision"
            : seed.status
    const reason = unavailableReason(`数据库可确定 ${status} 状态，但事件流缺少对应的事实性原因。`, {
      workId: seed.workId,
      status: seed.status,
    })
    markState(status, reason, projectRef, [projectRef])
  }

  prepared.events.forEach((event) => {
    if (event.projectId !== seed.workId) {
      addDiagnostic("invalid_event", "事件所属项目与当前投影不一致。", event, event, true)
      return
    }
    if (event.createdAt < seed.createdAt) {
      addDiagnostic("invalid_timestamp", "事件时间早于项目创建事实。", event, event, true)
      return
    }
    updatedAt = Math.max(updatedAt, event.createdAt)

    if (event.type === "project.status_changed") {
      const next = stringValue(event.data, "to")
      const parsed = ProjectStatus.safeParse(next)
      if (!parsed.success) {
        addDiagnostic("missing_fact", "项目状态事件缺少可识别的目标状态。", event, event, true)
        state = undefined
        return
      }
      latestProjectStatus = { status: parsed.data, event }
      hasExplicitOverride = false
      if (parsed.data === "intake") {
        markDefinition(event)
        return
      }
      if (parsed.data === "planning") {
        markKnown("running", "项目状态事件确认团队正在制定执行计划。", event)
        return
      }
      if (parsed.data === "executing") {
        markKnown("running", "项目状态事件确认团队正在执行已确认的工作。", event)
        return
      }
      if (parsed.data === "reviewing") {
        markKnown("reviewing", "项目状态事件确认成果正在接受独立验证。", event)
        return
      }
      if (parsed.data === "completed") {
        if (delivery) {
          const deliveryRef: ExperienceSourceRef = {
            kind: "delivery",
            id: delivery.id,
            version: delivery.version,
          }
          const sourceRefs = uniqueSourceRefs([...delivery.sourceRefs, sourceRef(event)])
          const reason = knownReason(delivery.reason.text, sourceRefs)
          delivery = { ...delivery, reason, sourceRefs }
          markState(
            delivery.acceptanceState === "accepted"
              ? "accepted"
              : delivery.acceptanceState === "revision_requested"
                ? "revision"
                : "delivered",
            reason,
            deliveryRef,
            sourceRefs,
          )
          hasExplicitOverride = true
          return
        }
        state = undefined
        return
      }
      const status =
        parsed.data === "awaiting_approval" ? "needs_approval" : parsed.data === "rejected" ? "revision" : "blocked"
      const reasonText = stringValue(event.data, "reason", 8_000)
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event)])
      markState(
        status,
        reasonText
          ? knownReason(reasonText, sourceRefs)
          : unavailableReason(`${status} 状态事件缺少事实性原因。`, event, event),
        projectRef,
        sourceRefs,
      )
      return
    }

    if (event.type === "goal_brief.created" || event.type === "goal_brief.versioned") {
      const fact = goalBriefFact(event)
      if (!fact) {
        addDiagnostic("missing_fact", "Goal Brief 事件缺少 Brief ID、版本或阻塞问题数量。", event, event, true)
        return
      }
      if (seed.definition.kind !== "goal_brief" || seed.definition.id !== fact.briefID) {
        addDiagnostic("missing_fact", "Goal Brief 事件与数据库中的已验证 Brief 身份不一致。", event, event, true)
        return
      }
      if (latestGoalBriefFact?.event.id !== event.id) return
      if (
        seed.definition.version !== fact.version ||
        seed.definition.blockingQuestionCount !== fact.blockingQuestionCount
      ) {
        addDiagnostic("missing_fact", "Goal Brief 事件与数据库中的已验证当前版本不一致。", event, event, true)
        return
      }
      if (seed.status === "intake") markDefinition(event)
      return
    }

    if (event.type === "charter.saved") {
      if (seed.definition.kind !== "legacy_charter") {
        addDiagnostic("missing_fact", "Charter 事件没有对应的有效数据库兼容视图。", event, event)
        return
      }
      if (seed.status === "intake") markDefinition(event)
      return
    }

    if (event.type === "work.paused" || event.type === "work.cancelled") {
      const reasonText = stringValue(event.data, "reason", 8_000)
      const status = event.type === "work.paused" ? "paused" : "cancelled"
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event)])
      markState(
        status,
        reasonText
          ? knownReason(reasonText, sourceRefs)
          : unavailableReason(`${event.type} 事件缺少事实性原因。`, event, event),
        projectRef,
        sourceRefs,
      )
      hasExplicitOverride = true
      if (status === "cancelled") attention.clear()
      return
    }

    if (event.type === "work.resumed") {
      const reasonText = stringValue(event.data, "reason", 8_000)
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event)])
      markState(
        "running",
        reasonText
          ? knownReason(reasonText, sourceRefs)
          : unavailableReason("work.resumed 事件缺少事实性原因。", event, event),
        projectRef,
        sourceRefs,
      )
      hasExplicitOverride = true
      return
    }

    if (event.type === "work_item.created") {
      const id = stringValue(event.data, "work_item_id")
      const title = stringValue(event.data, "title")
      if (!id || !title) {
        addDiagnostic("missing_fact", "Work Item 创建事件缺少 ID 或标题。", event, event)
        return
      }
      workItems.set(id, { title, status: "pending", source: sourceRef(event) })
      return
    }

    if (event.type.startsWith("work_item.")) {
      const itemStatus = event.type.slice("work_item.".length)
      if (["pending", "running", "blocked", "failed", "completed", "superseded", "cancelled"].includes(itemStatus)) {
        const id = stringValue(event.data, "work_item_id")
        const current = id ? workItems.get(id) : undefined
        if (!id || !current) {
          addDiagnostic("missing_fact", "Work Item 状态事件缺少对应的创建事实。", event, event)
          return
        }
        workItems.set(id, { ...current, status: itemStatus, source: sourceRef(event) })
        const key = `work-item:${id}`
        if (
          itemStatus === "completed" ||
          itemStatus === "superseded" ||
          itemStatus === "cancelled" ||
          itemStatus === "running"
        ) {
          attention.delete(key)
          return
        }
        if (itemStatus === "pending") return
        const reasonText = stringValue(event.data, "error", 8_000)
        const reason = reasonText
          ? knownReason(reasonText, [projectRef, sourceRef(event)])
          : unavailableReason("工作项状态事件缺少事实性原因。", event, event)
        attention.set(key, {
          id: key,
          type: itemStatus === "failed" ? "failure" : "blocked",
          workId: seed.workId,
          title: current.title,
          reason,
          impact: "该工作项尚未形成可接受成果。",
          priority: itemStatus === "failed" ? "critical" : "high",
          updatedAt: new Date(event.createdAt).toISOString(),
          sourceRefs: uniqueSourceRefs([projectRef, sourceRef(event)]),
        })
        if (itemStatus === "blocked" && event.data.blocks_critical_path === true) {
          const stateReason = reasonText ? reason : unavailableReason("关键路径阻塞事件缺少事实性原因。", event, event)
          markState("blocked", stateReason, projectRef, uniqueSourceRefs([projectRef, sourceRef(event)]))
          hasExplicitOverride = true
        }
        if (itemStatus === "failed" && event.data.retry_exhausted === true) {
          const stateReason = reasonText ? reason : unavailableReason("重试耗尽事件缺少事实性原因。", event, event)
          markState("failed", stateReason, projectRef, uniqueSourceRefs([projectRef, sourceRef(event)]))
          hasExplicitOverride = true
        }
        return
      }

      if (event.type === "work_item.retry_scheduled") {
        const id = stringValue(event.data, "work_item_id")
        if (!id || !workItems.has(id)) {
          addDiagnostic("missing_fact", "Work Item 重试事件缺少对应的创建事实。", event, event)
          return
        }
        attention.delete(`work-item:${id}`)
        if (hasExplicitOverride && state?.userStatus === "failed") {
          hasExplicitOverride = false
          state = undefined
        }
        return
      }

      if (event.type === "work_item.rework_requested" || event.type === "work_item.rework_scheduled") {
        const workerID = stringValue(event.data, "worker_id")
        if (!workerID) {
          addDiagnostic("missing_fact", "Work Item 返工事件缺少 Worker ID。", event, event)
          return
        }
        markKnown("revision", "返工事件确认成果正在按审查结果修改。", event)
        hasExplicitOverride = true
        return
      }
    }

    if (event.type === "gate.requested") {
      const gateID = stringValue(event.data, "gate_id")
      if (!gateID) {
        addDiagnostic("missing_fact", "审批事件缺少 Gate ID。", event, event)
        return
      }
      const gateRef: ExperienceSourceRef = { kind: "approval_gate", id: gateID }
      const reason = knownReason("Gate 请求事件确认高影响动作正在等待明确决定。", [
        projectRef,
        sourceRef(event),
        gateRef,
      ])
      attention.set(`gate:${gateID}`, {
        id: `gate:${gateID}`,
        type: "approval",
        workId: seed.workId,
        title: "等待明确批准",
        reason,
        impact: "批准前，高影响动作不会继续。",
        priority: "high",
        updatedAt: new Date(event.createdAt).toISOString(),
        sourceRefs: reason.sourceRefs,
      })
      if (seed.status === "awaiting_approval" || latestProjectStatus?.status === "awaiting_approval") {
        markState("needs_approval", reason, gateRef, reason.sourceRefs)
        hasExplicitOverride = true
      }
      return
    }

    if (event.type === "gate.resolved") {
      const gateID = stringValue(event.data, "gate_id")
      const decision = stringValue(event.data, "decision")
      if (!gateID || !["approve", "reject"].includes(decision ?? "")) {
        addDiagnostic("missing_fact", "审批结果事件缺少 Gate ID 或有效决定。", event, event)
        return
      }
      attention.delete(`gate:${gateID}`)
      return
    }

    if (event.type === "artifact.created") {
      const id = stringValue(event.data, "artifact_id")
      const kind = stringValue(event.data, "kind")
      if (!id || !kind) {
        addDiagnostic("missing_fact", "Artifact 事件缺少 ID 或类型。", event, event)
        return
      }
      artifactEvents.set(id, { kind, source: sourceRef(event) })
      return
    }

    if (event.type === "worktree_run.verification_failed") {
      const id = stringValue(event.data, "worktree_run_id") ?? event.id
      const reasonText = stringValue(event.data, "error", 8_000)
      const reason = reasonText
        ? knownReason(reasonText, [projectRef, sourceRef(event)])
        : unavailableReason("交付验证失败事件缺少事实性原因。", event, event)
      attention.set(`verification:${id}`, {
        id: `verification:${id}`,
        type: "failure",
        workId: seed.workId,
        title: "交付验证未通过",
        reason,
        impact: "验证通过前，成果不能进入正式交付。",
        priority: "critical",
        updatedAt: new Date(event.createdAt).toISOString(),
        sourceRefs: uniqueSourceRefs([projectRef, sourceRef(event)]),
      })
      return
    }

    if (event.type === "delivery.ready") {
      const deliveryID = stringValue(event.data, "delivery_id")
      const version = positiveNumberValue(event.data, "version")
      const artifactIDs = stringArrayValue(event.data, "artifact_ids")
      if (!deliveryID || !version || !artifactIDs) {
        addDiagnostic("missing_fact", "Delivery Ready 事件缺少 Delivery ID、版本或 Artifact 引用。", event, event, true)
        state = undefined
        return
      }
      const validArtifacts = artifactIDs.flatMap((id) => {
        const persisted = persistedArtifacts.get(id)
        const eventFact = artifactEvents.get(id)
        if (
          !persisted?.openable ||
          persisted.projectId !== seed.workId ||
          !eventFact ||
          persisted.kind !== eventFact.kind
        ) {
          addDiagnostic(
            "missing_fact",
            `Delivery 引用的 Artifact ${id} 缺少一致、可打开的数据库事实或 artifact.created 事实。`,
            { event, artifactID: id },
            event,
          )
          return []
        }
        return [
          {
            id,
            projectId: persisted.projectId,
            kind: persisted.kind,
            title: persisted.title,
            href: persisted.href,
          },
        ]
      })
      if (validArtifacts.length !== artifactIDs.length) {
        addDiagnostic("missing_fact", "Delivery 的 Artifact 引用未全部通过持久化与事件事实核对。", event, event, true)
        state = undefined
        return
      }
      const deliveryRef: ExperienceSourceRef = { kind: "delivery", id: deliveryID, version }
      const artifactRefs = validArtifacts.map(
        (artifact): ExperienceSourceRef => ({
          kind: "artifact",
          id: artifact.id,
        }),
      )
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event), deliveryRef, ...artifactRefs])
      const reason = knownReason(
        `Delivery v${version} 已形成，并有 ${validArtifacts.length} 个持久化 Artifact 可供验收。`,
        sourceRefs,
      )
      markState("delivered", reason, deliveryRef, sourceRefs)
      delivery = {
        id: deliveryID,
        version,
        acceptanceState: "pending",
        artifacts: validArtifacts,
        reason,
        sourceRefs,
      }
      attention.set(`delivery:${deliveryID}`, {
        id: `delivery:${deliveryID}`,
        type: "delivery",
        workId: seed.workId,
        title: "交付成果可验收",
        reason,
        impact: "成果正在等待查看、接受或返工决定。",
        priority: "normal",
        updatedAt: new Date(event.createdAt).toISOString(),
        sourceRefs,
      })
      hasExplicitOverride = true
      return
    }

    if (event.type === "delivery.accepted") {
      const deliveryID = stringValue(event.data, "delivery_id")
      if (!delivery || !deliveryID || deliveryID !== delivery.id) {
        addDiagnostic(
          "missing_fact",
          "Delivery Accepted 事件缺少匹配的 Delivery ID 或先前的 Delivery Ready 事实。",
          event,
          event,
          true,
        )
        state = undefined
        return
      }
      const deliveryRef: ExperienceSourceRef = { kind: "delivery", id: delivery.id, version: delivery.version }
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event), deliveryRef, ...delivery.sourceRefs])
      const reason = knownReason("接受事件确认用户或明确策略已验收交付。", sourceRefs)
      markState("accepted", reason, deliveryRef, sourceRefs)
      delivery = { ...delivery, acceptanceState: "accepted", reason, sourceRefs }
      attention.delete(`delivery:${delivery.id}`)
      hasExplicitOverride = true
      return
    }

    if (event.type === "delivery.revision_requested") {
      const deliveryID = stringValue(event.data, "delivery_id")
      if (!delivery || !deliveryID || deliveryID !== delivery.id) {
        addDiagnostic(
          "missing_fact",
          "Delivery Revision 事件缺少匹配的 Delivery ID 或先前的 Delivery Ready 事实。",
          event,
          event,
          true,
        )
        state = undefined
        return
      }
      const deliveryRef: ExperienceSourceRef = { kind: "delivery", id: delivery.id, version: delivery.version }
      const sourceRefs = uniqueSourceRefs([projectRef, sourceRef(event), deliveryRef, ...delivery.sourceRefs])
      const reasonText = stringValue(event.data, "reason", 8_000)
      const reason = reasonText
        ? knownReason(reasonText, sourceRefs)
        : unavailableReason("Delivery Revision 事件缺少事实性修改原因。", event, event)
      markState("revision", reason, deliveryRef, sourceRefs)
      delivery = {
        ...delivery,
        acceptanceState: "revision_requested",
        reason: reasonText ? knownReason(reasonText, sourceRefs) : delivery.reason,
        sourceRefs,
      }
      attention.delete(`delivery:${delivery.id}`)
      hasExplicitOverride = true
      return
    }

    if (knownNoopEvents.has(event.type)) return
    addDiagnostic("unknown_event", `未知事件 ${event.type} 无法安全映射为用户状态。`, event, event, true)
    state = undefined
  })

  if (latestProjectStatus && latestProjectStatus.status !== seed.status)
    addDiagnostic(
      "conflicting_duplicate",
      "项目记录与最新状态事件冲突，无法确定当前用户状态。",
      { seedStatus: seed.status, event: latestProjectStatus.event },
      latestProjectStatus.event,
      true,
    )

  if (!hasExplicitOverride) {
    if (!latestProjectStatus || latestProjectStatus.status === seed.status) {
      if ((!latestProjectStatus && seed.status !== "intake") || !state) markSeedStatus()
    }
  }

  if (seed.status === "completed" && !delivery)
    addDiagnostic(
      "missing_fact",
      "completed 记录不能替代 delivery.ready 与真实可打开 Artifact。",
      { workId: seed.workId, status: seed.status },
      latestProjectStatus?.event,
      true,
    )

  if (!state)
    addDiagnostic(
      "missing_fact",
      "当前事实无法确定 canonical 用户状态。",
      { workId: seed.workId, events: prepared.events.map((event) => event.id) },
      undefined,
      true,
    )

  const sourceRefCounts = [
    state ? { owner: "state", count: state.sourceRefs.length } : undefined,
    state?.reason.availability === "known"
      ? { owner: "state_reason", count: state.reason.sourceRefs.length }
      : undefined,
    delivery ? { owner: "delivery", count: delivery.sourceRefs.length } : undefined,
    delivery ? { owner: "delivery_reason", count: delivery.reason.sourceRefs.length } : undefined,
    ...[...attention.values()].flatMap((item) => [
      { owner: `attention:${item.id}`, count: item.sourceRefs.length },
      ...(item.reason.availability === "known"
        ? [{ owner: `attention_reason:${item.id}`, count: item.reason.sourceRefs.length }]
        : []),
    ]),
  ].filter((item): item is { owner: string; count: number } => Boolean(item))
  const projectionOverflows = [
    ...(seed.persistedArtifacts.length > MAX_PROJECTION_ITEMS
      ? [{ owner: "persisted_artifacts", count: seed.persistedArtifacts.length }]
      : []),
    ...(attention.size > MAX_PROJECTION_ITEMS ? [{ owner: "attention_items", count: attention.size }] : []),
    ...(delivery && delivery.artifacts.length > MAX_PROJECTION_ITEMS
      ? [{ owner: "delivery_artifacts", count: delivery.artifacts.length }]
      : []),
    ...sourceRefCounts.filter((item) => item.count > MAX_PROJECTION_ITEMS),
  ].sort((left, right) => left.owner.localeCompare(right.owner))
  if (projectionOverflows.length)
    addDiagnostic(
      "invalid_event",
      `投影事实超过共享上限 ${MAX_PROJECTION_ITEMS}，当前状态按不可用处理。`,
      { kind: "projection_overflow", items: projectionOverflows },
      undefined,
      true,
    )

  const boundedDiagnostics = boundDiagnostics([...diagnostics.values()], fatalDiagnosticIDs)
  const sourceWatermark = digest({
    projectorVersion: PROJECTOR_VERSION,
    seed,
    events: prepared.events,
    diagnostics: boundedDiagnostics.diagnostics.map((item) => ({ id: item.id, code: item.code })),
  })
  const finalUpdatedAt = new Date(updatedAt).toISOString()

  if (boundedDiagnostics.fatalDiagnosticIDs.length)
    return WorkProjection.parse({
      availability: "unavailable",
      projectorVersion: PROJECTOR_VERSION,
      sourceWatermark,
      workId: seed.workId,
      title: seed.title,
      updatedAt: finalUpdatedAt,
      reason: {
        availability: "unavailable",
        text: "当前原因不可用",
        diagnosticIds: boundedDiagnostics.fatalDiagnosticIDs,
      },
      diagnostics: boundedDiagnostics.diagnostics,
    })

  if (!state) throw new Error("Work projection state invariant failed")

  const currentItems = [...workItems.values()].filter((item) => item.status !== "superseded")
  const totalItems = currentItems.length
  const completedItems = currentItems.filter((item) => item.status === "completed").length
  const allowedActions = actionsFor(state.userStatus, state.targetRef)
  const nextAction = allowedActions.find((item) => item.enabled) ?? null
  const nextMilestone = [...workItems.entries()]
    .filter(([, item]) => item.status !== "completed" && item.status !== "superseded" && item.status !== "cancelled")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, item]) => ({ id, title: item.title, completed: false }))
    .at(0)
  const materializedAttention = [...attention.values()]
    .map((item) => ({
      ...item,
      recommendedAction: nextAction,
      allowedActions,
    }))
    .sort(
      (left, right) =>
        ({ critical: 0, high: 1, normal: 2 })[left.priority] - { critical: 0, high: 1, normal: 2 }[right.priority] ||
        left.id.localeCompare(right.id),
    )
  const deliverySummary =
    delivery &&
    ((state.userStatus === "delivered" && delivery.acceptanceState === "pending") ||
      (state.userStatus === "accepted" && delivery.acceptanceState === "accepted") ||
      (state.userStatus === "revision" && delivery.acceptanceState === "revision_requested"))
      ? {
          id: delivery.id,
          workId: seed.workId,
          version: delivery.version,
          acceptanceState: delivery.acceptanceState,
          artifacts: delivery.artifacts,
          reason: delivery.reason,
          nextAction,
          updatedAt: finalUpdatedAt,
          sourceRefs: delivery.sourceRefs,
          allowedActions,
        }
      : undefined

  return WorkProjection.parse({
    availability: "available",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark,
    summary: {
      workId: seed.workId,
      title: seed.title,
      userStatus: state.userStatus,
      phase: phaseByStatus[state.userStatus],
      owner: seed.ownerAgentId ? { id: seed.ownerAgentId } : undefined,
      nextMilestone,
      needsUserAction: ExperienceNeedsUserAction[state.userStatus],
      reason: state.reason,
      nextAction,
      updatedAt: finalUpdatedAt,
      sourceRefs: state.sourceRefs,
      allowedActions,
    },
    progress: {
      workId: seed.workId,
      userStatus: state.userStatus,
      phase: phaseByStatus[state.userStatus],
      completedItems,
      totalItems,
      ...(totalItems ? { percent: Math.round((completedItems / totalItems) * 100) } : {}),
      reason: state.reason,
      nextAction,
      updatedAt: finalUpdatedAt,
      sourceRefs: state.sourceRefs,
      allowedActions,
    },
    attentionItems: materializedAttention,
    delivery: deliverySummary,
    diagnostics: boundedDiagnostics.diagnostics,
  })
}

function rawEvents(projectID: string) {
  return Database.use((db) =>
    db
      .select()
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.project_id, projectID))
      .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
      .all(),
  ).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    actorId: row.actor_id ?? undefined,
    dataJSON: row.data_json,
    createdAt: row.created_at,
  }))
}

function unavailablePersistedProjection(
  row: typeof CompanyProjectTable.$inferSelect,
  facts: {
    artifacts: Array<{
      id: string
      kind: string
      title: string
      path: string | null
      content: string | null
    }>
    events: ReturnType<typeof rawEvents>
  },
) {
  const identity = {
    kind: "invalid_persisted_projection",
    project: {
      id: row.id,
      title: row.title,
      goal: row.goal,
      status: row.status,
      ownerAgentId: row.owner_agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    artifacts: facts.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      path: artifact.path,
      contentBytes: artifact.content === null ? null : Buffer.byteLength(artifact.content),
    })),
    events: facts.events.map((event) => ({
      id: event.id,
      projectId: event.projectId,
      type: event.type,
      actorId: event.actorId,
      createdAt: event.createdAt,
    })),
  }
  const issue = diagnostic("invalid_event", "项目持久化事实不符合用户投影契约，当前状态按不可用处理。", identity)
  const workID = z.string().trim().min(1).max(240).safeParse(row.id)
  const title = z.string().trim().min(1).max(240).safeParse(row.title)
  const updatedAt = EventTimestamp.safeParse(row.updated_at)
  const createdAt = EventTimestamp.safeParse(row.created_at)
  return WorkProjection.parse({
    availability: "unavailable",
    projectorVersion: PROJECTOR_VERSION,
    sourceWatermark: digest({
      projectorVersion: PROJECTOR_VERSION,
      identity,
      diagnostics: [{ id: issue.id, code: issue.code }],
    }),
    workId: workID.success ? workID.data : `invalid-project:${digest(row.id).slice(0, 32)}`,
    title: title.success ? title.data : "工作状态不可用",
    updatedAt: new Date(updatedAt.success ? updatedAt.data : createdAt.success ? createdAt.data : 0).toISOString(),
    reason: {
      availability: "unavailable",
      text: "当前原因不可用",
      diagnosticIds: [issue.id],
    },
    diagnostics: [issue],
  })
}

export function rebuild(projectID: string): WorkProjectionValue | undefined {
  const row = Database.use((db) =>
    db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectID)).get(),
  )
  if (!row) return undefined
  const artifacts = Database.use((db) =>
    db
      .select({
        id: CompanyArtifactTable.id,
        kind: CompanyArtifactTable.kind,
        title: CompanyArtifactTable.title,
        path: CompanyArtifactTable.path,
        content: CompanyArtifactTable.content,
      })
      .from(CompanyArtifactTable)
      .where(eq(CompanyArtifactTable.project_id, projectID))
      .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
      .limit(MAX_PROJECTION_ITEMS + 1)
      .all(),
  )
  const events = rawEvents(projectID)
  const projection = (() => {
    try {
      const definitionView = goalBriefProjectView(projectID)
      return project(
        {
          workId: row.id,
          title: row.title,
          goal: row.goal,
          status: row.status,
          ownerAgentId: row.owner_agent_id ?? undefined,
          definition: definitionView
            ? definitionView.kind === "goal_brief"
              ? {
                  kind: "goal_brief",
                  id: definitionView.brief.id,
                  version: definitionView.brief.version,
                  blockingQuestionCount: definitionView.brief.openQuestions.filter((question) => question.blocking)
                    .length,
                }
              : {
                  kind: "legacy_charter",
                  id: definitionView.brief.id,
                  version: definitionView.brief.version,
                }
            : { kind: "none" },
          persistedArtifacts: artifacts.map((artifact) => ({
            ...ExperienceArtifact.reference({
              id: artifact.id,
              projectId: projectID,
              kind: artifact.kind,
              title: artifact.title,
            }),
            openable: ExperienceArtifact.openable({
              outputDirectory: row.output_dir,
              path: artifact.path,
              content: artifact.content,
            }),
          })),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        events.map((event) => ({
          id: event.id,
          projectId: event.projectId,
          type: event.type,
          actorId: event.actorId,
          data: parseJSON(event.dataJSON),
          createdAt: event.createdAt,
        })),
      )
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError) && !(error instanceof RangeError))
        throw error
      return unavailablePersistedProjection(row, { artifacts, events })
    }
  })()
  const cached = Database.use((db) =>
    db.select().from(CompanyWorkProjectionTable).where(eq(CompanyWorkProjectionTable.project_id, projectID)).get(),
  )
  if (cached?.projector_version === PROJECTOR_VERSION && cached.source_watermark === projection.sourceWatermark) {
    const parsed = WorkProjection.safeParse(parseJSON(cached.projection_json))
    if (parsed.success) return parsed.data
  }
  Database.use((db) =>
    db
      .insert(CompanyWorkProjectionTable)
      .values({
        project_id: projectID,
        projector_version: PROJECTOR_VERSION,
        source_watermark: projection.sourceWatermark,
        projection_json: JSON.stringify(projection),
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: CompanyWorkProjectionTable.project_id,
        set: {
          projector_version: PROJECTOR_VERSION,
          source_watermark: projection.sourceWatermark,
          projection_json: JSON.stringify(projection),
          updated_at: Date.now(),
        },
      })
      .run(),
  )
  return projection
}

export function list() {
  return WorkProjectionList.parse({
    items: Database.use((db) =>
      db
        .select({ id: CompanyProjectTable.id })
        .from(CompanyProjectTable)
        .orderBy(desc(CompanyProjectTable.updated_at))
        .all(),
    ).flatMap((row) => {
      const projection = rebuild(row.id)
      return projection ? [projection] : []
    }),
  })
}
