import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { count, eq } from "drizzle-orm"
import { GoalBrief, GoalBriefHistory, GoalBriefProjectView } from "@agents-company/shared/experience"
import { GoalBriefStore } from "../../src/goal-brief"
import {
  GoalBriefGenerationRequestTable,
  GoalBriefTable,
  GoalBriefVersionTable,
} from "../../src/goal-brief/goal-brief.sql"
import {
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

function brief(goal = "交付可验证成果") {
  return {
    goal,
    deliverables: [{ id: "delivery-1", title: "成果", description: "形成可验证成果" }],
    acceptanceCriteria: [{ id: "criterion-1", description: "证据完整", verification: "检查自动验收结果" }],
    constraints: ["只使用授权资源"],
    nonGoals: ["不修改无关系统"],
    assumptions: [{ id: "assumption-1", description: "本地环境可用", confirmed: true }],
    openQuestions: [],
    riskLevel: "medium" as const,
    recommendedPlan: {
      summary: "实现后独立验证",
      steps: [{ id: "step-1", title: "实现与验证", outcome: "验收通过" }],
    },
    approvalMode: "balanced" as const,
    sourceRefs: [{ kind: "user" as const, id: "user-local" }],
  }
}

function project(id = "project-goal-brief") {
  Database.use((db) =>
    db
      .insert(CompanyProjectTable)
      .values({
        id,
        goal: "历史项目目标",
        title: "历史项目",
        status: "intake",
        output_dir: `/tmp/${id}`,
        created_at: 100,
        updated_at: 100,
      })
      .run(),
  )
  return id
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("Goal Brief persistence", () => {
  test.serial("persists, restores, compares, and conflict-checks immutable versions", () => {
    const created = GoalBrief.parse(
      GoalBriefStore.create({
        source: "user_input",
        sourceThreadId: "thread-1",
        brief: brief(),
      }),
    )
    const appended = GoalBriefStore.append(created.id, {
      expectedVersion: 1,
      source: "user_confirmation",
      brief: brief("交付已确认的可验证成果"),
    })

    expect(appended.ok).toBe(true)
    if (!appended.ok) throw new Error("Expected Goal Brief append to succeed")
    expect(appended.brief.version).toBe(2)
    expect(appended.brief.source).toBe("user_confirmation")
    expect(GoalBriefStore.get(created.id)).toEqual(appended.brief)
    expect(GoalBriefStore.get(created.id, 1)?.version).toBe(1)
    expect(GoalBriefStore.get(created.id, 99)).toBeUndefined()
    expect(GoalBriefHistory.parse(GoalBriefStore.history(created.id)).versions.map((item) => item.version)).toEqual([
      1, 2,
    ])

    const conflict = GoalBriefStore.append(created.id, {
      expectedVersion: 1,
      source: "system_suggestion",
      brief: brief("不应落库"),
    })
    expect(conflict).toEqual({ ok: false, reason: "version_conflict", currentVersion: 2 })
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(GoalBriefVersionTable)
          .where(eq(GoalBriefVersionTable.brief_id, created.id))
          .get(),
      )?.value,
    ).toBe(2)
  })

  test.serial("validates the complete Brief before any row or project event is written", () => {
    const projectID = project()

    expect(() =>
      GoalBriefStore.create({
        projectId: projectID,
        source: "system_suggestion",
        brief: { ...brief(), recommendedPlan: undefined },
      }),
    ).toThrow()
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectEventTable)
          .where(eq(CompanyProjectEventTable.project_id, projectID))
          .get(),
      )?.value,
    ).toBe(0)
  })

  test.serial("records source and a projection event when a valid version belongs to a project", () => {
    const projectID = project()
    const created = GoalBriefStore.create({
      projectId: projectID,
      source: "system_suggestion",
      brief: {
        ...brief(),
        openQuestions: [{ id: "question-1", question: "确认预算", impact: "影响范围", blocking: true, defaultAssumption: "按当前预算上限执行" }],
      },
    })
    const appended = GoalBriefStore.append(created.id, {
      expectedVersion: 1,
      source: "user_confirmation",
      brief: brief("确认后的项目目标"),
    })
    const events = Database.use((db) =>
      db.select().from(CompanyProjectEventTable).where(eq(CompanyProjectEventTable.project_id, projectID)).all(),
    )

    expect(appended.ok).toBe(true)
    expect(created.projectId).toBe(projectID)
    expect(created.source).toBe("system_suggestion")
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe("goal_brief.created")
    expect(events[0]?.actor_id).toBe("system")
    expect(events[1]?.type).toBe("goal_brief.versioned")
    expect(events[1]?.actor_id).toBe("user")
    expect(JSON.parse(events[0].data_json)).toMatchObject({
      version: 1,
      open_question_count: 1,
      blocking_question_count: 1,
    })
  })

  test.serial("enforces generation ownership and rejects broken durable bindings", () => {
    const input = {
      source: "system_suggestion" as const,
      brief: brief(),
    }
    expect(() => GoalBriefStore.completeGeneration("request-missing", "hash-missing", "owner-missing", input)).toThrow(
      "reservation is missing",
    )

    expect(GoalBriefStore.reserveGeneration("request-complete", "hash-complete", "owner-complete")).toEqual({
      status: "reserved",
    })
    expect(GoalBriefStore.extendGenerationLease("request-complete", "hash-complete", "owner-complete")).toBe(true)
    expect(GoalBriefStore.completeGeneration("request-complete", "hash-conflict", "owner-complete", input)).toEqual({
      status: "conflict",
    })
    const completed = GoalBriefStore.completeGeneration("request-complete", "hash-complete", "owner-complete", input)
    expect(completed.status).toBe("completed")
    if (completed.status !== "completed") throw new Error("Expected generation completion")
    expect(
      GoalBriefStore.append(completed.brief.id, {
        expectedVersion: 1,
        source: "user_confirmation",
        brief: brief("后续确认版本"),
      }),
    ).toMatchObject({ ok: true, brief: { version: 2 } })
    const replay = GoalBriefStore.completeGeneration("request-complete", "hash-complete", "owner-stale", input)
    expect(replay).toEqual(completed)

    expect(GoalBriefStore.reserveGeneration("request-takeover", "hash-takeover", "owner-stale", 100, 10)).toEqual({
      status: "reserved",
    })
    expect(GoalBriefStore.reserveGeneration("request-takeover", "hash-takeover", "owner-current", 110, 10)).toEqual({
      status: "reserved",
    })
    expect(GoalBriefStore.completeGeneration("request-takeover", "hash-takeover", "owner-stale", input)).toEqual({
      status: "ownership_lost",
    })

    Database.Client().$client.run("PRAGMA foreign_keys = OFF")
    Database.use((db) =>
      db
        .insert(GoalBriefGenerationRequestTable)
        .values({
          request_id: "request-dangling",
          payload_hash: "hash-dangling",
          owner_token: "owner-dangling",
          lease_expires_at: 100,
          brief_id: "brief-missing",
          created_at: 100,
          updated_at: 100,
        })
        .run(),
    )
    Database.Client().$client.run("PRAGMA foreign_keys = ON")
    expect(() =>
      GoalBriefStore.reserveGeneration("request-dangling", "hash-dangling", "owner-dangling", 100, 10),
    ).toThrow("missing Brief")
    Database.use((db) =>
      db
        .delete(GoalBriefGenerationRequestTable)
        .where(eq(GoalBriefGenerationRequestTable.request_id, "request-dangling"))
        .run(),
    )

    Database.use((db) => {
      db.insert(GoalBriefTable)
        .values({
          id: "brief-without-version",
          project_id: null,
          source_thread_id: null,
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(GoalBriefGenerationRequestTable)
        .values({
          request_id: "request-without-version",
          payload_hash: "hash-without-version",
          owner_token: "owner-without-version",
          lease_expires_at: 100,
          brief_id: "brief-without-version",
          created_at: 100,
          updated_at: 100,
        })
        .run()
    })
    expect(() =>
      GoalBriefStore.completeGeneration(
        "request-without-version",
        "hash-without-version",
        "owner-without-version",
        input,
      ),
    ).toThrow("missing Brief")
  })

  test.serial("reads a historical Charter as a non-persisted compatibility view", () => {
    const projectID = project("project-legacy")
    Database.use((db) =>
      db
        .insert(CompanyProjectCharterTable)
        .values({
          project_id: projectID,
          title: "Legacy Charter",
          value: "历史价值",
          deliverables_json: JSON.stringify(["历史交付物"]),
          scope_json: JSON.stringify(["历史范围"]),
          non_goals_json: JSON.stringify(["历史非目标"]),
          success_criteria_json: JSON.stringify(["历史成功标准"]),
          constraints_json: JSON.stringify(["历史约束"]),
          resources_json: JSON.stringify([]),
          risks_json: JSON.stringify([]),
          dri_agent_id: "legacy-owner",
          milestones_json: JSON.stringify(["历史里程碑"]),
          open_decisions_json: JSON.stringify(["历史开放问题"]),
          acceptance_criteria_json: JSON.stringify(["历史验收标准"]),
          policy_json: JSON.stringify({ source_approval_preset: "strict" }),
          created_at: 100,
          updated_at: 100,
        })
        .run(),
    )

    const view = GoalBriefProjectView.parse(GoalBriefStore.projectView(projectID))
    expect(view.kind).toBe("legacy_charter")
    if (view.kind !== "legacy_charter") throw new Error("Expected legacy view")
    expect(view.brief).toMatchObject({
      goal: "历史项目目标",
      deliverables: ["历史交付物"],
      acceptanceCriteria: ["历史验收标准"],
      riskLevel: null,
      recommendedPlan: null,
      source: "legacy_charter",
    })
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
    expect(
      Database.use((db) =>
        db
          .select({ title: CompanyProjectCharterTable.title })
          .from(CompanyProjectCharterTable)
          .where(eq(CompanyProjectCharterTable.project_id, projectID))
          .get(),
      ),
    ).toEqual({ title: "Legacy Charter" })
  })

  test.serial("returns only complete current versions and rejects an invalid legacy policy", () => {
    const projectID = project("project-current-brief")
    const created = GoalBriefStore.create({
      projectId: projectID,
      source: "user_input",
      brief: brief(),
    })

    expect(GoalBriefProjectView.parse(GoalBriefStore.projectView(projectID))).toMatchObject({
      kind: "goal_brief",
      brief: { id: created.id, version: 1 },
    })
    Database.use((db) => db.delete(GoalBriefVersionTable).where(eq(GoalBriefVersionTable.brief_id, created.id)).run())
    expect(
      GoalBriefStore.append(created.id, {
        expectedVersion: 1,
        source: "user_confirmation",
        brief: brief(),
      }),
    ).toEqual({ ok: false, reason: "not_found" })
    expect(GoalBriefStore.projectView(projectID)).toBeUndefined()

    const legacyProjectID = project("project-invalid-legacy")
    Database.use((db) =>
      db
        .insert(CompanyProjectCharterTable)
        .values({
          project_id: legacyProjectID,
          title: "Invalid Legacy Charter",
          value: "历史价值",
          deliverables_json: "[]",
          scope_json: "[]",
          non_goals_json: "[]",
          success_criteria_json: "[]",
          constraints_json: "[]",
          resources_json: "[]",
          risks_json: "[]",
          dri_agent_id: "legacy-owner",
          milestones_json: "[]",
          open_decisions_json: "[]",
          acceptance_criteria_json: "[]",
          policy_json: JSON.stringify({ source_approval_preset: "unsupported" }),
          created_at: 100,
          updated_at: 100,
        })
        .run(),
    )
    expect(GoalBriefStore.projectView(legacyProjectID)).toBeUndefined()
  })
})
