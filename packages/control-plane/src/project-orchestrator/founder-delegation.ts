import { createHash } from "node:crypto"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { and, asc, desc, eq } from "drizzle-orm"
import z from "zod"
import {
  FounderGreenDelegationAction,
  FounderGreenDelegationInput,
  FounderGreenDelegationProjection,
  FounderGreenDelegationRun,
  FounderGreenReadiness,
  FounderGreenReadinessRecordInput,
  type FounderGreenDelegationInput as FounderGreenDelegationInputValue,
  type FounderGreenReadiness as FounderGreenReadinessValue,
  type FounderGreenReadinessRecordInput as FounderGreenReadinessRecordInputValue,
} from "@agents-company/shared/founder-os"
import { CompanyTable } from "@/company/company.sql"
import {
  CompanyArtifactTable,
  CompanyGraphDecisionTable,
  CompanyOutcomeSignalTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyProjectTable,
  CompanyWorktreeRunTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { GraphOperation } from "@/company-project/schema"
import { GovernanceService, governanceLayer } from "@/founder-os/authority"
import { FounderInterventionFenceTable } from "@/founder-os/advisor.sql"
import {
  defaultLayer as decisionLedgerLayer,
  Service as DecisionLedgerService,
} from "@/founder-os/decision-ledger"
import {
  DecisionCurrentProjectionTable,
  FounderCorrectionTable,
  FounderGovernanceEventTable,
} from "@/founder-os/decision-ledger.sql"
import * as FounderOSMode from "@/founder-os/mode"
import { metricContract } from "@/founder-os/metric"
import {
  FounderBenchmarkReportTable,
  FounderShadowComparisonTable,
} from "@/founder-os/shadow.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { ProjectOrchestrator } from "./project-orchestrator"
import {
  FounderGreenDelegationRunTable,
  FounderGreenReadinessTable,
} from "./founder-delegation.sql"

const GateArtifactEvidence = z
  .object({
    verified: z.literal(true),
    gate: z.enum(["B3", "E0"]),
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
  })
  .catchall(z.unknown())

const W5ObservationEvidence = z
  .object({
    verified: z.literal(true),
    gate: z.literal("W5"),
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
    observationWindowDays: z.literal(30),
    sampleSize: z.number().int().min(20),
  })
  .catchall(z.unknown())

const TakeoverFenceEvidence = z
  .object({
    verified: z.literal(true),
    gate: z.literal("TAKEOVER_FENCE"),
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
    postFenceAuthorizationCount: z.literal(0),
    postFenceDispatchCount: z.literal(0),
    inFlightReconciled: z.literal(true),
  })
  .catchall(z.unknown())

const MetricContractEvidence = z
  .object({
    verified: z.literal(true),
    gate: z.literal("FOS_METRIC_001"),
    authority: z.enum(["control_plane", "human", "external_system", "independent_reviewer"]),
    contractVersion: z.literal("founder-os-w2-v1"),
    observationWindowDays: z.literal(30),
    metrics: z.array(z.object({
      id: z.string(),
      sampleSize: z.number().int().nonnegative(),
      value: z.number(),
    }).strict()),
  })
  .catchall(z.unknown())

function metricTargetMet(id: string, value: number) {
  if (["red_recall", "evidence_traceability", "ai_decision_outcome_traceability"].includes(id))
    return value === 1
  if (id === "historical_choice_consistency") return value >= 0.7
  if (id === "unauthorized_red_actions") return value === 0
  return false
}

function metricEvidenceMeetsContract(value: z.infer<typeof MetricContractEvidence>) {
  return metricContract.metrics.every((required) => {
    const observed = value.metrics.find((metric) => metric.id === required.id)
    return Boolean(
      observed
      && observed.sampleSize >= required.minimumSampleSize
      && metricTargetMet(required.id, observed.value),
    )
  })
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex")
}

function mode(companyId: string) {
  const company = Database.use((db) =>
    db.select().from(CompanyTable).where(eq(CompanyTable.id, companyId)).get(),
  )
  if (!company) throw new Error("Company was not found")
  return FounderOSMode.resolve({
    founderTwinMode: company.founder_twin_mode,
    companyCommonsMode: company.company_commons_mode,
  })
}

function readiness(companyId: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(FounderGreenReadinessTable)
      .where(eq(FounderGreenReadinessTable.company_id, companyId))
      .orderBy(desc(FounderGreenReadinessTable.created_at), desc(FounderGreenReadinessTable.id))
      .get(),
  )
  if (!row)
    return {
      id: null,
      value: FounderGreenReadiness.parse({
        schemaVersion: 1,
        companyId,
        status: "blocked",
        b3: { status: "missing", evidenceRef: null },
        e0: { status: "missing", evidenceRef: null },
        w5Observation: { status: "missing", evidenceRef: null },
        takeoverFence: { status: "missing", evidenceRef: null },
        preferenceHoldout: { status: "missing", reportRef: null, agreementRate: null },
        metricContract: {
          status: "missing",
          evidenceRef: null,
          windowDays: null,
          sampleContractMet: false,
        },
        authorization: { status: "missing", eventId: null, confirmedBy: null },
        exactCommit: { status: "missing", sha: null, evidenceRef: null },
        failClosedReasons: [
          "B3 evidence is missing.",
          "E0 evidence is missing.",
          "W5 observation evidence is missing.",
          "Takeover fence evidence is missing.",
          "Preference holdout benchmark is missing.",
          "FOS-METRIC-001 sample and window evidence is missing.",
          "Human authorization is missing.",
          "Exact commit submission evidence is missing.",
        ],
        autoPromotionAllowed: false,
        recordedAt: null,
      }),
    }
  const reasons = [
    ...(row.b3_status === "passed" && row.b3_evidence_ref ? [] : ["B3 evidence is missing."]),
    ...(row.e0_status === "passed" && row.e0_evidence_ref ? [] : ["E0 evidence is missing."]),
    ...(row.w5_observation_status === "passed" && row.w5_observation_evidence_ref
      ? []
      : ["W5 observation evidence is missing."]),
    ...(row.takeover_fence_status === "passed" && row.takeover_fence_evidence_ref
      ? []
      : ["Takeover fence evidence is missing."]),
    ...(row.preference_holdout_status === "passed"
      && row.preference_benchmark_report_id
      && row.preference_agreement_rate !== null
      && row.preference_agreement_rate >= 0.8
      ? []
      : ["Preference holdout agreement is missing or below 80%."]),
    ...(row.metric_contract_status === "passed"
      && row.metric_contract_evidence_ref
      && row.metric_window_days === 30
      && row.metric_sample_contract_met
      ? []
      : ["FOS-METRIC-001 sample and window contract is missing."]),
    ...(row.authorization_status === "human_confirmed" && row.authorization_event_id && row.confirmed_by
      ? []
      : ["Human authorization is missing."]),
    ...(row.exact_commit_status === "passed" && row.exact_commit_sha && row.exact_commit_evidence_ref
      ? []
      : ["Exact commit submission evidence is missing."]),
  ]
  return {
    id: row.id,
    value: FounderGreenReadiness.parse({
      schemaVersion: 1,
      companyId,
      status: reasons.length ? "blocked" : "ready",
      b3: { status: row.b3_status, evidenceRef: row.b3_evidence_ref },
      e0: { status: row.e0_status, evidenceRef: row.e0_evidence_ref },
      w5Observation: {
        status: row.w5_observation_status,
        evidenceRef: row.w5_observation_evidence_ref,
      },
      takeoverFence: {
        status: row.takeover_fence_status,
        evidenceRef: row.takeover_fence_evidence_ref,
      },
      preferenceHoldout: {
        status: row.preference_holdout_status,
        reportRef: row.preference_benchmark_report_id,
        agreementRate: row.preference_agreement_rate,
      },
      metricContract: {
        status: row.metric_contract_status,
        evidenceRef: row.metric_contract_evidence_ref,
        windowDays: row.metric_window_days,
        sampleContractMet: row.metric_sample_contract_met,
      },
      authorization: {
        status: row.authorization_status,
        eventId: row.authorization_event_id,
        confirmedBy: row.confirmed_by,
      },
      exactCommit: {
        status: row.exact_commit_status,
        sha: row.exact_commit_sha,
        evidenceRef: row.exact_commit_evidence_ref,
      },
      failClosedReasons: reasons,
      autoPromotionAllowed: false,
      recordedAt: row.created_at,
    }),
  }
}

function fenced(companyId: string, boardThreadId: string) {
  return Boolean(Database.use((db) =>
    db
      .select({ id: FounderInterventionFenceTable.id })
      .from(FounderInterventionFenceTable)
      .where(and(
        eq(FounderInterventionFenceTable.company_id, companyId),
        eq(FounderInterventionFenceTable.board_thread_id, boardThreadId),
      ))
      .get(),
  ))
}

function chain(row: typeof FounderGreenDelegationRunTable.$inferSelect) {
  const graphDecision = row.graph_decision_id
    ? Database.use((db) =>
        db.select().from(CompanyGraphDecisionTable).where(eq(CompanyGraphDecisionTable.id, row.graph_decision_id!)).get(),
      )
    : undefined
  const triggerReceipt = Database.use((db) =>
    db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, row.receipt_id)).get(),
  )
  const workItemIds = [...new Set([
    ...(triggerReceipt ? [triggerReceipt.work_item_id] : []),
    ...(graphDecision
    ? GraphOperation.array()
        .parse(JSON.parse(graphDecision.operations_json))
        .flatMap((operation) => operation.type === "add_work_item" ? [operation.item.id] : [])
    : []),
  ])].sort()
  const receiptIds = Database.use((db) =>
    db
      .select({ id: CompanyWorkReceiptTable.id, workItemId: CompanyWorkReceiptTable.work_item_id })
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.project_id, row.project_id))
      .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
      .all(),
  )
    .filter((receipt) => receipt.id === row.receipt_id || workItemIds.includes(receipt.workItemId))
    .map((receipt) => receipt.id)
  const outcomeIds = Database.use((db) =>
    db
      .select({ id: CompanyOutcomeSignalTable.id })
      .from(CompanyOutcomeSignalTable)
      .innerJoin(
        CompanyOutcomeSignalCurrentTable,
        eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
      )
      .where(and(
        eq(CompanyOutcomeSignalTable.decision_id, row.decision_id),
        eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
      ))
      .orderBy(asc(CompanyOutcomeSignalTable.observed_at), asc(CompanyOutcomeSignalTable.id))
      .all()
      .map((outcome) => outcome.id),
  )
  const ledgerOutcomeIds = Database.use((db) =>
    db
      .select({ ids: DecisionCurrentProjectionTable.outcome_ref_ids_json })
      .from(DecisionCurrentProjectionTable)
      .where(eq(DecisionCurrentProjectionTable.decision_id, row.decision_id))
      .get(),
  )
  return {
    decisionId: row.decision_id,
    ledgerDecisionId: row.decision_id,
    governanceRef: row.governance_ref,
    graphDecisionId: row.graph_decision_id,
    mutationId: row.mutation_id,
    workItemIds,
    receiptIds,
    outcomeIds,
    ledgerOutcomeLinked: Boolean(outcomeIds.length) && outcomeIds.every((id) =>
      ledgerOutcomeIds ? z.array(z.string()).parse(JSON.parse(ledgerOutcomeIds.ids)).includes(id) : false
    ),
  }
}

function fromRow(row: typeof FounderGreenDelegationRunTable.$inferSelect) {
  const currentChain = chain(row)
  const latestOutcome = currentChain.outcomeIds.length
    ? Database.use((db) =>
        db
          .select({
            result: CompanyOutcomeSignalTable.result,
            currentStatus: CompanyOutcomeSignalCurrentTable.current_status,
          })
          .from(CompanyOutcomeSignalTable)
          .innerJoin(
            CompanyOutcomeSignalCurrentTable,
            eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
          )
          .where(eq(
            CompanyOutcomeSignalTable.id,
            currentChain.outcomeIds[currentChain.outcomeIds.length - 1]!,
          ))
          .get(),
      )
    : undefined
  const outcomeStatus = latestOutcome?.currentStatus === "validated" ? latestOutcome.result : "missing"
  const completeChain = outcomeStatus === "succeeded"
    && Boolean(
      currentChain.governanceRef
      && currentChain.graphDecisionId
      && currentChain.mutationId
      && currentChain.workItemIds.length
      && currentChain.receiptIds.length
      && currentChain.outcomeIds.length
      && currentChain.ledgerOutcomeLinked
    )
  return FounderGreenDelegationRun.parse({
    schemaVersion: 1,
    id: row.id,
    companyId: row.company_id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    boardThreadId: row.board_thread_id,
    receiptId: row.receipt_id,
    actionType: row.action_type,
    actionAllowlisted: row.action_allowlisted,
    status: row.status,
    readiness: JSON.parse(row.readiness_json),
    mode: JSON.parse(row.mode_json),
    authority: row.authority_json ? JSON.parse(row.authority_json) : null,
    gate: row.gate_json ? JSON.parse(row.gate_json) : null,
    dispatch: row.dispatch_json ? JSON.parse(row.dispatch_json) : null,
    chain: currentChain,
    outcomeStatus,
    completeChain,
    failClosedReasons: JSON.parse(row.fail_closed_reasons_json),
    selfEvaluationAcceptedAsTruth: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function save(input: {
  id: string
  request: FounderGreenDelegationInputValue
  inputSha256: string
  status: "blocked" | "authorized" | "outcome_pending" | "completed" | "failed"
  readiness: FounderGreenReadinessValue
  readinessId: string | null
  mode: ReturnType<typeof mode>
  authority: unknown | null
  gate: unknown | null
  governanceRef: string | null
  graphDecisionId?: string | null
  mutationId?: string | null
  dispatch?: { status: "paused" | "gated" | "idle" | "dispatched"; workItemIds: string[] } | null
  reasons: string[]
  error?: string | null
}) {
  const existing = Database.use((db) =>
    db.select().from(FounderGreenDelegationRunTable).where(eq(FounderGreenDelegationRunTable.id, input.id)).get(),
  )
  const row = {
    id: input.id,
    company_id: input.request.companyId,
    idempotency_key: input.request.idempotencyKey,
    input_sha256: input.inputSha256,
    decision_id: input.request.decisionId,
    project_id: input.request.projectId,
    board_thread_id: input.request.boardThreadId,
    receipt_id: input.request.receiptId,
    action_type: input.request.actionType,
    action_allowlisted: FounderGreenDelegationAction.safeParse(input.request.actionType).success,
    status: input.status,
    readiness_id: input.readinessId,
    readiness_json: JSON.stringify(input.readiness),
    mode_json: JSON.stringify(input.mode),
    authority_json: input.authority ? JSON.stringify(input.authority) : null,
    gate_json: input.gate ? JSON.stringify(input.gate) : null,
    governance_ref: input.governanceRef,
    graph_decision_id: input.graphDecisionId ?? null,
    mutation_id: input.mutationId ?? null,
    dispatch_json: input.dispatch ? JSON.stringify(input.dispatch) : null,
    fail_closed_reasons_json: JSON.stringify(input.reasons),
    error: input.error ?? null,
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
  }
  Database.transaction((db) => {
    if (existing) {
      db.update(FounderGreenDelegationRunTable)
        .set(row)
        .where(eq(FounderGreenDelegationRunTable.id, input.id))
        .run()
      return
    }
    db.insert(FounderGreenDelegationRunTable).values(row).run()
  }, { behavior: "immediate" })
  return fromRow(Database.use((db) =>
    db.select().from(FounderGreenDelegationRunTable).where(eq(FounderGreenDelegationRunTable.id, input.id)).get()!,
  ))
}

function reconcileOutcomes(companyId: string) {
  Database.transaction((db) =>
    db
      .select()
      .from(FounderGreenDelegationRunTable)
      .where(and(
        eq(FounderGreenDelegationRunTable.company_id, companyId),
        eq(FounderGreenDelegationRunTable.status, "outcome_pending"),
      ))
      .all()
      .forEach((run) => {
        const outcome = db
          .select()
          .from(CompanyOutcomeSignalTable)
          .innerJoin(
            CompanyOutcomeSignalCurrentTable,
            eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
          )
          .where(and(
            eq(CompanyOutcomeSignalTable.decision_id, run.decision_id),
            eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
          ))
          .orderBy(desc(CompanyOutcomeSignalTable.observed_at), desc(CompanyOutcomeSignalTable.id))
          .get()
        if (!outcome) return
        const complete = outcome.company_outcome_signal.result === "succeeded"
          && Boolean(run.governance_ref && run.graph_decision_id && run.mutation_id)
        db.update(FounderGreenDelegationRunTable)
          .set({
            status: complete ? "completed" : "failed",
            fail_closed_reasons_json: JSON.stringify(
              complete
                ? []
                : outcome.company_outcome_signal.result === "succeeded"
                  ? ["OutcomeSignal succeeded but the persisted delegation chain is incomplete."]
                  : [`OutcomeSignal result is ${outcome.company_outcome_signal.result}.`],
            ),
            updated_at: Date.now(),
          })
          .where(eq(FounderGreenDelegationRunTable.id, run.id))
          .run()
      }),
  )
}

function recordReadiness(raw: FounderGreenReadinessRecordInputValue) {
  const input = FounderGreenReadinessRecordInput.parse(raw)
  const inputSha256 = digest(input)
  Database.transaction((db) => {
    const existing = db
      .select()
      .from(FounderGreenReadinessTable)
      .where(and(
        eq(FounderGreenReadinessTable.company_id, input.companyId),
        eq(FounderGreenReadinessTable.idempotency_key, input.idempotencyKey),
      ))
      .get()
    if (existing) {
      if (existing.input_sha256 !== inputSha256)
        throw new Error("Green readiness idempotency key has different facts")
      return
    }
    const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, input.companyId)).get()
    if (!company) throw new Error("Company was not found")
    const resolvedMode = FounderOSMode.resolve({
      founderTwinMode: company.founder_twin_mode,
      companyCommonsMode: company.company_commons_mode,
    })
    if (company.founder_twin_mode !== "advisor")
      throw new Error("Green readiness promotion requires current company mode advisor")
    if (!["green-delegated", "yellow-delegated"].includes(resolvedMode.globalMaximum.founderTwinMode))
      throw new Error("Global Founder Twin mode does not allow Green delegation")
    const artifact = (id: string, gate: "B3" | "E0") => {
      const row = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, id)).get()
      const project = row?.project_id
        ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, row.project_id)).get()
        : undefined
      if (
        !row
        || (row.company_id !== input.companyId && project?.company_id !== input.companyId)
        || GateArtifactEvidence.parse(JSON.parse(row.evidence_json)).gate !== gate
      )
        throw new Error(`${gate} readiness requires a verified company-scoped evidence Artifact`)
      return row
    }
    const b3 = artifact(input.b3ArtifactId, "B3")
    const e0 = artifact(input.e0ArtifactId, "E0")
    const typedArtifact = <T>(
      id: string,
      schema: z.ZodType<T>,
      label: string,
    ) => {
      const row = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, id)).get()
      const project = row?.project_id
        ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, row.project_id)).get()
        : undefined
      const evidence = row ? schema.safeParse(JSON.parse(row.evidence_json)) : undefined
      if (
        !row
        || (row.company_id !== input.companyId && project?.company_id !== input.companyId)
        || !evidence?.success
      )
        throw new Error(`${label} requires verified company-scoped typed evidence`)
      return { row, evidence: evidence.data }
    }
    const w5 = typedArtifact(input.w5ObservationArtifactId, W5ObservationEvidence, "W5 observation")
    const takeover = typedArtifact(input.takeoverFenceArtifactId, TakeoverFenceEvidence, "Takeover fence")
    const metric = typedArtifact(input.metricContractArtifactId, MetricContractEvidence, "FOS-METRIC-001")
    if (!metricEvidenceMeetsContract(metric.evidence))
      throw new Error("FOS-METRIC-001 evidence does not meet every minimum sample and target")
    const preference = db
      .select()
      .from(FounderBenchmarkReportTable)
      .where(and(
        eq(FounderBenchmarkReportTable.id, input.preferenceBenchmarkReportId),
        eq(FounderBenchmarkReportTable.company_id, input.companyId),
      ))
      .get()
    const preferenceMetrics = preference
      ? z
          .object({ agreementRate: z.number().min(0).max(1).nullable() })
          .catchall(z.unknown())
          .safeParse(JSON.parse(preference.metrics_json))
      : undefined
    if (
      !preference
      || preference.benchmark_type !== "taste"
      || preference.status !== "pass"
      || preference.confirmed_sample_count < 20
      || !preferenceMetrics?.success
      || preferenceMetrics.data.agreementRate === null
      || preferenceMetrics.data.agreementRate < 0.8
    )
      throw new Error("Green readiness requires a passing taste holdout benchmark with at least 80% agreement")
    const authorization = db
      .select()
      .from(FounderGovernanceEventTable)
      .where(and(
        eq(FounderGovernanceEventTable.id, input.authorizationEventId),
        eq(FounderGovernanceEventTable.company_id, input.companyId),
        eq(FounderGovernanceEventTable.actor_kind, "human"),
        eq(FounderGovernanceEventTable.actor_id, input.actor.id),
      ))
      .get()
    if (!authorization || authorization.type !== "approval_gate.resolved")
      throw new Error("Green readiness requires an existing human ApprovalGate resolution event")
    const authorizationData = z
      .object({ decision: z.literal("approve") })
      .catchall(z.unknown())
      .parse(JSON.parse(authorization.data_json))
    if (authorizationData.decision !== "approve")
      throw new Error("Green readiness requires an approved human authorization event")
    const worktree = db
      .select()
      .from(CompanyWorktreeRunTable)
      .where(eq(CompanyWorktreeRunTable.id, input.exactCommit.worktreeRunId))
      .get()
    const project = worktree
      ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, worktree.project_id)).get()
      : undefined
    if (
      !worktree
      || project?.company_id !== input.companyId
      || worktree.status !== "merged"
      || worktree.head_commit !== input.exactCommit.sha
      || !worktree.merge_gate_id
    )
      throw new Error("Exact commit readiness requires a merged, approved company WorktreeRun at the submitted SHA")
    db.insert(FounderGreenReadinessTable)
      .values({
        id: Identifier.create("fgrdy", "ascending"),
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        b3_status: "passed",
        b3_evidence_ref: b3.id,
        e0_status: "passed",
        e0_evidence_ref: e0.id,
        w5_observation_status: "passed",
        w5_observation_evidence_ref: w5.row.id,
        takeover_fence_status: "passed",
        takeover_fence_evidence_ref: takeover.row.id,
        preference_holdout_status: "passed",
        preference_benchmark_report_id: preference.id,
        preference_agreement_rate: preferenceMetrics.data.agreementRate,
        metric_contract_status: "passed",
        metric_contract_evidence_ref: metric.row.id,
        metric_window_days: metric.evidence.observationWindowDays,
        metric_sample_contract_met: true,
        authorization_status: "human_confirmed",
        authorization_event_id: authorization.id,
        confirmed_by: input.actor.id,
        exact_commit_status: "passed",
        exact_commit_sha: input.exactCommit.sha,
        exact_commit_evidence_ref: worktree.id,
        created_at: Date.now(),
      })
      .run()
    db.update(CompanyTable)
      .set({ founder_twin_mode: "green-delegated", time_updated: Date.now() })
      .where(eq(CompanyTable.id, input.companyId))
      .run()
  }, { behavior: "immediate" })
  return readiness(input.companyId).value
}

export interface Interface {
  readonly submit: (
    input: FounderGreenDelegationInputValue,
  ) => Effect.Effect<FounderGreenDelegationRun, unknown>
  readonly projection: (companyId: string) => Effect.Effect<FounderGreenDelegationProjection, unknown>
  readonly recordReadiness: (
    input: FounderGreenReadinessRecordInputValue,
  ) => Effect.Effect<FounderGreenReadiness, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/FounderGreenDelegation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const governance = yield* GovernanceService
    const ledger = yield* DecisionLedgerService
    const orchestrator = yield* ProjectOrchestrator.Service

    const submit = Effect.fn("FounderGreenDelegation.submit")(function* (
      raw: FounderGreenDelegationInputValue,
    ) {
      const input = FounderGreenDelegationInput.parse(raw)
      const inputSha256 = digest(input)
      const existing = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(FounderGreenDelegationRunTable)
            .where(and(
              eq(FounderGreenDelegationRunTable.company_id, input.companyId),
              eq(FounderGreenDelegationRunTable.idempotency_key, input.idempotencyKey),
            ))
            .get(),
        ),
      )
      if (existing) {
        if (existing.input_sha256 !== inputSha256)
          throw new Error("Green delegation idempotency key has different facts")
        reconcileOutcomes(input.companyId)
        return fromRow(Database.use((db) =>
          db.select().from(FounderGreenDelegationRunTable).where(eq(FounderGreenDelegationRunTable.id, existing.id)).get()!,
        ))
      }
      const id = Identifier.create("fgdel", "ascending")
      const currentMode = mode(input.companyId)
      const currentReadiness = readiness(input.companyId)
      const decision = yield* ledger.get(input.decisionId)
      const receipt = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, input.receiptId)).get(),
        ),
      )
      if (
        decision.scope.type !== "project"
        || decision.scope.companyId !== input.companyId
        || decision.scope.projectId !== input.projectId
        || decision.decisionMaker !== "ai_founder"
        || decision.decisionMakerId !== "board-ceo"
      )
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: null,
          gate: null,
          governanceRef: null,
          reasons: ["Delegation requires a project-scoped board-ceo AI Founder DecisionRecord."],
        })
      if (!receipt || receipt.project_id !== input.projectId)
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: null,
          gate: null,
          governanceRef: null,
          reasons: ["Delegation requires an existing project Work Receipt."],
        })
      if (fenced(input.companyId, input.boardThreadId))
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: null,
          gate: null,
          governanceRef: null,
          reasons: ["Human intervention fence is active; no new authorization was requested."],
        })
      const verdict = yield* governance.submit({
        schemaVersion: 1,
        idempotencyKey: `fgov_${inputSha256}`,
        decisionId: input.decisionId,
        actionType: input.actionType,
        proposedAuthorityClass: decision.authorityClass ?? "red",
        evidenceSufficient: Boolean(decision.evidenceRefs?.length),
        requestedBy: input.requestedBy,
      })
      const governanceRef = verdict.gate?.id ?? verdict.authority.policyId
      const reasons = [
        ...(FounderGreenDelegationAction.safeParse(input.actionType).success ? [] : ["Action is not Green allowlisted."]),
        ...(verdict.authority.authorityClass === "green" ? [] : [`Authority classified action as ${verdict.authority.authorityClass}.`]),
        ...(verdict.gate ? [`ApprovalGate is ${verdict.gate.status}.`] : []),
        ...(verdict.dispatchAllowed ? [] : ["Governance denied dispatch."]),
        ...(currentMode.effective.founderTwinMode === "green-delegated"
          ? []
          : ["Effective Founder Twin mode is not green-delegated."]),
        ...currentReadiness.value.failClosedReasons,
      ]
      if (!governanceRef || reasons.length)
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: verdict.authority,
          gate: verdict.gate,
          governanceRef,
          reasons: governanceRef ? reasons : [...reasons, "Governance produced no auditable reference."],
        })
      if (verdict.decision.currentStatus === "proposed")
        yield* ledger.appendTransition(input.decisionId, {
          schemaVersion: 1,
          idempotencyKey: `fgdel_${inputSha256}_accepted`,
          toStatus: "accepted",
          kind: "accepted",
          reason: "Deterministic Green delegation authorization accepted.",
          actorId: "board-ceo",
        })
      if (!["proposed", "accepted"].includes(verdict.decision.currentStatus))
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: verdict.authority,
          gate: verdict.gate,
          governanceRef,
          reasons: [`Decision status ${verdict.decision.currentStatus} cannot enter Green dispatch.`],
        })
      save({
        id,
        request: input,
        inputSha256,
        status: "authorized",
        readiness: currentReadiness.value,
        readinessId: currentReadiness.id,
        mode: currentMode,
        authority: verdict.authority,
        gate: verdict.gate,
        governanceRef,
        reasons: [],
      })
      if (fenced(input.companyId, input.boardThreadId))
        return save({
          id,
          request: input,
          inputSha256,
          status: "blocked",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: verdict.authority,
          gate: verdict.gate,
          governanceRef,
          reasons: ["Human intervention fence became active before dispatch."],
        })
      const outcome = yield* Effect.exit(orchestrator.processReceipt(input.receiptId))
      if (Exit.isFailure(outcome))
        return save({
          id,
          request: input,
          inputSha256,
          status: "failed",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: verdict.authority,
          gate: verdict.gate,
          governanceRef,
          reasons: ["Project Orchestrator failed."],
          error: String(Cause.squash(outcome.cause)),
        })
      if (outcome.value.processing.status === "disabled")
        return save({
          id,
          request: input,
          inputSha256,
          status: "failed",
          readiness: currentReadiness.value,
          readinessId: currentReadiness.id,
          mode: currentMode,
          authority: verdict.authority,
          gate: verdict.gate,
          governanceRef,
          reasons: ["Graph Supervisor execution is disabled."],
        })
      const applied = outcome.value.processing.decision.status === "applied"
      yield* ledger.appendTransition(input.decisionId, {
        schemaVersion: 1,
        idempotencyKey: `fgdel_${inputSha256}_${applied ? "executed" : "failed"}`,
        toStatus: applied ? "executed" : "failed",
        kind: applied ? "executed" : "failed",
        reason: applied
          ? "Green delegation completed through Project Orchestrator and Graph Supervisor."
          : "Graph Supervisor rejected the delegated mutation.",
        actorId: "board-ceo",
      })
      return save({
        id,
        request: input,
        inputSha256,
        status: applied ? "outcome_pending" : "failed",
        readiness: currentReadiness.value,
        readinessId: currentReadiness.id,
        mode: currentMode,
        authority: verdict.authority,
        gate: verdict.gate,
        governanceRef,
        graphDecisionId: outcome.value.processing.decision.id,
        ...(outcome.value.processing.mutation_id
          ? { mutationId: outcome.value.processing.mutation_id }
          : {}),
        dispatch: outcome.value.dispatch
          ? {
              status: outcome.value.dispatch.status,
              workItemIds: outcome.value.dispatch.dispatched_work_item_ids,
            }
          : null,
        reasons: applied
          ? ["OutcomeSignal is missing; the complete Decision to Outcome chain remains fail-closed."]
          : ["Graph Supervisor rejected the delegated mutation."],
      })
    })

    const projection = Effect.fn("FounderGreenDelegation.projection")(function* (companyId: string) {
      reconcileOutcomes(companyId)
      const currentReadiness = readiness(companyId)
      return FounderGreenDelegationProjection.parse({
        schemaVersion: 1,
        companyId,
        readiness: currentReadiness.value,
        mode: mode(companyId),
        allowlist: FounderGreenDelegationAction.options,
        unknownActionsClassifiedAsRed: true,
        activeFenceCount: Database.use((db) =>
          db
            .select({ id: FounderInterventionFenceTable.id })
            .from(FounderInterventionFenceTable)
            .where(eq(FounderInterventionFenceTable.company_id, companyId))
            .all(),
        ).length,
        trends: {
          humanConfirmedShadowComparisons: Database.use((db) =>
            db
              .select({ id: FounderShadowComparisonTable.id })
              .from(FounderShadowComparisonTable)
              .where(and(
                eq(FounderShadowComparisonTable.company_id, companyId),
                eq(FounderShadowComparisonTable.verification_status, "human_confirmed"),
              ))
              .all(),
          ).length,
          humanOverrides: Database.use((db) =>
            db
              .select({ id: FounderCorrectionTable.id })
              .from(FounderCorrectionTable)
              .where(and(
                eq(FounderCorrectionTable.company_id, companyId),
                eq(FounderCorrectionTable.kind, "override"),
              ))
              .all(),
          ).length,
          selfEvaluations: 0,
        },
        runs: Database.use((db) =>
          db
            .select()
            .from(FounderGreenDelegationRunTable)
            .where(eq(FounderGreenDelegationRunTable.company_id, companyId))
            .orderBy(desc(FounderGreenDelegationRunTable.created_at), desc(FounderGreenDelegationRunTable.id))
            .limit(100)
            .all(),
        ).map(fromRow),
        autoPromotionAllowed: false,
      })
    })

    return Service.of({
      submit,
      projection,
      recordReadiness: (input) => Effect.try({ try: () => recordReadiness(input), catch: (error) => error }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(governanceLayer, decisionLedgerLayer, ProjectOrchestrator.defaultLayer)),
)

export * as FounderGreenDelegation from "./founder-delegation"
