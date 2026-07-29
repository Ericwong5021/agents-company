import { Context, Effect, Layer, Semaphore } from "effect"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import z from "zod"
import { FirstSliceCandidate } from "@agents-company/shared/project-orchestration"
import type { RolloutShadowEvaluation } from "@agents-company/shared/rollout"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import { CompanyProject } from "@/company-project/company-project"
import {
  CompanyGraphDecisionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { CompanyGraphMutation } from "@/company-project/graph-mutation"
import {
  GraphDecision,
  GraphMutationProposal,
  GraphOperation,
  NewGraphWorkItem,
  type GraphDecision as GraphDecisionType,
  type GraphOperation as GraphOperationType,
  type GraphSnapshot,
  type Project,
  type WorkReceipt,
} from "@/company-project/schema"
import { CompanyWorkFacts, type ReceiptClaim } from "@/company-project/work-facts"
import { Flag } from "@/flag/flag"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"

export const ORCHESTRATOR_VERSION = 1

export const SupervisorDecision = z
  .object({
    kind: GraphDecision.shape.kind,
    reason_code: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    operations: z.array(GraphOperation).max(500),
  })
  .strict()
export type SupervisorDecision = z.infer<typeof SupervisorDecision>

export type DecisionInput = {
  project: Project
  receipt: WorkReceipt
  snapshot: GraphSnapshot
  pending_receipt_count: number
}

export type ProcessResult =
  | {
      status: "disabled"
      receipt_id: string
      project_id: string
    }
  | {
      status: "processed"
      receipt_id: string
      project_id: string
      mode: "shadow" | "active"
      decision: GraphDecisionType
      mutation_id?: string
      replayed: boolean
      conflict_count: number
    }

export type RecoveryReport = {
  project_ids: string[]
  processed_receipt_ids: string[]
  disabled_receipt_ids: string[]
}

type Hooks = {
  mode?: "off" | "shadow" | "active"
  decide?: (input: DecisionInput) => SupervisorDecision
  max_conflict_retries?: number
}

const privateReasoningMarkers = [
  "<thinking",
  "chain of thought",
  "private reasoning",
  "hidden reasoning",
  "思维链",
  "隐藏推理",
]

const safeSummary = (decision: SupervisorDecision) => {
  const summary = decision.summary.trim().slice(0, 2_000)
  if (privateReasoningMarkers.some((marker) => summary.toLowerCase().includes(marker)))
    return `Automated decision recorded from persisted receipt facts: ${decision.reason_code}`
  return summary
}

const decisionFromRow = (row: typeof CompanyGraphDecisionTable.$inferSelect) =>
  GraphDecision.parse({
    id: row.id,
    project_id: row.project_id,
    receipt_id: row.receipt_id,
    mutation_id: row.mutation_id ?? undefined,
    expected_revision: row.expected_revision,
    orchestrator_version: row.orchestrator_version,
    idempotency_key: row.idempotency_key,
    kind: row.kind,
    mode: row.mode,
    reason_code: row.reason_code,
    summary: row.summary,
    evidence_refs: JSON.parse(row.evidence_refs_json),
    operations: JSON.parse(row.operations_json),
    automated: row.automated,
    added_node_count: row.added_node_count,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? undefined,
  })

function insertEvent(db: TxOrDb, project_id: string, type: string, data: Record<string, unknown>, created_at: number) {
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

function sameDecision(
  row: typeof CompanyGraphDecisionTable.$inferSelect,
  input: {
    receipt: WorkReceipt
    snapshot: GraphSnapshot
    project: Project
    mode: "shadow" | "active"
    decision: SupervisorDecision
  },
) {
  return (
    row.project_id === input.project.id &&
    row.receipt_id === input.receipt.id &&
    row.expected_revision === input.snapshot.revision &&
    row.orchestrator_version === input.project.orchestrator_version &&
    row.kind === input.decision.kind &&
    row.mode === input.mode &&
    row.reason_code === input.decision.reason_code &&
    row.summary === safeSummary(input.decision) &&
    row.evidence_refs_json === JSON.stringify(input.receipt.evidence_refs) &&
    row.operations_json === JSON.stringify(input.decision.operations)
  )
}

const stableWorkItemID = (receipt_id: string, purpose: string, index: number) =>
  `cwi_${new Bun.CryptoHasher("sha256").update(`${receipt_id}:${purpose}:${index}`).digest("hex").slice(0, 26)}`

export function defaultDecision(input: DecisionInput): SupervisorDecision {
  const trigger = input.snapshot.nodes.find((node) => node.id === input.receipt.work_item_id)
  if (!trigger)
    return {
      kind: "retry",
      reason_code: "trigger_missing",
      summary: `Receipt ${input.receipt.id} references a WorkItem absent from revision ${input.snapshot.revision}.`,
      operations: [],
    }
  if (input.receipt.capability_gaps.length) {
    if (!input.receipt.evidence_refs.length)
      return {
        kind: "retry",
        reason_code: "capability_evidence_missing",
        summary: `Receipt ${input.receipt.id} reported capability gaps without persisted evidence references.`,
        operations: [],
      }
    const operations = input.receipt.capability_gaps.slice(0, 3).flatMap((capability, index) => {
      const work_item_id = stableWorkItemID(input.receipt.id, "capability-gap", index)
      return [
        {
          type: "add_work_item" as const,
          item: {
            id: work_item_id,
            plan_id: trigger.plan_id,
            parent_id: trigger.id,
            title: `Resolve capability gap: ${capability}`.slice(0, 500),
            description: `Produce verified evidence that resolves the reported capability gap: ${capability}`.slice(
              0,
              8_000,
            ),
            kind: "worker" as const,
            work_type: "analysis" as const,
            role: capability.slice(0, 160),
            capability_packs: ["research-analysis@1"],
            decision_scope: trigger.decision_scope,
            resource_scope: trigger.resource_scope,
            inputs: [input.receipt.summary, capability],
            expected_outputs: [`Verified resolution for ${capability}`],
            validators: ["Capability gap resolution is backed by persisted evidence"],
            disposition: "retain",
            model_group: "standard" as const,
            risk_level: "medium" as const,
            review_status: "not_required" as const,
            acceptance_criteria: ["Capability gap resolution is backed by persisted evidence"],
            max_attempts: 3,
            purpose: "recovery" as const,
            validation_mode: "machine" as const,
          },
        },
        {
          type: "request_capability" as const,
          need: {
            id: `receipt-gap-${index + 1}`,
            work_item_id,
            capability,
            reason: `Work Receipt ${input.receipt.id} reported this capability gap.`,
            allowed_permission_modes: ["read_only" as const],
            resource_scope: trigger.resource_scope,
          },
        },
      ]
    })
    return {
      kind: "request_capability",
      reason_code: "receipt_capability_gap",
      summary: `Receipt ${input.receipt.id} reported ${input.receipt.capability_gaps.length} capability gaps; ${Math.min(input.receipt.capability_gaps.length, 3)} bounded Needs were proposed.`,
      operations,
    }
  }
  const directOperations = input.receipt.task_proposals.flatMap((proposal) => {
    const operation = GraphOperation.safeParse(proposal)
    if (operation.success) return [operation.data]
    const item = NewGraphWorkItem.safeParse(proposal)
    if (item.success) return [{ type: "add_work_item" as const, item: item.data }]
    const candidate = FirstSliceCandidate.safeParse(proposal)
    if (!candidate.success || input.snapshot.nodes.some((node) => node.purpose === "first_slice")) return []
    return [
      {
        type: "add_work_item" as const,
        item: {
          id: stableWorkItemID(input.receipt.id, `first-slice:${candidate.data.id}`, 0),
          plan_id: trigger.plan_id,
          parent_id: trigger.id,
          title: candidate.data.title,
          description: candidate.data.description,
          kind: "worker" as const,
          work_type: candidate.data.work_type,
          role: candidate.data.role,
          capability_packs: candidate.data.capability_packs,
          decision_scope: candidate.data.decision_scope.filter((scope) => trigger.decision_scope.includes(scope)),
          resource_scope: candidate.data.resource_scope.filter((scope) => trigger.resource_scope.includes(scope)),
          inputs: [input.receipt.summary, `Reality anchor: ${candidate.data.reality_anchor}`],
          expected_outputs: [candidate.data.title],
          validators: candidate.data.acceptance_criteria,
          disposition: "retain",
          model_group: candidate.data.external_side_effect ? ("ultra" as const) : ("standard" as const),
          risk_level: candidate.data.external_side_effect ? ("high" as const) : ("medium" as const),
          review_status: "not_required" as const,
          acceptance_criteria: candidate.data.acceptance_criteria,
          max_attempts: 3,
          purpose: "delivery" as const,
          validation_mode: candidate.data.external_side_effect
            ? ("review_and_user_gate" as const)
            : ("machine" as const),
        },
      },
    ]
  })
  const boundedOperations = directOperations.reduce<{ operations: GraphOperationType[]; added: number }>(
    (result, operation) => {
      if (operation.type !== "add_work_item") return { ...result, operations: [...result.operations, operation] }
      if (result.added >= 3) return result
      return { operations: [...result.operations, operation], added: result.added + 1 }
    },
    { operations: [], added: 0 },
  ).operations
  if (boundedOperations.length) {
    if (!input.receipt.evidence_refs.length)
      return {
        kind: "retry",
        reason_code: "growth_evidence_missing",
        summary: `Receipt ${input.receipt.id} proposed graph growth without persisted evidence references.`,
        operations: [],
      }
    return {
      kind: "expand",
      reason_code: "receipt_task_proposal",
      summary: `Receipt ${input.receipt.id} proposed ${boundedOperations.filter((operation) => operation.type === "add_work_item").length} bounded WorkItem additions.`,
      operations: boundedOperations,
    }
  }
  const dependencies = input.receipt.dependency_proposals.flatMap((proposal) => {
    const parsed = z
      .object({
        work_item_id: z.string().trim().min(1),
        depends_on_id: z.string().trim().min(1),
      })
      .passthrough()
      .safeParse(proposal)
    if (!parsed.success) return []
    if (
      !input.snapshot.nodes.some((node) => node.id === parsed.data.work_item_id) ||
      !input.snapshot.nodes.some((node) => node.id === parsed.data.depends_on_id) ||
      input.snapshot.dependencies.some(
        (edge) => edge.work_item_id === parsed.data.work_item_id && edge.depends_on_id === parsed.data.depends_on_id,
      )
    )
      return []
    return [
      {
        type: "add_dependency" as const,
        work_item_id: parsed.data.work_item_id,
        depends_on_id: parsed.data.depends_on_id,
      },
    ]
  })
  if (dependencies.length) {
    if (!input.receipt.evidence_refs.length)
      return {
        kind: "retry",
        reason_code: "rewire_evidence_missing",
        summary: `Receipt ${input.receipt.id} proposed dependency changes without persisted evidence references.`,
        operations: [],
      }
    return {
      kind: "rewire",
      reason_code: "receipt_dependency_proposal",
      summary: `Receipt ${input.receipt.id} proposed ${dependencies.length} dependency changes.`,
      operations: dependencies,
    }
  }
  const terminalGraph =
    input.pending_receipt_count === 1 &&
    input.snapshot.nodes.every((node) => ["completed", "superseded", "cancelled"].includes(node.status))
  if (
    input.receipt.outcome !== "completed" ||
    input.receipt.blockers.length ||
    (input.receipt.questions.length && !terminalGraph)
  )
    return {
      kind: "retry",
      reason_code: "receipt_not_terminally_accepted",
      summary: `Receipt ${input.receipt.id} retains ${input.receipt.blockers.length} blockers and ${input.receipt.questions.length} questions.`,
      operations: [],
    }
  if (terminalGraph)
    return {
      kind: "quiesce",
      reason_code: "terminal_graph_observed",
      summary: `Receipt ${input.receipt.id} observed a terminal graph with no other pending receipts.`,
      operations: [],
    }
  return {
    kind: "accept",
    reason_code: "receipt_facts_accepted",
    summary: `Receipt ${input.receipt.id} was accepted without changing graph structure.`,
    operations: [],
  }
}

export interface Interface {
  readonly processReceipt: (receipt_id: string) => Effect.Effect<ProcessResult>
  readonly drain: (project_id: string) => Effect.Effect<ProcessResult[]>
  readonly shadowLegacy: (project_id: string) => Effect.Effect<RolloutShadowEvaluation[]>
  readonly getDecision: (id: string) => Effect.Effect<GraphDecisionType | undefined>
  readonly listDecisions: (project_id: string) => Effect.Effect<GraphDecisionType[]>
  readonly recover: () => Effect.Effect<RecoveryReport>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/GraphSupervisor") {}

export function makeLayer(hooks: Hooks = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const facts = yield* CompanyWorkFacts.Service
      const graph = yield* CompanyGraphMutation.Service
      const locks = new Map<string, Semaphore.Semaphore>()
      const lock = (project_id: string) => {
        const current = locks.get(project_id)
        if (current) return current
        const created = Semaphore.makeUnsafe(1)
        locks.set(project_id, created)
        return created
      }

      const getDecision = Effect.fn("GraphSupervisor.getDecision")(function* (id: string) {
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select().from(CompanyGraphDecisionTable).where(eq(CompanyGraphDecisionTable.id, id)).get(),
          ),
        )
        return row ? decisionFromRow(row) : undefined
      })

      const listDecisions = Effect.fn("GraphSupervisor.listDecisions")(function* (project_id: string) {
        return (yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphDecisionTable)
              .where(eq(CompanyGraphDecisionTable.project_id, project_id))
              .orderBy(asc(CompanyGraphDecisionTable.created_at), asc(CompanyGraphDecisionTable.id))
              .all(),
          ),
        )).map(decisionFromRow)
      })

      const setState = Effect.fn("GraphSupervisor.setState")(function* (
        project_id: string,
        orchestration_state: "idle" | "processing_receipt" | "blocked",
      ) {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(CompanyProjectTable)
              .set({ orchestration_state, updated_at: Date.now() })
              .where(eq(CompanyProjectTable.id, project_id))
              .run(),
          ),
        )
      })

      const recordDecision = Effect.fn("GraphSupervisor.recordDecision")(function* (input: {
        receipt: WorkReceipt
        snapshot: GraphSnapshot
        project: Project
        mode: "shadow" | "active"
        decision: SupervisorDecision
      }) {
        return yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const existing = db
                .select()
                .from(CompanyGraphDecisionTable)
                .where(
                  and(
                    eq(CompanyGraphDecisionTable.receipt_id, input.receipt.id),
                    eq(CompanyGraphDecisionTable.expected_revision, input.snapshot.revision),
                  ),
                )
                .get()
              if (existing) {
                if (!sameDecision(existing, input))
                  throw new Error("Graph Decision conflicts with persisted revision facts")
                return decisionFromRow(existing)
              }
              const now = Date.now()
              const id = Identifier.ascending("graphDecision")
              const row = {
                id,
                project_id: input.project.id,
                receipt_id: input.receipt.id,
                mutation_id: null,
                expected_revision: input.snapshot.revision,
                orchestrator_version: input.project.orchestrator_version,
                idempotency_key: `graph-decision:${input.receipt.id}:revision:${input.snapshot.revision}:v${input.project.orchestrator_version}`,
                kind: input.decision.kind,
                mode: input.mode,
                reason_code: input.decision.reason_code,
                summary: safeSummary(input.decision),
                evidence_refs_json: JSON.stringify(input.receipt.evidence_refs),
                operations_json: JSON.stringify(input.decision.operations),
                automated: true,
                added_node_count: input.decision.operations.filter((operation) => operation.type === "add_work_item")
                  .length,
                status: "recorded",
                created_at: now,
                resolved_at: null,
              }
              db.insert(CompanyGraphDecisionTable).values(row).run()
              db.update(CompanyProjectTable)
                .set({
                  orchestration_state: "processing_receipt",
                  orchestrator_version: input.project.orchestrator_version,
                  updated_at: now,
                })
                .where(eq(CompanyProjectTable.id, input.project.id))
                .run()
              insertEvent(
                db,
                input.project.id,
                "graph_decision.recorded",
                {
                  decisionId: id,
                  kind: input.decision.kind,
                  automated: true,
                  addedNodeCount: row.added_node_count,
                  receipt_id: input.receipt.id,
                  expected_revision: input.snapshot.revision,
                  orchestrator_version: input.project.orchestrator_version,
                  mode: input.mode,
                  reason_code: input.decision.reason_code,
                },
                now,
              )
              return decisionFromRow(row)
            },
            { behavior: "immediate" },
          ),
        )
      })

      const resolveDecision = Effect.fn("GraphSupervisor.resolveDecision")(function* (input: {
        id: string
        status: "shadowed" | "applied" | "rejected" | "superseded"
        mutation_id?: string
      }) {
        return yield* Effect.sync(() =>
          Database.transaction(
            (db) => {
              const current = db
                .select()
                .from(CompanyGraphDecisionTable)
                .where(eq(CompanyGraphDecisionTable.id, input.id))
                .get()
              if (!current) throw new Error(`Graph Decision not found: ${input.id}`)
              if (current.status === input.status && (current.mutation_id ?? undefined) === input.mutation_id)
                return decisionFromRow(current)
              if (current.status !== "recorded")
                throw new Error(`Graph Decision ${input.id} cannot resolve from ${current.status}`)
              const resolved_at = Date.now()
              db.update(CompanyGraphDecisionTable)
                .set({
                  mutation_id: input.mutation_id ?? null,
                  status: input.status,
                  resolved_at,
                })
                .where(eq(CompanyGraphDecisionTable.id, input.id))
                .run()
              insertEvent(
                db,
                current.project_id,
                "graph_decision.resolved",
                {
                  decision_id: input.id,
                  receipt_id: current.receipt_id,
                  mutation_id: input.mutation_id,
                  status: input.status,
                },
                resolved_at,
              )
              return decisionFromRow({
                ...current,
                mutation_id: input.mutation_id ?? null,
                status: input.status,
                resolved_at,
              })
            },
            { behavior: "immediate" },
          ),
        )
      })

      const latestResolved = Effect.fn("GraphSupervisor.latestResolved")(function* (receipt_id: string) {
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(CompanyGraphDecisionTable)
              .where(
                and(
                  eq(CompanyGraphDecisionTable.receipt_id, receipt_id),
                  inArray(CompanyGraphDecisionTable.status, ["shadowed", "applied", "rejected"]),
                ),
              )
              .orderBy(desc(CompanyGraphDecisionTable.expected_revision), desc(CompanyGraphDecisionTable.created_at))
              .get(),
          ),
        )
        return row ? decisionFromRow(row) : undefined
      })

      const recoverAppliedDecision = Effect.fn("GraphSupervisor.recoverAppliedDecision")(function* (
        receipt_id: string,
        project_id: string,
      ) {
        const finished = yield* latestResolved(receipt_id)
        if (finished) return finished
        const mutation = (yield* graph.list(project_id)).find(
          (candidate) =>
            candidate.trigger_receipt_id === receipt_id &&
            candidate.status === "applied" &&
            candidate.idempotency_key.startsWith("graph-mutation:"),
        )
        if (!mutation) return undefined
        const decision = yield* getDecision(
          mutation.idempotency_key.slice("graph-mutation:".length),
        )
        if (
          !decision ||
          decision.receipt_id !== receipt_id ||
          decision.status !== "recorded"
        )
          return undefined
        return yield* resolveDecision({
          id: decision.id,
          status: "applied",
          mutation_id: mutation.id,
        })
      })

      const processClaim = Effect.fn("GraphSupervisor.processClaim")(function* (
        claim: ReceiptClaim,
        mode: "shadow" | "active",
      ) {
        const resumed = yield* latestResolved(claim.receipt.id)
        if (resumed) {
          yield* facts.finalizeReceipt({
            id: claim.receipt.id,
            claim_id: claim.claim_id,
            decision_id: resumed.id,
            mutation_id: resumed.mutation_id,
            recovered: true,
          })
          return {
            status: "processed" as const,
            receipt_id: claim.receipt.id,
            project_id: claim.receipt.project_id,
            mode,
            decision: resumed,
            mutation_id: resumed.mutation_id,
            replayed: true,
            conflict_count: 0,
          }
        }
        const evaluate = (conflict_count: number): Effect.Effect<Exclude<ProcessResult, { status: "disabled" }>> =>
          Effect.gen(function* () {
            if (conflict_count > (hooks.max_conflict_retries ?? 8))
              throw new Error(`Graph Decision exceeded conflict retries for Receipt ${claim.receipt.id}`)
            const project = yield* projects.get(claim.receipt.project_id)
            if (!project) throw new Error(`Company project not found: ${claim.receipt.project_id}`)
            if (project.execution_strategy !== "seed_and_grow")
              throw new Error(`Company project ${project.id} is not Seed-and-Grow`)
            if (project.orchestrator_version !== ORCHESTRATOR_VERSION)
              throw new Error(
                `Unsupported orchestrator version ${project.orchestrator_version} for Project ${project.id}`,
              )
            const snapshot = yield* graph.snapshot(project.id)
            const existing = (yield* listDecisions(project.id)).find(
              (decision) =>
                decision.receipt_id === claim.receipt.id && decision.expected_revision === snapshot.revision,
            )
            const decision = existing
              ? {
                  kind: existing.kind,
                  reason_code: existing.reason_code,
                  summary: existing.summary,
                  operations: existing.operations,
                }
              : SupervisorDecision.parse(
                  (hooks.decide ?? defaultDecision)({
                    project,
                    receipt: claim.receipt,
                    snapshot,
                    pending_receipt_count: (yield* facts.listReceipts(project.id)).filter((receipt) =>
                      ["pending", "processing"].includes(receipt.processing_status),
                    ).length,
                  }),
                )
            const recorded =
              existing ?? (yield* recordDecision({ receipt: claim.receipt, snapshot, project, mode, decision }))
            const proposal = GraphMutationProposal.parse({
              project_id: project.id,
              trigger_receipt_id: claim.receipt.id,
              expected_revision: snapshot.revision,
              orchestrator_version: project.orchestrator_version,
              idempotency_key: `graph-mutation:${recorded.id}`,
              decision: recorded.kind,
              rationale: recorded.summary,
              evidence_refs: recorded.evidence_refs,
              operations: recorded.operations,
            })
            if (mode === "shadow") {
              const result = yield* graph.shadow(proposal)
              if (result.status === "conflict") {
                if (result.reason === "receipt_already_processed") {
                  const finished = yield* recoverAppliedDecision(
                    claim.receipt.id,
                    project.id,
                  )
                  if (!finished) throw new Error(`Receipt ${claim.receipt.id} was processed without Graph Decision`)
                  return {
                    status: "processed" as const,
                    receipt_id: claim.receipt.id,
                    project_id: project.id,
                    mode,
                    decision: finished,
                    mutation_id: finished.mutation_id,
                    replayed: true,
                    conflict_count,
                  }
                }
                yield* resolveDecision({ id: recorded.id, status: "superseded" })
                return yield* evaluate(conflict_count + 1)
              }
              const resolved = yield* resolveDecision({
                id: recorded.id,
                status: result.status === "validated" ? "shadowed" : "rejected",
              })
              yield* facts.finalizeReceipt({
                id: claim.receipt.id,
                claim_id: claim.claim_id,
                decision_id: resolved.id,
              })
              return {
                status: "processed" as const,
                receipt_id: claim.receipt.id,
                project_id: project.id,
                mode,
                decision: resolved,
                replayed: claim.replayed,
                conflict_count,
              }
            }
            const result = yield* graph.apply(proposal)
            if (result.status === "conflict") {
              if (result.reason === "receipt_already_processed") {
                const finished = yield* recoverAppliedDecision(
                  claim.receipt.id,
                  project.id,
                )
                if (!finished) throw new Error(`Receipt ${claim.receipt.id} was processed without Graph Decision`)
                return {
                  status: "processed" as const,
                  receipt_id: claim.receipt.id,
                  project_id: project.id,
                  mode,
                  decision: finished,
                  mutation_id: finished.mutation_id,
                  replayed: true,
                  conflict_count,
                }
              }
              yield* resolveDecision({ id: recorded.id, status: "superseded" })
              return yield* evaluate(conflict_count + 1)
            }
            const resolved = yield* resolveDecision({
              id: recorded.id,
              status: result.status === "applied" ? "applied" : "rejected",
              mutation_id: result.mutation.id,
            })
            yield* facts.finalizeReceipt({
              id: claim.receipt.id,
              claim_id: claim.claim_id,
              decision_id: resolved.id,
              mutation_id: resolved.mutation_id,
            })
            return {
              status: "processed" as const,
              receipt_id: claim.receipt.id,
              project_id: project.id,
              mode,
              decision: resolved,
              mutation_id: resolved.mutation_id,
              replayed: claim.replayed || result.replayed,
              conflict_count,
            }
          })
        return yield* evaluate(0).pipe(
          Effect.tap(() => setState(claim.receipt.project_id, "idle")),
          Effect.catchCause((cause) =>
            setState(claim.receipt.project_id, "blocked").pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        )
      })

      const drainUnlocked = (
        project_id: string,
        mode: "shadow" | "active",
        stop_receipt_id?: string,
      ): Effect.Effect<ProcessResult[]> =>
        Effect.gen(function* () {
          const claim = yield* facts.claimNextPending(project_id)
          if (!claim) return []
          const result = yield* processClaim(claim, mode)
          if (claim.receipt.id === stop_receipt_id) return [result]
          return [result, ...(yield* drainUnlocked(project_id, mode, stop_receipt_id))]
        })

      const processReceipt = Effect.fn("GraphSupervisor.processReceipt")(function* (receipt_id: string) {
        const location = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select({
                project_id: CompanyWorkReceiptTable.project_id,
                processing_status: CompanyWorkReceiptTable.processing_status,
                processed_decision_id: CompanyWorkReceiptTable.processed_decision_id,
              })
              .from(CompanyWorkReceiptTable)
              .where(eq(CompanyWorkReceiptTable.id, receipt_id))
              .get(),
          ),
        )
        if (!location) throw new Error(`Work Receipt not found: ${receipt_id}`)
        const mode = hooks.mode ?? Flag.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
        if (mode === "off") return { status: "disabled" as const, receipt_id, project_id: location.project_id }
        if (location.processing_status === "processed") {
          if (!location.processed_decision_id)
            throw new Error(`Processed Seed Receipt ${receipt_id} has no Graph Decision`)
          const decision = yield* getDecision(location.processed_decision_id)
          if (!decision) throw new Error(`Graph Decision not found: ${location.processed_decision_id}`)
          return {
            status: "processed" as const,
            receipt_id,
            project_id: location.project_id,
            mode,
            decision,
            mutation_id: decision.mutation_id,
            replayed: true,
            conflict_count: 0,
          }
        }
        const results = yield* lock(location.project_id).withPermits(1)(
          drainUnlocked(location.project_id, mode, receipt_id),
        )
        const target = results.find((result) => result.receipt_id === receipt_id)
        if (!target) throw new Error(`Receipt Processor did not reach Work Receipt ${receipt_id}`)
        return target
      })

      const shadowLegacyReceipt = Effect.fn("GraphSupervisor.shadowLegacyReceipt")(function* (
        project_id: string,
        receipt_id: string,
      ) {
        const project = yield* projects.get(project_id)
        if (!project || project.execution_strategy !== "legacy_full_plan")
          throw new Error(`Company project ${project_id} is not a legacy project`)
        if (project.orchestrator_version !== ORCHESTRATOR_VERSION)
          throw new Error(`Unsupported orchestrator version ${project.orchestrator_version} for Project ${project.id}`)
        const receipt = (yield* facts.listReceipts(project_id)).find((candidate) => candidate.id === receipt_id)
        if (!receipt || receipt.processing_status !== "processed")
          throw new Error(`Legacy Work Receipt ${receipt_id} is not terminally processed`)
        const snapshot = yield* graph.snapshot(project_id)
        const sourceKey = `shadow-supervisor:${receipt.id}:revision:${snapshot.revision}:v${project.orchestrator_version}`
        const existing = CompanyRollout.getShadowEvaluation(sourceKey)
        if (existing) return existing
        const before = CompanyRollout.projectBusinessStateSha256(project_id)
        const decision = SupervisorDecision.parse(
          (hooks.decide ?? defaultDecision)({
            project,
            receipt,
            snapshot,
            pending_receipt_count: 1,
          }),
        )
        const proposal = GraphMutationProposal.parse({
          project_id: project.id,
          trigger_receipt_id: receipt.id,
          expected_revision: snapshot.revision,
          orchestrator_version: project.orchestrator_version,
          idempotency_key: `shadow-graph-mutation:${receipt.id}:revision:${snapshot.revision}:v${project.orchestrator_version}`,
          decision: decision.kind,
          rationale: decision.summary,
          evidence_refs: receipt.evidence_refs,
          operations: decision.operations,
        })
        const result = yield* graph.shadow(proposal)
        if (result.status === "conflict")
          throw new Error(`Legacy shadow evaluation conflicted for Work Receipt ${receipt.id}: ${result.reason}`)
        const after = CompanyRollout.projectBusinessStateSha256(project_id)
        return CompanyRollout.recordShadowEvaluation({
          projectId: project.id,
          sourceKey,
          kind: "supervisor",
          receiptId: receipt.id,
          snapshotSha256: CompanyRollout.valueSha256(snapshot),
          businessStateBeforeSha256: before,
          businessStateAfterSha256: after,
          input: { project, receipt, snapshot, pendingReceiptCount: 1 },
          output: {
            decision,
            mutation: proposal,
            policyVerdict: result.verdict,
            preview: result.preview,
          },
          status: result.status,
        })
      })

      const shadowLegacy = Effect.fn("GraphSupervisor.shadowLegacy")(function* (project_id: string) {
        if (!CompanyRollout.shadowEnabled()) return []
        const project = yield* projects.get(project_id)
        if (!project || project.execution_strategy !== "legacy_full_plan") return []
        return yield* lock(project_id).withPermits(1)(
          Effect.forEach(
            (yield* facts.listReceipts(project_id)).filter((receipt) => receipt.processing_status === "processed"),
            (receipt) => shadowLegacyReceipt(project_id, receipt.id),
            { concurrency: 1 },
          ),
        )
      })

      const drain = Effect.fn("GraphSupervisor.drain")(function* (project_id: string) {
        const project = yield* projects.get(project_id)
        if (!project) throw new Error(`Company project not found: ${project_id}`)
        if (project.execution_strategy !== "seed_and_grow") return []
        const mode = hooks.mode ?? Flag.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
        if (mode === "off") {
          return (yield* facts.listReceipts(project_id))
            .filter((receipt) => ["pending", "processing"].includes(receipt.processing_status))
            .map((receipt) => ({
              status: "disabled" as const,
              receipt_id: receipt.id,
              project_id,
            }))
        }
        return yield* lock(project_id).withPermits(1)(drainUnlocked(project_id, mode))
      })

      const recover = Effect.fn("GraphSupervisor.recover")(function* () {
        const project_ids = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .selectDistinct({ id: CompanyProjectTable.id })
              .from(CompanyProjectTable)
              .innerJoin(CompanyWorkReceiptTable, eq(CompanyWorkReceiptTable.project_id, CompanyProjectTable.id))
              .where(
                and(
                  eq(CompanyProjectTable.execution_strategy, "seed_and_grow"),
                  inArray(CompanyWorkReceiptTable.processing_status, ["pending", "processing"]),
                ),
              )
              .orderBy(asc(CompanyProjectTable.created_at), asc(CompanyProjectTable.id))
              .all()
              .map((project) => project.id),
          ),
        )
        const results = (yield* Effect.forEach(project_ids, drain, { concurrency: 1 })).flat()
        return {
          project_ids,
          processed_receipt_ids: results.flatMap((result) =>
            result.status === "processed" ? [result.receipt_id] : [],
          ),
          disabled_receipt_ids: results.flatMap((result) => (result.status === "disabled" ? [result.receipt_id] : [])),
        }
      })

      return Service.of({ processReceipt, drain, shadowLegacy, getDecision, listDecisions, recover })
    }),
  )
}

export const defaultLayer = makeLayer().pipe(
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
  Layer.provide(CompanyGraphMutation.defaultLayer),
)

export * as GraphSupervisor from "./graph-supervisor"
