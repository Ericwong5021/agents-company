import { Context, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { CompanyProject } from "@/company-project/company-project"
import {
  CompanyAttentionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "@/company-project/company-project.sql"
import { CompanyProjectExecution } from "@/company-project/execution"
import { CompanyRecruitment } from "@/company-recruitment"
import { Flag } from "@/flag/flag"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"

export type DispatchResult = {
  project_id: string
  status: "paused" | "gated" | "idle" | "dispatched"
  barrier: "open" | "paused"
  eligible_work_item_ids: string[]
  dispatched_work_item_ids: string[]
  run_id?: string
}

export type DispatchBarrierResult = DispatchResult & {
  barrier_changed: boolean
  barrier_event_id?: string
  idempotency_key: string
  replayed: boolean
}

export interface Interface {
  readonly dispatchReady: (project_id: string) => Effect.Effect<DispatchResult>
  readonly pauseDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchBarrierResult>
  readonly resumeDispatch: (project_id: string, reason?: string) => Effect.Effect<DispatchBarrierResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/DispatchCoordinator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const recruitment = yield* CompanyRecruitment.Service
    const execution = yield* CompanyProjectExecution.Service

    const setBarrier = Effect.fn("DispatchCoordinator.setBarrier")(function* (input: {
      project_id: string
      paused: boolean
      reason?: string
    }) {
      return yield* Effect.sync(() =>
        Database.transaction(
          (db) => {
            const project = db
              .select()
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, input.project_id))
              .get()
            if (!project) throw new Error(`Company project not found: ${input.project_id}`)
            if (project.dispatch_paused === input.paused) {
              const event = db
                .select()
                .from(CompanyProjectEventTable)
                .where(eq(CompanyProjectEventTable.project_id, input.project_id))
                .orderBy(CompanyProjectEventTable.created_at, CompanyProjectEventTable.id)
                .all()
                .findLast((candidate) => candidate.type === (input.paused ? "dispatch.paused" : "dispatch.resumed"))
              return { changed: false, event_id: event?.id }
            }
            const now = Date.now()
            const event_id = Identifier.ascending("event")
            db.update(CompanyProjectTable)
              .set({
                dispatch_paused: input.paused,
                orchestration_state: input.paused ? "paused" : "idle",
                updated_at: now,
              })
              .where(eq(CompanyProjectTable.id, input.project_id))
              .run()
            db.insert(CompanyProjectEventTable)
              .values({
                id: event_id,
                project_id: input.project_id,
                type: input.paused ? "dispatch.paused" : "dispatch.resumed",
                actor_id: null,
                data_json: JSON.stringify({ reason: input.reason?.slice(0, 2_000) }),
                created_at: now,
              })
              .run()
            return { changed: true, event_id }
          },
          { behavior: "immediate" },
        ),
      )
    })

    const dispatchReady = Effect.fn("DispatchCoordinator.dispatchReady")(function* (project_id: string) {
      const project = yield* projects.get(project_id)
      if (!project) throw new Error(`Company project not found: ${project_id}`)
      if (project.execution_strategy === "seed_and_grow" && Flag.AGENTCOMPANY_SEED_GROW_ORCHESTRATION !== "active")
        return {
          project_id,
          status: "paused" as const,
          barrier: "paused" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        }
      if (project.dispatch_paused)
        return {
          project_id,
          status: "paused" as const,
          barrier: "paused" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        }
      const approvalGates = yield* projects.listGates(project_id)
      const materialAttention = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ id: CompanyAttentionTable.id })
            .from(CompanyAttentionTable)
            .where(
              and(
                eq(CompanyAttentionTable.project_id, project_id),
                eq(CompanyAttentionTable.status, "open"),
                eq(CompanyAttentionTable.material, true),
              ),
            )
            .get(),
        ),
      )
      if (approvalGates.some((gate) => gate.status === "pending") || materialAttention)
        return {
          project_id,
          status: "gated" as const,
          barrier: "open" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        }
      const assignments = yield* recruitment.listAssignments({ project_id })
      const eligible = (yield* projects.readyWorkItems(project_id))
        .filter((item) => item.kind !== "planner")
        .filter((item) =>
          assignments.some(
            (assignment) =>
              assignment.work_item_id === item.id &&
              assignment.agent_id === item.owner_agent_id &&
              (assignment.status === "assigned" || assignment.status === "active"),
          ),
        )
      if (!eligible.length)
        return {
          project_id,
          status: "idle" as const,
          barrier: "open" as const,
          eligible_work_item_ids: [],
          dispatched_work_item_ids: [],
        }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({ orchestration_state: "dispatching", updated_at: Date.now() })
            .where(eq(CompanyProjectTable.id, project_id))
            .run(),
        ),
      )
      const run_id = yield* execution.dispatchReady(project_id)
      const dispatched_work_item_ids = (yield* projects.listWorkItems(project_id))
        .filter((item) => eligible.some((candidate) => candidate.id === item.id) && item.status === "running")
        .map((item) => item.id)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyProjectTable)
            .set({ orchestration_state: "idle", updated_at: Date.now() })
            .where(eq(CompanyProjectTable.id, project_id))
            .run(),
        ),
      )
      return {
        project_id,
        status: dispatched_work_item_ids.length ? ("dispatched" as const) : ("idle" as const),
        barrier: "open" as const,
        eligible_work_item_ids: eligible.map((item) => item.id),
        dispatched_work_item_ids,
        run_id,
      }
    })

    const pauseDispatch = Effect.fn("DispatchCoordinator.pauseDispatch")(function* (
      project_id: string,
      reason?: string,
    ) {
      const barrier = yield* setBarrier({ project_id, paused: true, reason })
      return {
        ...(yield* dispatchReady(project_id)),
        barrier_changed: barrier.changed,
        barrier_event_id: barrier.event_id,
        idempotency_key: `dispatch-barrier:${project_id}:paused`,
        replayed: !barrier.changed,
      }
    })

    const resumeDispatch = Effect.fn("DispatchCoordinator.resumeDispatch")(function* (
      project_id: string,
      reason?: string,
    ) {
      const barrier = yield* setBarrier({ project_id, paused: false, reason })
      return {
        ...(yield* dispatchReady(project_id)),
        barrier_changed: barrier.changed,
        barrier_event_id: barrier.event_id,
        idempotency_key: `dispatch-barrier:${project_id}:open`,
        replayed: !barrier.changed,
      }
    })

    return Service.of({ dispatchReady, pauseDispatch, resumeDispatch })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyRecruitment.defaultLayer),
  Layer.provide(CompanyProjectExecution.defaultLayer),
)

export * as DispatchCoordinator from "./dispatch"
