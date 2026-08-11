import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gte } from "drizzle-orm"
import { AgentRun } from "@/agent-run/agent-run"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { CompanyProjectAssignmentTable } from "@/company-recruitment/company-recruitment.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { WorkflowRunTable } from "@/workflow/workflow.sql"
import { workflowRef } from "@/workflow/runtime-ref"
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
    reclaimed_work_item_ids: string[]
  }
  rebuilt_project_ids: string[]
}

function reconcileWorkItems() {
  return Database.transaction(
    (db) => {
      const completed_work_item_ids: string[] = []
      const blocked_work_item_ids: string[] = []
      const confirmed_work_item_ids: string[] = []
      const reclaimed_work_item_ids: string[] = []
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
          if (item.dispatch_claim_id) {
            const now = Date.now()
            const project = db
              .select({ status: CompanyProjectTable.status })
              .from(CompanyProjectTable)
              .where(eq(CompanyProjectTable.id, item.project_id))
              .get()
            const reservedWorkflow = item.workflow_run_id
              ? db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, item.workflow_run_id)).get()
              : undefined
            const activeAgentRun = db
              .select({ id: AgentRunTable.id })
              .from(AgentRunTable)
              .where(
                and(
                  eq(AgentRunTable.company_project_id, item.project_id),
                  eq(AgentRunTable.work_item_id, item.id),
                  gte(AgentRunTable.time_created, item.dispatch_claimed_at ?? item.started_at ?? item.updated_at),
                ),
              )
              .all()
              .find((run) => {
                const row = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, run.id)).get()
                return row && ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(row.state)
              })
            if (reservedWorkflow?.status === "running" || activeAgentRun)
              throw new Error(`Dispatch claim still has an active runtime for ${item.id}`)
            const retryable = !reservedWorkflow || reservedWorkflow.status === "cancelled"
            const nextStatus =
              retryable &&
              project &&
              !["completed", "rejected"].includes(project.status) &&
              item.attempt <= item.max_attempts
                ? "pending"
                : "blocked"
            const recoverySummary = reservedWorkflow
              ? reservedWorkflow.status === "cancelled"
                ? "Reserved Workflow run was cancelled before dispatch binding completed"
                : `Reserved Workflow run reached ${reservedWorkflow.status} before dispatch binding completed`
              : "Dispatch claim ended before the reserved Workflow run was created"
            if (attempt?.status === "running")
              db.update(CompanyWorkAttemptTable)
                .set({
                  status: "stopped",
                  failure_kind: "environment",
                  safe_summary: recoverySummary,
                  finished_at: now,
                })
                .where(eq(CompanyWorkAttemptTable.id, attempt.id))
                .run()
            db.update(CompanyWorkItemTable)
              .set({
                status: nextStatus,
                workflow_run_id: null,
                dispatch_claim_id: null,
                dispatch_claim_generation: null,
                dispatch_claimed_at: null,
                max_attempts: nextStatus === "pending" ? Math.max(item.max_attempts, item.attempt + 1) : item.max_attempts,
                error: nextStatus === "blocked" ? recoverySummary : null,
                updated_at: now,
              })
              .where(eq(CompanyWorkItemTable.id, item.id))
              .run()
            db.update(CompanyProjectAssignmentTable)
              .set({ status: "assigned", started_at: null })
              .where(
                and(
                  eq(CompanyProjectAssignmentTable.work_item_id, item.id),
                  eq(CompanyProjectAssignmentTable.status, "active"),
                ),
              )
              .run()
            db.insert(CompanyProjectEventTable)
              .values({
                id: Identifier.ascending("event"),
                project_id: item.project_id,
                type: "dispatch.claim_recovered",
                actor_id: null,
                data_json: JSON.stringify({
                  work_item_id: item.id,
                  attempt_id: attempt?.id,
                  claim_id: item.dispatch_claim_id,
                  workflow_run_id: item.workflow_run_id,
                  workflow_status: reservedWorkflow?.status,
                  next_status: nextStatus,
                }),
                created_at: now,
              })
              .run()
            reclaimed_work_item_ids.push(item.id)
            return
          }
          const receipt = attempt
            ? db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.attempt_id, attempt.id)).get()
            : undefined
          const run = attempt?.agent_run_id
            ? db.select().from(AgentRunTable).where(eq(AgentRunTable.id, attempt.agent_run_id)).get()
            : attempt
              ? db
                  .select()
                  .from(AgentRunTable)
                  .where(
                    and(
                      eq(AgentRunTable.company_project_id, item.project_id),
                      eq(AgentRunTable.work_item_id, item.id),
                      gte(AgentRunTable.time_created, attempt.started_at),
                    ),
                  )
                  .orderBy(desc(AgentRunTable.time_created), desc(AgentRunTable.id))
                  .get()
              : undefined
          const now = Date.now()
          const workflow = item.workflow_run_id
            ? db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, item.workflow_run_id)).get()
            : undefined
          const workflowFinalizing =
            workflow &&
            workflow.status !== "running" &&
            workflow.time_updated <= now &&
            now - workflow.time_updated < 30_000
          const nextStatus =
            receipt && attempt?.status === "completed"
              ? "completed"
              : receipt && attempt?.status !== "running"
                ? "blocked"
                : workflow?.status === "running" || workflowFinalizing
                  ? "running"
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
        reclaimed_work_item_ids,
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
      const agentRuns = yield* AgentRun.Service
      const agentSupervisor = yield* AgentRunSupervisor.Service
      const terminateClaimedRuns = Effect.fn("CompanyProjectRecovery.terminateClaimedRuns")(function* () {
        const claimed = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyWorkItemTable)
              .where(eq(CompanyWorkItemTable.status, "running"))
              .all()
              .filter((item) => item.dispatch_claim_id),
          ),
        )
        yield* Effect.forEach(
          claimed,
          (item) =>
            Effect.gen(function* () {
              if (item.workflow_run_id && workflowRef.current)
                yield* workflowRef.current.cancel({ runID: item.workflow_run_id })
              const candidates = (yield* agentRuns.list({ companyProjectID: item.project_id, limit: 500 })).filter(
                (run) =>
                  run.workItemID === item.id &&
                  run.time.created >= (item.dispatch_claimed_at ?? item.started_at ?? item.updated_at) &&
                  ["queued", "starting", "running", "interrupting", "awaiting_recovery"].includes(run.state),
              )
              yield* Effect.forEach(
                candidates,
                (run) =>
                  Effect.gen(function* () {
                    const attached = yield* agentSupervisor.stop(run.id)
                    if (attached) {
                      for (let attempt = 0; attempt < 120; attempt++) {
                        const current = yield* agentRuns.get(run.id)
                        if (!current || ["completed", "failed", "stopped"].includes(current.state)) return
                        yield* Effect.sleep("50 millis")
                      }
                      throw new Error(`Timed out stopping AgentRun ${run.id} for dispatch recovery`)
                    }
                    const started = (yield* agentRuns.events(run.id)).findLast((event) => event.type === "runtime.started")
                    const pid = started
                      ? (() => {
                          const value = JSON.parse(started.payloadJSON) as Record<string, unknown>
                          return typeof value.pid === "number" ? value.pid : undefined
                        })()
                      : undefined
                    if (pid !== undefined) {
                      const alive = yield* Effect.sync(() => {
                        try {
                          process.kill(pid, 0)
                          return true
                        } catch (error) {
                          return error instanceof Error && "code" in error && error.code === "ESRCH" ? false : true
                        }
                      })
                      if (alive) throw new Error(`Detached AgentRun ${run.id} is still active during dispatch recovery`)
                    }
                    yield* agentRuns.transition({
                      id: run.id,
                      state: "stopped",
                      exitCode: 130,
                      safeErrorSummary: "Dispatch recovery terminated an unbound Workflow run",
                    })
                  }),
                { concurrency: 4, discard: true },
              )
              if (!item.workflow_run_id) return
              yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .update(WorkflowRunTable)
                    .set({
                      status: "cancelled",
                      error: "Dispatch recovery cancelled the reserved Workflow run before binding completed",
                      time_updated: Date.now(),
                    })
                    .where(
                      and(eq(WorkflowRunTable.id, item.workflow_run_id!), eq(WorkflowRunTable.status, "running")),
                    )
                    .run(),
                ),
              )
            }),
          { concurrency: 1, discard: true },
        )
      })
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
        yield* terminateClaimedRuns()
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
  Layer.provide(AgentRun.defaultLayer),
  Layer.provide(AgentRunSupervisor.defaultLayer),
)

export * as CompanyProjectRecovery from "./recovery"
