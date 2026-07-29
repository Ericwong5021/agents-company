import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { count, eq } from "drizzle-orm"
import { WorkProjection, WorkProjectionList } from "@agents-company/shared/experience"
import {
  PROJECTOR_VERSION,
  list,
  project,
  rebuild,
  type WorkProjectionSeed,
} from "../../src/company-project/work-projection"
import {
  CompanyArtifactTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "../../src/company-project/company-project.sql"
import { CompanyWorkProjectionTable } from "../../src/company-project/work-projection.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

function seed(status: WorkProjectionSeed["status"] = "intake", overrides: Partial<WorkProjectionSeed> = {}) {
  return {
    workId: "project-projection",
    title: "体验重构",
    goal: "形成稳定用户状态",
    status,
    ownerAgentId: "agent-owner",
    definition: {
      kind: "goal_brief" as const,
      id: "brief-1",
      version: 1,
      blockingQuestionCount: 0,
    },
    persistedArtifacts: [
      {
        id: "artifact-a",
        projectId: "project-projection",
        kind: "product",
        title: "可验收成果",
        href: "/experience/projects/project-projection/artifacts/artifact-a",
        openable: true,
      },
    ],
    createdAt: 100,
    updatedAt: 900,
    ...overrides,
  }
}

function event(id: string, type: string, createdAt: number, data: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "project-projection",
    type,
    data,
    createdAt,
  }
}

function available(value: ReturnType<typeof project>) {
  if (value.availability !== "available") throw new Error("Expected an available projection")
  return value
}

function unavailable(value: ReturnType<typeof project>) {
  if (value.availability !== "unavailable") throw new Error("Expected an unavailable projection")
  return value
}

function deliverySequence() {
  return [
    event("event-1", "project.created", 100, { goal: "形成稳定用户状态" }),
    event("event-2", "goal_brief.created", 200, {
      brief_id: "brief-1",
      version: 1,
      blocking_question_count: 0,
    }),
    event("event-3", "work_item.created", 300, { work_item_id: "item-a", title: "实现" }),
    event("event-4", "work_item.created", 310, { work_item_id: "item-b", title: "验证" }),
    event("event-5", "work_item.running", 400, { work_item_id: "item-a" }),
    event("event-6", "work_item.completed", 500, { work_item_id: "item-a" }),
    event("event-7", "artifact.created", 600, { artifact_id: "artifact-a", kind: "product" }),
    event("event-8", "project.status_changed", 700, { from: "executing", to: "completed" }),
    event("event-9", "delivery.ready", 800, {
      delivery_id: "delivery-1",
      version: 1,
      artifact_ids: ["artifact-a"],
    }),
  ]
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("Work Projection", () => {
  test.serial("is identical for realtime order, replay order, and exact duplicate events", () => {
    const realtime = available(project(seed("completed"), deliverySequence()))
    const replay = available(project(seed("completed"), [...deliverySequence().reverse(), deliverySequence()[3]]))

    expect(replay).toEqual(realtime)
    expect(WorkProjection.safeParse(realtime).success).toBe(true)
    expect(realtime.summary).toMatchObject({
      userStatus: "delivered",
      reason: {
        availability: "known",
        text: expect.stringContaining("Delivery v1"),
      },
    })
    expect(realtime.progress).toMatchObject({ completedItems: 1, totalItems: 2, percent: 50 })
    expect(realtime.attentionItems.filter((item) => item.type === "delivery")).toHaveLength(1)
    expect(realtime.delivery?.artifacts).toEqual([
      {
        id: "artifact-a",
        projectId: "project-projection",
        kind: "product",
        title: "可验收成果",
        href: "/experience/projects/project-projection/artifacts/artifact-a",
      },
    ])
  })

  test.serial("removes superseded work from current progress without losing its event history", () => {
    const result = available(
      project(seed("executing"), [
        event("event-1", "work_item.created", 200, { work_item_id: "item-old", title: "旧工作" }),
        event("event-2", "work_item.created", 210, { work_item_id: "item-current", title: "当前工作" }),
        event("event-3", "graph_mutation.applied", 220, { mutation_id: "mutation-1" }),
        event("event-4", "work_item.superseded", 230, {
          work_item_id: "item-old",
          replacement_id: "item-current",
          reason: "新证据替代旧路径",
        }),
      ]),
    )

    expect(result.progress).toMatchObject({ completedItems: 0, totalItems: 1, percent: 0 })
    expect(result.summary.nextMilestone).toMatchObject({ id: "item-current", title: "当前工作" })
    expect(result.diagnostics.filter((item) => item.code === "unknown_event")).toEqual([])
  })

  test.serial("deduplicates attention and resolves approval facts deterministically", () => {
    const events = [
      event("event-1", "gate.requested", 300, { gate_id: "gate-1" }),
      event("event-2", "gate.resolved", 400, { gate_id: "gate-1", decision: "approve" }),
    ]
    const result = available(project(seed("executing"), [...events, events[0]]))

    expect(result.summary.userStatus).toBe("running")
    expect(result.attentionItems).toEqual([])
  })

  test.serial("uses validated definition facts for draft, needs input, ready, and legacy Charter", () => {
    const draft = available(
      project(seed("intake", { definition: { kind: "none" } }), [
        event("event-created", "project.created", 100, { goal: "形成稳定用户状态" }),
      ]),
    )
    const needsInput = available(
      project(
        seed("intake", {
          definition: {
            kind: "goal_brief",
            id: "brief-2",
            version: 2,
            blockingQuestionCount: 1,
          },
        }),
        [
          event("event-brief", "goal_brief.versioned", 200, {
            brief_id: "brief-2",
            version: 2,
            blocking_question_count: 1,
          }),
        ],
      ),
    )
    const ready = available(
      project(seed(), [
        event("event-brief", "goal_brief.created", 200, {
          brief_id: "brief-1",
          version: 1,
          blocking_question_count: 0,
        }),
      ]),
    )
    const legacy = available(
      project(
        seed("intake", {
          definition: { kind: "legacy_charter", id: "project-projection", version: 1 },
        }),
        [event("event-charter", "charter.saved", 200)],
      ),
    )

    expect(draft.summary.userStatus).toBe("draft")
    expect(needsInput.summary.userStatus).toBe("needs_input")
    expect(ready.summary.userStatus).toBe("ready")
    expect(legacy.summary).toMatchObject({
      userStatus: "ready",
      reason: { availability: "known", text: expect.stringContaining("Charter") },
    })
  })

  test.serial("validates only the latest legal Goal Brief event against the current seed", () => {
    const result = available(
      project(
        seed("intake", {
          definition: {
            kind: "goal_brief",
            id: "brief-1",
            version: 3,
            blockingQuestionCount: 0,
          },
        }),
        [
          event("event-brief-created", "goal_brief.created", 200, {
            brief_id: "brief-1",
            version: 1,
            blocking_question_count: 2,
          }),
          event("event-brief-v2", "goal_brief.versioned", 300, {
            brief_id: "brief-1",
            version: 2,
            blocking_question_count: 1,
          }),
          event("event-brief-v3", "goal_brief.versioned", 400, {
            brief_id: "brief-1",
            version: 3,
            blocking_question_count: 0,
          }),
        ],
      ),
    )

    expect(result.summary).toMatchObject({
      userStatus: "ready",
      reason: { availability: "known", text: expect.stringContaining("v3") },
    })
    expect(result.diagnostics.filter((item) => item.code === "missing_fact")).toEqual([])
    expect(result.summary.sourceRefs).toContainEqual(
      expect.objectContaining({ kind: "project_event", id: "event-brief-v3" }),
    )
  })

  test.serial("fails closed when Goal Brief versions regress in event time or disagree with the seed", () => {
    const regressed = unavailable(
      project(
        seed("intake", {
          definition: {
            kind: "goal_brief",
            id: "brief-1",
            version: 3,
            blockingQuestionCount: 0,
          },
        }),
        [
          event("event-brief-v1", "goal_brief.created", 200, {
            brief_id: "brief-1",
            version: 1,
            blocking_question_count: 2,
          }),
          event("event-brief-v3", "goal_brief.versioned", 300, {
            brief_id: "brief-1",
            version: 3,
            blocking_question_count: 0,
          }),
          event("event-brief-v2", "goal_brief.versioned", 400, {
            brief_id: "brief-1",
            version: 2,
            blocking_question_count: 1,
          }),
        ],
      ),
    )
    const mismatched = unavailable(
      project(seed(), [
        event("event-brief", "goal_brief.created", 200, {
          brief_id: "brief-1",
          version: 1,
          blocking_question_count: 1,
        }),
      ]),
    )

    expect(regressed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_timestamp",
        message: expect.stringContaining("版本随事件时间发生回退"),
      }),
    )
    expect(mismatched.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_fact",
        message: expect.stringContaining("当前版本不一致"),
      }),
    )
  })

  test.serial("maps every project status event through the canonical user vocabulary", () => {
    const mappings = [
      ["intake", "ready"],
      ["planning", "running"],
      ["executing", "running"],
      ["reviewing", "reviewing"],
      ["awaiting_approval", "needs_approval"],
      ["rejected", "revision"],
      ["blocked", "blocked"],
    ] as const satisfies readonly (readonly [WorkProjectionSeed["status"], string])[]
    expect(
      mappings.map(([status, expected], index) => {
        const result = available(
          project(seed(status), [
            event(`event-status-${index}`, "project.status_changed", 200, { to: status, reason: `${status} reason` }),
          ]),
        )
        expect(result.summary.reason).toMatchObject({ availability: "known" })
        return [result.summary.userStatus, expected]
      }),
    ).toEqual([
      ["ready", "ready"],
      ["running", "running"],
      ["running", "running"],
      ["reviewing", "reviewing"],
      ["needs_approval", "needs_approval"],
      ["revision", "revision"],
      ["blocked", "blocked"],
    ])
  })

  test.serial("keeps a known status available when its reason fact is missing", () => {
    const result = available(project(seed("blocked"), [event("event-1", "project.created", 100)]))

    expect(result.summary).toMatchObject({
      userStatus: "blocked",
      reason: {
        availability: "unavailable",
        text: "当前原因不可用",
      },
      nextAction: { id: "resolve_blocker", enabled: true },
    })
    expect(result.summary.allowedActions.filter((item) => item.enabled)).toEqual([
      expect.objectContaining({ id: "resolve_blocker" }),
      expect.objectContaining({ id: "open_diagnostics" }),
      expect.objectContaining({ id: "stop_work" }),
    ])
  })

  test.serial("maps only canonical work controls and critical-path or exhausted-retry predicates", () => {
    const paused = available(
      project(seed("executing"), [event("event-paused", "work.paused", 200, { reason: "用户要求暂停" })]),
    )
    const cancelled = available(
      project(seed("executing"), [event("event-cancelled", "work.cancelled", 200, { reason: "用户终止" })]),
    )
    const nonCritical = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "次要工作" }),
        event("event-blocked", "work_item.blocked", 300, {
          work_item_id: "item-1",
          error: "依赖未就绪",
          blocks_critical_path: false,
        }),
      ]),
    )
    const pending = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "待开始工作" }),
        event("event-pending", "work_item.pending", 300, { work_item_id: "item-1" }),
      ]),
    )
    const critical = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "关键工作" }),
        event("event-blocked", "work_item.blocked", 300, {
          work_item_id: "item-1",
          error: "关键依赖不可用",
          blocks_critical_path: true,
        }),
      ]),
    )
    const retryRemaining = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "可重试工作" }),
        event("event-failed", "work_item.failed", 300, {
          work_item_id: "item-1",
          error: "瞬时错误",
          retry_exhausted: false,
        }),
      ]),
    )
    const exhausted = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "失败工作" }),
        event("event-failed", "work_item.failed", 300, {
          work_item_id: "item-1",
          error: "重试耗尽",
          retry_exhausted: true,
        }),
      ]),
    )

    expect(paused.summary.userStatus).toBe("paused")
    expect(cancelled.summary.userStatus).toBe("cancelled")
    expect(nonCritical.summary.userStatus).toBe("running")
    expect(nonCritical.attentionItems).toHaveLength(1)
    expect(pending.summary.userStatus).toBe("running")
    expect(pending.attentionItems).toEqual([])
    expect(critical.summary.userStatus).toBe("blocked")
    expect(retryRemaining.summary.userStatus).toBe("running")
    expect(retryRemaining.attentionItems).toHaveLength(1)
    expect(exhausted.summary.userStatus).toBe("failed")
    expect(unavailable(project(seed("executing"), [event("event-old", "project.paused", 200)]))).toMatchObject({
      availability: "unavailable",
      reason: { text: "当前原因不可用" },
    })
  })

  test.serial("diagnoses malformed governance facts and resumes after bounded work recovery", () => {
    const malformed = unavailable(
      project(seed(), [
        event("event-brief-missing", "goal_brief.created", 200),
        event("event-brief-mismatch", "goal_brief.versioned", 210, {
          brief_id: "brief-other",
          version: 1,
          blocking_question_count: 0,
        }),
        event("event-charter", "charter.saved", 220),
        event("event-item-missing", "work_item.created", 230, { work_item_id: "item-missing-title" }),
        event("event-status-missing", "work_item.running", 240, { work_item_id: "item-never-created" }),
        event("event-retry-missing", "work_item.retry_scheduled", 250, {
          work_item_id: "item-never-created",
        }),
        event("event-rework-missing", "work_item.rework_requested", 260),
        event("event-gate-missing", "gate.requested", 270),
        event("event-gate-result-missing", "gate.resolved", 280, { gate_id: "gate-1", decision: "maybe" }),
        event("event-artifact-missing", "artifact.created", 290, { artifact_id: "artifact-invalid" }),
      ]),
    )
    const recovered = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "可恢复工作" }),
        event("event-failed", "work_item.failed", 300, {
          work_item_id: "item-1",
          error: "瞬时错误",
          retry_exhausted: true,
        }),
        event("event-retry", "work_item.retry_scheduled", 400, { work_item_id: "item-1" }),
        event("event-rework", "work_item.rework_scheduled", 500, { worker_id: "agent-1" }),
      ]),
    )

    expect(malformed.diagnostics.filter((item) => item.code === "missing_fact")).toHaveLength(10)
    expect(recovered.summary.userStatus).toBe("revision")
    expect(recovered.attentionItems).toEqual([])
  })

  test.serial("does not fabricate a reason for work item or verification failures", () => {
    const result = available(
      project(seed("executing"), [
        event("event-item", "work_item.created", 200, { work_item_id: "item-1", title: "待验证工作" }),
        event("event-failed", "work_item.failed", 300, { work_item_id: "item-1", retry_exhausted: false }),
        event("event-verification", "worktree_run.verification_failed", 400, { worktree_run_id: "run-1" }),
      ]),
    )

    expect(result.attentionItems).toHaveLength(2)
    expect(result.attentionItems.every((item) => item.reason.availability === "unavailable")).toBe(true)
    expect(result.diagnostics.filter((item) => item.code === "missing_fact")).toHaveLength(3)
  })

  test.serial("requires delivery.ready plus event-backed and openable persisted artifacts", () => {
    const completed = unavailable(
      project(seed("completed"), [
        event("event-status", "project.status_changed", 200, { from: "executing", to: "completed" }),
        event("event-artifact", "artifact.created", 300, { artifact_id: "artifact-a", kind: "product" }),
      ]),
    )
    const missingPersistedArtifact = unavailable(
      project(seed("completed", { persistedArtifacts: [] }), deliverySequence()),
    )
    const accepted = available(
      project(seed("completed"), [
        ...deliverySequence(),
        event("event-accepted", "delivery.accepted", 850, { delivery_id: "delivery-1" }),
      ]),
    )
    const deliveryBeforeCompleted = available(
      project(
        seed("completed"),
        deliverySequence().map((item) =>
          item.type === "delivery.ready"
            ? { ...item, createdAt: 700 }
            : item.type === "project.status_changed"
              ? { ...item, createdAt: 800 }
              : item,
        ),
      ),
    )

    expect(completed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing_fact", message: expect.stringContaining("delivery.ready") }),
    )
    expect(missingPersistedArtifact.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing_fact", message: expect.stringContaining("Artifact") }),
    )
    expect(accepted.summary.userStatus).toBe("accepted")
    expect(accepted.delivery?.acceptanceState).toBe("accepted")
    expect(deliveryBeforeCompleted.summary.userStatus).toBe("delivered")
    expect(deliveryBeforeCompleted.delivery?.acceptanceState).toBe("pending")
  })

  test.serial("rejects orphan delivery decisions and projects factual revision requests", () => {
    const acceptedWithoutDelivery = unavailable(
      project(seed("completed"), [event("event-accepted", "delivery.accepted", 200)]),
    )
    const revisionWithoutDelivery = unavailable(
      project(seed("completed"), [event("event-revision", "delivery.revision_requested", 200)]),
    )
    const invalidReady = unavailable(
      project(seed("completed"), [event("event-ready", "delivery.ready", 200, { delivery_id: "delivery-1" })]),
    )
    const mismatchedAccepted = unavailable(
      project(seed("completed"), [
        ...deliverySequence(),
        event("event-accepted", "delivery.accepted", 850, { delivery_id: "delivery-other" }),
      ]),
    )
    const mismatchedRevision = unavailable(
      project(seed("completed"), [
        ...deliverySequence(),
        event("event-revision", "delivery.revision_requested", 850, {
          delivery_id: "delivery-other",
          reason: "错误关联",
        }),
      ]),
    )
    const revision = available(
      project(seed("completed"), [
        ...deliverySequence(),
        event("event-revision", "delivery.revision_requested", 850, {
          delivery_id: "delivery-1",
          reason: "验收标准仍有一项未通过",
        }),
      ]),
    )

    expect(acceptedWithoutDelivery.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Accepted") }),
    )
    expect(revisionWithoutDelivery.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Revision") }),
    )
    expect(invalidReady.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Delivery Ready") }),
    )
    expect(mismatchedAccepted.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("匹配的 Delivery ID") }),
    )
    expect(mismatchedRevision.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("匹配的 Delivery ID") }),
    )
    expect(revision.summary).toMatchObject({
      userStatus: "revision",
      reason: { availability: "known", text: "验收标准仍有一项未通过" },
    })
    expect(revision.delivery?.acceptanceState).toBe("revision_requested")
  })

  test.serial("isolates unknown, conflicting, malformed, cross-project, and invalid-timestamp events", () => {
    const conflictingA = event("event-conflict", "work.paused", 300)
    const conflictingB = event("event-conflict", "work.cancelled", 300)
    const result = unavailable(
      project(seed(), [
        event("event-unknown", "runtime.secret_internal_state", 200),
        conflictingA,
        conflictingB,
        { ...event("event-time", "work.paused", 400), createdAt: "invalid" },
        event("event-before-project", "work.cancelled", 50),
        { ...event("event-range", "work.cancelled", 500), createdAt: Number.MAX_SAFE_INTEGER },
        { ...event("event-cross", "work.cancelled", 500), projectId: "another-project" },
        { broken: true },
      ]),
    )

    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["unknown_event", "conflicting_duplicate", "invalid_timestamp", "invalid_event"]),
    )
    expect("summary" in result).toBe(false)
    expect("delivery" in result).toBe(false)
    expect("attentionItems" in result).toBe(false)
  })

  test.serial("folds diagnostic overflow deterministically and stays fail-closed", () => {
    const events = Array.from({ length: 550 }, (_, index) =>
      event(`event-unknown-${index.toString().padStart(3, "0")}`, `runtime.unknown_${index}`, 200 + index),
    )
    const result = unavailable(project(seed(), events))
    const replayed = unavailable(project(seed(), [...events].reverse()))

    expect(result).toEqual(replayed)
    expect(result.diagnostics).toHaveLength(500)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_event",
        message: expect.stringContaining("诊断数量超过共享上限 500"),
      }),
    )
    expect(result.reason.diagnosticIds.every((id) => result.diagnostics.some((item) => item.id === id))).toBe(true)
    expect(WorkProjection.safeParse(result).success).toBe(true)
  })

  test.serial("fails closed before attention or source reference collections exceed the shared contract", () => {
    const failedWorkItems = Array.from({ length: 501 }, (_, index) => [
      event(`event-item-${index}`, "work_item.created", 200 + index * 2, {
        work_item_id: `item-${index}`,
        title: `失败工作 ${index}`,
      }),
      event(`event-failed-${index}`, "work_item.failed", 201 + index * 2, {
        work_item_id: `item-${index}`,
        error: `失败 ${index}`,
        retry_exhausted: false,
      }),
    ]).flat()
    const artifacts = Array.from({ length: 498 }, (_, index) => ({
      id: `artifact-${index}`,
      projectId: "project-projection",
      kind: "product",
      title: `成果 ${index}`,
      href: `/experience/projects/project-projection/artifacts/artifact-${index}`,
      openable: true,
    }))
    const artifactEvents = artifacts.map((artifact, index) =>
      event(`event-artifact-${index}`, "artifact.created", 200 + index, {
        artifact_id: artifact.id,
        kind: artifact.kind,
      }),
    )
    const attentionOverflow = unavailable(project(seed("executing"), failedWorkItems))
    const sourceRefsOverflow = unavailable(
      project(seed("completed", { persistedArtifacts: artifacts }), [
        ...artifactEvents,
        event("event-completed", "project.status_changed", 800, { to: "completed" }),
        event("event-delivery", "delivery.ready", 900, {
          delivery_id: "delivery-overflow",
          version: 1,
          artifact_ids: artifacts.map((artifact) => artifact.id),
        }),
      ]),
    )

    expect(attentionOverflow.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("投影事实超过共享上限 500") }),
    )
    expect(sourceRefsOverflow.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("投影事实超过共享上限 500") }),
    )
    expect(WorkProjection.safeParse(attentionOverflow).success).toBe(true)
    expect(WorkProjection.safeParse(sourceRefsOverflow).success).toBe(true)
  })

  test.serial("rejects a project row that conflicts with its latest status event", () => {
    const result = unavailable(
      project(seed("executing"), [
        event("event-status", "project.status_changed", 200, { from: "executing", to: "reviewing" }),
      ]),
    )

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "conflicting_duplicate", message: expect.stringContaining("项目记录") }),
    )
  })

  test.serial("fails closed for 501 persisted Artifacts without breaking the work list", () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values([
          {
            id: "project-artifact-overflow",
            goal: "验证长项目 Artifact 上限",
            title: "长项目",
            status: "intake",
            output_dir: "/tmp/project-artifact-overflow",
            created_at: 100,
            updated_at: 300,
          },
          {
            id: "project-healthy",
            goal: "验证其他项目不受影响",
            title: "正常项目",
            status: "intake",
            output_dir: "/tmp/project-healthy",
            created_at: 100,
            updated_at: 400,
          },
        ])
        .run()
      db.insert(CompanyProjectEventTable)
        .values([
          {
            id: "event-overflow-created",
            project_id: "project-artifact-overflow",
            type: "project.created",
            data_json: JSON.stringify({ goal: "验证长项目 Artifact 上限" }),
            created_at: 100,
          },
          {
            id: "event-healthy-created",
            project_id: "project-healthy",
            type: "project.created",
            data_json: JSON.stringify({ goal: "验证其他项目不受影响" }),
            created_at: 100,
          },
        ])
        .run()
      db.insert(CompanyArtifactTable)
        .values(
          Array.from({ length: 501 }, (_, index) => ({
            id: `artifact-overflow-${index.toString().padStart(3, "0")}`,
            project_id: "project-artifact-overflow",
            kind: "product",
            title: `成果 ${index}`,
            content: `artifact ${index}`,
            evidence_json: "{}",
            created_at: 200 + index,
          })),
        )
        .run()
    })

    const first = WorkProjection.parse(rebuild("project-artifact-overflow"))
    const replayed = WorkProjection.parse(rebuild("project-artifact-overflow"))
    expect(first).toEqual(replayed)
    expect(first.availability).toBe("unavailable")
    expect(first.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_event",
        message: expect.stringContaining("投影事实超过共享上限 500"),
      }),
    )

    const result = WorkProjectionList.parse(list())
    expect(result.items).toHaveLength(2)
    expect(
      result.items.map((item) => ({
        id: item.availability === "available" ? item.summary.workId : item.workId,
        availability: item.availability,
      })),
    ).toEqual([
      { id: "project-healthy", availability: "available" },
      { id: "project-artifact-overflow", availability: "unavailable" },
    ])
  })

  test.serial("isolates oversized persisted project and Artifact facts from healthy work", () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values([
          {
            id: "project-oversized",
            goal: "g".repeat(8_001),
            title: "t".repeat(241),
            status: "intake",
            output_dir: "/tmp/project-oversized",
            created_at: 100,
            updated_at: 300,
          },
          {
            id: "project-artifact-invalid",
            goal: "验证无效 Artifact 隔离",
            title: "无效 Artifact 项目",
            status: "intake",
            output_dir: "/tmp/project-artifact-invalid",
            created_at: 100,
            updated_at: 200,
          },
          {
            id: "project-healthy",
            goal: "验证正常项目仍可读取",
            title: "正常项目",
            status: "intake",
            output_dir: "/tmp/project-healthy",
            created_at: 100,
            updated_at: 400,
          },
        ])
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: `artifact-${"x".repeat(241)}`,
          project_id: "project-artifact-invalid",
          kind: "product",
          title: "无效成果",
          content: "artifact",
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
    })

    const oversized = WorkProjection.parse(rebuild("project-oversized"))
    const invalidArtifact = WorkProjection.parse(rebuild("project-artifact-invalid"))
    expect(oversized).toEqual(WorkProjection.parse(rebuild("project-oversized")))
    expect(invalidArtifact).toEqual(WorkProjection.parse(rebuild("project-artifact-invalid")))
    expect([oversized, invalidArtifact].every((item) => item.availability === "unavailable")).toBe(true)
    expect(
      [oversized, invalidArtifact].every((item) =>
        item.diagnostics.some((diagnostic) => diagnostic.message.includes("项目持久化事实不符合用户投影契约")),
      ),
    ).toBe(true)
    expect(JSON.stringify(oversized)).not.toContain("t".repeat(241))

    expect(
      WorkProjectionList.parse(list()).items.map((item) => ({
        id: item.availability === "available" ? item.summary.workId : item.workId,
        availability: item.availability,
      })),
    ).toEqual([
      { id: "project-healthy", availability: "available" },
      { id: "project-oversized", availability: "unavailable" },
      { id: "project-artifact-invalid", availability: "unavailable" },
    ])
  })

  test.serial("fails closed for corrupt persisted identifiers, timestamps, and event JSON", () => {
    const invalidID = `project-${"x".repeat(241)}`
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values([
          {
            id: invalidID,
            goal: "验证损坏事件隔离",
            title: "损坏事件项目",
            status: "intake",
            output_dir: "/tmp/project-corrupt-event",
            created_at: 100,
            updated_at: 253_402_300_800_000,
          },
          {
            id: "project-invalid-times",
            goal: "g".repeat(8_001),
            title: "无效时间项目",
            status: "intake",
            output_dir: "/tmp/project-invalid-times",
            created_at: -1,
            updated_at: -1,
          },
        ])
        .run()
      db.insert(CompanyProjectEventTable)
        .values({
          id: "event-corrupt",
          project_id: invalidID,
          type: "project.created",
          data_json: "{",
          created_at: 100,
        })
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-corrupt",
          project_id: invalidID,
          kind: "product",
          title: "空成果",
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
    })

    const corrupt = WorkProjection.parse(rebuild(invalidID))
    const invalidTimes = WorkProjection.parse(rebuild("project-invalid-times"))
    expect(corrupt).toMatchObject({
      availability: "unavailable",
      workId: expect.stringMatching(/^invalid-project:/),
      updatedAt: new Date(100).toISOString(),
    })
    expect(invalidTimes).toMatchObject({
      availability: "unavailable",
      workId: "project-invalid-times",
      updatedAt: new Date(0).toISOString(),
    })
    expect(WorkProjectionList.parse(list()).items).toHaveLength(2)
  })

  test.serial("caches a validated projection and rebuilds it when the event watermark changes", () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-projection",
          goal: "形成稳定用户状态",
          title: "体验重构",
          status: "intake",
          owner_agent_id: "agent-owner",
          output_dir: "/tmp/project-projection",
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(CompanyProjectEventTable)
        .values({
          id: "event-1",
          project_id: "project-projection",
          type: "project.created",
          data_json: JSON.stringify({ goal: "形成稳定用户状态" }),
          created_at: 200,
        })
        .run()
    })

    const first = WorkProjection.parse(rebuild("project-projection"))
    const replayed = WorkProjection.parse(rebuild("project-projection"))
    expect(replayed).toEqual(first)
    expect(first.availability).toBe("available")
    expect(Database.use((db) => db.select({ value: count() }).from(CompanyWorkProjectionTable).get())?.value).toBe(1)
    expect(
      Database.use((db) =>
        db
          .select({ version: CompanyWorkProjectionTable.projector_version })
          .from(CompanyWorkProjectionTable)
          .where(eq(CompanyWorkProjectionTable.project_id, "project-projection"))
          .get(),
      ),
    ).toEqual({ version: PROJECTOR_VERSION })

    Database.use((db) =>
      db
        .update(CompanyWorkProjectionTable)
        .set({ projection_json: "{}" })
        .where(eq(CompanyWorkProjectionTable.project_id, "project-projection"))
        .run(),
    )
    expect(WorkProjection.parse(rebuild("project-projection"))).toEqual(first)

    Database.use((db) =>
      db
        .insert(CompanyProjectEventTable)
        .values({
          id: "event-2",
          project_id: "project-projection",
          type: "runtime.unknown",
          data_json: "{}",
          created_at: 300,
        })
        .run(),
    )
    const rebuilt = WorkProjection.parse(rebuild("project-projection"))
    expect(rebuilt.sourceWatermark).not.toBe(first.sourceWatermark)
    expect(rebuilt.availability).toBe("unavailable")
    expect(rebuilt.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown_event" }))
    expect(WorkProjectionList.parse(list()).items).toHaveLength(1)
  })
})
