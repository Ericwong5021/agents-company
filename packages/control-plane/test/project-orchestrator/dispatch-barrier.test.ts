import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CompanyProject } from "../../src/company-project"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { DispatchCoordinator } from "../../src/project-orchestrator/dispatch"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    DispatchCoordinator.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(async () => {
  await Instance.disposeAll()
})

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
})
