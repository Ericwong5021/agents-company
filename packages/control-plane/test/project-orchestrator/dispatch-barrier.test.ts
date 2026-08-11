import { afterEach, beforeEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CompanyProject, CompanyProjectExecution } from "../../src/company-project"
import { CompanyRecruitment } from "../../src/company-recruitment"
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
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyRecruitment.defaultLayer,
    DispatchCoordinator.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const pauseRaceExecution = Layer.succeed(
  CompanyProjectExecution.Service,
  CompanyProjectExecution.Service.of({
    start: () => Effect.die("unused"),
    startFromCharter: () => Effect.die("unused"),
    replanFromCharter: () => Effect.die("unused"),
    retry: () => Effect.die("unused"),
    resolveGate: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    dispatchReady: (project_id) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({ dispatch_paused: true, dispatch_generation: 1, orchestration_state: "paused" })
            .where(eq(CompanyProjectTable.id, project_id))
            .run(),
          ),
      ).pipe(Effect.as(undefined)),
  }),
)
const pauseRaceDependencies = Layer.mergeAll(
  CompanyProject.defaultLayer,
  CompanyRecruitment.defaultLayer,
  pauseRaceExecution,
  CrossSpawnSpawner.defaultLayer,
)
const pauseRaceIt = testEffect(
  Layer.mergeAll(pauseRaceDependencies, DispatchCoordinator.layer.pipe(Layer.provide(pauseRaceDependencies))),
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
          dispatch_generation: 1,
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
        expect(yield* projects.get(project.id)).toMatchObject({
          dispatch_paused: false,
          dispatch_generation: 2,
          orchestration_state: "idle",
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

  it.live("increments the barrier generation and reclaims an unbound dispatch claim", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const recruitment = yield* CompanyRecruitment.Service
        const dispatch = yield* DispatchCoordinator.Service
        const project = yield* projects.create({ goal: "Pause before an assigned delivery launches" })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Pause-safe dispatch",
          acceptance_criteria: ["Unbound claims are reclaimed"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Prepare delivery",
          description: "Remain retryable when dispatch pauses before launch",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          capability_packs: ["analysis@1"],
          resource_scope: ["artifacts/delivery.json"],
          model_group: "standard",
          acceptance_criteria: ["Delivery exists"],
        })
        const need = yield* recruitment.createNeed({
          project_id: project.id,
          work_item_id: item.id,
          need_key: "pause-safe-dispatch-analyst",
          role: item.role,
          work_type: item.work_type,
          capability_packs: item.capability_packs,
          risk_level: item.risk_level,
          demand_horizon: "project",
          workspace_scopes: item.resource_scope,
        })
        const assignment = yield* recruitment.selectAndAssign({
          capability_need_id: need.id,
          exclude_agent_ids: [],
          permission_mode: "read_only",
        })
        const claim = yield* projects.claimWorkItemForDispatch(item.id)

        expect(claim).toBeDefined()
        expect(claim!.generation).toBe(0)
        expect(claim!.workflow_run_id).toBeString()
        const paused = yield* dispatch.pauseDispatch(project.id, "pause before runtime launch")
        const replayed = yield* dispatch.pauseDispatch(project.id, "pause replay")
        const facts = projectFacts(project.id)

        expect(paused).toMatchObject({ barrier_changed: true, replayed: false })
        expect(replayed).toMatchObject({
          barrier_changed: false,
          barrier_event_id: paused.barrier_event_id,
          replayed: true,
        })
        expect(facts.project).toMatchObject({ dispatch_paused: true, dispatch_generation: 1 })
        expect(facts.workItems).toMatchObject([
          {
            id: item.id,
            status: "pending",
            attempt: 1,
            dispatch_claim_id: null,
            dispatch_claim_generation: null,
            dispatch_claimed_at: null,
            workflow_run_id: null,
          },
        ])
        expect(facts.attempts).toMatchObject([
          {
            id: claim!.attempt_id,
            work_item_id: item.id,
            ordinal: 1,
            status: "stopped",
            failure_kind: "environment",
          },
        ])
        expect(facts.assignments.find((candidate) => candidate.id === assignment.assignment.id)).toMatchObject({
          status: "assigned",
          started_at: null,
        })
      }),
    ),
  )

  pauseRaceIt.live("does not overwrite a concurrent pause when a dispatch wave finishes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const recruitment = yield* CompanyRecruitment.Service
        const dispatch = yield* DispatchCoordinator.Service
        const project = yield* projects.create({ goal: "Preserve a concurrent dispatch pause" })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Pause interleaving",
          acceptance_criteria: ["Pause remains authoritative"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Concurrent pause target",
          description: "Remain pending while dispatch pauses",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          capability_packs: ["analysis@1"],
          resource_scope: ["artifacts/pause-race.json"],
          model_group: "standard",
          acceptance_criteria: ["Pause remains authoritative"],
        })
        const need = yield* recruitment.createNeed({
          project_id: project.id,
          work_item_id: item.id,
          need_key: "pause-race-analyst",
          role: item.role,
          work_type: item.work_type,
          capability_packs: item.capability_packs,
          risk_level: item.risk_level,
          demand_horizon: "project",
          workspace_scopes: item.resource_scope,
        })
        yield* recruitment.selectAndAssign({
          capability_need_id: need.id,
          exclude_agent_ids: [],
          permission_mode: "read_only",
        })

        expect(yield* dispatch.dispatchReady(project.id)).toMatchObject({
          status: "paused",
          barrier: "paused",
          eligible_work_item_ids: [item.id],
          dispatched_work_item_ids: [],
        })
        expect(yield* projects.get(project.id)).toMatchObject({
          dispatch_paused: true,
          dispatch_generation: 1,
          orchestration_state: "paused",
        })
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
