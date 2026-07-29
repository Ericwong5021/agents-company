import { createHash } from "node:crypto"
import { lstat, mkdir, realpath, rename } from "node:fs/promises"
import path from "node:path"
import { AgentRunEventTable, AgentRunTable, AgentRunUsageTable } from "@/agent-run/agent-run.sql"
import {
  CompanyCapabilityNeedTable,
  CompanyAgentPerformanceTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "@/company-recruitment/company-recruitment.sql"
import {
  CompanyApprovalGateTable,
  CompanyArtifactTable,
  CompanyAttentionTable,
  CompanyGraphDecisionTable,
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectActionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyValidationRepairTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import { WorkflowRunTable } from "@/workflow/workflow.sql"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import {
  CompanyRolloutCandidateTable,
  CompanyRolloutLocalRepeatTable,
  CompanyRolloutRollbackTable,
  CompanyRolloutShadowEvaluationTable,
} from "@/company-rollout/company-rollout.sql"
import { GoalBriefTable } from "@/goal-brief/goal-brief.sql"
import { CompanyGateObservationTable } from "./gate-observation.sql"
import { and, asc, count, eq, inArray } from "@/storage"
import { Database } from "@/storage"
import {
  MetricContract,
  MetricSourceRef,
  PrePublicScenarioApplicability,
  PrePublicScenarioMetricIds,
  type MetricContract as MetricContractValue,
  type MetricSourceRef as MetricSourceRefValue,
} from "@agents-company/shared/seed-grow-metrics"
import z from "zod"
import {
  bindPersistedFactArtifact,
  PersistedFactArtifact,
  PersistedFactArtifactReference,
  persistedMetricContractDigest,
  PersistedFactRunBinding,
  type PersistedFactRunBinding as PersistedFactRunBindingValue,
  type PersistedMetricEvent,
} from "./persisted-fact-artifact"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Identifier = z.string().trim().min(1).max(500)
const Timestamp = z.string().datetime()
const JSONRecord = z.record(z.string(), z.unknown())
const SourceReference = z
  .object({
    kind: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .passthrough()
const Window = z
  .object({
    id: Identifier,
    startedAt: Timestamp,
    endedAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) > Date.parse(value.startedAt)) return
    context.addIssue({ code: "custom", message: "Fact window must end after it starts" })
  })

const ObservationReport = z
  .object({
    class: z.enum([
      "scenario_fixture",
      "command_probe",
      "git_blob",
      "fact_report",
      "terminal_invariant",
      "receipt_recovery",
      "graph_mutation_recovery",
      "delivery",
      "validation",
      "approval",
      "quiescence",
      "interruption",
      "review",
      "quality_pair",
      "benchmark",
      "shadow_pair",
      "repair_circuit",
      "model_usage",
    ]),
    path: z.string().refine((value) => path.isAbsolute(value)),
    sha256: Digest,
  })
  .strict()

const ObservationEvidence = z
  .object({
    report: ObservationReport,
  })
  .passthrough()

const ObservationReportClass = {
  "scenario.fixture_checked": "scenario_fixture",
  "command.probe_checked": "command_probe",
  "git.blob_checked": "git_blob",
  "report.file_checked": "fact_report",
  "terminal.invariant_checked": "terminal_invariant",
  "receipt.recovery_checked": "receipt_recovery",
  "graph_mutation.recovery_checked": "graph_mutation_recovery",
  "delivery.checked": "delivery",
  "validation_anchor.checked": "validation",
  "approval_gate.checked": "approval",
  "quiescence.checked": "quiescence",
  "interruption.checked": "interruption",
  "review_presence.checked": "review",
  "quality_pair.checked": "quality_pair",
  "benchmark.checked": "benchmark",
  "shadow_pair.checked": "shadow_pair",
  "repair.circuit_checked": "repair_circuit",
  "model.usage_checked": "model_usage",
} as const

const TerminalInvariantObservation = z
  .object({
    passed: z.boolean(),
    falseCompletion: z.boolean(),
    invariantReportSha256: Digest,
    pendingWorkItemCount: z.number().int().nonnegative(),
    pendingReceiptCount: z.number().int().nonnegative(),
    pendingMutationCount: z.number().int().nonnegative(),
    pendingGateCount: z.number().int().nonnegative(),
  })
  .strict()
const ReceiptRecoveryObservation = z
  .object({
    lostAt: z.number().int().nonnegative(),
    recoveredAt: z.number().int().nonnegative(),
    duplicate: z.boolean(),
    consistent: z.boolean(),
  })
  .strict()
const GraphMutationRecoveryObservation = z
  .object({
    lostAt: z.number().int().nonnegative(),
    recoveredAt: z.number().int().nonnegative(),
    consistent: z.boolean(),
    duplicateSideEffects: z.number().int().nonnegative(),
  })
  .strict()
const DeliveryObservation = z
  .object({
    deliveryId: Identifier,
    artifactId: Identifier,
    artifactSha256: Digest,
    validationGateId: Identifier,
    criterionId: Identifier,
    criterionStatus: z.enum(["pass", "fail", "not_evaluated"]),
    risk: z.enum(["low", "medium", "high"]),
    opened: z.boolean(),
  })
  .strict()
const ValidationObservation = z
  .object({
    gateId: Identifier,
    passed: z.boolean(),
    anchorPassed: z.boolean(),
  })
  .strict()
export const ApprovalGateObservation = z
  .object({
    gateId: Identifier,
    status: z.enum(["pending", "approved", "rejected"]),
    dispatchPaused: z.boolean(),
    anchorPassed: z.boolean(),
  })
  .strict()
export const QuiescenceObservation = z
  .object({
    status: z.literal("blocked"),
    ready: z.literal(false),
    criterionId: Identifier,
    criterionStatus: z.literal("fail"),
    risk: z.enum(["low", "medium", "high"]),
    blockerEntityIds: z.array(Identifier).min(1).max(10_000),
  })
  .strict()
const InterruptionObservation = z
  .object({
    attentionId: Identifier.nullable(),
    presented: z.boolean(),
    needed: z.boolean(),
  })
  .strict()
export const ReviewObservation = z
  .object({
    risk: z.enum(["low", "medium", "high"]),
    invoked: z.boolean(),
    independent: z.boolean(),
    rejected: z.boolean(),
    findingConfirmed: z.boolean(),
  })
  .strict()
const PairObservation = z
  .object({
    legacyRunId: Identifier,
    seedGrowRunId: Identifier,
  })
  .strict()
const BenchmarkObservation = z
  .object({
    terminalDecision: z.enum(["completed", "correctly_stopped", "correctly_blocked", "in_progress"]),
    oracleKind: Identifier,
  })
  .strict()
const LegacyFrozenOracle = z
  .object({
    kind: z.literal("legacy_frozen_oracle"),
    scenarioId: Identifier,
    contractSha256: Digest,
    oracleKey: Identifier,
    projectStatus: z.enum(["completed", "blocked", "rejected", "awaiting_approval"]),
    planIds: z.array(Identifier).min(1),
    workItemIds: z.array(Identifier).min(1),
    assignmentIds: z.array(Identifier).min(1),
    workflowRunIds: z.array(Identifier).min(1),
    artifactIds: z.array(Identifier),
    approvalGateIds: z.array(Identifier),
    settledFactSha256: Digest,
  })
  .strict()
const ScenarioOracleKinds = {
  S13: "s13_seed_pair",
  S14: "s14_direct_single",
  S15: "s15_approval_stop",
  S16: "s16_prerequisite_repair",
  S17: "s17_capability_growth",
  S18: "s18_risk_reviewer",
  S19: "b5_process_recovery",
  S20: "b5_process_recovery",
  S21: "s21_revision_conflict",
  S22: "s22_repair_circuit",
  S23: "s23_supersede_replace",
  S24: "s24_quiescence_blocked",
  S25: "s25_assignment_release",
  S26: "s26_company_pool_reuse",
  S27: "b5_process_recovery",
} as const
const ScenarioTerminalDecisions = {
  S13: "in_progress",
  S14: "in_progress",
  S15: "correctly_stopped",
  S16: "in_progress",
  S17: "in_progress",
  S18: "in_progress",
  S19: "in_progress",
  S20: "in_progress",
  S21: "in_progress",
  S22: "correctly_stopped",
  S23: "in_progress",
  S24: "correctly_blocked",
  S25: "in_progress",
  S26: "in_progress",
  S27: "in_progress",
} as const
export const RepairCircuitObservation = z
  .object({
    workItemId: Identifier,
    attentionId: Identifier,
    attemptCount: z.literal(3),
  })
  .strict()
const ModelUsageObservation = z
  .object({
    agentRunId: Identifier,
    purpose: z.enum(["wayfinder", "builder", "reviewer", "worker"]),
  })
  .strict()
const CommandProbeObservation = z
  .object({
    agentRunId: Identifier,
    commandId: Identifier,
    exitCode: z.literal(0),
    stdoutSha256: Digest,
    stderrSha256: Digest,
  })
  .strict()
const GitBlobObservation = z
  .object({
    path: z.string().trim().min(1),
    candidateBlobSha256: Digest,
    runtimeSha256: Digest,
  })
  .strict()
const ReportFileObservation = z
  .object({
    reportClass: Identifier,
    path: z.string().refine((value) => path.isAbsolute(value)),
    sha256: Digest,
  })
  .strict()
const ScenarioFixtureObservation = z
  .object({
    scenarioId: Identifier,
    snapshotSha256: Digest,
  })
  .strict()

export const PersistedFactExportRequest = z
  .object({
    id: Identifier,
    candidateSha: CandidateSha,
    metricContract: MetricContract,
    window: Window,
    runBindings: z.array(PersistedFactRunBinding).min(1).max(10_000),
    outputPath: z.string().refine((value) => path.isAbsolute(value)),
    evidenceProfile: z.enum(["generic", "b5_real_candidate"]).default("generic"),
    isolationRoot: z
      .string()
      .refine((value) => path.isAbsolute(value))
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const runIds = value.runBindings.map((binding) => binding.runId)
    const projectIds = value.runBindings.map((binding) => binding.projectId)
    if (new Set(runIds).size !== runIds.length)
      context.addIssue({ code: "custom", path: ["runBindings"], message: "Run bindings must be unique" })
    if (new Set(projectIds).size !== projectIds.length)
      context.addIssue({
        code: "custom",
        path: ["runBindings"],
        message: "Each exported run must use an isolated project",
      })
    if (value.evidenceProfile === "b5_real_candidate" && !value.isolationRoot)
      context.addIssue({
        code: "custom",
        path: ["isolationRoot"],
        message: "B5 fact export requires an isolation root",
      })
  })
export type PersistedFactExportRequest = z.input<typeof PersistedFactExportRequest>

export const PersistedFactExportResult = z
  .object({
    artifact: PersistedFactArtifact,
    reference: PersistedFactArtifactReference,
  })
  .strict()
export type PersistedFactExportResult = z.infer<typeof PersistedFactExportResult>

type TxOrDb = Database.TxOrDb
type ProjectEventRow = typeof CompanyProjectEventTable.$inferSelect
type EventInput = {
  binding: PersistedFactRunBindingValue
  candidateSha: string
  eventType: string
  occurredAt: number
  subjectId: string
  sourceKind: MetricSourceRefValue["kind"]
  sourceEntity: string
  sourceId: string
  sourceFacet?: string
  raw: unknown
  properties: Record<string, unknown>
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function canonical(value: unknown) {
  return JSON.stringify(normalized(value))
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

const RepositoryRoot = path.resolve(import.meta.dir, "../../../..")
const ProducerPath = "packages/control-plane/script/produce-seed-grow-candidate-facts.ts"
const ScenarioContractPath = "docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json"
const MetricContractPath = "docs/product-design/experience-refactor/metric-contract.v1.json"
const B5ScenarioIds = Array.from({ length: 15 }, (_, index) => `S${index + 13}`)
const RuntimeDependencyPaths = [
  ProducerPath,
  "packages/control-plane/src/metrics/b5-candidate-scenarios.ts",
  "packages/control-plane/src/metrics/gate-observation.ts",
  "packages/control-plane/src/metrics/gate-observation.sql.ts",
  "packages/control-plane/src/metrics/persisted-fact-artifact.ts",
  "packages/control-plane/src/metrics/persisted-fact-exporter.ts",
  "packages/control-plane/src/metrics/seed-grow-reporter.ts",
  "packages/shared/src/seed-grow-metrics.ts",
] as const

function metricApplies(metricId: keyof typeof PrePublicScenarioApplicability, scenarioId: string) {
  return (PrePublicScenarioApplicability[metricId] as readonly string[]).includes(scenarioId)
}

async function candidateBlob(candidateSha: string, filePath: string) {
  const process = Bun.spawn(["git", "show", `${candidateSha}:${filePath}`], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Candidate Git blob is unavailable for ${filePath}: ${stderr.trim()}`)
  return new Uint8Array(stdout)
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function validateObservationFile(rawPath: string, expectedSha256: string, isolationRoot: string) {
  const root = await realpath(isolationRoot)
  const target = await realpath(rawPath)
  const info = await lstat(rawPath)
  if (!contains(root, target) || !info.isFile() || info.isSymbolicLink())
    throw new Error(`Gate observation report escapes the B5 isolation root: ${rawPath}`)
  const bytes = new Uint8Array(await Bun.file(target).arrayBuffer())
  if (sha256(bytes) !== expectedSha256) throw new Error(`Gate observation report digest mismatch: ${rawPath}`)
  return target
}

const ScenarioContract = z
  .object({
    extends: z
      .object({
        path: z.string().trim().min(1),
        sha256: Digest,
      })
      .passthrough(),
    legacyBaselineOracle: z
      .object({
        kind: z.literal("persisted_legacy_outcome"),
        settleTimeoutMs: z.number().int().positive(),
        pollIntervalMs: z.number().int().positive(),
        terminalProjectStatuses: z
          .array(z.enum(["completed", "blocked", "rejected", "awaiting_approval"]))
          .min(1),
        requiredFacts: z.tuple([
          z.literal("plan"),
          z.literal("planner_work_item"),
          z.literal("project_assignment"),
          z.literal("workflow_run"),
        ]),
      })
      .strict(),
    scenarios: z
      .array(
        z
          .object({
            id: Identifier,
            observedMetrics: z.array(Identifier),
          })
          .passthrough(),
      )
      .length(15),
  })
  .passthrough()

async function b5Evidence(raw: z.output<typeof PersistedFactExportRequest>) {
  if (raw.evidenceProfile !== "b5_real_candidate") return undefined
  const scenarioBytes = await candidateBlob(raw.candidateSha, ScenarioContractPath)
  const scenarioContract = ScenarioContract.parse(JSON.parse(new TextDecoder().decode(scenarioBytes)) as unknown)
  const metricBytes = await candidateBlob(raw.candidateSha, MetricContractPath)
  const candidateMetricContract = MetricContract.parse(JSON.parse(new TextDecoder().decode(metricBytes)) as unknown)
  const producerSha256 = sha256(await candidateBlob(raw.candidateSha, ProducerPath))
  for (const dependencyPath of RuntimeDependencyPaths) {
    const candidateSha256 = sha256(await candidateBlob(raw.candidateSha, dependencyPath))
    const runtimeSha256 = sha256(
      new Uint8Array(await Bun.file(path.join(RepositoryRoot, dependencyPath)).arrayBuffer()),
    )
    if (candidateSha256 !== runtimeSha256)
      throw new Error(`B5 runtime dependency differs from candidate Git blob: ${dependencyPath}`)
  }
  if (persistedMetricContractDigest(candidateMetricContract) !== persistedMetricContractDigest(raw.metricContract))
    throw new Error("B5 metric contract does not match the candidate Git blob")
  if (
    !B5ScenarioIds.every((scenarioId) => scenarioContract.scenarios.some((scenario) => scenario.id === scenarioId)) ||
    scenarioContract.scenarios.some((scenario) => !B5ScenarioIds.includes(scenario.id))
  )
    throw new Error("B5 scenario contract must contain the fixed ordered S13-S27 set")
  const baseScenarioBytes = await candidateBlob(raw.candidateSha, scenarioContract.extends.path)
  if (sha256(baseScenarioBytes) !== scenarioContract.extends.sha256)
    throw new Error("B5 scenario contract base digest does not match the candidate Git blob")
  scenarioContract.scenarios.forEach((scenario) => {
    scenario.observedMetrics
      .filter((metricId) =>
        PrePublicScenarioMetricIds.includes(metricId as (typeof PrePublicScenarioMetricIds)[number]),
      )
      .forEach((metricId) => {
        if (!metricApplies(metricId as keyof typeof PrePublicScenarioApplicability, scenario.id))
          throw new Error(`B5 scenario ${scenario.id} has drifted applicability for ${metricId}`)
      })
  })
  const scenarioDigests = new Map(
    scenarioContract.scenarios.map((scenario) => [scenario.id, sha256(canonical(scenario))]),
  )
  const orderedBindings = B5ScenarioIds.flatMap((scenarioId) => [
    `${scenarioId}:legacy_full_plan`,
    `${scenarioId}:seed_and_grow`,
  ])
  if (
    raw.runBindings.length !== 30 ||
    raw.runBindings.some((binding, index) => `${binding.scenarioId}:${binding.strategy}` !== orderedBindings[index]) ||
    B5ScenarioIds.some((scenarioId) =>
      ["legacy_full_plan", "seed_and_grow"].some(
        (strategy) =>
          raw.runBindings.filter(
            (binding) =>
              binding.scenarioId === scenarioId &&
              binding.strategy === strategy &&
              binding.snapshotDigest === scenarioDigests.get(scenarioId),
          ).length !== 1,
      ),
    )
  )
    throw new Error("B5 fact export requires one isolated legacy and seed project for every S13-S27 scenario")
  const observations = Database.use((database) =>
    database
      .select()
      .from(CompanyGateObservationTable)
      .where(eq(CompanyGateObservationTable.candidate_sha, raw.candidateSha))
      .orderBy(asc(CompanyGateObservationTable.created_at), asc(CompanyGateObservationTable.id))
      .all(),
  )
  const root = raw.isolationRoot!
  for (const observation of observations) {
    const binding = raw.runBindings.find((item) => item.runId === observation.run_id)
    if (
      !binding ||
      binding.projectId !== observation.project_id ||
      binding.scenarioId !== observation.scenario_id ||
      binding.strategy !== observation.strategy ||
      binding.snapshotDigest !== observation.snapshot_sha256 ||
      observation.producer_path !== ProducerPath ||
      observation.producer_sha256 !== producerSha256
    )
      throw new Error(`B5 observation ${observation.id} has a mismatched candidate source binding`)
    const evidence = ObservationEvidence.parse(JSON.parse(observation.evidence_json) as unknown)
    const properties = parseRecord(observation.properties_json, `B5 observation ${observation.id} properties`)
    const sourceRefs = parseList(observation.source_refs_json, `B5 observation ${observation.id} sources`)
    if (
      sha256(
        canonical({
          projectId: observation.project_id,
          pairedProjectId: observation.paired_project_id ?? undefined,
          candidateSha: observation.candidate_sha,
          scenarioId: observation.scenario_id,
          runId: observation.run_id,
          subjectId: observation.subject_id,
          strategy: observation.strategy,
          snapshotSha256: observation.snapshot_sha256,
          eventType: observation.event_type,
          properties,
          sourceRefs,
          evidence: JSON.parse(observation.evidence_json) as unknown,
          producerPath: observation.producer_path,
          producerSha256: observation.producer_sha256,
        }),
      ) !== observation.input_sha256
    )
      throw new Error(`B5 observation ${observation.id} has a tampered input digest`)
    if (
      observation.created_at < Date.parse(raw.window.startedAt) ||
      observation.created_at > Date.parse(raw.window.endedAt)
    )
      throw new Error(`B5 observation ${observation.id} falls outside its candidate window`)
    const pairType = ["quality_pair.checked", "shadow_pair.checked"].includes(observation.event_type)
    const pairedBinding = observation.paired_project_id
      ? raw.runBindings.find((item) => item.projectId === observation.paired_project_id)
      : undefined
    if (
      (pairType &&
        (!pairedBinding ||
          pairedBinding.scenarioId !== binding.scenarioId ||
          pairedBinding.snapshotDigest !== binding.snapshotDigest ||
          pairedBinding.strategy === binding.strategy)) ||
      (!pairType && observation.paired_project_id)
    )
      throw new Error(`B5 observation ${observation.id} has an invalid paired project binding`)
    const expectedClass = ObservationReportClass[observation.event_type as keyof typeof ObservationReportClass]
    if (!expectedClass || evidence.report.class !== expectedClass)
      throw new Error(`B5 observation ${observation.id} has an invalid report class`)
    const reportPath = await validateObservationFile(evidence.report.path, evidence.report.sha256, root)
    if (
      !sourceRefs.some(
        (reference) =>
          SourceReference.safeParse(reference).success &&
          reference.kind === "external_report" &&
          path.resolve(reference.id as string) === reportPath,
      )
    )
      throw new Error(`B5 observation ${observation.id} has no exact external report source binding`)
    if (observation.event_type === "scenario.fixture_checked") {
      const properties = ScenarioFixtureObservation.parse(JSON.parse(observation.properties_json) as unknown)
      if (
        properties.scenarioId !== binding.scenarioId ||
        properties.snapshotSha256 !== scenarioDigests.get(binding.scenarioId)
      )
        throw new Error(`B5 observation ${observation.id} has a non-canonical scenario snapshot`)
    }
    if (observation.event_type === "delivery.checked") {
      const properties = DeliveryObservation.parse(JSON.parse(observation.properties_json) as unknown)
      const artifact = Database.use((database) =>
        database.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, properties.artifactId)).get(),
      )
      const gate = Database.use((database) =>
        database
          .select()
          .from(CompanyValidationGateTable)
          .where(eq(CompanyValidationGateTable.id, properties.validationGateId))
          .get(),
      )
      const criteria =
        gate && Array.isArray(JSON.parse(gate.criteria_json) as unknown)
          ? (JSON.parse(gate.criteria_json) as Array<Record<string, unknown>>)
          : []
      const gateEvidence =
        gate && Array.isArray(JSON.parse(gate.evidence_refs_json) as unknown)
          ? (JSON.parse(gate.evidence_refs_json) as Array<Record<string, unknown>>)
          : []
      if (!artifact || artifact.project_id !== binding.projectId)
        throw new Error(`B5 observation ${observation.id} has no persisted delivery artifact`)
      if (
        !gate ||
        gate.project_id !== binding.projectId ||
        gate.status !== "passed" ||
        !criteria.some((criterion) => criterion.id === properties.criterionId) ||
        !gateEvidence.some(
          (reference) =>
            reference.kind === "artifact" &&
            reference.id === properties.artifactId,
        ) ||
        properties.criterionStatus !== "pass" ||
        !properties.opened
      )
        throw new Error(`B5 observation ${observation.id} has no passed acceptance Gate for its delivery`)
      const bytes = artifact.path
        ? new Uint8Array(await Bun.file(artifact.path).arrayBuffer())
        : new TextEncoder().encode(artifact.content ?? "")
      if (!bytes.length || sha256(bytes) !== properties.artifactSha256)
        throw new Error(`B5 observation ${observation.id} has a mismatched delivery artifact digest`)
      if (artifact.path) {
        const project = Database.use((database) =>
          database
            .select({ output_dir: CompanyProjectTable.output_dir })
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.id, binding.projectId))
            .get(),
        )!
        const artifactPath = await realpath(artifact.path)
        const outputDirectory = await realpath(project.output_dir)
        const info = await lstat(artifact.path)
        if (!contains(outputDirectory, artifactPath) || !info.isFile() || info.isSymbolicLink())
          throw new Error(`B5 observation ${observation.id} has an unsafe delivery artifact path`)
      }
    }
    if (observation.event_type === "benchmark.checked") {
      const properties = BenchmarkObservation.parse(JSON.parse(observation.properties_json) as unknown)
      const report = JSON.parse(await Bun.file(reportPath).text()) as unknown
      const parsedReport = z
        .object({
          projectStatus: Identifier,
          terminalDecision: BenchmarkObservation.shape.terminalDecision,
          oracle: z.record(z.string(), z.unknown()),
        })
        .passthrough()
        .parse(report)
      if (
        parsedReport.terminalDecision !== properties.terminalDecision ||
        parsedReport.oracle.kind !== properties.oracleKind
      )
        throw new Error(`B5 observation ${observation.id} has a self-reported scenario verdict`)
      if (binding.strategy === "legacy_full_plan") {
        const oracle = LegacyFrozenOracle.parse(parsedReport.oracle)
        const facts = Database.use((database) => {
          const project = database
            .select()
            .from(CompanyProjectTable)
            .where(eq(CompanyProjectTable.id, binding.projectId))
            .get()
          const plans = database
            .select()
            .from(CompanyPlanTable)
            .where(eq(CompanyPlanTable.project_id, binding.projectId))
            .all()
          const workItems = database
            .select()
            .from(CompanyWorkItemTable)
            .where(eq(CompanyWorkItemTable.project_id, binding.projectId))
            .all()
          const assignments = database
            .select()
            .from(CompanyProjectAssignmentTable)
            .where(eq(CompanyProjectAssignmentTable.project_id, binding.projectId))
            .all()
          const artifacts = database
            .select()
            .from(CompanyArtifactTable)
            .where(eq(CompanyArtifactTable.project_id, binding.projectId))
            .all()
          const approvalGates = database
            .select()
            .from(CompanyApprovalGateTable)
            .where(eq(CompanyApprovalGateTable.project_id, binding.projectId))
            .all()
          const workflowRunIds = [
            ...new Set(workItems.flatMap((item) => (item.workflow_run_id ? [item.workflow_run_id] : []))),
          ].sort()
          const workflowRuns = workflowRunIds.length
            ? database
                .select()
                .from(WorkflowRunTable)
                .where(inArray(WorkflowRunTable.id, workflowRunIds))
                .all()
            : []
          return {
            project,
            plans,
            workItems,
            assignments,
            artifacts,
            approvalGates,
            workflowRunIds,
            workflowRuns,
          }
        })
        const projection = {
          project: {
            id: facts.project?.id,
            status: facts.project?.status,
            executionStrategy: facts.project?.execution_strategy,
          },
          plans: facts.plans
            .map((plan) => ({ id: plan.id, version: plan.version, phase: plan.phase, status: plan.status }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          workItems: facts.workItems
            .map((item) => ({
              id: item.id,
              kind: item.kind,
              status: item.status,
              workflowRunId: item.workflow_run_id ?? null,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          assignments: facts.assignments
            .map((assignment) => ({
              id: assignment.id,
              workItemId: assignment.work_item_id,
              agentId: assignment.agent_id,
              status: assignment.status,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          artifacts: facts.artifacts
            .map((artifact) => ({
              id: artifact.id,
              workItemId: artifact.work_item_id ?? null,
              kind: artifact.kind,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          approvalGates: facts.approvalGates
            .map((gate) => ({ id: gate.id, kind: gate.kind, status: gate.status }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
        const decision =
          facts.project?.status === "completed"
            ? "completed"
            : facts.project?.status === "blocked"
              ? "correctly_blocked"
              : "correctly_stopped"
        const exact = (left: string[], right: string[]) =>
          JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
        if (
          oracle.scenarioId !== binding.scenarioId ||
          oracle.contractSha256 !== sha256(canonical(scenarioContract.legacyBaselineOracle)) ||
          !facts.project ||
          facts.project.execution_strategy !== "legacy_full_plan" ||
          !scenarioContract.legacyBaselineOracle.terminalProjectStatuses.includes(
            facts.project.status as never,
          ) ||
          parsedReport.projectStatus !== facts.project.status ||
          oracle.projectStatus !== facts.project.status ||
          properties.terminalDecision !== decision ||
          !facts.workItems.some(
            (item) =>
              item.kind === "planner" &&
              ["completed", "blocked", "failed"].includes(item.status) &&
              Boolean(item.workflow_run_id),
          ) ||
          facts.workflowRuns.length !== facts.workflowRunIds.length ||
          facts.workflowRuns.some((run) => !["completed", "failed", "cancelled"].includes(run.status)) ||
          !exact(oracle.planIds, facts.plans.map((plan) => plan.id)) ||
          !exact(oracle.workItemIds, facts.workItems.map((item) => item.id)) ||
          !exact(oracle.assignmentIds, facts.assignments.map((assignment) => assignment.id)) ||
          !exact(oracle.workflowRunIds, facts.workflowRunIds) ||
          !exact(oracle.artifactIds, facts.artifacts.map((artifact) => artifact.id)) ||
          !exact(oracle.approvalGateIds, facts.approvalGates.map((gate) => gate.id)) ||
          oracle.settledFactSha256 !== sha256(canonical(projection)) ||
          ![
            { kind: "project", ids: [binding.projectId] },
            { kind: "work_item", ids: oracle.workItemIds },
            { kind: "project_assignment", ids: oracle.assignmentIds },
            { kind: "workflow_run", ids: oracle.workflowRunIds },
            { kind: "artifact", ids: oracle.artifactIds },
            { kind: "approval_gate", ids: oracle.approvalGateIds },
          ].every(({ kind, ids }) =>
            ids.every((id) =>
              sourceRefs.some(
                (reference) =>
                  SourceReference.safeParse(reference).success &&
                  reference.kind === kind &&
                  reference.id === id,
              ),
            ),
          )
        )
          throw new Error(`B5 observation ${observation.id} has no persisted frozen legacy oracle`)
      }
    }
    if (observation.event_type === "git.blob_checked") {
      const properties = GitBlobObservation.parse(JSON.parse(observation.properties_json) as unknown)
      const blobSha256 = sha256(await candidateBlob(raw.candidateSha, properties.path))
      await validateObservationFile(
        path.join(RepositoryRoot, properties.path),
        properties.runtimeSha256,
        RepositoryRoot,
      )
      if (
        properties.candidateBlobSha256 !== blobSha256 ||
        properties.runtimeSha256 !== blobSha256
      )
        throw new Error(`B5 observation ${observation.id} has a mismatched runtime Git blob`)
    }
    if (observation.event_type === "report.file_checked") {
      const properties = ReportFileObservation.parse(JSON.parse(observation.properties_json) as unknown)
      if (
        path.resolve(properties.path) !== reportPath ||
        properties.sha256 !== evidence.report.sha256 ||
        properties.reportClass !== evidence.report.class
      )
        throw new Error(`B5 observation ${observation.id} has a mismatched report file`)
    }
  }
  return { observations, producerSha256, scenarioDigests }
}

function parseRecord(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown
  const result = JSONRecord.safeParse(parsed)
  if (!result.success) throw new Error(`${label} must contain a JSON object`)
  return result.data
}

function parseList(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a JSON array`)
  return parsed
}

function metricEvent(input: EventInput): PersistedMetricEvent {
  if (!Number.isInteger(input.occurredAt) || input.occurredAt < 0)
    throw new Error(`${input.sourceEntity} ${input.sourceId} has an invalid timestamp`)
  const facet = input.sourceFacet ? `:${input.sourceFacet}` : ""
  return {
    eventId: `${input.sourceEntity}-${sha256(
      `${input.binding.runId}:${input.sourceId}:${input.eventType}${facet}`,
    ).slice(0, 40)}`,
    eventType: input.eventType,
    occurredAt: new Date(input.occurredAt).toISOString(),
    projectId: input.binding.projectId,
    scenarioId: input.binding.scenarioId,
    runId: input.binding.runId,
    strategy: input.binding.strategy,
    subjectId: input.subjectId,
    source: MetricSourceRef.parse({
      kind: input.sourceKind,
      id: `${input.sourceEntity}:${input.sourceId}:${input.binding.runId}${facet}`,
      candidateSha: input.candidateSha,
      runId: input.binding.runId,
      digest: sha256(canonical({ entity: input.sourceEntity, id: input.sourceId, facet, raw: input.raw })),
    }),
    properties: input.properties,
  }
}

function inWindow(timestamp: number, window: z.infer<typeof Window>) {
  return timestamp >= Date.parse(window.startedAt) && timestamp <= Date.parse(window.endedAt)
}

function timestampOf(row: ProjectEventRow, data: Record<string, unknown>) {
  const occurredAt = data.occurredAt
  if (typeof occurredAt === "string" && !Number.isNaN(Date.parse(occurredAt))) return Date.parse(occurredAt)
  return row.created_at
}

function explicitBindingValue(data: Record<string, unknown>, camel: string, snake: string) {
  if (Object.prototype.hasOwnProperty.call(data, camel)) return data[camel]
  if (Object.prototype.hasOwnProperty.call(data, snake)) return data[snake]
  return undefined
}

function assertEventBinding(
  row: ProjectEventRow,
  data: Record<string, unknown>,
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
  recognized: boolean,
) {
  if (!recognized && row.type !== "local_gate.run_bound") return
  const expected = [
    ["candidateSha", "candidate_sha", candidateSha],
    ["projectId", "project_id", binding.projectId],
    ["scenarioId", "scenario_id", binding.scenarioId],
    ["runId", "run_id", binding.runId],
    ["strategy", "strategy", binding.strategy],
    ["snapshotDigest", "snapshot_sha256", binding.snapshotDigest],
  ] as const
  expected.forEach(([camel, snake, value]) => {
    const observed = explicitBindingValue(data, camel, snake)
    if (recognized && observed === undefined)
      throw new Error(`Project event ${row.id} has no exact source binding for ${camel}`)
    if (observed !== undefined && observed !== value) throw new Error(`Project event ${row.id} has mismatched ${camel}`)
  })
}

function exactAnchor(
  events: { row: ProjectEventRow; data: Record<string, unknown> }[],
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
) {
  return events.some(({ row, data }) => {
    if (row.type !== "local_gate.run_bound" && row.type !== "benchmark.completed") return false
    return (
      explicitBindingValue(data, "candidateSha", "candidate_sha") === candidateSha &&
      explicitBindingValue(data, "runId", "run_id") === binding.runId &&
      explicitBindingValue(data, "scenarioId", "scenario_id") === binding.scenarioId &&
      explicitBindingValue(data, "strategy", "strategy") === binding.strategy &&
      explicitBindingValue(data, "snapshotDigest", "snapshot_sha256") === binding.snapshotDigest
    )
  })
}

function sourceReferenceExists(db: TxOrDb, projectId: string, reference: Record<string, unknown>) {
  if (typeof reference.kind !== "string" || typeof reference.id !== "string" || !reference.id)
    throw new Error(`Project ${projectId} contains an invalid source reference`)
  const sameProject = (row: { project_id: string | null } | undefined) => row?.project_id === projectId
  if (reference.kind === "project") return reference.id === projectId
  if (reference.kind === "project_event")
    return sameProject(
      db
        .select({ project_id: CompanyProjectEventTable.project_id })
        .from(CompanyProjectEventTable)
        .where(eq(CompanyProjectEventTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_item")
    return sameProject(
      db
        .select({ project_id: CompanyWorkItemTable.project_id })
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_attempt")
    return sameProject(
      db
        .select({ project_id: CompanyWorkAttemptTable.project_id })
        .from(CompanyWorkAttemptTable)
        .where(eq(CompanyWorkAttemptTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "work_receipt")
    return sameProject(
      db
        .select({ project_id: CompanyWorkReceiptTable.project_id })
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "graph_mutation")
    return sameProject(
      db
        .select({ project_id: CompanyGraphMutationTable.project_id })
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "project_assignment")
    return sameProject(
      db
        .select({ project_id: CompanyProjectAssignmentTable.project_id })
        .from(CompanyProjectAssignmentTable)
        .where(eq(CompanyProjectAssignmentTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "validation_gate")
    return sameProject(
      db
        .select({ project_id: CompanyValidationGateTable.project_id })
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "approval_gate")
    return sameProject(
      db
        .select({ project_id: CompanyApprovalGateTable.project_id })
        .from(CompanyApprovalGateTable)
        .where(eq(CompanyApprovalGateTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "attention")
    return sameProject(
      db
        .select({ project_id: CompanyAttentionTable.project_id })
        .from(CompanyAttentionTable)
        .where(eq(CompanyAttentionTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "agent_run")
    return sameProject(
      db
        .select({ project_id: AgentRunTable.company_project_id })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "workflow_run") {
    const run = db
      .select({ id: WorkflowRunTable.id })
      .from(WorkflowRunTable)
      .where(eq(WorkflowRunTable.id, reference.id))
      .get()
    return Boolean(
      run &&
        db
          .select({ id: CompanyWorkItemTable.id })
          .from(CompanyWorkItemTable)
          .where(
            and(
              eq(CompanyWorkItemTable.project_id, projectId),
              eq(CompanyWorkItemTable.workflow_run_id, reference.id),
            ),
          )
          .get(),
    )
  }
  if (reference.kind === "project_action")
    return sameProject(
      db
        .select({ project_id: CompanyProjectActionTable.project_id })
        .from(CompanyProjectActionTable)
        .where(eq(CompanyProjectActionTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "goal_brief")
    return sameProject(
      db
        .select({ project_id: GoalBriefTable.project_id })
        .from(GoalBriefTable)
        .where(eq(GoalBriefTable.id, reference.id))
        .get(),
    )
  if (reference.kind === "artifact")
    return sameProject(
      db
        .select({ project_id: CompanyArtifactTable.project_id })
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.id, reference.id))
        .get(),
    )
  return false
}

function validateSourceReferences(db: TxOrDb, projectId: string, source: string, references: unknown[]) {
  references.forEach((reference) => {
    const parsed = SourceReference.safeParse(reference)
    if (!parsed.success || !sourceReferenceExists(db, projectId, parsed.data))
      throw new Error(`${source} references an unavailable source fact`)
  })
}

const ObservationRequiredSourceKinds = {
  "scenario.fixture_checked": [],
  "command.probe_checked": ["agent_run"],
  "git.blob_checked": [],
  "report.file_checked": [],
  "terminal.invariant_checked": ["project"],
  "receipt.recovery_checked": ["work_receipt"],
  "graph_mutation.recovery_checked": ["graph_mutation"],
  "delivery.checked": ["artifact", "validation_gate"],
  "validation_anchor.checked": ["validation_gate"],
  "approval_gate.checked": ["approval_gate"],
  "quiescence.checked": ["project"],
  "interruption.checked": ["project"],
  "review_presence.checked": ["project"],
  "quality_pair.checked": ["project"],
  "benchmark.checked": ["project"],
  "shadow_pair.checked": ["project"],
  "repair.circuit_checked": ["attention", "validation_gate"],
  "model.usage_checked": ["agent_run"],
} as const

function validateObservationSources(
  db: TxOrDb,
  binding: PersistedFactRunBindingValue,
  observation: typeof CompanyGateObservationTable.$inferSelect,
  rollout: ReturnType<typeof CompanyRollout.evidence>,
  candidateSha: string,
) {
  const references = parseList(observation.source_refs_json, `B5 observation ${observation.id} sources`).map(
    (reference) => SourceReference.parse(reference),
  )
  references.forEach((reference) => {
    if (reference.kind === "external_report") return
    if (reference.kind === "rollout_repeat") {
      if (
        !rollout.localRepeats.some(
          (item) =>
            item.id === reference.id &&
            item.runId === binding.runId &&
            rollout.candidates.some(
              (candidate) => candidate.id === item.candidateId && candidate.candidateSha === candidateSha,
            ),
        )
      )
        throw new Error(`B5 observation ${observation.id} has an unavailable rollout repeat`)
      return
    }
    if (reference.kind === "rollout_rollback") {
      if (
        !rollout.rollbacks.some(
          (item) =>
            item.id === reference.id &&
            item.projectId === binding.projectId &&
            (!item.candidateId ||
              rollout.candidates.some(
                (candidate) => candidate.id === item.candidateId && candidate.candidateSha === candidateSha,
              )),
        )
      )
        throw new Error(`B5 observation ${observation.id} has an unavailable rollback report`)
      return
    }
    if (!sourceReferenceExists(db, binding.projectId, reference))
      throw new Error(`B5 observation ${observation.id} references an unavailable ${reference.kind} fact`)
  })
  ObservationRequiredSourceKinds[observation.event_type as keyof typeof ObservationRequiredSourceKinds].forEach(
    (kind) => {
      if (!references.some((reference) => reference.kind === kind))
        throw new Error(`B5 observation ${observation.id} is missing its required ${kind} source`)
    },
  )
  return references
}

export function requireExactB5CheckedObservations(eventTypes: string[], required: string[], runId: string) {
  const unexpected = eventTypes.find((eventType) => !required.includes(eventType))
  if (unexpected) throw new Error(`B5 run ${runId} contains non-required ${unexpected} evidence`)
  required.forEach((eventType) => {
    const count = eventTypes.filter((candidate) => candidate === eventType).length
    if (count !== 1)
      throw new Error(`B5 run ${runId} requires exactly one ${eventType} observation, received ${count}`)
  })
}

export function validateB5RepairCircuitEvidence(raw: {
  attemptCount: number
  repairCount: number
  repairRound: number
  maxRepairRounds: number
  attentionId: string
  circuitAttentionIds: string[]
}) {
  const value = z
    .object({
      attemptCount: z.literal(3),
      repairCount: z.literal(3),
      repairRound: z.literal(3),
      maxRepairRounds: z.literal(3),
      attentionId: Identifier,
      circuitAttentionIds: z.array(Identifier).length(1),
    })
    .strict()
    .parse(raw)
  if (value.circuitAttentionIds[0] !== value.attentionId)
    throw new Error("B5 repair circuit requires exactly one bound Attention")
  return value
}

export function validateB5ReviewPresenceEvidence(raw: {
  claimed: z.infer<typeof ReviewObservation>
  chains: { workItemId: string; assignmentId: string; runId: string; independent: boolean }[]
  unboundReviewerRunIds: string[]
  rejected: boolean
  references: { kind: string; id: string }[]
}) {
  if (raw.unboundReviewerRunIds.length)
    throw new Error(`B5 review observation has no persisted Reviewer WorkItem, Assignment, and AgentRun chain`)
  const invoked = raw.chains.length > 0
  const independent = invoked && raw.chains.every((chain) => chain.independent)
  if (
    raw.claimed.invoked !== invoked ||
    raw.claimed.independent !== independent ||
    raw.claimed.rejected !== raw.rejected
  )
    throw new Error(`B5 review observation does not match persisted Reviewer facts`)
  if (
    invoked &&
    raw.chains.some(
      (chain) =>
        !raw.references.some((reference) => reference.kind === "work_item" && reference.id === chain.workItemId) ||
        !raw.references.some(
          (reference) => reference.kind === "project_assignment" && reference.id === chain.assignmentId,
        ) ||
        !raw.references.some((reference) => reference.kind === "agent_run" && reference.id === chain.runId),
    )
  )
    throw new Error(`B5 review observation is missing its exact Reviewer source chain`)
  if (!invoked && raw.references.some((reference) => reference.kind === "agent_run"))
    throw new Error(`B5 review absence observation cannot cite an unrelated AgentRun`)
  return { ...raw.claimed, invoked, independent, rejected: raw.rejected }
}

function quiescenceBlockers(db: TxOrDb, projectId: string) {
  return [
    ...db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.project_id, projectId))
      .all()
      .filter((item) => !["completed", "superseded", "cancelled"].includes(item.status))
      .map((item) => ({ kind: "work_item", id: item.id })),
    ...db
      .select()
      .from(CompanyWorkAttemptTable)
      .where(eq(CompanyWorkAttemptTable.project_id, projectId))
      .all()
      .filter((item) => item.status === "running")
      .map((item) => ({ kind: "work_attempt", id: item.id })),
    ...db
      .select()
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.project_id, projectId))
      .all()
      .filter((item) => item.processing_status !== "processed")
      .map((item) => ({ kind: "work_receipt", id: item.id })),
    ...db
      .select()
      .from(CompanyGraphMutationTable)
      .where(eq(CompanyGraphMutationTable.project_id, projectId))
      .all()
      .filter((item) => ["proposed", "validated"].includes(item.status))
      .map((item) => ({ kind: "graph_mutation", id: item.id })),
    ...db
      .select()
      .from(CompanyValidationGateTable)
      .where(eq(CompanyValidationGateTable.project_id, projectId))
      .all()
      .filter((item) => ["pending", "running", "failed"].includes(item.status))
      .map((item) => ({ kind: "validation_gate", id: item.id })),
    ...db
      .select()
      .from(CompanyApprovalGateTable)
      .where(eq(CompanyApprovalGateTable.project_id, projectId))
      .all()
      .filter((item) => item.status === "pending")
      .map((item) => ({ kind: "approval_gate", id: item.id })),
    ...db
      .select()
      .from(CompanyAttentionTable)
      .where(eq(CompanyAttentionTable.project_id, projectId))
      .all()
      .filter((item) => item.status === "open" && item.material)
      .map((item) => ({ kind: "attention", id: item.id })),
    ...db
      .select()
      .from(CompanyProjectActionTable)
      .where(eq(CompanyProjectActionTable.project_id, projectId))
      .all()
      .filter((item) => item.status === "claimed")
      .map((item) => ({ kind: "project_action", id: item.id })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

function reconcileReviewPresence(
  db: TxOrDb,
  binding: PersistedFactRunBindingValue,
  value: z.infer<typeof ReviewObservation>,
  references: z.infer<typeof SourceReference>[],
) {
  const items = db
    .select()
    .from(CompanyWorkItemTable)
    .where(eq(CompanyWorkItemTable.project_id, binding.projectId))
    .all()
  const reviewers = items.filter((item) => item.kind === "reviewer")
  const reviewerIds = new Set(reviewers.map((item) => item.id))
  const assignments = db
    .select()
    .from(CompanyProjectAssignmentTable)
    .where(eq(CompanyProjectAssignmentTable.project_id, binding.projectId))
    .all()
  const runs = db
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.company_project_id, binding.projectId))
    .all()
  const reviewerRuns = runs.filter((run) => run.work_item_id && reviewerIds.has(run.work_item_id))
  const chains = reviewerRuns.flatMap((run) => {
    const reviewer = reviewers.find((item) => item.id === run.work_item_id)!
    const assignment = assignments.find(
      (candidate) => candidate.work_item_id === reviewer.id && candidate.agent_id === run.agent_id,
    )
    const parentAssignments = assignments.filter((candidate) => candidate.work_item_id === reviewer.parent_id)
    if (!assignment || !reviewer.parent_id || !parentAssignments.length) return []
    return [{
      workItemId: reviewer.id,
      assignmentId: assignment.id,
      runId: run.id,
      independent: parentAssignments.every((candidate) => candidate.agent_id !== run.agent_id),
    }]
  })
  const rejected = reviewers.some((reviewer) => {
    const parent = items.find((item) => item.id === reviewer.parent_id)
    return parent?.review_status === "rejected"
  })
  return validateB5ReviewPresenceEvidence({
    claimed: value,
    chains,
    unboundReviewerRunIds: reviewerRuns
      .filter((run) => !chains.some((chain) => chain.runId === run.id))
      .map((run) => run.id),
    rejected,
    references,
  })
}

function gateObservationFacts(
  db: TxOrDb,
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
  window: z.infer<typeof Window>,
  rollout: ReturnType<typeof CompanyRollout.evidence>,
  gateEvidence: NonNullable<Awaited<ReturnType<typeof b5Evidence>>>,
) {
  const rows = gateEvidence.observations.filter((item) => item.run_id === binding.runId)
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, binding.projectId)).get()!
  const byType = (eventType: string) => rows.filter((item) => item.event_type === eventType)
  const required = [
    "scenario.fixture_checked",
    "command.probe_checked",
    "git.blob_checked",
    "report.file_checked",
    "terminal.invariant_checked",
    "benchmark.checked",
    "model.usage_checked",
    ...(binding.strategy === "seed_and_grow" ? ["shadow_pair.checked"] : []),
    ...(metricApplies("delivery_consumability_rate", binding.scenarioId) ? ["delivery.checked"] : []),
    ...(metricApplies("receipt_recovery_success_rate", binding.scenarioId) && binding.strategy === "seed_and_grow"
      ? ["receipt.recovery_checked"]
      : []),
    ...(metricApplies("graph_mutation_recovery_success_rate", binding.scenarioId) &&
    binding.strategy === "seed_and_grow"
      ? ["graph_mutation.recovery_checked"]
      : []),
    ...(metricApplies("validation_gate_false_pass_rate", binding.scenarioId) && binding.strategy === "seed_and_grow"
      ? [binding.scenarioId === "S15" ? "approval_gate.checked" : "validation_anchor.checked"]
      : []),
    ...(binding.scenarioId === "S24" && binding.strategy === "seed_and_grow" ? ["quiescence.checked"] : []),
    ...(metricApplies("invalid_interruption_rate", binding.scenarioId) && binding.strategy === "seed_and_grow"
      ? ["interruption.checked"]
      : []),
    ...(metricApplies("reviewer_invocation_ratio_vs_legacy", binding.scenarioId) ? ["review_presence.checked"] : []),
    ...(metricApplies("low_risk_quality_ratio_vs_legacy", binding.scenarioId) && binding.strategy === "seed_and_grow"
      ? ["quality_pair.checked"]
      : []),
    ...(binding.scenarioId === "S22" && binding.strategy === "seed_and_grow" ? ["repair.circuit_checked"] : []),
  ]
  requireExactB5CheckedObservations(
    rows.map((row) => row.event_type),
    required,
    binding.runId,
  )
  const output: PersistedMetricEvent[] = []
  const emit = (
    row: typeof CompanyGateObservationTable.$inferSelect,
    eventType: string,
    properties: Record<string, unknown>,
    facet = eventType,
  ) => {
    if (!inWindow(row.created_at, window)) return
    output.push(
      metricEvent({
        binding,
        candidateSha,
        eventType,
        occurredAt: row.created_at,
        subjectId: row.subject_id,
        sourceKind: "gate_report",
        sourceEntity: "company_gate_observation",
        sourceId: row.id,
        sourceFacet: facet,
        raw: row,
        properties,
      }),
    )
  }
  rows.forEach((row) => {
    const properties = JSON.parse(row.properties_json) as unknown
    const evidence = ObservationEvidence.parse(JSON.parse(row.evidence_json) as unknown)
    const references = validateObservationSources(db, binding, row, rollout, candidateSha)
    if (row.event_type === "scenario.fixture_checked") {
      ScenarioFixtureObservation.parse(properties)
      emit(row, "fact.gate_observation", {
        observationType: row.event_type,
        reportSha256: evidence.report.sha256,
      })
      return
    }
    if (row.event_type === "command.probe_checked") {
      const value = CommandProbeObservation.parse(properties)
      const run = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, value.agentRunId)).get()
      if (
        !run ||
        run.company_project_id !== binding.projectId ||
        run.exit_code !== value.exitCode ||
        run.time_finished === null
      )
        throw new Error(`B5 command observation ${row.id} has no successful persisted AgentRun`)
      emit(row, "fact.gate_observation", {
        observationType: row.event_type,
        agentRunId: run.id,
        commandId: value.commandId,
        stdoutSha256: value.stdoutSha256,
        stderrSha256: value.stderrSha256,
      })
      return
    }
    if (["git.blob_checked", "report.file_checked"].includes(row.event_type)) {
      if (row.event_type === "git.blob_checked") GitBlobObservation.parse(properties)
      if (row.event_type === "report.file_checked") ReportFileObservation.parse(properties)
      emit(row, "fact.gate_observation", {
        observationType: row.event_type,
        reportSha256: evidence.report.sha256,
      })
      return
    }
    if (row.event_type === "terminal.invariant_checked") {
      const value = TerminalInvariantObservation.parse(properties)
      const pendingWorkItemCount = db
        .select()
        .from(CompanyWorkItemTable)
        .where(eq(CompanyWorkItemTable.project_id, binding.projectId))
        .all()
        .filter((item) => !["completed", "superseded", "cancelled"].includes(item.status)).length
      const pendingReceiptCount = db
        .select()
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.project_id, binding.projectId))
        .all()
        .filter((item) => item.processing_status !== "processed").length
      const pendingMutationCount = db
        .select()
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.project_id, binding.projectId))
        .all()
        .filter((item) => !["applied", "rejected", "superseded"].includes(item.status)).length
      const pendingGateCount = db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.project_id, binding.projectId))
        .all()
        .filter((item) => ["pending", "running"].includes(item.status)).length +
        db
          .select()
          .from(CompanyApprovalGateTable)
          .where(eq(CompanyApprovalGateTable.project_id, binding.projectId))
          .all()
          .filter((item) => item.status === "pending").length
      const falseCompletion =
        project.status === "completed" &&
        pendingWorkItemCount + pendingReceiptCount + pendingMutationCount + pendingGateCount > 0
      if (
        value.passed === value.falseCompletion ||
        value.invariantReportSha256 !== evidence.report.sha256 ||
        value.falseCompletion !== falseCompletion ||
        value.pendingWorkItemCount !== pendingWorkItemCount ||
        value.pendingReceiptCount !== pendingReceiptCount ||
        value.pendingMutationCount !== pendingMutationCount ||
        value.pendingGateCount !== pendingGateCount
      )
        throw new Error(`B5 terminal observation ${row.id} has inconsistent invariant evidence`)
      emit(row, "terminal.invariant_checked", {
        projectId: binding.projectId,
        passed: value.passed,
        falseCompletion: value.falseCompletion,
        invariantReportSha256: value.invariantReportSha256,
      })
      return
    }
    if (row.event_type === "receipt.recovery_checked") {
      const value = ReceiptRecoveryObservation.parse(properties)
      const receiptRef = references.find((reference) => reference.kind === "work_receipt")!
      const receipt = db
        .select()
        .from(CompanyWorkReceiptTable)
        .where(eq(CompanyWorkReceiptTable.id, receiptRef.id))
        .get()
      if (
        !receipt ||
        receipt.processing_status !== "processed" ||
        receipt.processed_at === null ||
        value.recoveredAt <= value.lostAt ||
        value.duplicate ||
        !value.consistent
      )
        throw new Error(`B5 receipt recovery observation ${row.id} does not match terminal receipt facts`)
      emit(row, "connection.lost", { reasonKind: "process_restart", boundaryKind: "receipt" }, "lost")
      emit(
        row,
        "connection.recovered",
        { contextPreserved: value.consistent, duplicateSideEffects: value.duplicate ? 1 : 0 },
        "recovered",
      )
      return
    }
    if (row.event_type === "graph_mutation.recovery_checked") {
      const value = GraphMutationRecoveryObservation.parse(properties)
      const mutationRef = references.find((reference) => reference.kind === "graph_mutation")!
      const mutation = db
        .select()
        .from(CompanyGraphMutationTable)
        .where(eq(CompanyGraphMutationTable.id, mutationRef.id))
        .get()
      if (
        !mutation ||
        mutation.status !== "applied" ||
        mutation.applied_revision === null ||
        value.recoveredAt <= value.lostAt ||
        !value.consistent ||
        value.duplicateSideEffects !== 0
      )
        throw new Error(`B5 mutation recovery observation ${row.id} does not match graph facts`)
      emit(row, "connection.lost", { reasonKind: "process_restart", boundaryKind: "graph_mutation" }, "lost")
      emit(
        row,
        "connection.recovered",
        { contextPreserved: value.consistent, duplicateSideEffects: value.duplicateSideEffects },
        "recovered",
      )
      emit(row, "graph_mutation.recovered", {
        mutationId: mutation.id,
        consistent: value.consistent,
        duplicateSideEffects: value.duplicateSideEffects,
      })
      return
    }
    if (row.event_type === "delivery.checked") {
      const value = DeliveryObservation.parse(properties)
      const artifactRef = references.find((reference) => reference.kind === "artifact")!
      const gateRef = references.find((reference) => reference.kind === "validation_gate")!
      const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, artifactRef.id)).get()
      const gate = db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.id, gateRef.id))
        .get()
      const criteria = gate ? (JSON.parse(gate.criteria_json) as Array<Record<string, unknown>>) : []
      const gateReferences = gate ? (JSON.parse(gate.evidence_refs_json) as Array<Record<string, unknown>>) : []
      if (
        !artifact ||
        artifact.id !== value.artifactId ||
        artifact.project_id !== binding.projectId ||
        !gate ||
        gate.id !== value.validationGateId ||
        gate.project_id !== binding.projectId ||
        gate.status !== "passed" ||
        !criteria.some((criterion) => criterion.id === value.criterionId) ||
        !gateReferences.some(
          (reference) =>
            reference.kind === "artifact" && reference.id === artifact.id,
        ) ||
        value.criterionStatus !== "pass" ||
        !value.opened
      )
        throw new Error(`B5 delivery observation ${row.id} has no consumable persisted artifact`)
      emit(row, "delivery.presented", {
        deliveryId: value.deliveryId,
        artifactCount: 1,
        noFileReason: "",
      })
      emit(row, "delivery.artifact_opened", {
        deliveryId: value.deliveryId,
        artifactId: value.artifactId,
        succeeded: value.opened,
      })
      emit(row, "delivery.criterion_evaluated", {
        deliveryId: value.deliveryId,
        criterionId: value.criterionId,
        status: value.criterionStatus,
        evidenceCount: references.length,
        risk: value.risk,
        strategy: binding.strategy,
      })
      return
    }
    if (row.event_type === "validation_anchor.checked") {
      const value = ValidationObservation.parse(properties)
      const gate = db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.id, value.gateId))
        .get()
      if (
        !gate ||
        gate.project_id !== binding.projectId ||
        value.passed !== (gate.status === "passed") ||
        value.passed !== value.anchorPassed
      )
        throw new Error(`B5 validation observation ${row.id} does not match its Gate anchor`)
      emit(row, "validation_gate.evaluated", {
        gateId: gate.id,
        passed: value.passed,
        anchorPassed: value.anchorPassed,
        falsePass: value.passed && !value.anchorPassed,
      })
      return
    }
    if (row.event_type === "approval_gate.checked") {
      const value = ApprovalGateObservation.parse(properties)
      const gate = db
        .select()
        .from(CompanyApprovalGateTable)
        .where(eq(CompanyApprovalGateTable.id, value.gateId))
        .get()
      if (
        binding.scenarioId !== "S15" ||
        !gate ||
        gate.project_id !== binding.projectId ||
        gate.status !== value.status ||
        value.status !== "pending" ||
        !project.dispatch_paused ||
        value.dispatchPaused !== project.dispatch_paused ||
        value.anchorPassed
      )
        throw new Error(`B5 approval observation ${row.id} does not match its pending ApprovalGate anchor`)
      emit(row, "validation_gate.evaluated", {
        gateId: gate.id,
        gateType: "approval",
        passed: false,
        anchorPassed: false,
        falsePass: false,
      })
      return
    }
    if (row.event_type === "quiescence.checked") {
      const value = QuiescenceObservation.parse(properties)
      const blockers = quiescenceBlockers(db, binding.projectId)
      const blockerIds = blockers.map((blocker) => blocker.id).sort()
      if (
        binding.scenarioId !== "S24" ||
        project.status === "completed" ||
        !blockers.length ||
        canonical(blockerIds) !== canonical([...value.blockerEntityIds].sort()) ||
        blockers.some(
          (blocker) =>
            !references.some((reference) => reference.kind === blocker.kind && reference.id === blocker.id),
        )
      )
        throw new Error(`B5 quiescence observation ${row.id} does not match persisted completion blockers`)
      emit(row, "delivery.criterion_evaluated", {
        deliveryId: `quiescence:${binding.projectId}`,
        criterionId: value.criterionId,
        status: value.criterionStatus,
        evidenceCount: blockers.length + 1,
        evidenceNotApplicableReason: "completion_rejected_by_quiescence",
        risk: value.risk,
        strategy: binding.strategy,
      })
      return
    }
    if (row.event_type === "interruption.checked") {
      const value = InterruptionObservation.parse(properties)
      const attention = value.attentionId
        ? db.select().from(CompanyAttentionTable).where(eq(CompanyAttentionTable.id, value.attentionId)).get()
        : undefined
      if (
        (value.presented &&
          (!attention ||
            attention.project_id !== binding.projectId ||
            !attention.interrupts_user ||
            value.needed !== attention.material)) ||
        (!value.presented && (attention || value.needed))
      )
        throw new Error(`B5 interruption observation ${row.id} does not match Attention facts`)
      if (value.presented && !references.some((reference) => reference.kind === "attention"))
        throw new Error(`B5 interruption observation ${row.id} is missing its Attention source`)
      emit(row, "interruption.checked", {
        projectId: binding.projectId,
        presented: value.presented,
        needed: value.needed,
        attentionId: value.attentionId,
      })
      return
    }
    if (row.event_type === "review_presence.checked") {
      const value = ReviewObservation.parse(properties)
      emit(row, "review.completed", reconcileReviewPresence(db, binding, value, references))
      return
    }
    if (row.event_type === "benchmark.checked") {
      const value = BenchmarkObservation.parse(properties)
      const terminal = byType("terminal.invariant_checked")
        .map((item) => TerminalInvariantObservation.parse(JSON.parse(item.properties_json) as unknown))
        .find((item) => item.passed)
      const scenarioId = binding.scenarioId as keyof typeof ScenarioOracleKinds
      const legacyMatched =
        binding.strategy === "legacy_full_plan" &&
        value.oracleKind === "legacy_frozen_oracle" &&
        ["completed", "correctly_stopped", "correctly_blocked"].includes(value.terminalDecision)
      const matched =
        terminal &&
        (legacyMatched ||
          (binding.strategy === "seed_and_grow" &&
            value.oracleKind === ScenarioOracleKinds[scenarioId] &&
            value.terminalDecision === ScenarioTerminalDecisions[scenarioId]))
      const status = matched
        ? "pass"
        : binding.strategy === "legacy_full_plan"
          ? "blocked"
          : "fail"
      emit(
        row,
        "scenario.verdict_checked",
        {
          scenarioId: binding.scenarioId,
          status,
          terminalDecision: value.terminalDecision,
          oracleKind: value.oracleKind,
          terminalInvariantPassed: Boolean(terminal),
        },
        "verdict",
      )
      emit(row, "benchmark.completed", {
        scenarioId: binding.scenarioId,
        finalDecision: status === "pass" ? "pass" : "fail",
      })
      return
    }
    if (row.event_type === "shadow_pair.checked") {
      const value = PairObservation.parse(properties)
      const legacy = gateEvidence.observations.find(
        (item) =>
          item.run_id === value.legacyRunId &&
          item.scenario_id === binding.scenarioId &&
          item.strategy === "legacy_full_plan",
      )
      if (
        binding.strategy !== "seed_and_grow" ||
        value.seedGrowRunId !== binding.runId ||
        !legacy ||
        row.paired_project_id !== legacy.project_id ||
        legacy.snapshot_sha256 !== row.snapshot_sha256
      )
        throw new Error(`B5 shadow observation ${row.id} has an invalid matched snapshot pair`)
      emit(row, "shadow.compared", {
        comparisonId: row.subject_id,
        legacyRunId: value.legacyRunId,
        seedGrowRunId: value.seedGrowRunId,
      })
      return
    }
    if (row.event_type === "quality_pair.checked") {
      const value = PairObservation.parse(properties)
      const legacy = gateEvidence.observations.find(
        (item) =>
          item.run_id === value.legacyRunId &&
          item.event_type === "delivery.checked" &&
          item.scenario_id === binding.scenarioId &&
          item.strategy === "legacy_full_plan",
      )
      const seed = byType("delivery.checked")[0]
      if (
        binding.strategy !== "seed_and_grow" ||
        value.seedGrowRunId !== binding.runId ||
        !legacy ||
        !seed ||
        row.paired_project_id !== legacy.project_id ||
        legacy.snapshot_sha256 !== row.snapshot_sha256
      )
        throw new Error(`B5 quality observation ${row.id} has an invalid matched delivery pair`)
      const legacyDelivery = DeliveryObservation.parse(JSON.parse(legacy.properties_json) as unknown)
      const seedDelivery = DeliveryObservation.parse(JSON.parse(seed.properties_json) as unknown)
      emit(row, "quality_pair.checked", {
        legacyRunId: value.legacyRunId,
        seedGrowRunId: value.seedGrowRunId,
        risk: seedDelivery.risk,
        legacyScore: legacyDelivery.criterionStatus === "pass" ? 1 : 0,
        seedGrowScore: seedDelivery.criterionStatus === "pass" ? 1 : 0,
        snapshotSha256: binding.snapshotDigest,
      })
      return
    }
    if (row.event_type === "repair.circuit_checked") {
      const value = RepairCircuitObservation.parse(properties)
      const gate = db
        .select()
        .from(CompanyValidationGateTable)
        .where(eq(CompanyValidationGateTable.id, references.find((item) => item.kind === "validation_gate")!.id))
        .get()!
      const repairCount = db
        .select({ value: count() })
        .from(CompanyValidationRepairTable)
        .where(eq(CompanyValidationRepairTable.gate_id, gate.id))
        .get()!.value
      const attentionRef = references.find((item) => item.kind === "attention")!
      const attention = db
        .select()
        .from(CompanyAttentionTable)
        .where(eq(CompanyAttentionTable.id, attentionRef.id))
        .get()
      const circuitAttentions = db
        .select()
        .from(CompanyAttentionTable)
        .where(eq(CompanyAttentionTable.project_id, binding.projectId))
        .all()
        .filter((candidate) =>
          (JSON.parse(candidate.source_refs_json) as unknown[]).some(
            (reference) =>
              SourceReference.safeParse(reference).success &&
              (reference as { kind: string; id: string }).kind === "validation_gate" &&
              (reference as { kind: string; id: string }).id === gate.id,
          ),
        )
      if (!attention || attention.project_id !== binding.projectId)
        throw new Error(`B5 repair circuit observation ${row.id} has no three-round persisted repair history`)
      if (gate.work_item_id !== value.workItemId)
        throw new Error(`B5 repair circuit observation ${row.id} has a mismatched WorkItem`)
      validateB5RepairCircuitEvidence({
        attemptCount: value.attemptCount,
        repairCount,
        repairRound: gate.repair_round,
        maxRepairRounds: gate.max_repair_rounds,
        attentionId: value.attentionId,
        circuitAttentionIds: circuitAttentions.map((candidate) => candidate.id),
      })
      emit(row, "repair.circuit_opened", {
        workItemId: value.workItemId,
        attemptCount: value.attemptCount,
        attentionId: value.attentionId,
      })
      return
    }
    if (row.event_type === "model.usage_checked") {
      const value = ModelUsageObservation.parse(properties)
      const usage = db
        .select()
        .from(AgentRunUsageTable)
        .where(eq(AgentRunUsageTable.agent_run_id, value.agentRunId))
        .get()
      if (!usage) throw new Error(`B5 model usage observation ${row.id} has no persisted AgentRun usage`)
      const tokens = [
        usage.input_tokens,
        usage.output_tokens,
        usage.reasoning_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
      ].reduce<number>((total, item) => total + (item ?? 0), 0)
      emit(row, "model.usage_recorded", {
        runId: value.agentRunId,
        strategy: binding.strategy,
        purpose: value.purpose,
        modelCalls: 1,
        tokens,
        cost: 0,
      })
    }
  })
  return output
}

function projectFacts(
  db: TxOrDb,
  binding: PersistedFactRunBindingValue,
  candidateSha: string,
  contract: MetricContractValue,
  window: z.infer<typeof Window>,
  rollout: ReturnType<typeof CompanyRollout.evidence>,
  gateEvidence: Awaited<ReturnType<typeof b5Evidence>>,
) {
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, binding.projectId)).get()
  if (!project) throw new Error(`Run ${binding.runId} references an unavailable project`)
  if (project.execution_strategy !== binding.strategy)
    throw new Error(`Project ${binding.projectId} has mismatched execution strategy`)
  const events = db
    .select()
    .from(CompanyProjectEventTable)
    .where(eq(CompanyProjectEventTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectEventTable.created_at), asc(CompanyProjectEventTable.id))
    .all()
    .map((row) => ({ row, data: parseRecord(row.data_json, `Project event ${row.id}`) }))
  const attempts = db
    .select()
    .from(CompanyWorkAttemptTable)
    .where(eq(CompanyWorkAttemptTable.project_id, binding.projectId))
    .orderBy(asc(CompanyWorkAttemptTable.started_at), asc(CompanyWorkAttemptTable.id))
    .all()
  const receipts = db
    .select()
    .from(CompanyWorkReceiptTable)
    .where(eq(CompanyWorkReceiptTable.project_id, binding.projectId))
    .orderBy(asc(CompanyWorkReceiptTable.created_at), asc(CompanyWorkReceiptTable.id))
    .all()
  const mutations = db
    .select()
    .from(CompanyGraphMutationTable)
    .where(eq(CompanyGraphMutationTable.project_id, binding.projectId))
    .orderBy(asc(CompanyGraphMutationTable.created_at), asc(CompanyGraphMutationTable.id))
    .all()
  const decisions = db
    .select()
    .from(CompanyGraphDecisionTable)
    .where(eq(CompanyGraphDecisionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyGraphDecisionTable.created_at), asc(CompanyGraphDecisionTable.id))
    .all()
  const gates = db
    .select()
    .from(CompanyValidationGateTable)
    .where(eq(CompanyValidationGateTable.project_id, binding.projectId))
    .orderBy(asc(CompanyValidationGateTable.created_at), asc(CompanyValidationGateTable.id))
    .all()
  const repairs = gates.length
    ? db
        .select()
        .from(CompanyValidationRepairTable)
        .where(
          inArray(
            CompanyValidationRepairTable.gate_id,
            gates.map((gate) => gate.id),
          ),
        )
        .orderBy(asc(CompanyValidationRepairTable.created_at), asc(CompanyValidationRepairTable.id))
        .all()
    : []
  const assignments = db
    .select()
    .from(CompanyProjectAssignmentTable)
    .where(eq(CompanyProjectAssignmentTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectAssignmentTable.assigned_at), asc(CompanyProjectAssignmentTable.id))
    .all()
  const selections = db
    .select()
    .from(CompanyTeamSelectionTable)
    .where(eq(CompanyTeamSelectionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyTeamSelectionTable.time_created), asc(CompanyTeamSelectionTable.id))
    .all()
  const performances = db
    .select()
    .from(CompanyAgentPerformanceTable)
    .where(eq(CompanyAgentPerformanceTable.project_id, binding.projectId))
    .orderBy(asc(CompanyAgentPerformanceTable.time_created), asc(CompanyAgentPerformanceTable.id))
    .all()
  const attentions = db
    .select()
    .from(CompanyAttentionTable)
    .where(eq(CompanyAttentionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyAttentionTable.created_at), asc(CompanyAttentionTable.id))
    .all()
  const actions = db
    .select()
    .from(CompanyProjectActionTable)
    .where(eq(CompanyProjectActionTable.project_id, binding.projectId))
    .orderBy(asc(CompanyProjectActionTable.created_at), asc(CompanyProjectActionTable.id))
    .all()
  const agentRuns = db
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.company_project_id, binding.projectId))
    .orderBy(asc(AgentRunTable.time_created), asc(AgentRunTable.id))
    .all()
  const shadows = rollout.shadowEvaluations.filter((item) => item.projectId === binding.projectId)
  const repeat = rollout.localRepeats.find(
    (item) =>
      item.runId === binding.runId &&
      rollout.candidates.some(
        (candidate) => candidate.id === item.candidateId && candidate.candidateSha === candidateSha,
      ),
  )
  const recognizedTypes = new Map(contract.eventTypes.map((item) => [item.id, item.requiredProperties]))
  events
    .filter(({ row }) => row.type === "delivery.artifact_opened")
    .forEach(({ row, data }) => {
      const artifactId = explicitBindingValue(data, "artifactId", "artifact_id")
      const artifact =
        typeof artifactId === "string"
          ? db
              .select({ project_id: CompanyArtifactTable.project_id })
              .from(CompanyArtifactTable)
              .where(eq(CompanyArtifactTable.id, artifactId))
              .get()
          : undefined
      if (artifact?.project_id !== binding.projectId)
        throw new Error(`Project event ${row.id} references an unavailable artifact`)
    })
  events.forEach(({ row, data }) =>
    assertEventBinding(row, data, binding, candidateSha, !gateEvidence && recognizedTypes.has(row.type)),
  )
  const runAnchored =
    project.active_run_id === binding.runId ||
    attempts.some((item) => item.agent_run_id === binding.runId) ||
    agentRuns.some((item) => item.id === binding.runId) ||
    Boolean(repeat) ||
    events.some(
      ({ row, data }) =>
        (row.type === "local_gate.run_bound" || recognizedTypes.has(row.type)) &&
        explicitBindingValue(data, "runId", "run_id") === binding.runId,
    )
  const scenarioAnchored =
    Boolean(gateEvidence) ||
    exactAnchor(events, binding, candidateSha) ||
    shadows.some(
      (item) =>
        item.snapshotSha256 === binding.snapshotDigest &&
        (item.input.scenarioId === binding.scenarioId || item.output.scenarioId === binding.scenarioId),
    )
  const snapshotAnchored =
    Boolean(gateEvidence) ||
    exactAnchor(events, binding, candidateSha) ||
    shadows.some((item) => item.snapshotSha256 === binding.snapshotDigest)
  if (!runAnchored) throw new Error(`Run ${binding.runId} is not bound to project ${binding.projectId}`)
  if (!scenarioAnchored) throw new Error(`Run ${binding.runId} has no persisted scenario binding`)
  if (!snapshotAnchored) throw new Error(`Run ${binding.runId} has no persisted snapshot binding`)

  attempts.forEach((attempt) => {
    if (!attempt.agent_run_id) return
    const run = agentRuns.find((item) => item.id === attempt.agent_run_id)
    if (!run || run.work_item_id !== attempt.work_item_id)
      throw new Error(`Work Attempt ${attempt.id} references an unavailable AgentRun`)
  })
  receipts.forEach((receipt) => {
    const attempt = attempts.find((item) => item.id === receipt.attempt_id)
    if (!attempt || attempt.work_item_id !== receipt.work_item_id)
      throw new Error(`Work Receipt ${receipt.id} references an unavailable Work Attempt`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Work Receipt ${receipt.id}`,
      parseList(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
    )
  })
  mutations.forEach((mutation) => {
    if (!receipts.some((receipt) => receipt.id === mutation.trigger_receipt_id))
      throw new Error(`Graph Mutation ${mutation.id} references an unavailable Work Receipt`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Graph Mutation ${mutation.id}`,
      parseList(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`),
    )
  })
  decisions.forEach((decision) => {
    const receipt = receipts.find((item) => item.id === decision.receipt_id)
    if (!receipt) throw new Error(`Graph Decision ${decision.id} references an unavailable Work Receipt`)
    if (decision.mutation_id && !mutations.some((item) => item.id === decision.mutation_id))
      throw new Error(`Graph Decision ${decision.id} references an unavailable Graph Mutation`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Graph Decision ${decision.id}`,
      parseList(decision.evidence_refs_json, `Graph Decision ${decision.id} evidence`),
    )
  })
  gates.forEach((gate) => {
    if (
      gate.work_item_id &&
      !db
        .select({ id: CompanyWorkItemTable.id })
        .from(CompanyWorkItemTable)
        .where(
          and(eq(CompanyWorkItemTable.id, gate.work_item_id), eq(CompanyWorkItemTable.project_id, binding.projectId)),
        )
        .get()
    )
      throw new Error(`Validation Gate ${gate.id} references an unavailable Work Item`)
    const criteria = parseList(gate.criteria_json, `Validation Gate ${gate.id} criteria`)
    if (![sha256(canonical(criteria)), sha256(gate.criteria_json)].includes(gate.criteria_sha256))
      throw new Error(`Validation Gate ${gate.id} criteria digest is invalid`)
    validateSourceReferences(
      db,
      binding.projectId,
      `Validation Gate ${gate.id}`,
      parseList(gate.evidence_refs_json, `Validation Gate ${gate.id} evidence`),
    )
  })
  repairs.forEach((repair) => {
    if (!gates.some((gate) => gate.id === repair.gate_id))
      throw new Error(`Validation Repair ${repair.id} references an unavailable Validation Gate`)
    const diagnosis = parseRecord(repair.diagnosis_json, `Validation Repair ${repair.id} diagnosis`)
    const diff = parseList(repair.repair_diff_json, `Validation Repair ${repair.id} diff`)
    const evidence = parseList(repair.reverify_evidence_json, `Validation Repair ${repair.id} evidence`)
    if (!Object.keys(diagnosis).length)
      throw new Error(`Validation Repair ${repair.id} diagnosis does not identify a changed fact`)
    if (!diff.length) throw new Error(`Validation Repair ${repair.id} repair diff does not prove a changed fact`)
    if (!evidence.length)
      throw new Error(`Validation Repair ${repair.id} has no reverify evidence for the changed fact`)
  })
  attentions.forEach((attention) => {
    const sourceRefs = parseList(attention.source_refs_json, `Attention ${attention.id} sources`)
    validateSourceReferences(db, binding.projectId, `Attention ${attention.id}`, sourceRefs)
    const normalizedSourceRefs = [...sourceRefs].sort((left, right) => canonical(left).localeCompare(canonical(right)))
    if (
      sha256(
        canonical({
          project_id: attention.project_id,
          idempotency_key: attention.idempotency_key,
          issue: {
            issue_kind: attention.issue_kind,
            risk: attention.risk,
            materiality: attention.materiality,
          },
          title: attention.title,
          summary: attention.summary,
          ...(attention.required_decision ? { required_decision: attention.required_decision } : {}),
          source_refs: normalizedSourceRefs,
          decision: {
            issue_kind: attention.issue_kind,
            risk: attention.risk,
            materiality: attention.materiality,
            route: attention.route,
            material: attention.material,
            interrupts_user: attention.interrupts_user,
            allowed_actions: parseList(attention.allowed_actions_json, `Attention ${attention.id} allowed actions`),
          },
        }),
      ) !== attention.input_sha256
    )
      throw new Error(`Attention ${attention.id} input digest is invalid`)
  })
  actions.forEach((action) => {
    if (action.attention_id && !attentions.some((attention) => attention.id === action.attention_id))
      throw new Error(`Project Action ${action.id} references an unavailable Attention`)
    const payload = parseRecord(action.payload_json, `Project Action ${action.id} payload`)
    if (
      sha256(
        canonical({
          action: action.action,
          attention_id: action.attention_id ?? undefined,
          expected_revision: action.expected_revision ?? undefined,
          payload,
        }),
      ) !== action.payload_sha256
    )
      throw new Error(`Project Action ${action.id} payload digest is invalid`)
    if (action.result_json) parseRecord(action.result_json, `Project Action ${action.id} result`)
  })
  assignments.forEach((assignment) => {
    const selection = selections.find((item) => item.id === assignment.selection_id)
    const need = db
      .select()
      .from(CompanyCapabilityNeedTable)
      .where(eq(CompanyCapabilityNeedTable.id, assignment.capability_need_id))
      .get()
    const item = db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, assignment.work_item_id))
      .get()
    if (
      !selection ||
      selection.agent_id !== assignment.agent_id ||
      !need ||
      need.project_id !== binding.projectId ||
      !item ||
      item.project_id !== binding.projectId ||
      (assignment.source_receipt_id !== null &&
        !receipts.some((receipt) => receipt.id === assignment.source_receipt_id))
    )
      throw new Error(`Project Assignment ${assignment.id} has inconsistent source facts`)
  })
  selections.forEach((selection) => {
    const need = db
      .select({ project_id: CompanyCapabilityNeedTable.project_id })
      .from(CompanyCapabilityNeedTable)
      .where(eq(CompanyCapabilityNeedTable.id, selection.capability_need_id))
      .get()
    if (need?.project_id !== binding.projectId)
      throw new Error(`Team Selection ${selection.id} references an unavailable Capability Need`)
  })
  performances.forEach((performance) => {
    const selection = selections.find((item) => item.id === performance.selection_id)
    if (!selection || selection.agent_id !== performance.agent_id)
      throw new Error(`Agent Performance ${performance.id} has inconsistent Selection facts`)
  })
  shadows.forEach((shadow) => {
    if (shadow.receiptId && !receipts.some((receipt) => receipt.id === shadow.receiptId))
      throw new Error(`Shadow evaluation ${shadow.id} references an unavailable Work Receipt`)
  })
  agentRuns.forEach((run) => {
    if (!run.work_item_id) return
    const item = db
      .select({ project_id: CompanyWorkItemTable.project_id })
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, run.work_item_id))
      .get()
    if (item?.project_id !== binding.projectId)
      throw new Error(`AgentRun ${run.id} references an unavailable Work Item`)
  })

  const firstReceiptAt = receipts.map((item) => item.created_at).sort((left, right) => left - right)[0]
  const output: PersistedMetricEvent[] = []
  const logical = new Set<string>()
  const append = (event: PersistedMetricEvent | undefined, key: string) => {
    if (!event || !inWindow(Date.parse(event.occurredAt), window) || logical.has(key)) return
    output.push(event)
    logical.add(key)
  }
  const emit = (input: Omit<EventInput, "binding" | "candidateSha">, key: string) =>
    append(metricEvent({ ...input, binding, candidateSha }), key)
  const rawSourceRefs = (value: string, label: string) => parseList(value, label)

  receipts.forEach((receipt) => {
    emit(
      {
        eventType: "work_receipt.submitted",
        occurredAt: receipt.created_at,
        subjectId: receipt.id,
        sourceKind: "work_receipt",
        sourceEntity: "company_work_receipt",
        sourceId: receipt.id,
        raw: receipt,
        properties: {
          receiptId: receipt.id,
          attemptId: receipt.attempt_id,
          sourceRefCount: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`).length,
          unknownCount: parseList(receipt.unknowns_json, `Work Receipt ${receipt.id} unknowns`).length,
          sourceRefs: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
        },
      },
      `work_receipt.submitted:${receipt.id}`,
    )
    const processed = events.find(
      ({ row, data }) =>
        row.type === "work_receipt.processed" &&
        (data.receiptId === receipt.id || data.receipt_id === receipt.id) &&
        typeof data.duplicate === "boolean" &&
        typeof data.recovered === "boolean",
    )
    if (!processed || receipt.processing_status !== "processed" || receipt.processed_at === null) return
    emit(
      {
        eventType: "work_receipt.processed",
        occurredAt: receipt.processed_at,
        subjectId: receipt.id,
        sourceKind: "work_receipt",
        sourceEntity: "company_work_receipt",
        sourceId: receipt.id,
        sourceFacet: "processed",
        raw: { receipt, event: processed.row },
        properties: {
          receiptId: receipt.id,
          duplicate: processed.data.duplicate,
          recovered: processed.data.recovered,
          sourceRefs: rawSourceRefs(receipt.evidence_refs_json, `Work Receipt ${receipt.id} evidence`),
        },
      },
      `work_receipt.processed:${receipt.id}`,
    )
  })
  decisions.forEach((decision) =>
    emit(
      {
        eventType: "graph_decision.recorded",
        occurredAt: decision.created_at,
        subjectId: decision.id,
        sourceKind: "project_event",
        sourceEntity: "company_graph_decision",
        sourceId: decision.id,
        raw: decision,
        properties: {
          decisionId: decision.id,
          kind: decision.kind,
          automated: decision.automated,
          addedNodeCount: decision.added_node_count,
          sourceRefs: rawSourceRefs(decision.evidence_refs_json, `Graph Decision ${decision.id} evidence`),
        },
      },
      `graph_decision.recorded:${decision.id}`,
    ),
  )
  mutations.forEach((mutation) => {
    const verdict = parseRecord(mutation.policy_verdict_json, `Graph Mutation ${mutation.id} policy verdict`)
    emit(
      {
        eventType: "graph_mutation.evaluated",
        occurredAt: mutation.applied_at ?? mutation.created_at,
        subjectId: mutation.id,
        sourceKind: "graph_mutation",
        sourceEntity: "company_graph_mutation",
        sourceId: mutation.id,
        raw: mutation,
        properties: {
          mutationId: mutation.id,
          evidenceCount: rawSourceRefs(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`).length,
          verdict: typeof verdict.result === "string" ? verdict.result : mutation.status,
          sourceRefs: rawSourceRefs(mutation.evidence_refs_json, `Graph Mutation ${mutation.id} evidence`),
        },
      },
      `graph_mutation.evaluated:${mutation.id}`,
    )
  })
  assignments.forEach((assignment) => {
    const item = db
      .select()
      .from(CompanyWorkItemTable)
      .where(eq(CompanyWorkItemTable.id, assignment.work_item_id))
      .get()!
    emit(
      {
        eventType: "project_assignment.activated",
        occurredAt: assignment.started_at ?? assignment.assigned_at,
        subjectId: assignment.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_project_assignment",
        sourceId: assignment.id,
        sourceFacet: "activated",
        raw: assignment,
        properties: {
          assignmentId: assignment.id,
          agentId: assignment.agent_id,
          purpose: item.purpose,
          initial: firstReceiptAt === undefined || assignment.assigned_at <= firstReceiptAt,
          sourceRefs: [
            { kind: "selection", id: assignment.selection_id },
            ...(assignment.source_receipt_id ? [{ kind: "work_receipt", id: assignment.source_receipt_id }] : []),
          ],
        },
      },
      `project_assignment.activated:${assignment.id}`,
    )
    if (assignment.released_at === null) return
    emit(
      {
        eventType: "project_assignment.released",
        occurredAt: assignment.released_at,
        subjectId: assignment.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_project_assignment",
        sourceId: assignment.id,
        sourceFacet: "released",
        raw: assignment,
        properties: {
          assignmentId: assignment.id,
          agentId: assignment.agent_id,
          durationMs: Math.max(0, assignment.released_at - assignment.assigned_at),
          sourceRefs: [{ kind: "selection", id: assignment.selection_id }],
        },
      },
      `project_assignment.released:${assignment.id}`,
    )
  })
  selections
    .filter((selection) => selection.decision === "selected")
    .forEach((selection) =>
      emit(
        {
          eventType: "candidate.selected",
          occurredAt: selection.time_created,
          subjectId: selection.id,
          sourceKind: "project_assignment",
          sourceEntity: "company_team_selection",
          sourceId: selection.id,
          raw: selection,
          properties: {
            candidateId: selection.agent_id,
            reused: selection.source === "company_pool",
            createdForNeed: selection.source === "new_candidate",
            selectionId: selection.id,
            capabilityNeedId: selection.capability_need_id,
          },
        },
        `candidate.selected:${selection.id}`,
      ),
    )
  attempts.forEach((attempt) =>
    emit(
      {
        eventType: "fact.work_attempt",
        occurredAt: attempt.finished_at ?? attempt.started_at,
        subjectId: attempt.id,
        sourceKind: "work_attempt",
        sourceEntity: "company_work_attempt",
        sourceId: attempt.id,
        raw: attempt,
        properties: {
          attemptId: attempt.id,
          workItemId: attempt.work_item_id,
          agentRunId: attempt.agent_run_id,
          ordinal: attempt.ordinal,
          status: attempt.status,
          failureKind: attempt.failure_kind,
        },
      },
      `fact.work_attempt:${attempt.id}`,
    ),
  )
  gates.forEach((gate) =>
    emit(
      {
        eventType: "fact.validation_gate",
        occurredAt: gate.evaluated_at ?? gate.created_at,
        subjectId: gate.id,
        sourceKind: "validation_gate",
        sourceEntity: "company_validation_gate",
        sourceId: gate.id,
        raw: gate,
        properties: {
          gateId: gate.id,
          kind: gate.kind,
          status: gate.status,
          repairRound: gate.repair_round,
          criteriaSha256: gate.criteria_sha256,
          sourceRefs: rawSourceRefs(gate.evidence_refs_json, `Validation Gate ${gate.id} evidence`),
        },
      },
      `fact.validation_gate:${gate.id}`,
    ),
  )
  repairs.forEach((repair) =>
    emit(
      {
        eventType: "graph_repair.completed",
        occurredAt: repair.created_at,
        subjectId: repair.id,
        sourceKind: "validation_gate",
        sourceEntity: "company_validation_repair",
        sourceId: repair.id,
        raw: repair,
        properties: {
          repairId: repair.id,
          passedOriginalCriterion: repair.result === "passed",
          attemptCount: repair.round,
          blindRetryCount: 0,
          gateId: repair.gate_id,
          diagnosis: parseRecord(repair.diagnosis_json, `Validation Repair ${repair.id} diagnosis`),
          sourceRefs: parseList(repair.reverify_evidence_json, `Validation Repair ${repair.id} evidence`),
        },
      },
      `graph_repair.completed:${repair.id}`,
    ),
  )
  performances.forEach((performance) =>
    emit(
      {
        eventType: "fact.agent_performance",
        occurredAt: performance.time_created,
        subjectId: performance.id,
        sourceKind: "project_assignment",
        sourceEntity: "company_agent_performance",
        sourceId: performance.id,
        raw: performance,
        properties: {
          performanceId: performance.id,
          selectionId: performance.selection_id,
          agentId: performance.agent_id,
          outcome: performance.outcome,
          qualityScore: performance.quality_score,
          reliabilityScore: performance.reliability_score,
          costScore: performance.cost_score,
          speedScore: performance.speed_score,
        },
      },
      `fact.agent_performance:${performance.id}`,
    ),
  )
  attentions.forEach((attention) => {
    const sourceRefs = rawSourceRefs(attention.source_refs_json, `Attention ${attention.id} sources`)
    emit(
      {
        eventType: "attention.opened",
        occurredAt: attention.created_at,
        subjectId: attention.id,
        sourceKind: "attention",
        sourceEntity: "company_attention",
        sourceId: attention.id,
        sourceFacet: "opened",
        raw: attention,
        properties: {
          attentionId: attention.id,
          materiality: attention.materiality,
          interruptsUser: attention.interrupts_user,
          sourceRefs,
        },
      },
      `attention.opened:${attention.id}`,
    )
    if (attention.resolved_at === null) return
    emit(
      {
        eventType: "attention.resolved",
        occurredAt: attention.resolved_at,
        subjectId: attention.id,
        sourceKind: "attention",
        sourceEntity: "company_attention",
        sourceId: attention.id,
        sourceFacet: "resolved",
        raw: attention,
        properties: {
          attentionId: attention.id,
          latencyMs: Math.max(0, attention.resolved_at - attention.created_at),
          sourceRefs,
        },
      },
      `attention.resolved:${attention.id}`,
    )
  })
  actions.forEach((action) =>
    emit(
      {
        eventType: "fact.project_action",
        occurredAt: action.finished_at ?? action.updated_at,
        subjectId: action.id,
        sourceKind: "attention",
        sourceEntity: "company_project_action",
        sourceId: action.id,
        raw: action,
        properties: {
          actionId: action.id,
          attentionId: action.attention_id,
          action: action.action,
          status: action.status,
          payloadSha256: action.payload_sha256,
        },
      },
      `fact.project_action:${action.id}`,
    ),
  )
  agentRuns.forEach((run) => {
    const usage = db.select().from(AgentRunUsageTable).where(eq(AgentRunUsageTable.agent_run_id, run.id)).get()
    const runEvents = db
      .select()
      .from(AgentRunEventTable)
      .where(eq(AgentRunEventTable.agent_run_id, run.id))
      .orderBy(asc(AgentRunEventTable.sequence), asc(AgentRunEventTable.id))
      .all()
    runEvents.forEach((event) => parseRecord(event.payload_json, `AgentRun event ${event.id}`))
    emit(
      {
        eventType: "fact.agent_run",
        occurredAt: run.time_finished ?? run.time_updated,
        subjectId: run.id,
        sourceKind: "agent_run",
        sourceEntity: "agent_run",
        sourceId: run.id,
        raw: { run, usage, events: runEvents },
        properties: {
          agentRunId: run.id,
          agentId: run.agent_id,
          workItemId: run.work_item_id,
          state: run.state,
          exitCode: run.exit_code,
          eventCount: runEvents.length,
          usage: usage
            ? {
                source: usage.source,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                reasoningTokens: usage.reasoning_tokens,
                cacheReadTokens: usage.cache_read_tokens,
                cacheWriteTokens: usage.cache_write_tokens,
              }
            : undefined,
        },
      },
      `fact.agent_run:${run.id}`,
    )
  })
  if (project.status === "completed" && project.completed_at !== null)
    emit(
      {
        eventType: "project.completed",
        occurredAt: project.completed_at,
        subjectId: project.id,
        sourceKind: "project_event",
        sourceEntity: "company_project",
        sourceId: project.id,
        raw: project,
        properties: { projectId: project.id, strategy: binding.strategy },
      },
      `project.completed:${project.id}`,
    )

  events.forEach(({ row, data }) => {
    const required = recognizedTypes.get(row.type)
    const complete = required?.every((key) => Object.prototype.hasOwnProperty.call(data, key)) === true
    const subjectId =
      [
        "receiptId",
        "decisionId",
        "mutationId",
        "gateId",
        "assignmentId",
        "attentionId",
        "attemptId",
        "deliveryId",
        "comparisonId",
        "projectId",
      ]
        .map((key) => data[key])
        .find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? row.id
    const metricKey = `${row.type}:${subjectId}`
    const eventType = !gateEvidence && complete && !logical.has(metricKey) ? row.type : "fact.project_event"
    emit(
      {
        eventType,
        occurredAt: timestampOf(row, data),
        subjectId,
        sourceKind: "project_event",
        sourceEntity: "company_project_event",
        sourceId: row.id,
        raw: row,
        properties:
          eventType === row.type
            ? data
            : {
                projectEventId: row.id,
                type: row.type,
                actorId: row.actor_id,
                data,
              },
      },
      eventType === row.type ? metricKey : `fact.project_event:${row.id}`,
    )
  })
  const candidate = rollout.candidates.find((item) => item.candidateSha === candidateSha)!
  emit(
    {
      eventType: "fact.rollout_candidate",
      occurredAt: candidate.registeredAt,
      subjectId: candidate.id,
      sourceKind: "gate_report",
      sourceEntity: "company_rollout_candidate",
      sourceId: candidate.id,
      raw: candidate,
      properties: {
        candidateId: candidate.id,
        candidateSha: candidate.candidateSha,
        targetRef: candidate.targetRef,
      },
    },
    `fact.rollout_candidate:${candidate.id}`,
  )
  rollout.localRepeats
    .filter((item) => item.candidateId === candidate.id && item.runId === binding.runId)
    .forEach((item) =>
      emit(
        {
          eventType: "fact.rollout_local_repeat",
          occurredAt: item.recordedAt,
          subjectId: item.id,
          sourceKind: "gate_report",
          sourceEntity: "company_rollout_local_repeat",
          sourceId: item.id,
          raw: item,
          properties: {
            repeatId: item.id,
            candidateId: item.candidateId,
            runId: item.runId,
            ordinal: item.ordinal,
            outcome: item.outcome,
            environmentSha256: item.environmentSha256,
            evidenceSha256: item.evidenceSha256,
            normalizedResultSha256: item.normalizedResultSha256,
          },
        },
        `fact.rollout_local_repeat:${item.id}`,
      ),
    )
  rollout.rollbacks
    .filter(
      (item) =>
        (item.projectId === binding.projectId && (!item.candidateId || item.candidateId === candidate.id)) ||
        (!item.projectId && item.candidateId === candidate.id),
    )
    .forEach((item) =>
      emit(
        {
          eventType: "fact.rollout_rollback",
          occurredAt: item.recordedAt,
          subjectId: item.id,
          sourceKind: "rollback_report",
          sourceEntity: "company_rollout_rollback",
          sourceId: item.id,
          raw: item,
          properties: {
            rollbackId: item.id,
            candidateId: item.candidateId,
            ...(item.projectId ? { projectId: item.projectId } : {}),
            target: item.target,
            outcome: item.outcome,
            executionModeAfter: item.executionModeAfter,
            evidenceSha256: item.evidenceSha256,
          },
        },
        `fact.rollout_rollback:${item.id}`,
      ),
    )
  shadows.forEach((item) =>
    emit(
      {
        eventType: "fact.rollout_shadow_evaluation",
        occurredAt: item.createdAt,
        subjectId: item.id,
        sourceKind: "shadow_report",
        sourceEntity: "company_rollout_shadow_evaluation",
        sourceId: item.id,
        raw: item,
        properties: {
          shadowEvaluationId: item.id,
          kind: item.kind,
          receiptId: item.receiptId,
          snapshotDigest: item.snapshotSha256,
          inputSha256: item.inputSha256,
          outputSha256: item.outputSha256,
          businessStateBeforeSha256: item.businessStateBeforeSha256,
          businessStateAfterSha256: item.businessStateAfterSha256,
          status: item.status,
        },
      },
      `fact.rollout_shadow_evaluation:${item.id}`,
    ),
  )
  if (gateEvidence) output.push(...gateObservationFacts(db, binding, candidateSha, window, rollout, gateEvidence))
  return output
}

async function executableDigest() {
  return sha256(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer()))
}

async function assertOutputTarget(target: string) {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(`Persisted fact output cannot be a symbolic link: ${target}`)
  if (info && !info.isFile()) throw new Error(`Persisted fact output must be a regular file: ${target}`)
}

export async function exportPersistedFactArtifact(raw: PersistedFactExportRequest): Promise<PersistedFactExportResult> {
  const request = PersistedFactExportRequest.parse(raw)
  const producerDigest = await executableDigest()
  const gateEvidence = await b5Evidence(request)
  const events = Database.transaction(
    (db) => {
      if (
        [
          CompanyRolloutCandidateTable,
          CompanyRolloutLocalRepeatTable,
          CompanyRolloutRollbackTable,
          CompanyRolloutShadowEvaluationTable,
        ].some((table) => db.select({ value: count() }).from(table).get()!.value > 500)
      )
        throw new Error("Persisted rollout fact count exceeds the local Gate export limit")
      const rollout = CompanyRollout.evidence(500)
      if (!rollout.candidates.some((candidate) => candidate.candidateSha === request.candidateSha))
        throw new Error(`Candidate ${request.candidateSha} is not registered in persisted rollout facts`)
      return request.runBindings.flatMap((binding) =>
        projectFacts(db, binding, request.candidateSha, request.metricContract, request.window, rollout, gateEvidence),
      )
    },
    { behavior: "immediate" },
  )
  const artifact = bindPersistedFactArtifact({
    schemaVersion: 1,
    kind: "seed-grow-local-gate-persisted-facts",
    id: request.id,
    producer: {
      kind: "local_gate",
      commandId: "seed-grow-persisted-fact-exporter",
      version: "v1",
      executableDigest: producerDigest,
    },
    candidateSha: request.candidateSha,
    metricContractDigest: persistedMetricContractDigest(request.metricContract),
    metricQueryVersion: request.metricContract.queryVersion,
    shadowQueryVersion: request.metricContract.shadowComparison?.queryVersion ?? "seed-grow-shadow-query.v1",
    window: request.window,
    runBindings: request.runBindings,
    events,
  })
  await assertOutputTarget(request.outputPath)
  await mkdir(path.dirname(request.outputPath), { recursive: true })
  const source = `${JSON.stringify(artifact, null, 2)}\n`
  const temporary = `${request.outputPath}.${process.pid}.${sha256(source).slice(0, 12)}.tmp`
  await Bun.write(temporary, source)
  await rename(temporary, request.outputPath)
  return PersistedFactExportResult.parse({
    artifact,
    reference: {
      path: request.outputPath,
      sha256: sha256(source),
    },
  })
}

export * as PersistedFactExporter from "./persisted-fact-exporter"
