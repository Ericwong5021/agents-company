import { afterEach, beforeEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CompanyProject } from "../../src/company-project"
import {
  CompanyGraphMutationTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import { CompanyProjectAssignmentTable } from "../../src/company-recruitment/company-recruitment.sql"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { DispatchCoordinator } from "../../src/project-orchestrator/dispatch"
import { Database, eq } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(CompanyProject.defaultLayer, DispatchCoordinator.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

let previousExecutionMode: string | undefined

beforeEach(() => {
  previousExecutionMode = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
})

afterEach(async () => {
  await resetDatabase()
  if (previousExecutionMode === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previousExecutionMode
})

function projectFacts(projectId: string) {
  return Database.use((db) => ({
    project: db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectId)).get(),
    workItems: db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.project_id, projectId)).all(),
    attempts: db.select().from(CompanyWorkAttemptTable).where(eq(CompanyWorkAttemptTable.project_id, projectId)).all(),
    receipts: db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.project_id, projectId)).all(),
    mutations: db
      .select()
      .from(CompanyGraphMutationTable)
      .where(eq(CompanyGraphMutationTable.project_id, projectId))
      .all(),
    assignments: db
      .select()
      .from(CompanyProjectAssignmentTable)
      .where(eq(CompanyProjectAssignmentTable.project_id, projectId))
      .all(),
    events: db.select().from(CompanyProjectEventTable).where(eq(CompanyProjectEventTable.project_id, projectId)).all(),
  }))
}

describe("Dispatch barrier", () => {
  it.live("persists pause state and excludes unassigned ready WorkItems", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const dispatch = yield* DispatchCoordinator.Service
        const project = yield* projects.create({
          goal: "Dispatch only assigned nodes",
          execution_strategy: "seed_and_grow",
          seed_mode: "direct_single",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        const paused = yield* dispatch.pauseDispatch(project.id, "test barrier")
        const pausedReplay = yield* dispatch.pauseDispatch(project.id, "test barrier replay")
        expect(paused).toMatchObject({
          status: "paused",
          barrier: "paused",
          barrier_changed: true,
          replayed: false,
        })
        expect(pausedReplay).toMatchObject({
          barrier_changed: false,
          barrier_event_id: paused.barrier_event_id,
          idempotency_key: paused.idempotency_key,
          replayed: true,
        })
        expect(yield* projects.get(project.id)).toMatchObject({
          dispatch_paused: true,
          orchestration_state: "paused",
        })
        const resumed = yield* dispatch.resumeDispatch(project.id, "resume test")
        const resumedReplay = yield* dispatch.resumeDispatch(project.id, "resume test replay")
        expect(resumed).toMatchObject({
          status: "idle",
          barrier: "open",
          barrier_changed: true,
          replayed: false,
        })
        expect(resumedReplay).toMatchObject({
          barrier_changed: false,
          barrier_event_id: resumed.barrier_event_id,
          idempotency_key: resumed.idempotency_key,
          replayed: true,
        })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Dispatch policy",
          acceptance_criteria: ["Assignment is required"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Unassigned",
          description: "Owner text without Assignment is insufficient",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          owner_agent_id: "agent-without-assignment",
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["Assignment exists"],
        })
        const result = yield* dispatch.dispatchReady(project.id)
        expect(result).toMatchObject({
          status: "idle",
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        })
        expect((yield* projects.listWorkItems(project.id)).find((candidate) => candidate.id === item.id)?.status).toBe(
          "pending",
        )
      }),
    ),
  )

  it.live("[b5-local-rollback] stops Seed-and-Grow dispatch and preserves pinned project facts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const dispatch = yield* DispatchCoordinator.Service
        for (const [to, idempotencyKey] of [
          ["shadow", "b5-shadow"],
          ["opt_in", "b5-opt-in"],
          ["dogfood_default", "b5-dogfood"],
        ] as const)
          CompanyRollout.transition({
            idempotencyKey,
            to,
            reason: `B5 local rollback reaches ${to}`,
          })
        expect(CompanyRollout.resolveNewProjectStrategy()).toBe("seed_and_grow")
        expect(CompanyRollout.resolveNewProjectStrategy("legacy_full_plan")).toBe("legacy_full_plan")

        const project = yield* projects.create({
          goal: "Preserve an in-flight Seed-and-Grow project during rollback",
          execution_strategy: CompanyRollout.resolveNewProjectStrategy(),
          seed_mode: "direct_single",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Rollback preservation",
          acceptance_criteria: ["No Seed-and-Grow dispatch after kill switch"],
        })
        yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Remain pending",
          description: "This work must remain untouched while orchestration is off.",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          owner_agent_id: "rollback-agent",
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["No dispatch"],
        })
        const before = projectFacts(project.id)

        process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
        expect(CompanyRollout.status()).toMatchObject({
          state: { phase: "dogfood_default" },
          executionMode: "off",
          newProjectPolicy: {
            defaultStrategy: "legacy_full_plan",
            seedOptInAllowed: false,
            explicitLegacyFallbackAllowed: false,
          },
        })
        expect(CompanyRollout.resolveNewProjectStrategy("seed_and_grow")).toBe("legacy_full_plan")
        expect(yield* dispatch.dispatchReady(project.id)).toEqual({
          project_id: project.id,
          status: "paused",
          barrier: "paused",
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        })
        expect(projectFacts(project.id)).toEqual(before)
        expect(yield* projects.get(project.id)).toMatchObject({
          execution_strategy: "seed_and_grow",
          dispatch_paused: false,
        })
        const fallback = yield* projects.create({
          goal: "Use the legacy fallback for a new project after rollback",
          execution_strategy: CompanyRollout.resolveNewProjectStrategy(),
        })
        expect(fallback.execution_strategy).toBe("legacy_full_plan")

        const directory = path.resolve(import.meta.dir, "../../.artifacts/seed-grow-b5")
        const existingProject = yield* projects.get(project.id)
        yield* Effect.promise(async () => {
          await mkdir(directory, { recursive: true })
          await Bun.write(
            path.join(directory, "local-rollback.json"),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                result: "pass",
                phaseRetained: CompanyRollout.status().state.phase,
                executionMode: CompanyRollout.status().executionMode,
                newProjectStrategy: fallback.execution_strategy,
                existingProjectStrategy: existingProject?.execution_strategy,
                seedDispatchStatus: "paused",
                dataPreserved: true,
                destructiveRetirement: false,
              },
              null,
              2,
            )}\n`,
          )
        })
      }),
    ),
  )
})
