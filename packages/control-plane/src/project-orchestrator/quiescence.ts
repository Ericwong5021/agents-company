import { Context, Effect, Layer, Semaphore } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { CompanyID } from "@/company/schema"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectCharterTable,
  CompanyProjectEventTable,
  CompanyProjectActionTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { CompanyRecruitment } from "@/company-recruitment"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"

export type QuiescenceBlocker = {
  code:
    | "not_seed_and_grow"
    | "project_status_not_completable"
    | "nonterminal_work_items"
    | "running_attempts"
    | "terminal_attempts_without_receipt"
    | "unprocessed_receipts"
    | "pending_mutations"
    | "unresolved_validation_gates"
    | "pending_approval_gates"
    | "open_material_attention"
    | "claimed_project_actions"
    | "unresolved_receipt_blockers"
    | "acceptance_evidence_missing"
    | "active_quiesce_decision_missing"
  entity_ids: string[]
}

export type QuiescenceResult = {
  project_id: string
  status: "not_applicable" | "blocked" | "completed"
  ready: boolean
  replayed: boolean
  graph_revision: number
  blocker_codes: QuiescenceBlocker["code"][]
  blockers: QuiescenceBlocker[]
  quiesce_decision_id?: string
  delivery_package_artifact_id?: string
  released_selection_ids: string[]
}

export interface Interface {
  readonly check: (project_id: string) => Effect.Effect<QuiescenceResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/QuiescenceService") {}

const parseList = (value: string) => JSON.parse(value) as string[]
const parseEvidence = (value: string) =>
  JSON.parse(value) as { kind: "agent_run" | "artifact" | "project_event"; id: string }[]
const terminalWorkItemStatuses = new Set(["completed", "superseded", "cancelled"])
const completableProjectStatuses = new Set(["planning", "executing", "reviewing", "awaiting_approval", "completed"])

function inspectAndFinalize(project_id: string) {
  return Database.transaction(
    (db) => {
      const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()
      if (!project) throw new Error(`Company project not found: ${project_id}`)
      const existingPackage = db
        .select()
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.project_id, project_id))
        .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
        .all()
        .find((artifact) => artifact.kind === "delivery_package")
      const openMaterialAttention = db
        .select()
        .from(CompanyAttentionTable)
        .where(
          and(
            eq(CompanyAttentionTable.project_id, project_id),
            eq(CompanyAttentionTable.status, "open"),
            eq(CompanyAttentionTable.material, true),
          ),
        )
        .orderBy(asc(CompanyAttentionTable.created_at), asc(CompanyAttentionTable.id))
        .all()
      const claimedActions = db
        .select()
        .from(CompanyProjectActionTable)
        .where(
          and(eq(CompanyProjectActionTable.project_id, project_id), eq(CompanyProjectActionTable.status, "claimed")),
        )
        .orderBy(asc(CompanyProjectActionTable.created_at), asc(CompanyProjectActionTable.id))
        .all()
      if (project.status === "completed" && existingPackage && !openMaterialAttention.length && !claimedActions.length)
        return {
          project,
          result: {
            project_id,
            status: "completed" as const,
            ready: true,
            replayed: true,
            graph_revision: project.graph_revision,
            blocker_codes: [],
            blockers: [],
            quiesce_decision_id: String(
              (JSON.parse(existingPackage.evidence_json) as Record<string, unknown>).quiesce_decision_id ?? "",
            ),
            delivery_package_artifact_id: existingPackage.id,
            released_selection_ids: [],
          },
        }
      const workItems = db
        .select()
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.project_id, project_id))
        .orderBy(asc(CompanyWorkItemTable.created_at), asc(CompanyWorkItemTable.id))
        .all()
      const attempts = db
        .select()
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.project_id, project_id))
        .orderBy(asc(CompanyWorkAttemptTable.started_at), asc(CompanyWorkAttemptTable.id))
        .all()
      const receipts = db
        .select()
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.project_id, project_id))
        .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
        .all()
      const mutations = db
        .select()
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.project_id, project_id))
        .all()
      const validationGates = db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.project_id, project_id))
        .all()
      const approvalGates = db
        .select()
        .from(CompanyApprovalGateTable)
        .where(eq(CompanyApprovalGateTable.project_id, project_id))
        .all()
      const decisions = db
        .select()
        .from(CompanyGraphDecisionTable)
        .where(eq(CompanyGraphDecisionTable.project_id, project_id))
        .orderBy(asc(CompanyGraphDecisionTable.created_at), asc(CompanyGraphDecisionTable.id))
        .all()
      const quiesce = decisions.findLast(
        (decision) => decision.kind === "quiesce" && decision.mode === "active" && decision.status === "applied",
      )
      const latestReceipts = [...receipts]
        .reverse()
        .filter(
          (receipt, index, source) =>
            source.findIndex((candidate) => candidate.work_item_id === receipt.work_item_id) === index,
        )
      const charter = db
        .select()
        .from(CompanyProjectCharterTable)
        .where(eq(CompanyProjectCharterTable.project_id, project_id))
        .get()
      const acceptanceCriteria = [
        ...new Set([
          ...(charter ? parseList(charter.acceptance_criteria_json) : []),
          ...db
            .select()
            .from(CompanyPlanTable)
            .where(eq(CompanyPlanTable.project_id, project_id))
            .all()
            .filter((plan) => plan.status === "active")
            .flatMap((plan) => parseList(plan.acceptance_criteria_json)),
        ]),
      ].sort()
      const artifacts = db
        .select()
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.project_id, project_id))
        .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
        .all()
        .filter((artifact) => artifact.kind !== "delivery_package")
      const acceptanceCoverage = acceptanceCriteria.map((criterion) => {
        const workItemReceipts = workItems
          .filter((item) => parseList(item.acceptance_criteria_json).includes(criterion))
          .flatMap((item) =>
            latestReceipts.filter(
              (receipt) =>
                receipt.work_item_id === item.id &&
                receipt.processing_status === "processed" &&
                receipt.outcome === "completed",
            ),
          )
        const receiptEvidence = workItemReceipts.flatMap((receipt) => parseEvidence(receipt.evidence_refs_json))
        const receiptArtifactIDs = workItemReceipts.flatMap((receipt) => parseList(receipt.artifact_ids_json))
        const validationEvidence = validationGates.flatMap((gate) =>
          gate.status === "passed" &&
          (
            JSON.parse(gate.criteria_json) as {
              statement: string
            }[]
          ).some((candidate) => candidate.statement === criterion)
            ? parseEvidence(gate.evidence_refs_json)
            : [],
        )
        const artifactBindings = artifacts.filter((artifact) => {
          const evidence = JSON.parse(artifact.evidence_json) as Record<string, unknown>
          return (
            (Array.isArray(evidence.acceptance_criteria) && evidence.acceptance_criteria.includes(criterion)) ||
            (typeof evidence.criterion === "string" && evidence.criterion === criterion) ||
            (typeof evidence.criterion_bindings === "object" &&
              evidence.criterion_bindings !== null &&
              criterion in evidence.criterion_bindings)
          )
        })
        const artifactEvidenceBindings = artifactBindings.filter(
          (artifact) => artifact.kind !== "acceptance_limitation",
        )
        const limitations = [
          ...new Set([
            ...latestReceipts.flatMap((receipt) =>
              parseList(receipt.unknowns_json).filter(
                (limitation) =>
                  limitation.startsWith(`[acceptance:${criterion}]`) ||
                  limitation.startsWith(`acceptance:${criterion}:`),
              ),
            ),
            ...artifactBindings.flatMap((artifact) => {
              const evidence = JSON.parse(artifact.evidence_json) as Record<string, unknown>
              if (artifact.kind !== "acceptance_limitation") return []
              if (typeof evidence.limitation === "string") return [evidence.limitation]
              if (
                typeof evidence.criterion_bindings === "object" &&
                evidence.criterion_bindings !== null &&
                typeof (evidence.criterion_bindings as Record<string, unknown>)[criterion] === "string"
              )
                return [(evidence.criterion_bindings as Record<string, string>)[criterion]!]
              return []
            }),
          ]),
        ].sort()
        const boundEvidence = [
          ...new Map(
            [...receiptEvidence, ...validationEvidence]
              .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
              .map((reference) => [`${reference.kind}:${reference.id}`, reference]),
          ).values(),
        ]
        return {
          criterion,
          disposition:
            boundEvidence.length || receiptArtifactIDs.length || artifactEvidenceBindings.length
              ? ("evidence" as const)
              : limitations.length
                ? ("limitation" as const)
                : ("missing" as const),
          evidence_refs: boundEvidence,
          artifact_ids: [
            ...new Set([...receiptArtifactIDs, ...artifactBindings.map((artifact) => artifact.id)]),
          ].sort(),
          limitations,
        }
      })
      const blockers = [
        ...(project.execution_strategy !== "seed_and_grow"
          ? [{ code: "not_seed_and_grow" as const, entity_ids: [project.id] }]
          : []),
        ...(!completableProjectStatuses.has(project.status)
          ? [{ code: "project_status_not_completable" as const, entity_ids: [project.id] }]
          : []),
        ...(workItems.some((item) => !terminalWorkItemStatuses.has(item.status))
          ? [
              {
                code: "nonterminal_work_items" as const,
                entity_ids: workItems
                  .filter((item) => !terminalWorkItemStatuses.has(item.status))
                  .map((item) => item.id)
                  .sort(),
              },
            ]
          : []),
        ...(attempts.some((attempt) => attempt.status === "running")
          ? [
              {
                code: "running_attempts" as const,
                entity_ids: attempts
                  .filter((attempt) => attempt.status === "running")
                  .map((attempt) => attempt.id)
                  .sort(),
              },
            ]
          : []),
        ...(attempts.some(
          (attempt) => attempt.status !== "running" && !receipts.some((receipt) => receipt.attempt_id === attempt.id),
        )
          ? [
              {
                code: "terminal_attempts_without_receipt" as const,
                entity_ids: attempts
                  .filter(
                    (attempt) =>
                      attempt.status !== "running" && !receipts.some((receipt) => receipt.attempt_id === attempt.id),
                  )
                  .map((attempt) => attempt.id)
                  .sort(),
              },
            ]
          : []),
        ...(receipts.some((receipt) => receipt.processing_status !== "processed")
          ? [
              {
                code: "unprocessed_receipts" as const,
                entity_ids: receipts
                  .filter((receipt) => receipt.processing_status !== "processed")
                  .map((receipt) => receipt.id)
                  .sort(),
              },
            ]
          : []),
        ...(mutations.some((mutation) => mutation.status === "proposed" || mutation.status === "validated")
          ? [
              {
                code: "pending_mutations" as const,
                entity_ids: mutations
                  .filter((mutation) => mutation.status === "proposed" || mutation.status === "validated")
                  .map((mutation) => mutation.id)
                  .sort(),
              },
            ]
          : []),
        ...(validationGates.some((gate) => ["pending", "running", "failed"].includes(gate.status))
          ? [
              {
                code: "unresolved_validation_gates" as const,
                entity_ids: validationGates
                  .filter((gate) => ["pending", "running", "failed"].includes(gate.status))
                  .map((gate) => gate.id)
                  .sort(),
              },
            ]
          : []),
        ...(approvalGates.some((gate) => gate.status === "pending")
          ? [
              {
                code: "pending_approval_gates" as const,
                entity_ids: approvalGates
                  .filter((gate) => gate.status === "pending")
                  .map((gate) => gate.id)
                  .sort(),
              },
            ]
          : []),
        ...(openMaterialAttention.length
          ? [
              {
                code: "open_material_attention" as const,
                entity_ids: openMaterialAttention.map((attention) => attention.id),
              },
            ]
          : []),
        ...(claimedActions.length
          ? [
              {
                code: "claimed_project_actions" as const,
                entity_ids: claimedActions.map((action) => action.id),
              },
            ]
          : []),
        ...(latestReceipts.some((receipt) => receipt.outcome !== "completed" || parseList(receipt.blockers_json).length)
          ? [
              {
                code: "unresolved_receipt_blockers" as const,
                entity_ids: latestReceipts
                  .filter((receipt) => receipt.outcome !== "completed" || parseList(receipt.blockers_json).length)
                  .map((receipt) => receipt.id)
                  .sort(),
              },
            ]
          : []),
        ...(acceptanceCoverage.some((coverage) => coverage.disposition === "missing")
          ? [
              {
                code: "acceptance_evidence_missing" as const,
                entity_ids: acceptanceCoverage
                  .filter((coverage) => coverage.disposition === "missing")
                  .map((coverage) => coverage.criterion),
              },
            ]
          : []),
        ...(!quiesce ? [{ code: "active_quiesce_decision_missing" as const, entity_ids: [project.id] }] : []),
      ].sort((left, right) => left.code.localeCompare(right.code))
      if (blockers.length)
        return {
          project,
          result: {
            project_id,
            status: project.execution_strategy === "seed_and_grow" ? ("blocked" as const) : ("not_applicable" as const),
            ready: false,
            replayed: false,
            graph_revision: project.graph_revision,
            blocker_codes: blockers.map((blocker) => blocker.code),
            blockers,
            released_selection_ids: [],
          },
        }
      const now = Date.now()
      const deliveryPackage = existingPackage ?? {
        id: Identifier.ascending("artifact"),
        project_id,
        work_item_id: null,
        kind: "delivery_package",
        title: `${project.title} Delivery Package`,
        path: null,
        content: `${JSON.stringify(
          {
            schema_version: 1,
            project_id,
            graph_revision: project.graph_revision,
            quiesce_decision_id: quiesce!.id,
            acceptance_coverage: acceptanceCoverage,
            work_item_ids: workItems.map((item) => item.id),
            receipt_ids: receipts.map((receipt) => receipt.id),
            validation_gate_ids: validationGates
              .filter((gate) => gate.status === "passed")
              .map((gate) => gate.id)
              .sort(),
            limitations: acceptanceCoverage.flatMap((coverage) => coverage.limitations),
          },
          null,
          2,
        )}\n`,
        evidence_json: JSON.stringify({
          quiesce_decision_id: quiesce!.id,
          graph_revision: project.graph_revision,
          receipt_ids: receipts.map((receipt) => receipt.id),
        }),
        created_by_agent_id: null,
        created_at: now,
      }
      if (!existingPackage) {
        db.insert(CompanyArtifactTable).values(deliveryPackage).run()
        db.insert(CompanyProjectEventTable)
          .values({
            id: Identifier.ascending("event"),
            project_id,
            type: "artifact.created",
            actor_id: null,
            data_json: JSON.stringify({
              artifact_id: deliveryPackage.id,
              kind: deliveryPackage.kind,
            }),
            created_at: now,
          })
          .run()
      }
      if (project.status !== "completed")
        db.insert(CompanyProjectEventTable)
          .values({
            id: Identifier.ascending("event"),
            project_id,
            type: "project.status_changed",
            actor_id: null,
            data_json: JSON.stringify({
              from: project.status,
              to: "completed",
              reason: "seed_graph_quiescent",
            }),
            created_at: now,
          })
          .run()
      db.update(CompanyProjectTable)
        .set({
          status: "completed",
          orchestration_state: "quiescent",
          updated_at: now,
          completed_at: project.completed_at ?? now,
        })
        .where(eq(CompanyProjectTable.id, project_id))
        .run()
      return {
        project,
        result: {
          project_id,
          status: "completed" as const,
          ready: true,
          replayed: Boolean(existingPackage && project.status === "completed"),
          graph_revision: project.graph_revision,
          blocker_codes: [],
          blockers: [],
          quiesce_decision_id: quiesce!.id,
          delivery_package_artifact_id: deliveryPackage.id,
          released_selection_ids: [],
        },
      }
    },
    { behavior: "immediate" },
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const recruitment = yield* CompanyRecruitment.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    const lock = (project_id: string) => {
      const current = locks.get(project_id)
      if (current) return current
      const created = Semaphore.makeUnsafe(1)
      locks.set(project_id, created)
      return created
    }
    const check = Effect.fn("QuiescenceService.check")(function* (project_id: string) {
      const finalized = yield* lock(project_id).withPermits(1)(Effect.sync(() => inspectAndFinalize(project_id)))
      if (finalized.result.status !== "completed") return finalized.result
      const released = yield* recruitment.releaseProject({
        ...(finalized.project.company_id ? { company_id: CompanyID.parse(finalized.project.company_id) } : {}),
        project_id,
      })
      return {
        ...finalized.result,
        released_selection_ids: released.map((selection) => selection.id).sort(),
      }
    })
    return Service.of({ check })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CompanyRecruitment.defaultLayer))

export * as QuiescenceService from "./quiescence"
