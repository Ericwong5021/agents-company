import { Context, Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import { validateGraphPatch } from "./graph-patch-validator"
import {
  GraphMutation,
  GraphMutationProposal,
  GraphSnapshot,
  WorkReceiptEvidenceRef,
  type GraphMutation as GraphMutationType,
  type GraphMutationProposal as GraphMutationProposalType,
  type GraphPolicyVerdict as GraphPolicyVerdictType,
  type GraphSnapshot as GraphSnapshotType,
} from "./schema"

export const GraphInvalidated = BusEvent.define(
  "company.project.graph.invalidated",
  z
    .object({
      project_id: z.string(),
      mutation_id: z.string(),
      graph_revision: z.number().int().nonnegative(),
    })
    .strict(),
)

export type Boundary =
  | "before_transaction"
  | "after_mutation_write"
  | "after_operations"
  | "after_revision"
  | "after_event"
  | "after_commit"
  | "after_broadcast"

type Hooks = {
  onBoundary?: (boundary: Boundary) => void
  publish?: (input: { project_id: string; mutation_id: string; graph_revision: number }) => Promise<void>
}

export type ApplyResult =
  | {
      status: "applied"
      mutation: GraphMutationType
      before: GraphSnapshotType
      after: GraphSnapshotType
      replayed: boolean
    }
  | {
      status: "rejected"
      mutation: GraphMutationType
      before: GraphSnapshotType
      preview: GraphSnapshotType
      replayed: boolean
    }
  | {
      status: "conflict"
      reason: "revision_mismatch" | "receipt_already_processed"
      expected_revision: number
      actual_revision: number
      before: GraphSnapshotType
    }

export type ShadowResult =
  | {
      status: "validated" | "rejected"
      verdict: GraphPolicyVerdictType
      before: GraphSnapshotType
      preview: GraphSnapshotType
    }
  | {
      status: "conflict"
      reason: "revision_mismatch" | "receipt_already_processed"
      expected_revision: number
      actual_revision: number
      before: GraphSnapshotType
    }

const parseList = (value: string) => z.array(z.string()).parse(JSON.parse(value))
const parseEvidence = (value: string) => z.array(WorkReceiptEvidenceRef).parse(JSON.parse(value))

function snapshot(db: TxOrDb, project_id: string) {
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()
  if (!project) throw new Error(`Company project not found: ${project_id}`)
  return GraphSnapshot.parse({
    project_id,
    revision: project.graph_revision,
    nodes: db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, project_id))
      .orderBy(asc(CompanyWorkItemTable.id))
      .all()
      .map((row) => ({
        id: row.id,
        plan_id: row.plan_id,
        parent_id: row.parent_id ?? undefined,
        kind: row.kind,
        status: row.status,
        owner_agent_id: row.owner_agent_id ?? undefined,
        decision_scope: parseList(row.decision_scope_json),
        resource_scope: parseList(row.resource_scope_json),
        acceptance_criteria: parseList(row.acceptance_criteria_json),
        risk_level: row.risk_level,
        purpose: row.purpose,
        validation_mode: row.validation_mode,
        superseded_by_id: row.superseded_by_id ?? undefined,
      })),
    dependencies: db
      .select({
        work_item_id: CompanyWorkItemDependencyTable.work_item_id,
        depends_on_id: CompanyWorkItemDependencyTable.depends_on_id,
      })
      .from(CompanyWorkItemDependencyTable)
      .innerJoin(
        CompanyWorkItemTable,
        eq(CompanyWorkItemTable.id, CompanyWorkItemDependencyTable.work_item_id),
      )
      .where(eq(CompanyWorkItemTable.project_id, project_id))
      .orderBy(CompanyWorkItemDependencyTable.work_item_id, CompanyWorkItemDependencyTable.depends_on_id)
      .all(),
  })
}

function mutationFromRow(row: typeof CompanyGraphMutationTable.$inferSelect) {
  return GraphMutation.parse({
    id: row.id,
    project_id: row.project_id,
    trigger_receipt_id: row.trigger_receipt_id,
    expected_revision: row.expected_revision,
    applied_revision: row.applied_revision ?? undefined,
    orchestrator_version: row.orchestrator_version,
    idempotency_key: row.idempotency_key,
    decision: row.decision,
    rationale: row.rationale,
    evidence_refs: JSON.parse(row.evidence_refs_json),
    operations: JSON.parse(row.operations_json),
    status: row.status,
    policy_verdict: JSON.parse(row.policy_verdict_json),
    created_at: row.created_at,
    applied_at: row.applied_at ?? undefined,
  })
}

function sameProposal(row: typeof CompanyGraphMutationTable.$inferSelect, proposal: GraphMutationProposalType) {
  return (
    row.trigger_receipt_id === proposal.trigger_receipt_id &&
    row.expected_revision === proposal.expected_revision &&
    row.orchestrator_version === proposal.orchestrator_version &&
    row.decision === proposal.decision &&
    row.rationale === proposal.rationale &&
    row.evidence_refs_json === JSON.stringify(proposal.evidence_refs) &&
    row.operations_json === JSON.stringify(proposal.operations)
  )
}

function insertEvent(
  db: TxOrDb,
  project_id: string,
  type: string,
  data: Record<string, unknown>,
  created_at: number,
) {
  db.insert(CompanyProjectEventTable)
    .values({
      id: Identifier.ascending("event"),
      project_id,
      type,
      actor_id: null,
      data_json: JSON.stringify(data),
      created_at,
    })
    .run()
}

function applyOperations(
  db: TxOrDb,
  proposal: GraphMutationProposalType,
  mutation_id: string,
  applied_revision: number,
  now: number,
) {
  proposal.operations.forEach((operation) => {
    if (operation.type === "add_work_item") {
      db.insert(CompanyWorkItemTable)
        .values({
          id: operation.item.id,
          project_id: proposal.project_id,
          plan_id: operation.item.plan_id,
          source_task_key: null,
          parent_id: operation.item.parent_id ?? null,
          title: operation.item.title,
          description: operation.item.description,
          kind: operation.item.kind,
          work_type: operation.item.work_type,
          role: operation.item.role,
          capability_packs_json: JSON.stringify(operation.item.capability_packs),
          decision_scope_json: JSON.stringify(operation.item.decision_scope),
          resource_scope_json: JSON.stringify(operation.item.resource_scope),
          inputs_json: JSON.stringify(operation.item.inputs),
          expected_outputs_json: JSON.stringify(operation.item.expected_outputs),
          validators_json: JSON.stringify(operation.item.validators),
          disposition: operation.item.disposition,
          model_group: operation.item.model_group,
          risk_level: operation.item.risk_level,
          review_status: operation.item.review_status,
          status: "pending",
          purpose: operation.item.purpose,
          origin_kind: "graph_mutation",
          origin_ref_id: mutation_id,
          graph_revision_created: applied_revision,
          validation_mode: operation.item.validation_mode,
          superseded_by_id: null,
          owner_agent_id: operation.item.owner_agent_id ?? null,
          workflow_run_id: null,
          acceptance_criteria_json: JSON.stringify(operation.item.acceptance_criteria),
          attempt: 0,
          max_attempts: operation.item.max_attempts,
          error: null,
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now,
        })
        .run()
      insertEvent(
        db,
        proposal.project_id,
        "work_item.created",
        {
          work_item_id: operation.item.id,
          title: operation.item.title,
          kind: operation.item.kind,
          work_type: operation.item.work_type,
          role: operation.item.role,
          graph_revision: applied_revision,
          mutation_id,
        },
        now,
      )
      return
    }
    if (operation.type === "add_dependency") {
      db.insert(CompanyWorkItemDependencyTable)
        .values({
          work_item_id: operation.work_item_id,
          depends_on_id: operation.depends_on_id,
        })
        .run()
      return
    }
    if (operation.type === "remove_dependency") {
      db.delete(CompanyWorkItemDependencyTable)
        .where(
          and(
            eq(CompanyWorkItemDependencyTable.work_item_id, operation.work_item_id),
            eq(CompanyWorkItemDependencyTable.depends_on_id, operation.depends_on_id),
          ),
        )
        .run()
      return
    }
    if (operation.type === "supersede_work_item") {
      db.update(CompanyWorkItemTable)
        .set({
          status: "superseded",
          superseded_by_id: operation.replacement_id ?? null,
          updated_at: now,
        })
        .where(eq(CompanyWorkItemTable.id, operation.work_item_id))
        .run()
      insertEvent(
        db,
        proposal.project_id,
        "work_item.superseded",
        {
          work_item_id: operation.work_item_id,
          replacement_id: operation.replacement_id,
          reason: operation.reason,
          graph_revision: applied_revision,
          mutation_id,
        },
        now,
      )
      return
    }
    if (operation.type === "add_validation_gate") {
      const criteria = [
        {
          id: `${operation.gate.id}:policy`,
          statement: operation.gate.summary,
          anchor: {
            kind: "policy",
            reference: `graph:${mutation_id}:${operation.gate.work_item_id}`,
          },
          operator: "equals",
          expected: true,
        },
      ]
      db.insert(CompanyValidationGateTable)
        .values({
          id: operation.gate.id,
          project_id: proposal.project_id,
          work_item_id: operation.gate.work_item_id,
          kind: "policy",
          status: "pending",
          criteria_json: JSON.stringify(criteria),
          criteria_sha256: new Bun.CryptoHasher("sha256")
            .update(JSON.stringify(criteria))
            .digest("hex"),
          blocking_work_item_ids_json: JSON.stringify([operation.gate.work_item_id]),
          evidence_refs_json: "[]",
          evaluator: "policy_invariant_v1",
          repair_round: 0,
          max_repair_rounds: 3,
          failure_summary: null,
          supersedes_gate_id: null,
          created_at: now,
          evaluated_at: null,
        })
        .run()
      insertEvent(
        db,
        proposal.project_id,
        "graph.validation_gate.requested",
        { mutation_id, graph_revision: applied_revision, gate: operation.gate },
        now,
      )
      return
    }
    if (operation.type === "request_capability") {
      insertEvent(
        db,
        proposal.project_id,
        "graph.capability.requested",
        { mutation_id, graph_revision: applied_revision, need: operation.need },
        now,
      )
      return
    }
    insertEvent(
      db,
      proposal.project_id,
      "graph.user_decision.requested",
      { mutation_id, graph_revision: applied_revision, request: operation.request },
      now,
    )
  })
}

function evaluate(db: TxOrDb, proposal: GraphMutationProposalType) {
  const before = snapshot(db, proposal.project_id)
  const receipt = db
    .select()
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.id, proposal.trigger_receipt_id))
    .get()
  if (!receipt || receipt.project_id !== proposal.project_id) {
    throw new Error("Graph Mutation references an unavailable Work Receipt")
  }
  if (receipt.processing_status !== "processed") {
    throw new Error("Graph Mutation requires a processed Work Receipt")
  }
  if (before.revision !== proposal.expected_revision) {
    return {
      status: "conflict" as const,
      reason: "revision_mismatch" as const,
      expected_revision: proposal.expected_revision,
      actual_revision: before.revision,
      before,
    }
  }
  if (receipt.processed_mutation_id) {
    return {
      status: "conflict" as const,
      reason: "receipt_already_processed" as const,
      expected_revision: proposal.expected_revision,
      actual_revision: before.revision,
      before,
    }
  }
  return {
    status: "evaluated" as const,
    before,
    receipt,
    ...validateGraphPatch({
      proposal,
      snapshot: before,
      valid_plan_ids: db
        .select({ id: CompanyPlanTable.id })
        .from(CompanyPlanTable)
        .where(eq(CompanyPlanTable.project_id, proposal.project_id))
        .all()
        .map((plan) => plan.id),
      trigger_work_item_id: receipt.work_item_id,
      receipt_evidence_refs: parseEvidence(receipt.evidence_refs_json),
    }),
  }
}

export interface Interface {
  readonly apply: (input: GraphMutationProposalType) => Effect.Effect<ApplyResult>
  readonly shadow: (input: GraphMutationProposalType) => Effect.Effect<ShadowResult>
  readonly snapshot: (project_id: string) => Effect.Effect<GraphSnapshotType>
  readonly get: (id: string) => Effect.Effect<GraphMutationType | undefined>
  readonly list: (project_id: string) => Effect.Effect<GraphMutationType[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyGraphMutation") {}

export function makeLayer(hooks: Hooks = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const get = Effect.fn("CompanyGraphMutation.get")(function* (id: string) {
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyGraphMutationTable).where(eq(CompanyGraphMutationTable.id, id)).get(),
          ),
        )
        return row ? mutationFromRow(row) : undefined
      })

      const list = Effect.fn("CompanyGraphMutation.list")(function* (project_id: string) {
        return (yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphMutationTable)
              .where(eq(CompanyGraphMutationTable.project_id, project_id))
              .orderBy(asc(CompanyGraphMutationTable.created_at), asc(CompanyGraphMutationTable.id))
              .all(),
          ),
        )).map(mutationFromRow)
      })

      const readSnapshot = Effect.fn("CompanyGraphMutation.snapshot")(function* (project_id: string) {
        return yield* Effect.sync(() => Database.use((db) => snapshot(db, project_id)))
      })

      const shadow = Effect.fn("CompanyGraphMutation.shadow")(function* (input: GraphMutationProposalType) {
        const proposal = GraphMutationProposal.parse(input)
        const result = yield* Effect.sync(() => Database.use((db) => evaluate(db, proposal)))
        if (result.status === "conflict") return result
        return {
          status: result.verdict.result === "allowed" ? ("validated" as const) : ("rejected" as const),
          verdict: result.verdict,
          before: result.before,
          preview: result.preview,
        }
      })

      const apply = Effect.fn("CompanyGraphMutation.apply")(function* (input: GraphMutationProposalType) {
        const proposal = GraphMutationProposal.parse(input)
        hooks.onBoundary?.("before_transaction")
        const result = yield* Effect.sync(() =>
          Database.transaction(
            (db): ApplyResult => {
              const existing = db
                .select()
                .from(CompanyGraphMutationTable)
                .where(
                  and(
                    eq(CompanyGraphMutationTable.project_id, proposal.project_id),
                    eq(CompanyGraphMutationTable.idempotency_key, proposal.idempotency_key),
                  ),
                )
                .get()
              if (existing) {
                if (!sameProposal(existing, proposal)) {
                  throw new Error("Graph Mutation idempotency key conflicts with persisted facts")
                }
                const current = snapshot(db, proposal.project_id)
                const mutation = mutationFromRow(existing)
                if (mutation.status === "applied") {
                  return { status: "applied", mutation, before: current, after: current, replayed: true }
                }
                const evaluated = evaluate(db, proposal)
                if (evaluated.status === "conflict") {
                  return {
                    status: "rejected",
                    mutation,
                    before: current,
                    preview: current,
                    replayed: true,
                  }
                }
                return {
                  status: "rejected",
                  mutation,
                  before: evaluated.before,
                  preview: evaluated.preview,
                  replayed: true,
                }
              }
              const evaluated = evaluate(db, proposal)
              if (evaluated.status === "conflict") return evaluated
              const id = Identifier.ascending("graphMutation")
              const now = Date.now()
              const status = evaluated.verdict.result === "allowed" ? "applied" : "rejected"
              const applied_revision = status === "applied" ? proposal.expected_revision + 1 : null
              const row = {
                id,
                project_id: proposal.project_id,
                trigger_receipt_id: proposal.trigger_receipt_id,
                expected_revision: proposal.expected_revision,
                applied_revision,
                orchestrator_version: proposal.orchestrator_version,
                idempotency_key: proposal.idempotency_key,
                decision: proposal.decision,
                rationale: proposal.rationale,
                evidence_refs_json: JSON.stringify(proposal.evidence_refs),
                operations_json: JSON.stringify(proposal.operations),
                status,
                policy_verdict_json: JSON.stringify(evaluated.verdict),
                created_at: now,
                applied_at: status === "applied" ? now : null,
              }
              db.insert(CompanyGraphMutationTable).values(row).run()
              hooks.onBoundary?.("after_mutation_write")
              if (status === "rejected") {
                insertEvent(
                  db,
                  proposal.project_id,
                  "graph_mutation.rejected",
                  {
                    mutation_id: id,
                    receipt_id: proposal.trigger_receipt_id,
                    expected_revision: proposal.expected_revision,
                    decision: proposal.decision,
                    verdict: evaluated.verdict,
                  },
                  now,
                )
                return {
                  status: "rejected",
                  mutation: mutationFromRow(row),
                  before: evaluated.before,
                  preview: evaluated.preview,
                  replayed: false,
                }
              }
              applyOperations(db, proposal, id, applied_revision!, now)
              hooks.onBoundary?.("after_operations")
              db.update(CompanyProjectTable)
                .set({ graph_revision: applied_revision!, updated_at: now })
                .where(
                  and(
                    eq(CompanyProjectTable.id, proposal.project_id),
                    eq(CompanyProjectTable.graph_revision, proposal.expected_revision),
                  ),
                )
                .run()
              if (
                db
                  .select({ graph_revision: CompanyProjectTable.graph_revision })
                  .from(CompanyProjectTable)
                  .where(eq(CompanyProjectTable.id, proposal.project_id))
                  .get()?.graph_revision !== applied_revision
              ) {
                throw new Error("Graph Mutation revision compare-and-swap failed")
              }
              db.update(CompanyWorkReceiptTable)
                .set({ processed_mutation_id: id })
                .where(eq(CompanyWorkReceiptTable.id, proposal.trigger_receipt_id))
                .run()
              hooks.onBoundary?.("after_revision")
              insertEvent(
                db,
                proposal.project_id,
                "graph_mutation.applied",
                {
                  mutation_id: id,
                  receipt_id: proposal.trigger_receipt_id,
                  expected_revision: proposal.expected_revision,
                  applied_revision,
                  decision: proposal.decision,
                  verdict: evaluated.verdict,
                },
                now,
              )
              hooks.onBoundary?.("after_event")
              return {
                status: "applied",
                mutation: mutationFromRow(row),
                before: evaluated.before,
                after: snapshot(db, proposal.project_id),
                replayed: false,
              }
            },
            { behavior: "immediate" },
          ),
        )
        hooks.onBoundary?.("after_commit")
        if (result.status === "applied" && !result.replayed) {
          const invalidation = {
            project_id: proposal.project_id,
            mutation_id: result.mutation.id,
            graph_revision: result.mutation.applied_revision!,
          }
          yield* Effect.promise(() =>
            hooks.publish
              ? hooks.publish(invalidation)
              : Bus.publish(GraphInvalidated, {
                  project_id: proposal.project_id,
                  mutation_id: result.mutation.id,
                  graph_revision: result.mutation.applied_revision!,
                }),
          )
          hooks.onBoundary?.("after_broadcast")
        }
        return result
      })

      return Service.of({ apply, shadow, snapshot: readSnapshot, get, list })
    }),
  )
}

export const defaultLayer = makeLayer()

export * as CompanyGraphMutation from "./graph-mutation"
