import { Context, Effect, Layer, Semaphore } from "effect"
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm"
import { GoalBriefAcceptanceCriterion } from "@agents-company/shared/experience"
import z from "zod"
import { existsSync, readFileSync } from "node:fs"
import { CompanyID } from "@/company/schema"
import {
  CompanyApprovalGateTable,
  CompanyAcceptanceCriterionTable,
  CompanyAcceptanceFactTable,
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
  CompanyWorkReceiptAcceptanceFactTable,
} from "@/company-project/company-project.sql"
import { CompanyRecruitment } from "@/company-recruitment"
import { GoalBriefTable, GoalBriefVersionTable } from "@/goal-brief"
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

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

const DeliveryArtifactBinding = z
  .object({
    id: z.string().trim().min(1),
    work_item_id: z.string().trim().min(1).nullable(),
    attempt_id: z.string().trim().min(1).nullable(),
    version: z.number().int().positive().nullable(),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    materialized_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    integrity_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict()

export const DeliveryAcceptanceBinding = z
  .object({
    version: z.number().int().positive(),
    graph_revision: z.number().int().nonnegative(),
    plan_id: z.string().trim().min(1),
    plan_version: z.number().int().positive(),
    plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    brief_id: z.string().trim().min(1),
    brief_version: z.number().int().positive(),
    brief_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    criterion_ids: z.array(z.string().trim().min(1)).max(200),
    criterion_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    acceptance_criteria_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    delivery_package_artifact_id: z.string().trim().min(1),
    delivery_package_integrity_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    artifact_ids: z.array(z.string().trim().min(1)).max(2_000),
    artifacts: z.array(DeliveryArtifactBinding).max(2_000),
    receipt_ids: z.array(z.string().trim().min(1)).max(2_000),
    receipts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    acceptance_fact_ids: z.array(z.string().trim().min(1)).max(10_000),
    acceptance_facts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    legacy_unverified: z.boolean(),
  })
  .strict()

export const DeliveryReadySnapshot = DeliveryAcceptanceBinding.extend({
  delivery_id: z.string().trim().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export function deliveryAcceptanceBindingDigest(input: z.infer<typeof DeliveryAcceptanceBinding>) {
  return sha256(JSON.stringify(DeliveryAcceptanceBinding.parse(input)))
}

function artifactBinding(row: typeof CompanyArtifactTable.$inferSelect) {
  const content_sha256 = row.content === null ? null : sha256(row.content)
  const materialized_sha256 = row.path
    ? existsSync(row.path)
      ? new Bun.CryptoHasher("sha256").update(readFileSync(row.path)).digest("hex")
      : null
    : null
  const integrity_sha256 = content_sha256 || materialized_sha256
    ? sha256(
        JSON.stringify({
          content_sha256: content_sha256 ?? undefined,
          materialized_sha256: materialized_sha256 ?? undefined,
        }),
      )
    : null
  if (
    row.content_sha256 !== content_sha256 ||
    row.materialized_sha256 !== materialized_sha256 ||
    row.integrity_sha256 !== integrity_sha256
  )
    throw new Error("stale_delivery")
  return DeliveryArtifactBinding.parse({
    id: row.id,
    work_item_id: row.work_item_id,
    attempt_id: row.attempt_id,
    version: row.version,
    content_sha256,
    materialized_sha256,
    integrity_sha256,
  })
}

export function deliveryAcceptanceSnapshotWithDatabase(
  db: Database.TxOrDb,
  input: { project_id: string; delivery_package_artifact_id: string; version: number },
) {
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, input.project_id)).get()
  if (!project?.active_plan_version) throw new Error("stale_delivery")
  const activePlans = db
    .select()
    .from(CompanyPlanTable)
    .where(and(eq(CompanyPlanTable.project_id, input.project_id), eq(CompanyPlanTable.status, "active")))
    .all()
  const plan = activePlans[0]
  if (activePlans.length !== 1 || plan?.version !== project.active_plan_version) throw new Error("stale_delivery")
  const briefRoot = db.select().from(GoalBriefTable).where(eq(GoalBriefTable.project_id, input.project_id)).get()
  const briefVersion = briefRoot
    ? db
        .select()
        .from(GoalBriefVersionTable)
        .where(eq(GoalBriefVersionTable.brief_id, briefRoot.id))
        .orderBy(desc(GoalBriefVersionTable.version))
        .get()
    : undefined
  const legacyCharter = briefRoot
    ? undefined
    : db
        .select({ project_id: CompanyProjectCharterTable.project_id })
        .from(CompanyProjectCharterTable)
        .where(eq(CompanyProjectCharterTable.project_id, input.project_id))
        .get()
  if ((briefRoot && !briefVersion) || (!briefRoot && !legacyCharter)) throw new Error("stale_delivery")
  const briefCriteria = briefVersion
    ? GoalBriefAcceptanceCriterion.array()
        .max(200)
        .parse(JSON.parse(briefVersion.acceptance_criteria_json))
    : []
  const criterion_ids = briefCriteria.map((criterion) => criterion.id).sort()
  if (new Set(criterion_ids).size !== criterion_ids.length) throw new Error("stale_delivery")
  const workItems = db
    .select()
    .from(CompanyWorkItemTable)
    .where(
      and(
        eq(CompanyWorkItemTable.project_id, input.project_id),
        eq(CompanyWorkItemTable.plan_id, plan.id),
        notInArray(CompanyWorkItemTable.status, ["superseded", "cancelled"]),
      ),
    )
    .orderBy(asc(CompanyWorkItemTable.id))
    .all()
  if (!workItems.length || workItems.some((item) => item.status !== "completed")) throw new Error("stale_delivery")
  const receipts = workItems.length
    ? db
        .select()
        .from(CompanyWorkReceiptTable)
        .where(inArray(CompanyWorkReceiptTable.work_item_id, workItems.map((item) => item.id)))
        .orderBy(desc(CompanyWorkReceiptTable.created_at), desc(CompanyWorkReceiptTable.id))
        .all()
        .filter(
          (receipt, index, values) =>
            values.findIndex((candidate) => candidate.work_item_id === receipt.work_item_id) === index,
        )
        .sort((left, right) => left.id.localeCompare(right.id))
    : []
  if (receipts.length !== workItems.length || receipts.some((receipt) => receipt.outcome !== "completed"))
    throw new Error("stale_delivery")
  const artifact_ids = [
    ...new Set(receipts.flatMap((receipt) => z.array(z.string().trim().min(1)).parse(JSON.parse(receipt.artifact_ids_json)))),
  ].sort()
  const artifactRows = artifact_ids.length
    ? db
        .select()
        .from(CompanyArtifactTable)
        .where(inArray(CompanyArtifactTable.id, artifact_ids))
        .all()
        .sort((left, right) => left.id.localeCompare(right.id))
    : []
  if (artifactRows.length !== artifact_ids.length || artifactRows.some((artifact) => artifact.project_id !== input.project_id))
    throw new Error("stale_delivery")
  const artifacts = artifactRows.map(artifactBinding)
  if (artifacts.some((artifact) => !artifact.integrity_sha256)) throw new Error("stale_delivery")
  const receiptByID = new Map(receipts.map((receipt) => [receipt.id, receipt]))
  const attemptRows = receipts.length
    ? db
        .select()
        .from(CompanyWorkAttemptTable)
        .where(inArray(CompanyWorkAttemptTable.id, receipts.map((receipt) => receipt.attempt_id)))
        .all()
    : []
  if (
    attemptRows.length !== receipts.length ||
    receipts.some((receipt) => {
      const item = workItems.find((candidate) => candidate.id === receipt.work_item_id)
      const attempt = attemptRows.find((candidate) => candidate.id === receipt.attempt_id)
      const receiptArtifactIDs = z.array(z.string().trim().min(1)).parse(JSON.parse(receipt.artifact_ids_json))
      return (
        !item ||
        !attempt ||
        attempt.project_id !== input.project_id ||
        attempt.work_item_id !== item.id ||
        attempt.ordinal !== item.attempt ||
        attempt.status !== "completed" ||
        receiptArtifactIDs.some((artifactID) => {
          const artifact = artifactRows.find((candidate) => candidate.id === artifactID)
          return !artifact || artifact.work_item_id !== item.id || artifact.attempt_id !== attempt.id
        })
      )
    })
  )
    throw new Error("stale_delivery")
  const acceptanceLinks = receipts.length
    ? db
        .select()
        .from(CompanyWorkReceiptAcceptanceFactTable)
        .where(inArray(CompanyWorkReceiptAcceptanceFactTable.receipt_id, receipts.map((receipt) => receipt.id)))
        .all()
    : []
  const acceptance_fact_ids = [...new Set(acceptanceLinks.map((link) => link.fact_id))].sort()
  const receiptByWorkItemID = new Map(receipts.map((receipt) => [receipt.work_item_id, receipt]))
  const acceptanceCriteria = workItems.length
    ? db
        .select()
        .from(CompanyAcceptanceCriterionTable)
        .where(inArray(CompanyAcceptanceCriterionTable.work_item_id, workItems.map((item) => item.id)))
        .orderBy(asc(CompanyAcceptanceCriterionTable.id))
        .all()
    : []
  if (
    acceptanceCriteria.some(
      (criterion) =>
        criterion.project_id !== input.project_id ||
        criterion.plan_id !== plan.id ||
        sha256(criterion.statement) !== criterion.statement_sha256,
    )
  )
    throw new Error("stale_delivery")
  if (
    workItems.some(
      (item) =>
        item.validation_contract_version === 2 &&
        (!acceptanceCriteria.some((criterion) => criterion.work_item_id === item.id) ||
          !acceptanceLinks.some((link) => link.receipt_id === receiptByWorkItemID.get(item.id)?.id)),
    )
  )
    throw new Error("stale_delivery")
  const facts = acceptance_fact_ids.length
    ? db
        .select()
        .from(CompanyAcceptanceFactTable)
        .where(inArray(CompanyAcceptanceFactTable.id, acceptance_fact_ids))
        .all()
        .sort((left, right) => left.id.localeCompare(right.id))
    : []
  const supersedingFacts = acceptance_fact_ids.length
    ? db
        .select({ id: CompanyAcceptanceFactTable.id })
        .from(CompanyAcceptanceFactTable)
        .where(inArray(CompanyAcceptanceFactTable.supersedes_fact_id, acceptance_fact_ids))
        .all()
    : []
  if (
    facts.length !== acceptance_fact_ids.length ||
    supersedingFacts.length > 0 ||
    acceptanceCriteria.some(
      (criterion) =>
        criterion.required &&
        !facts.some(
          (fact) =>
            fact.work_item_id === criterion.work_item_id &&
            fact.criterion_id === criterion.id &&
            fact.verdict === "passed" &&
            acceptanceLinks.some(
              (link) =>
                link.fact_id === fact.id &&
                link.receipt_id === receiptByWorkItemID.get(criterion.work_item_id)?.id,
            ),
        ),
    ) ||
    facts.some(
      (fact) =>
        fact.verdict !== "passed" ||
        !acceptanceCriteria.some(
          (criterion) => criterion.id === fact.criterion_id && criterion.work_item_id === fact.work_item_id,
        ) ||
        artifacts.find((artifact) => artifact.id === fact.artifact_id)?.integrity_sha256 !==
          fact.artifact_integrity_sha256,
    ) ||
    acceptanceLinks.some((link) => {
      const receipt = receiptByID.get(link.receipt_id)
      const fact = facts.find((candidate) => candidate.id === link.fact_id)
      return (
        !receipt ||
        !fact ||
        fact.project_id !== input.project_id ||
        fact.work_item_id !== receipt.work_item_id ||
        fact.attempt_id !== receipt.attempt_id ||
        !artifact_ids.includes(fact.artifact_id)
      )
    })
  )
    throw new Error("stale_delivery")
  const deliveryPackage = db
    .select()
    .from(CompanyArtifactTable)
    .where(eq(CompanyArtifactTable.id, input.delivery_package_artifact_id))
    .get()
  if (!deliveryPackage || deliveryPackage.project_id !== input.project_id || deliveryPackage.kind !== "delivery_package")
    throw new Error("stale_delivery")
  if (deliveryPackage.version !== input.version) throw new Error("stale_delivery")
  const packageBinding = artifactBinding(deliveryPackage)
  if (!packageBinding.integrity_sha256) throw new Error("stale_delivery")
  return DeliveryAcceptanceBinding.parse({
    version: input.version,
    graph_revision: project.graph_revision,
    plan_id: plan.id,
    plan_version: plan.version,
    plan_sha256: sha256(JSON.stringify(plan)),
    brief_id: briefRoot?.id ?? `legacy:${input.project_id}`,
    brief_version: briefVersion?.version ?? 1,
    brief_sha256: sha256(JSON.stringify(briefVersion ?? legacyCharter)),
    criterion_ids,
    criterion_sha256: sha256(JSON.stringify(briefCriteria)),
    acceptance_criteria_sha256: sha256(JSON.stringify(acceptanceCriteria)),
    delivery_package_artifact_id: deliveryPackage.id,
    delivery_package_integrity_sha256: packageBinding.integrity_sha256,
    artifact_ids,
    artifacts,
    receipt_ids: receipts.map((receipt) => receipt.id),
    receipts_sha256: sha256(JSON.stringify(receipts)),
    acceptance_fact_ids,
    acceptance_facts_sha256: sha256(JSON.stringify(facts)),
    legacy_unverified: !briefCriteria.length || workItems.some((item) => item.validation_contract_version === 1),
  })
}

function inspectAndFinalize(project_id: string) {
  return Database.transaction(
    (db) => {
      const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, project_id)).get()
      if (!project) throw new Error(`Company project not found: ${project_id}`)
      const deliveryEvents = db
        .select()
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.project_id, project_id))
        .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
        .all()
      const latestReady = deliveryEvents.findLast((event) => event.type === "delivery.ready")
      const revisionPending =
        deliveryEvents.findLastIndex((event) => event.type === "delivery.revision_requested") >
        deliveryEvents.findLastIndex((event) => event.type === "delivery.ready")
      const deliveryPackages = db
        .select()
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.project_id, project_id))
        .orderBy(asc(CompanyArtifactTable.created_at), asc(CompanyArtifactTable.id))
        .all()
        .filter((artifact) => artifact.kind === "delivery_package")
      const latestPackage = deliveryPackages.at(-1)
      const existingPackage = revisionPending ? undefined : latestPackage
      const ensureDeliveryReady = (artifactID: string, createdAt: number) => {
        const exists = db
          .select({ data_json: CompanyProjectEventTable.data_json })
          .from(CompanyProjectEventTable)
          .where(
            and(
              eq(CompanyProjectEventTable.project_id, project_id),
              eq(CompanyProjectEventTable.type, "delivery.ready"),
            ),
          )
          .all()
          .some((event) => {
            const data = JSON.parse(event.data_json) as Record<string, unknown>
            return data.delivery_package_artifact_id === artifactID
          })
        if (exists) return
        const version = latestReady
          ? z
              .object({ version: z.number().int().positive() })
              .passthrough()
              .parse(JSON.parse(latestReady.data_json)).version + 1
          : 1
        const binding = deliveryAcceptanceSnapshotWithDatabase(db, {
          project_id,
          delivery_package_artifact_id: artifactID,
          version,
        })
        db.insert(CompanyProjectEventTable)
          .values({
            id: Identifier.ascending("event"),
            project_id,
            type: "delivery.ready",
            actor_id: null,
            data_json: JSON.stringify({
              delivery_id: `delivery:${artifactID}`,
              ...binding,
              sha256: deliveryAcceptanceBindingDigest(binding),
            }),
            created_at: createdAt,
          })
          .run()
      }
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
      if (
        project.status === "completed" &&
        existingPackage &&
        !openMaterialAttention.length &&
        !claimedActions.length
      ) {
        ensureDeliveryReady(existingPackage.id, Date.now())
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
      const deliveryPackageContent = `${JSON.stringify(
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
      )}\n`
      const deliveryPackageContentSha256 = sha256(deliveryPackageContent)
      const deliveryPackage = existingPackage ?? {
        id: Identifier.ascending("artifact"),
        project_id,
        company_id: null,
        scope_type: "project" as const,
        private_owner_id: null,
        work_item_id: null,
        attempt_id: null,
        version: latestPackage?.version ? latestPackage.version + 1 : 1,
        supersedes_artifact_id: latestPackage?.id ?? null,
        content_sha256: deliveryPackageContentSha256,
        materialized_sha256: null,
        integrity_sha256: sha256(JSON.stringify({ content_sha256: deliveryPackageContentSha256 })),
        kind: "delivery_package",
        title: `${project.title} Delivery Package`,
        path: null,
        content: deliveryPackageContent,
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
      ensureDeliveryReady(deliveryPackage.id, now)
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
