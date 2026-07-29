import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import type { GoalBriefDraft } from "@agents-company/shared/experience"
import {
  CompanyAttention,
  CompanyProjectDirection,
} from "../../src/company-project"
import type { AdjustDirectionRequest } from "../../src/company-project/direction"
import {
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "../../src/company-project/company-project.sql"
import { GoalBriefStore } from "../../src/goal-brief"
import { GoalBriefVersionTable } from "../../src/goal-brief/goal-brief.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

function draft(label: string): GoalBriefDraft {
  return {
    goal: `Goal ${label}`,
    deliverables: [
      {
        id: `deliverable-${label}`,
        title: `Deliverable ${label}`,
        description: `Deliverable description ${label}`,
      },
    ],
    acceptanceCriteria: [
      {
        id: `criterion-${label}`,
        description: `Acceptance ${label}`,
        verification: `Verify ${label}`,
      },
    ],
    constraints: [`Constraint ${label}`],
    nonGoals: [`Non-goal ${label}`],
    assumptions: [
      {
        id: `assumption-${label}`,
        description: `Assumption ${label}`,
        confirmed: false,
      },
    ],
    openQuestions: [],
    riskLevel: "medium",
    recommendedPlan: {
      summary: `Plan ${label}`,
      steps: [
        {
          id: `step-${label}`,
          title: `Step ${label}`,
          outcome: `Outcome ${label}`,
        },
      ],
    },
    approvalMode: "balanced",
    sourceRefs: [{ kind: "user", id: `user-${label}` }],
  }
}

function seed(label: string) {
  const project_id = `project-direction-${label}`
  const plan_id = `plan-direction-${label}-1`
  const now = Date.now()
  Database.use((db) => {
    db.insert(CompanyProjectTable)
      .values({
        id: project_id,
        goal: `Goal initial ${label}`,
        title: `Direction ${label}`,
        status: "executing",
        output_dir: `/tmp/${project_id}`,
        active_plan_version: 1,
        graph_revision: 4,
        dispatch_paused: true,
        created_at: now,
        updated_at: now,
      })
      .run()
    db.insert(CompanyPlanTable)
      .values({
        id: plan_id,
        project_id,
        version: 1,
        phase: "execution",
        status: "active",
        summary: `Initial plan ${label}`,
        assumptions_json: "[]",
        acceptance_criteria_json: JSON.stringify([`Initial acceptance ${label}`]),
        change_reason: null,
        created_at: now,
      })
      .run()
  })
  const brief = GoalBriefStore.create({
    projectId: project_id,
    source: "user_input",
    brief: draft(`initial-${label}`),
  })
  return { project_id, plan_id, brief }
}

function input(
  value: ReturnType<typeof seed>,
  label: string,
  overrides: Partial<AdjustDirectionRequest> = {},
): AdjustDirectionRequest {
  return CompanyProjectDirection.AdjustDirectionRequest.parse({
    project_id: value.project_id,
    brief_id: value.brief.id,
    idempotency_key: `adjust-${label}`,
    expected_graph_revision: 4,
    expected_brief_version: 1,
    expected_plan_version: 1,
    source: "user_confirmation",
    brief: draft(`adjusted-${label}`),
    change_reason: `Direction changed ${label}`,
    ...overrides,
  })
}

function adjust(
  value: AdjustDirectionRequest,
  layer = CompanyProjectDirection.defaultLayer,
) {
  return Effect.runPromise(
    CompanyProjectDirection.Service.use((service) => service.adjust(value)).pipe(
      Effect.provide(layer),
    ),
  )
}

function openScopeAttention(project_id: string) {
  return Effect.runPromise(
    CompanyAttention.Service.use((service) =>
      service.open({
        project_id,
        idempotency_key: `attention-${project_id}`,
        issue: { issue_kind: "scope_change", risk: "high", materiality: "scope" },
        title: "Scope changed",
        summary: "The user changed the project direction",
        required_decision: "Confirm the new direction",
        source_refs: [{ kind: "project", id: project_id }],
      }),
    ).pipe(Effect.provide(CompanyAttention.defaultLayer)),
  )
}

function countRows(table: typeof CompanyPlanTable | typeof GoalBriefVersionTable) {
  return Database.use((db) => db.select({ value: count() }).from(table).get())!.value
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("CompanyProjectDirection", () => {
  test.serial("atomically versions the Goal Brief and derived Plan and replays once", async () => {
    const seeded = seed("atomic")
    const attention = await openScopeAttention(seeded.project_id)
    const request = input(seeded, "atomic", { attention_id: attention!.record.id })
    const result = await adjust(request)
    expect(result).toMatchObject({
      status: "applied",
      replayed: false,
      brief: { id: seeded.brief.id, version: 2, goal: "Goal adjusted-atomic" },
      plan: {
        version: 2,
        phase: "replan",
        status: "active",
        summary: "Plan adjusted-atomic",
        assumptions: ["Assumption adjusted-atomic"],
        acceptance_criteria: ["Acceptance adjusted-atomic"],
        change_reason: "Direction changed atomic",
      },
      action: {
        attention_id: attention!.record.id,
        action: "adjust_brief",
        status: "applied",
        expected_revision: 4,
      },
    })

    const project = Database.use((db) =>
      db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, seeded.project_id)).get(),
    )
    expect(project).toMatchObject({
      goal: "Goal adjusted-atomic",
      active_plan_version: 2,
      graph_revision: 5,
    })
    expect(
      Database.use((db) =>
        db
          .select({ version: CompanyPlanTable.version, status: CompanyPlanTable.status })
          .from(CompanyPlanTable)
          .where(eq(CompanyPlanTable.project_id, seeded.project_id))
          .orderBy(CompanyPlanTable.version)
          .all(),
      ),
    ).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "active" },
    ])
    expect(countRows(GoalBriefVersionTable)).toBe(2)
    expect(countRows(CompanyPlanTable)).toBe(2)

    const replayed = await adjust(request)
    expect(replayed).toEqual({ ...result, replayed: true })
    expect(countRows(GoalBriefVersionTable)).toBe(2)
    expect(countRows(CompanyPlanTable)).toBe(2)
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectEventTable)
          .where(eq(CompanyProjectEventTable.type, "project.direction_adjusted"))
          .get(),
      )!.value,
    ).toBe(1)
    await expect(
      adjust({
        ...request,
        change_reason: "A different command under the same key",
      }),
    ).rejects.toThrow("different facts")
  })

  test.serial("rejects graph, Brief, and Plan CAS conflicts before version writes", async () => {
    const graph = seed("graph-conflict")
    const graphResult = await adjust(
      input(graph, "graph-conflict", { expected_graph_revision: 3 }),
    )
    expect(graphResult).toMatchObject({
      status: "rejected",
      reason: "project_revision_conflict",
      conflict: { expected_revision: 3, current_revision: 4 },
      action: { status: "rejected" },
    })

    const brief = seed("brief-conflict")
    const briefResult = await adjust(
      input(brief, "brief-conflict", { expected_brief_version: 2 }),
    )
    expect(briefResult).toMatchObject({
      status: "rejected",
      reason: "brief_version_conflict",
      conflict: { expected_brief_version: 2, current_brief_version: 1 },
      action: { status: "rejected" },
    })

    const plan = seed("plan-conflict")
    const planResult = await adjust(
      input(plan, "plan-conflict", { expected_plan_version: 2 }),
    )
    expect(planResult).toMatchObject({
      status: "rejected",
      reason: "plan_version_conflict",
      conflict: { expected_plan_version: 2, current_plan_version: 1 },
      action: { status: "rejected" },
    })
    expect(countRows(GoalBriefVersionTable)).toBe(3)
    expect(countRows(CompanyPlanTable)).toBe(3)
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.status, "rejected"))
          .get(),
      )!.value,
    ).toBe(3)
  })

  test.serial("rolls back a partial transaction while preserving and replaying its intent", async () => {
    const seeded = seed("rollback")
    const request = input(seeded, "rollback")
    const faultLayer = CompanyProjectDirection.makeLayer({
      onBoundary: (boundary) => {
        if (boundary === "after_brief_version") throw new Error("injected transaction failure")
      },
    }).pipe(Layer.provide(CompanyAttention.defaultLayer))
    await expect(adjust(request, faultLayer)).rejects.toThrow("injected transaction failure")

    expect(countRows(GoalBriefVersionTable)).toBe(1)
    expect(countRows(CompanyPlanTable)).toBe(1)
    expect(
      Database.use((db) =>
        db
          .select()
          .from(CompanyProjectActionTable)
          .where(eq(CompanyProjectActionTable.project_id, seeded.project_id))
          .get(),
      ),
    ).toMatchObject({ status: "claimed" })
    expect(
      Database.use((db) =>
        db
          .select({ value: count() })
          .from(CompanyProjectEventTable)
          .where(eq(CompanyProjectEventTable.type, "goal_brief.versioned"))
          .get(),
      )!.value,
    ).toBe(0)

    const recovered = await adjust(request)
    expect(recovered).toMatchObject({
      status: "applied",
      replayed: true,
      brief: { version: 2 },
      plan: { version: 2 },
      action: { status: "applied" },
    })
    expect(countRows(GoalBriefVersionTable)).toBe(2)
    expect(countRows(CompanyPlanTable)).toBe(2)
  })

  test.serial("replays a committed action after an interrupted response without duplicates", async () => {
    const seeded = seed("after-commit")
    const request = input(seeded, "after-commit")
    const faultLayer = CompanyProjectDirection.makeLayer({
      onBoundary: (boundary) => {
        if (boundary === "after_commit") throw new Error("response interrupted")
      },
    }).pipe(Layer.provide(CompanyAttention.defaultLayer))
    await expect(adjust(request, faultLayer)).rejects.toThrow("response interrupted")
    expect(countRows(GoalBriefVersionTable)).toBe(2)
    expect(countRows(CompanyPlanTable)).toBe(2)

    expect(await adjust(request)).toMatchObject({
      status: "applied",
      replayed: true,
      brief: { version: 2 },
      plan: { version: 2 },
      action: { status: "applied" },
    })
    expect(countRows(GoalBriefVersionTable)).toBe(2)
    expect(countRows(CompanyPlanTable)).toBe(2)
  })
})
