import { Context, Effect, Layer } from "effect"
import { asc, desc, eq } from "drizzle-orm"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import { CompanyGraphMutation } from "./graph-mutation"
import { CompanyValidationGate } from "./validation-gate"
import { CompanyWorkFacts } from "./work-facts"
import * as WorkProjection from "./work-projection"

export type Boundary =
  | "before_recovery"
  | "after_receipts"
  | "after_mutations"
  | "after_gates"
  | "after_work_items"
  | "after_projections"

type Hooks = {
  onBoundary?: (boundary: Boundary) => void
}

export type RecoveryReport = {
  receipts: {
    reconciled_attempt_ids: string[]
    processed_receipt_ids: string[]
    pending_seed_receipt_ids: string[]
  }
  mutations: CompanyGraphMutation.RecoveryResult
  gates: CompanyValidationGate.RecoveryResult
  work_items: {
    completed_work_item_ids: string[]
    blocked_work_item_ids: string[]
    confirmed_work_item_ids: string[]
  }
  rebuilt_project_ids: string[]
}

function reconcileWorkItems() {
  return Database.transaction(
    (db) => {
      const completed_work_item_ids: string[] = []
      const blocked_work_item_ids: string[] = []
      const confirmed_work_item_ids: string[] = []
      db.select()
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.status, "running"))
        .orderBy(asc(CompanyWorkItemTable.created_at), asc(CompanyWorkItemTable.id))
        .all()
        .forEach((item) => {
          const attempt = db
            .select()
            .from(CompanyWorkAttemptTable)
            .where(eq(CompanyWorkAttemptTable.work_item_id, item.id))
            .orderBy(desc(CompanyWorkAttemptTable.ordinal))
            .get()
          const receipt = attempt
            ? db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.attempt_id, attempt.id)).get()
            : undefined
          const run = attempt?.agent_run_id
            ? db.select().from(AgentRunTable).where(eq(AgentRunTable.id, attempt.agent_run_id)).get()
            : undefined
          const now = Date.now()
          const nextStatus =
            receipt && attempt?.status === "completed"
              ? "completed"
              : receipt && attempt?.status !== "running"
                ? "blocked"
                : run && ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state)
                  ? "running"
                  : "blocked"
          if (nextStatus === "running") {
            confirmed_work_item_ids.push(item.id)
            return
          }
          const error =
            nextStatus === "blocked"
              ? receipt?.summary || run?.safe_error_summary || "Runtime ended without a terminal Work Receipt"
              : null
          db.update(CompanyWorkItemTable)
            .set({
              status: nextStatus,
              error,
              completed_at: nextStatus === "completed" ? now : null,
              updated_at: now,
            })
            .where(eq(CompanyWorkItemTable.id, item.id))
            .run()
          if (attempt?.status === "running" && nextStatus === "blocked") {
            db.update(CompanyWorkAttemptTable)
              .set({
                status: "stopped",
                failure_kind: "environment",
                safe_summary: error,
                finished_at: now,
              })
              .where(eq(CompanyWorkAttemptTable.id, attempt.id))
              .run()
          }
          db.insert(CompanyProjectEventTable)
            .values({
              id: Identifier.ascending("event"),
              project_id: item.project_id,
              type: "work_item.recovered",
              actor_id: null,
              data_json: JSON.stringify({
                work_item_id: item.id,
                previous_status: item.status,
                next_status: nextStatus,
                attempt_id: attempt?.id,
                receipt_id: receipt?.id,
                agent_run_id: run?.id,
                error,
              }),
              created_at: now,
            })
            .run()
          if (nextStatus === "completed") {
            completed_work_item_ids.push(item.id)
            return
          }
          blocked_work_item_ids.push(item.id)
        })
      return {
        completed_work_item_ids,
        blocked_work_item_ids,
        confirmed_work_item_ids,
      }
    },
    { behavior: "immediate" },
  )
}

export interface Interface {
  readonly recover: () => Effect.Effect<RecoveryReport>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyProjectRecovery") {}

export function makeLayer(hooks: Hooks = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const facts = yield* CompanyWorkFacts.Service
      const graph = yield* CompanyGraphMutation.Service
      const gates = yield* CompanyValidationGate.Service
      const recover = Effect.fn("CompanyProjectRecovery.recover")(function* () {
        hooks.onBoundary?.("before_recovery")
        const receipts = yield* facts.recover()
        hooks.onBoundary?.("after_receipts")
        const mutations = yield* graph.recover()
        if (mutations.unresolved_mutation_ids.length) {
          throw new Error(`Unresolved Graph Mutations: ${mutations.unresolved_mutation_ids.join(", ")}`)
        }
        hooks.onBoundary?.("after_mutations")
        const recoveredGates = yield* gates.recover()
        hooks.onBoundary?.("after_gates")
        const work_items = yield* Effect.sync(reconcileWorkItems)
        hooks.onBoundary?.("after_work_items")
        const rebuilt_project_ids = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({ id: CompanyProjectTable.id })
              .from(CompanyProjectTable)
              .orderBy(asc(CompanyProjectTable.created_at), asc(CompanyProjectTable.id))
              .all(),
          ).map((project) => {
            WorkProjection.rebuild(project.id)
            return project.id
          }),
        )
        hooks.onBoundary?.("after_projections")
        return {
          receipts,
          mutations,
          gates: recoveredGates,
          work_items,
          rebuilt_project_ids,
        }
      })
      return Service.of({ recover })
    }),
  )
}

export const defaultLayer = makeLayer().pipe(
  Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
  Layer.provide(CompanyGraphMutation.defaultLayer),
  Layer.provide(CompanyValidationGate.defaultLayer),
)

export * as CompanyProjectRecovery from "./recovery"
