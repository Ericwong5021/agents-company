import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import {
  MetricContract,
  MetricEvaluationReport,
  PrePublicScenarioMetricIds,
} from "@agents-company/shared/seed-grow-metrics"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import { Effect, Layer } from "effect"
import z from "zod"
import {
  B5RunBinding,
  B5ScenarioRunResult,
  B5ScenarioIds,
  B5StrategyOrder,
  exactB5RunBindings,
  loadB5ScenarioSnapshots,
  requiredB5ObservationTypes,
} from "../src/metrics/b5-candidate-scenarios"
import { B5CandidateRecoveryResult } from "../src/metrics/b5-candidate-recovery"

const root = path.resolve(import.meta.dir, "../../..")
const producerPath = "packages/control-plane/script/produce-seed-grow-candidate-facts.ts"
const benchmarkPath =
  "docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json"
const metricContractPath =
  "docs/product-design/experience-refactor/metric-contract.v1.json"
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const IsolationId = z.string().regex(/^[a-f0-9]{16}$/)
const Timestamp = z.number().int().nonnegative()
const CandidateArgument = z.union([CommitSha, z.literal("HEAD")])
const AttemptId = z.enum(["automatic", "attempt-01", "attempt-02"])
const AbsolutePath = z.string().refine((value) => path.isAbsolute(value))
const RelativeFile = z
  .object({
    relativePath: z.string().trim().min(1).refine((value) => !path.isAbsolute(value)),
    sha256: Digest,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.literal("application/json"),
  })
  .strict()

export const B5ProducerArguments = z
  .object({
    candidateSha: CandidateArgument,
    attemptId: AttemptId,
    outputDirectory: AbsolutePath,
  })
  .strict()
export type B5ProducerArguments = z.infer<typeof B5ProducerArguments>

const EnvironmentBinding = z
  .object({
    absolutePathSha256: Digest,
    stateSha256: Digest,
  })
  .strict()

export const B5CandidateAttemptSummary = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-b5-candidate-attempt"),
    candidate: z
      .object({
        requestedSha: CommitSha,
        headSha: CommitSha,
        treeSha: CommitSha,
        parentSha: CommitSha,
      })
      .strict(),
    attemptId: AttemptId,
    attemptIsolationId: IsolationId,
    producer: z
      .object({
        path: z.literal(producerPath),
        sha256: Digest,
      })
      .strict(),
    environment: z
      .object({
        worktree: EnvironmentBinding,
        runtimeHome: EnvironmentBinding,
        database: EnvironmentBinding,
        output: EnvironmentBinding,
        isolationRoot: EnvironmentBinding,
        productionDataInherited: z.literal(false),
        productionProcessUsed: z.literal(false),
        networkPortsUsed: z.tuple([]),
      })
      .strict(),
    window: z
      .object({
        startedAt: Timestamp,
        finishedAt: Timestamp,
      })
      .strict()
      .refine((value) => value.finishedAt >= value.startedAt),
    orderedRunBindings: z.array(B5RunBinding).length(30),
    files: z
      .object({
        facts: RelativeFile.extend({ relativePath: z.literal("facts.json") }).strict(),
        summary: z
          .object({
            relativePath: z.literal("summary.json"),
            mediaType: z.literal("application/json"),
          })
          .strict(),
        metricReport: RelativeFile.extend({
          relativePath: z.literal("metric-report.json"),
        }).strict(),
        shadowReport: RelativeFile.extend({
          relativePath: z.literal("shadow-report.json"),
        }).strict(),
        rollbackKillSwitch: RelativeFile.extend({
          relativePath: z.literal("rollback-kill-switch.json"),
        }).strict(),
        rollbackLegacyFallback: RelativeFile.extend({
          relativePath: z.literal("rollback-legacy-fallback.json"),
        }).strict(),
        observationReports: z.array(RelativeFile).length(30),
      })
      .strict(),
    normalizedResultSha256: Digest,
    outputIsolationSha256: Digest,
    singleAttemptMetricGate: z
      .object({
        status: z.literal("deferred"),
        deferredMetricIds: z.tuple([
          z.literal("complex_initial_assignment_median"),
        ]),
        unexpectedMetricIds: z.tuple([]),
      })
      .strict(),
    singleAttemptShadowGate: z
      .object({
        status: z.literal("deferred"),
        blockedReasons: z.tuple([z.literal("insufficient_sample")]),
      })
      .strict(),
    attemptStatus: z.literal("completed"),
    promotionClaimed: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      exactB5RunBindings(value.orderedRunBindings)
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["orderedRunBindings"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (value.candidate.requestedSha !== value.candidate.headSha)
      context.addIssue({
        code: "custom",
        path: ["candidate", "headSha"],
        message: "Candidate SHA must equal the checked-out HEAD",
      })
    value.orderedRunBindings.forEach((binding, index) => {
      const report = value.files.observationReports[index]
      const expected = `reports/${binding.scenarioId}-${binding.strategy}.json`
      if (report?.relativePath !== expected)
        context.addIssue({
          code: "custom",
          path: ["files", "observationReports", index, "relativePath"],
          message: `Expected fixed archived report ${expected}`,
        })
    })
  })
export type B5CandidateAttemptSummary = z.infer<typeof B5CandidateAttemptSummary>

const ActiveRolloutStatus = z
  .object({
    phase: z.literal("dogfood_default"),
    executionMode: z.literal("active"),
    newProjectPolicy: z
      .object({
        defaultStrategy: z.literal("seed_and_grow"),
        seedOptInAllowed: z.literal(true),
        explicitLegacyFallbackAllowed: z.literal(true),
      })
      .strict(),
  })
  .strict()

const DisabledRolloutStatus = z
  .object({
    phase: z.literal("dogfood_default"),
    executionMode: z.literal("off"),
    newProjectPolicy: z
      .object({
        defaultStrategy: z.literal("legacy_full_plan"),
        seedOptInAllowed: z.literal(false),
        explicitLegacyFallbackAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict()

const DispatchResult = z
  .object({
    project_id: z.string().trim().min(1),
    status: z.enum(["paused", "gated", "idle", "dispatched"]),
    barrier: z.enum(["open", "paused"]),
    eligible_work_item_ids: z.array(z.string().trim().min(1)),
    dispatched_work_item_ids: z.array(z.string().trim().min(1)),
    run_id: z.string().trim().min(1).optional(),
  })
  .strict()

const RollbackObservationBase = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-b5-rollback-observation"),
    candidateSha: CommitSha,
    attemptId: AttemptId,
    attemptIsolationId: IsolationId,
    outcome: z.literal("completed"),
    phaseAtAction: z.literal("dogfood_default"),
    inFlightProject: z
      .object({
        id: z.string().trim().min(1),
        status: z.literal("executing"),
        strategyBefore: z.literal("seed_and_grow"),
        strategyAfter: z.literal("seed_and_grow"),
        businessStateSha256Before: Digest,
        businessStateSha256After: Digest,
      })
      .strict(),
    process: z
      .object({
        pid: z.number().int().positive(),
        producerPath: z.literal(producerPath),
        producerSha256: Digest,
        startedAt: Timestamp,
      })
      .strict(),
    businessRows: z
      .object({
        beforeSha256: Digest,
        afterSha256: Digest,
        newProjectId: z.string().trim().min(1),
        newProjectStrategy: z.literal("legacy_full_plan"),
        existingProjectId: z.string().trim().min(1),
        existingProjectStrategyBefore: z.literal("seed_and_grow"),
        existingProjectStrategyAfter: z.literal("seed_and_grow"),
      })
      .strict(),
    resolvedExplicitFallbackStrategy: z.literal("legacy_full_plan"),
    isolation: z
      .object({
        database: z.literal("fresh_local_sqlite"),
        databasePathSha256: Digest,
        productionDatabaseInherited: z.literal(false),
        productionProcessUsed: z.literal(false),
        networkPortsUsed: z.tuple([]),
      })
      .strict(),
    observedAt: Timestamp,
  })
  .strict()

const RollbackDispatch = z
  .object({
    coordinator: z.literal("DispatchCoordinator"),
    action: z.enum(["kill_switch", "legacy_fallback"]),
    projectId: z.string().trim().min(1),
    result: DispatchResult,
    resultSha256: Digest,
    observedAt: Timestamp,
  })
  .strict()

export const B5RollbackObservation = z
  .discriminatedUnion("target", [
    RollbackObservationBase.extend({
      target: z.literal("kill_switch"),
      before: ActiveRolloutStatus,
      after: DisabledRolloutStatus,
      dispatch: RollbackDispatch.extend({
        action: z.literal("kill_switch"),
        result: DispatchResult.extend({
          status: z.literal("paused"),
          barrier: z.literal("paused"),
          eligible_work_item_ids: z.tuple([]),
          dispatched_work_item_ids: z.tuple([]),
          run_id: z.never().optional(),
        }).strict(),
      }).strict(),
      resolvedNewProjectStrategy: z.literal("legacy_full_plan"),
    }).strict(),
    RollbackObservationBase.extend({
      target: z.literal("legacy_fallback"),
      before: ActiveRolloutStatus,
      after: ActiveRolloutStatus,
      dispatch: RollbackDispatch.extend({
        action: z.literal("legacy_fallback"),
        result: DispatchResult.extend({
          status: z.literal("idle"),
          barrier: z.literal("open"),
          eligible_work_item_ids: z.tuple([]),
          dispatched_work_item_ids: z.tuple([]),
          run_id: z.never().optional(),
        }).strict(),
      }).strict(),
      resolvedNewProjectStrategy: z.literal("legacy_full_plan"),
    }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.dispatch.result.project_id !== value.dispatch.projectId)
      context.addIssue({
        code: "custom",
        path: ["dispatch", "result", "project_id"],
        message: "Dispatch result project does not match the observed project",
      })
    if (value.dispatch.resultSha256 !== valueSha256(value.dispatch.result))
      context.addIssue({
        code: "custom",
        path: ["dispatch", "resultSha256"],
        message: "Dispatch result digest mismatch",
      })
    if (value.dispatch.observedAt !== value.observedAt)
      context.addIssue({
        code: "custom",
        path: ["dispatch", "observedAt"],
        message: "Dispatch observation timestamp mismatch",
      })
    if (value.process.startedAt > value.observedAt)
      context.addIssue({
        code: "custom",
        path: ["process", "startedAt"],
        message: "Rollback observation predates its producer process",
      })
    if (
      value.inFlightProject.businessStateSha256Before !==
        value.inFlightProject.businessStateSha256After ||
      value.inFlightProject.strategyBefore !== value.inFlightProject.strategyAfter
    )
      context.addIssue({
        code: "custom",
        path: ["inFlightProject"],
        message: "Rollback changed the in-flight project",
      })
    if (
      value.dispatch.projectId !== value.inFlightProject.id ||
      value.businessRows.existingProjectId !== value.inFlightProject.id ||
      value.businessRows.existingProjectStrategyBefore !== value.inFlightProject.strategyBefore ||
      value.businessRows.existingProjectStrategyAfter !== value.inFlightProject.strategyAfter ||
      value.businessRows.newProjectStrategy !== value.resolvedNewProjectStrategy
    )
      context.addIssue({
        code: "custom",
        path: ["dispatch"],
        message: "Rollback observation bindings are inconsistent",
      })
  })
export type B5RollbackObservation = z.infer<typeof B5RollbackObservation>

const ScenarioProbe = z
  .object({
    runId: z.string().trim().min(1),
    commandId: z.literal("bun-local-project-binding-probe"),
    stdoutSha256: Digest,
    stderrSha256: Digest,
  })
  .strict()

const ScenarioTerminal = z
  .object({
    passed: z.literal(true),
    falseCompletion: z.literal(false),
    pendingWorkItemCount: z.number().int().nonnegative(),
    pendingReceiptCount: z.number().int().nonnegative(),
    pendingMutationCount: z.number().int().nonnegative(),
    pendingGateCount: z.number().int().nonnegative(),
  })
  .strict()

const ScenarioReviewer = z
  .object({
    workItemId: z.string().trim().min(1),
    assignmentId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    independent: z.literal(true),
    rejected: z.boolean(),
  })
  .strict()

const QuiescenceBlockerCode = z.enum([
  "not_seed_and_grow",
  "project_status_not_completable",
  "nonterminal_work_items",
  "running_attempts",
  "terminal_attempts_without_receipt",
  "unprocessed_receipts",
  "pending_mutations",
  "unresolved_validation_gates",
  "pending_approval_gates",
  "open_material_attention",
  "claimed_project_actions",
  "unresolved_receipt_blockers",
  "acceptance_evidence_missing",
  "active_quiesce_decision_missing",
])

const ScenarioQuiescence = z
  .object({
    project_id: z.string().trim().min(1),
    status: z.literal("blocked"),
    ready: z.literal(false),
    replayed: z.boolean(),
    graph_revision: z.number().int().nonnegative(),
    blocker_codes: z.array(QuiescenceBlockerCode).min(1),
    blockers: z
      .array(
        z
          .object({
            code: QuiescenceBlockerCode,
            entity_ids: z.array(z.string().trim().min(1)),
          })
          .strict(),
      )
      .min(1),
    quiesce_decision_id: z.string().trim().min(1).optional(),
    delivery_package_artifact_id: z.string().trim().min(1).optional(),
    released_selection_ids: z.array(z.string().trim().min(1)),
  })
  .strict()

const SeedOracleKindByScenario = {
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

export const B5ScenarioObservationReport = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-b5-scenario-observation"),
    candidateSha: CommitSha,
    attemptId: AttemptId,
    attemptIsolationId: IsolationId,
    result: B5ScenarioRunResult,
    binding: B5ScenarioRunResult.shape.binding,
    projectStatus: B5ScenarioRunResult.shape.projectStatus,
    terminalDecision: B5ScenarioRunResult.shape.terminalDecision,
    oracle: B5ScenarioRunResult.shape.oracle,
    sourceRefs: B5ScenarioRunResult.shape.sourceRefs,
    probe: ScenarioProbe,
    reviewer: ScenarioReviewer.optional(),
    delivery: z
      .object({
        id: z.string().trim().min(1),
        sha256: Digest,
      })
      .strict()
      .optional(),
    validationGate: z
      .object({
        id: z.string().trim().min(1),
        status: z.enum(["pending", "running", "passed", "failed", "superseded"]),
      })
      .strict()
      .optional(),
    approvalGate: z
      .object({
        id: z.string().trim().min(1),
        status: z.enum(["pending", "approved", "rejected"]),
      })
      .strict()
      .optional(),
    attention: z
      .object({
        id: z.string().trim().min(1),
        material: z.literal(true),
        interrupts_user: z.literal(true),
      })
      .strict()
      .optional(),
    terminal: ScenarioTerminal,
    quiescence: ScenarioQuiescence.optional(),
    quiescenceBlockers: z.array(
      z
        .object({
          kind: z.enum([
            "work_item",
            "work_attempt",
            "work_receipt",
            "graph_mutation",
            "validation_gate",
            "approval_gate",
            "attention",
            "project_action",
          ]),
          id: z.string().trim().min(1),
        })
        .strict(),
    ),
    recovery: B5CandidateRecoveryResult.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.binding.runId !==
      b5AttemptRunId({
        attemptId: value.attemptId,
        attemptIsolationId: value.attemptIsolationId,
        scenarioId: value.binding.scenarioId,
        strategy: value.binding.strategy,
        candidateSha: value.candidateSha,
      })
    )
      context.addIssue({
        code: "custom",
        path: ["binding", "runId"],
        message: "Scenario run is not bound to candidate, attempt, and isolation identity",
      })
    const expectedOracleKind =
      value.binding.strategy === "legacy_full_plan"
        ? "legacy_frozen_oracle"
        : SeedOracleKindByScenario[value.binding.scenarioId]
    if (value.oracle.kind !== expectedOracleKind)
      context.addIssue({
        code: "custom",
        path: ["oracle", "kind"],
        message: "Scenario oracle does not match its strategy and scenario binding",
      })
    if (
      value.oracle.kind === "b5_process_recovery" &&
      value.oracle.scenarioId !== value.binding.scenarioId
    )
      context.addIssue({
        code: "custom",
        path: ["oracle", "scenarioId"],
        message: "Recovery oracle does not match its scenario binding",
      })
    if (
      valueSha256({
        binding: value.binding,
        projectStatus: value.projectStatus,
        terminalDecision: value.terminalDecision,
        oracle: value.oracle,
        sourceRefs: value.sourceRefs,
      }) !== valueSha256(value.result)
    )
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Scenario result core does not match the archived projection",
      })
    if (value.probe.runId !== value.binding.runId)
      context.addIssue({
        code: "custom",
        path: ["probe", "runId"],
        message: "Scenario probe is not bound to the archived run",
      })
    const pendingCount =
      value.terminal.pendingWorkItemCount +
      value.terminal.pendingReceiptCount +
      value.terminal.pendingMutationCount +
      value.terminal.pendingGateCount
    if (
      value.projectStatus === "completed" &&
      pendingCount !== 0
    )
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "Completed project retains pending terminal facts",
      })
    if (
      value.terminalDecision === "completed" &&
      (value.projectStatus !== "completed" || pendingCount !== 0)
    )
      context.addIssue({
        code: "custom",
        path: ["terminalDecision"],
        message: "Completed decision is inconsistent with persisted terminal facts",
      })
    if (value.quiescence?.project_id !== undefined &&
      value.quiescence.project_id !== value.binding.projectId)
      context.addIssue({
        code: "custom",
        path: ["quiescence", "project_id"],
        message: "Quiescence result is not bound to the scenario project",
      })
    if (
      value.recovery &&
      (value.recovery.candidateSha !== value.candidateSha ||
        value.recovery.scenarioId !== value.binding.scenarioId ||
        value.recovery.snapshotDigest !== value.binding.snapshotDigest ||
        value.recovery.runId !== value.binding.runId)
    )
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Recovery result is not bound to the scenario candidate and run",
      })
    const observationTypes = requiredB5ObservationTypes(
      value.binding.scenarioId,
      value.binding.strategy,
    )
    const attached = [
      {
        path: "delivery",
        required: observationTypes.includes("delivery.checked"),
        present: Boolean(value.delivery),
      },
      {
        path: "validationGate",
        required: observationTypes.includes("validation_anchor.checked"),
        present: Boolean(value.validationGate),
      },
      {
        path: "approvalGate",
        required:
          value.binding.scenarioId === "S15" &&
          value.binding.strategy === "seed_and_grow",
        present: Boolean(value.approvalGate),
      },
      {
        path: "attention",
        required:
          ["S15", "S22"].includes(value.binding.scenarioId) &&
          value.binding.strategy === "seed_and_grow",
        present: Boolean(value.attention),
      },
      {
        path: "reviewer",
        required:
          value.binding.scenarioId === "S18" &&
          value.binding.strategy === "seed_and_grow",
        present: Boolean(value.reviewer),
      },
      {
        path: "quiescence",
        required:
          value.binding.scenarioId === "S24" &&
          value.binding.strategy === "seed_and_grow",
        present: Boolean(value.quiescence),
      },
      {
        path: "recovery",
        required:
          ["S19", "S20", "S27"].includes(value.binding.scenarioId) &&
          value.binding.strategy === "seed_and_grow",
        present: Boolean(value.recovery),
      },
    ]
    for (const field of attached) {
      if (field.required === field.present) continue
      context.addIssue({
        code: "custom",
        path: [field.path],
        message: `${field.path} attachment does not match the scenario contract`,
      })
    }
    const requiresQuiescenceBlockers =
      value.binding.scenarioId === "S24" &&
      value.binding.strategy === "seed_and_grow"
    if (requiresQuiescenceBlockers === Boolean(value.quiescenceBlockers.length))
      return
    context.addIssue({
      code: "custom",
      path: ["quiescenceBlockers"],
      message: "Quiescence blockers do not match the scenario contract",
    })
  })
export type B5ScenarioObservationReport = z.infer<
  typeof B5ScenarioObservationReport
>

export const B5CanonicalNormalizedResultInput = z
  .object({
    scenarioReports: z.array(B5ScenarioObservationReport).length(30),
    metricReport: MetricEvaluationReport,
    shadowReport: ShadowComparisonReport,
    rollbackObservations: z.array(B5RollbackObservation).length(2),
  })
  .strict()
  .superRefine((value, context) => {
    const first = value.scenarioReports[0]
    if (!first) return
    try {
      exactB5RunBindings(value.scenarioReports.map((report) => report.binding))
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["scenarioReports"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (
      value.scenarioReports.some(
        (report) =>
          report.candidateSha !== first.candidateSha ||
          report.attemptId !== first.attemptId ||
          report.attemptIsolationId !== first.attemptIsolationId,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["scenarioReports"],
        message: "Scenario reports do not belong to one candidate attempt",
      })
    const runIds = value.scenarioReports.map((report) => report.binding.runId).sort()
    const deferredMetric = value.metricReport.results.find(
      (result) => result.metricId === "complex_initial_assignment_median",
    )
    if (
      value.metricReport.candidateSha !== first.candidateSha ||
      value.metricReport.status !== "blocked" ||
      value.metricReport.results.length !== PrePublicScenarioMetricIds.length ||
      !deferredMetric ||
      deferredMetric.status !== "blocked" ||
      deferredMetric.sampleSize !== 1 ||
      deferredMetric.blockedReasons.length !== 1 ||
      deferredMetric.blockedReasons[0] !== "insufficient_sample" ||
      value.metricReport.results.some(
        (result) =>
          result.metricId !== "complex_initial_assignment_median" &&
          result.status !== "pass",
      ) ||
      JSON.stringify([...value.metricReport.runIds].sort()) !== JSON.stringify(runIds)
    )
      context.addIssue({
        code: "custom",
        path: ["metricReport"],
        message: "Metric report does not match the complete single-attempt scenario run set",
      })
    if (
      PrePublicScenarioMetricIds.some(
        (metricId) =>
          value.metricReport.results.filter((result) => result.metricId === metricId)
            .length !== 1,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["metricReport", "results"],
        message: "Metric report does not contain each required B5 metric exactly once",
      })
    const legacyRunIds = value.scenarioReports
      .filter((report) => report.binding.strategy === "legacy_full_plan")
      .map((report) => report.binding.runId)
      .sort()
    const seedRunIds = value.scenarioReports
      .filter((report) => report.binding.strategy === "seed_and_grow")
      .map((report) => report.binding.runId)
      .sort()
    if (
      value.shadowReport.candidateSha !== first.candidateSha ||
      value.shadowReport.status !== "blocked" ||
      value.shadowReport.blockedReasons.length !== 1 ||
      value.shadowReport.blockedReasons[0] !== "insufficient_sample" ||
      value.shadowReport.checks.some((check) => check.status !== "blocked") ||
      JSON.stringify([...value.shadowReport.scenarioIds].sort()) !==
        JSON.stringify([...B5ScenarioIds].sort()) ||
      JSON.stringify([...value.shadowReport.legacyRunIds].sort()) !==
        JSON.stringify(legacyRunIds) ||
      JSON.stringify([...value.shadowReport.seedAndGrowRunIds].sort()) !==
        JSON.stringify(seedRunIds)
    )
      context.addIssue({
        code: "custom",
        path: ["shadowReport"],
        message: "Shadow report does not match the complete single-attempt scenario pairs",
      })
    if (
      value.rollbackObservations.some(
        (observation) =>
          observation.candidateSha !== first.candidateSha ||
          observation.attemptId !== first.attemptId ||
          observation.attemptIsolationId !== first.attemptIsolationId,
      ) ||
      new Set(value.rollbackObservations.map((observation) => observation.target))
        .size !== 2
    )
      context.addIssue({
        code: "custom",
        path: ["rollbackObservations"],
        message: "Rollback observations do not bind both targets to the candidate attempt",
      })
  })
export type B5CanonicalNormalizedResultInput = z.infer<
  typeof B5CanonicalNormalizedResultInput
>

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

export function b5AttemptIsolationId(worktree: string, outputDirectory: string) {
  return IsolationId.parse(
    sha256(`${path.resolve(worktree)}:${path.resolve(outputDirectory)}`).slice(0, 16),
  )
}

export function b5AttemptRunId(input: {
  attemptId: z.infer<typeof AttemptId>
  attemptIsolationId: string
  scenarioId: z.infer<typeof B5RunBinding>["scenarioId"]
  strategy: z.infer<typeof B5RunBinding>["strategy"]
  candidateSha: string
}) {
  return `b5-${AttemptId.parse(input.attemptId)}-${IsolationId.parse(input.attemptIsolationId)}-${input.scenarioId.toLowerCase()}-${input.strategy}-${CommitSha.parse(input.candidateSha).slice(0, 12)}`
}

function b5ObservationId(attemptIsolationId: string, runId: string, eventType: string) {
  return `event_${sha256(`${IsolationId.parse(attemptIsolationId)}:${runId}:${eventType}`).slice(0, 26)}`
}

export function b5AttemptIdentityPlan(input: {
  worktree: string
  outputDirectory: string
  attemptId: z.infer<typeof AttemptId>
  candidateSha: string
}) {
  const attemptIsolationId = b5AttemptIsolationId(
    input.worktree,
    input.outputDirectory,
  )
  const runs = B5ScenarioIds.flatMap((scenarioId) =>
    B5StrategyOrder.map((strategy) => ({
      scenarioId,
      strategy,
      runId: b5AttemptRunId({
        attemptId: input.attemptId,
        attemptIsolationId,
        scenarioId,
        strategy,
        candidateSha: input.candidateSha,
      }),
    })),
  )
  return {
    attemptIsolationId,
    runIds: runs.map((run) => run.runId),
    eventIds: runs.flatMap((run) =>
      requiredB5ObservationTypes(run.scenarioId, run.strategy).map((eventType) =>
        b5ObservationId(attemptIsolationId, run.runId, eventType),
      ),
    ),
    sourceIds: runs.flatMap((run) =>
      requiredB5ObservationTypes(run.scenarioId, run.strategy).map(
        (eventType) =>
          `company_gate_observation:${b5ObservationId(attemptIsolationId, run.runId, eventType)}:${run.runId}`,
      ),
    ),
  }
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return result.stdout.toString().trim()
}

function gitBytes(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return new Uint8Array(result.stdout)
}

function flagValue(argv: string[], name: string) {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1] || argv[index + 1]!.startsWith("--"))
    throw new Error(`Missing required ${name}`)
  if (argv.indexOf(name, index + 1) >= 0) throw new Error(`Duplicate ${name}`)
  return argv[index + 1]!
}

export function parseB5ProducerArguments(argv: string[]) {
  const known = new Set(["--candidate-sha", "--attempt-id", "--out"])
  const flags = argv.filter((value) => value.startsWith("--"))
  const unknown = flags.find((value) => !known.has(value))
  if (unknown) throw new Error(`Unknown argument ${unknown}`)
  if (argv.length !== 6) throw new Error("B5 producer requires exactly three named arguments")
  return B5ProducerArguments.parse({
    candidateSha: flagValue(argv, "--candidate-sha"),
    attemptId: flagValue(argv, "--attempt-id"),
    outputDirectory: path.resolve(flagValue(argv, "--out")),
  })
}

export async function resolveB5CandidateGit(candidateSha: string) {
  const headSha = CommitSha.parse(git(["rev-parse", "--verify", "HEAD^{commit}"]))
  const requestedSha = candidateSha === "HEAD" ? headSha : CommitSha.parse(candidateSha)
  if (requestedSha !== headSha)
    throw new Error(`Requested candidate ${requestedSha} is not checked out at HEAD ${headSha}`)
  const parents = git(["rev-list", "--parents", "-n", "1", headSha]).split(/\s+/)
  if (parents.length !== 2 || parents[0] !== headSha)
    throw new Error("B5 candidate must have exactly one direct Git parent")
  const producerBlob = gitBytes(["cat-file", "blob", `${headSha}:${producerPath}`])
  const currentProducer = new Uint8Array(
    await Bun.file(path.join(root, producerPath)).arrayBuffer(),
  )
  if (!producerBlob.length || sha256(producerBlob) !== sha256(currentProducer))
    throw new Error("B5 producer runtime source differs from its candidate Git blob")
  return {
    requestedSha,
    headSha,
    treeSha: CommitSha.parse(git(["rev-parse", `${headSha}^{tree}`])),
    parentSha: CommitSha.parse(parents[1]),
    producerSha256: sha256(producerBlob),
  }
}

export async function prepareB5CandidateAttempt(input: B5ProducerArguments) {
  const parsed = B5ProducerArguments.parse(input)
  const requestedOutputDirectory = path.resolve(parsed.outputDirectory)
  const existing = await readdir(requestedOutputDirectory).catch(() => [])
  if (existing.length) throw new Error("B5 producer output directory must be empty")
  await mkdir(requestedOutputDirectory, { recursive: true })
  const outputDirectory = await realpath(requestedOutputDirectory)
  const isolationRoot = path.join(outputDirectory, ".isolation")
  const runtimeHome = path.join(isolationRoot, "runtime-home")
  const databasePath = path.join(isolationRoot, "agent-company.db")
  await mkdir(runtimeHome, { recursive: true })
  const worktree = await realpath(root)
  const snapshots = loadB5ScenarioSnapshots(
    JSON.parse(await Bun.file(path.join(root, benchmarkPath)).text()) as unknown,
  )
  if (snapshots.length !== B5ScenarioIds.length)
    throw new Error("B5 producer did not load the complete benchmark scenario set")
  return {
    arguments: parsed,
    git: await resolveB5CandidateGit(parsed.candidateSha),
    attemptIsolationId: b5AttemptIsolationId(worktree, outputDirectory),
    snapshots,
    paths: {
      worktree,
      outputDirectory,
      isolationRoot,
      runtimeHome,
      databasePath,
      facts: path.join(outputDirectory, "facts.json"),
      summary: path.join(outputDirectory, "summary.json"),
      metricReport: path.join(outputDirectory, "metric-report.json"),
      shadowReport: path.join(outputDirectory, "shadow-report.json"),
      rollbackKillSwitch: path.join(outputDirectory, "rollback-kill-switch.json"),
      rollbackLegacyFallback: path.join(outputDirectory, "rollback-legacy-fallback.json"),
      observationReports: path.join(outputDirectory, "reports"),
    },
  }
}

export function environmentPathDigest(target: string) {
  return sha256(path.resolve(target))
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

function valueSha256(value: unknown) {
  return sha256(JSON.stringify(normalized(value)))
}

export function b5NormalizedResultSha256(value: unknown) {
  return valueSha256(value)
}

function canonicalOracle(
  oracle: B5ScenarioObservationReport["oracle"],
): Record<string, unknown> {
  if (oracle.kind === "legacy_frozen_oracle")
    return {
      kind: oracle.kind,
      scenarioId: oracle.scenarioId,
      projectStatus: oracle.projectStatus,
      planCount: oracle.planIds.length,
      workItemCount: oracle.workItemIds.length,
      assignmentCount: oracle.assignmentIds.length,
      workflowRunCount: oracle.workflowRunIds.length,
      artifactCount: oracle.artifactIds.length,
      approvalGateCount: oracle.approvalGateIds.length,
      settledFactSha256: oracle.settledFactSha256,
    }
  if (oracle.kind === "s13_seed_pair")
    return {
      kind: oracle.kind,
      seedMode: oracle.seedMode,
      assignmentCount: oracle.assignmentIds.length,
      agentCount: oracle.agentIds.length,
      initialGraphNodeCount: oracle.initialGraphNodeCount,
    }
  if (oracle.kind === "s14_direct_single")
    return {
      kind: oracle.kind,
      seedMode: oracle.seedMode,
      reviewerWorkItemCount: oracle.reviewerWorkItemIds.length,
    }
  if (oracle.kind === "s15_approval_stop")
    return {
      kind: oracle.kind,
      seedMode: oracle.seedMode,
      builderDispatched: oracle.builderDispatched,
      externalEffectEventCount: oracle.externalEffectEventIds.length,
    }
  if (oracle.kind === "s16_prerequisite_repair")
    return {
      kind: oracle.kind,
      criteriaSha256: oracle.criteriaSha256,
      initialStatus: oracle.initialStatus,
      repairedStatus: oracle.repairedStatus,
    }
  if (oracle.kind === "s17_capability_growth")
    return {
      kind: oracle.kind,
      assignmentCount: oracle.assignmentIds.length,
      agentCount: oracle.agentIds.length,
      replayedMaterialization: oracle.replayedMaterialization,
    }
  if (oracle.kind === "s18_risk_reviewer")
    return {
      kind: oracle.kind,
      independent: oracle.independent,
      rejected: oracle.rejected,
    }
  if (oracle.kind === "s21_revision_conflict")
    return {
      kind: oracle.kind,
      receiptCount: oracle.receiptIds.length,
      decisionCount: oracle.decisionIds.length,
      supersededDecisionCount: oracle.supersededDecisionIds.length,
      conflictCount: oracle.conflictCount,
    }
  if (oracle.kind === "s22_repair_circuit")
    return {
      kind: oracle.kind,
      attemptCount: oracle.attemptIds.length,
      repairRounds: oracle.repairRounds,
      fourthAttemptScheduled: oracle.fourthAttemptScheduled,
      fourthRepairReplayed: oracle.fourthRepairReplayed,
    }
  if (oracle.kind === "s23_supersede_replace")
    return { kind: oracle.kind, historyRetained: oracle.historyRetained }
  if (oracle.kind === "s24_quiescence_blocked")
    return {
      kind: oracle.kind,
      blockerCodes: [...oracle.blockerCodes].sort(),
      deliveryArtifactCount: oracle.deliveryArtifactIds.length,
    }
  if (oracle.kind === "s25_assignment_release")
    return {
      kind: oracle.kind,
      identityPreserved:
        oracle.identityBeforeSha256 === oracle.identityAfterSha256,
      released: oracle.released,
    }
  if (oracle.kind === "s26_company_pool_reuse")
    return {
      kind: oracle.kind,
      candidateCountBeforeSecond: oracle.candidateCountBeforeSecond,
      candidateCountAfterSecond: oracle.candidateCountAfterSecond,
      secondSelectionSource: oracle.secondSelectionSource,
    }
  return {
    kind: oracle.kind,
    scenarioId: oracle.scenarioId,
    receiptCount: oracle.receiptIds.length,
    mutationCount: oracle.mutationIds.length,
    duplicateSideEffects: oracle.duplicateSideEffects,
    exactlyOnce: oracle.exactlyOnce,
    processSeparated:
      !oracle.crashedPids.some((pid) => oracle.recoveryPids.includes(pid)),
  }
}

export function b5CanonicalNormalizedResultSha256(
  raw: B5CanonicalNormalizedResultInput,
) {
  const input = B5CanonicalNormalizedResultInput.parse(raw)
  const byRun = new Map(
    input.scenarioReports.map((report) => [
      `${report.binding.scenarioId}:${report.binding.strategy}`,
      report,
    ]),
  )
  return b5NormalizedResultSha256({
    runs: B5ScenarioIds.flatMap((scenarioId) =>
      B5StrategyOrder.map((strategy) => {
        const report = byRun.get(`${scenarioId}:${strategy}`)!
        return {
          scenarioId,
          strategy,
          projectStatus: report.projectStatus,
          terminalDecision: report.terminalDecision,
          oracle: canonicalOracle(report.oracle),
          terminal: report.terminal,
          reviewer: report.reviewer
            ? {
                independent: report.reviewer.independent,
                rejected: report.reviewer.rejected,
              }
            : null,
          deliveryPresent: Boolean(report.delivery),
          validationStatus: report.validationGate?.status ?? null,
          approvalStatus: report.approvalGate?.status ?? null,
          attention: report.attention
            ? {
                material: report.attention.material,
                interruptsUser: report.attention.interrupts_user,
              }
            : null,
          quiescence: report.quiescence
            ? {
                status: report.quiescence.status,
                ready: report.quiescence.ready,
                blockerCodes: [...report.quiescence.blocker_codes].sort(),
              }
            : null,
          recovery: report.recovery
            ? {
                scenarioId: report.recovery.scenarioId,
                duplicateSideEffects: report.recovery.duplicateSideEffects,
                exactlyOnce: report.recovery.exactlyOnce,
              }
            : null,
        }
      }),
    ),
    metrics: [...input.metricReport.results]
      .sort((left, right) => left.metricId.localeCompare(right.metricId))
      .map((result) => ({
        metricId: result.metricId,
        blocking: result.blocking,
        status: result.status,
        value: result.value,
        numerator: result.numerator,
        denominator: result.denominator,
        sampleSize: result.sampleSize,
        meetsThreshold: result.meetsThreshold,
        threshold: result.threshold,
        blockedReasons: [...result.blockedReasons].sort(),
      })),
    shadow: {
      status: input.shadowReport.status,
      deltas: input.shadowReport.deltas,
      checks: [...input.shadowReport.checks]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((check) => ({
          id: check.id,
          field: check.field,
          operator: check.operator,
          target: check.target,
          blocking: check.blocking,
          status: check.status,
          value: check.value,
        })),
    },
    rollback: [...input.rollbackObservations]
      .sort((left, right) => left.target.localeCompare(right.target))
      .map((observation) => ({
        target: observation.target,
        outcome: observation.outcome,
        before: observation.before,
        after: observation.after,
        inFlightStatus: observation.inFlightProject.status,
        inFlightStrategyBefore: observation.inFlightProject.strategyBefore,
        inFlightStrategyAfter: observation.inFlightProject.strategyAfter,
        businessStatePreserved:
          observation.inFlightProject.businessStateSha256Before ===
          observation.inFlightProject.businessStateSha256After,
        dispatch: {
          status: observation.dispatch.result.status,
          barrier: observation.dispatch.result.barrier,
          eligibleCount:
            observation.dispatch.result.eligible_work_item_ids.length,
          dispatchedCount:
            observation.dispatch.result.dispatched_work_item_ids.length,
        },
        newProjectStrategy: observation.businessRows.newProjectStrategy,
        resolvedNewProjectStrategy: observation.resolvedNewProjectStrategy,
        resolvedExplicitFallbackStrategy:
          observation.resolvedExplicitFallbackStrategy,
      })),
  })
}

async function writeJSON(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true })
  const source = `${JSON.stringify(value, null, 2)}\n`
  await Bun.write(target, source)
  return {
    path: target,
    sha256: sha256(source),
    byteLength: new TextEncoder().encode(source).byteLength,
  }
}

async function relativeFile(rootDirectory: string, target: string) {
  const source = new Uint8Array(await Bun.file(target).arrayBuffer())
  return RelativeFile.parse({
    relativePath: path.relative(rootDirectory, target),
    sha256: sha256(source),
    byteLength: source.byteLength,
    mediaType: "application/json",
  })
}

async function stateEntries(
  rootDirectory: string,
  target = rootDirectory,
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): Promise<{ path: string; sha256: string; byteLength: number }[]> {
  const relative = path.relative(rootDirectory, target) || "."
  if (excludedRelativePaths.has(relative)) return []
  const info = await lstat(target).catch(() => null)
  if (!info) return []
  if (info.isSymbolicLink()) throw new Error(`B5 state target cannot be a symbolic link: ${target}`)
  if (info.isFile()) {
    const source = new Uint8Array(await Bun.file(target).arrayBuffer())
    return [{ path: relative, sha256: sha256(source), byteLength: source.byteLength }]
  }
  if (!info.isDirectory()) throw new Error(`B5 state target must be a regular file or directory: ${target}`)
  const children = (await readdir(target)).sort()
  if (!children.length) return [{ path: `${relative}/`, sha256: sha256(""), byteLength: 0 }]
  return (
    await Promise.all(
      children.map((child) =>
        stateEntries(rootDirectory, path.join(target, child), excludedRelativePaths),
      ),
    )
  ).flat()
}

async function stateSha256(target: string, excludedRelativePaths: ReadonlySet<string> = new Set()) {
  return valueSha256(await stateEntries(target, target, excludedRelativePaths))
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${valueSha256(value).slice(0, 26)}`
}

function rolloutStatus(value: {
  state: { phase: string }
  executionMode: "off" | "shadow" | "active"
  newProjectPolicy: {
    defaultStrategy: "legacy_full_plan" | "seed_and_grow"
    seedOptInAllowed: boolean
    explicitLegacyFallbackAllowed: boolean
  }
}) {
  if (value.state.phase !== "dogfood_default")
    throw new Error(`B5 rollback requires dogfood_default, received ${value.state.phase}`)
  if (value.executionMode === "shadow")
    throw new Error("B5 rollback cannot run in shadow execution mode")
  return {
    phase: value.state.phase,
    executionMode: value.executionMode,
    newProjectPolicy: value.newProjectPolicy,
  } as const
}

const reportClass = {
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

type ScenarioRecord = {
  result: B5ScenarioRunResult
  report: {
    path: string
    sha256: string
    byteLength: number
  }
  probe: {
    runId: string
    commandId: string
    stdoutSha256: string
    stderrSha256: string
  }
  delivery?: {
    id: string
    sha256: string
  }
  validationGate?: {
    id: string
    status: "pending" | "running" | "passed" | "failed" | "superseded"
  }
  approvalGate?: {
    id: string
    status: "pending" | "approved" | "rejected"
  }
  attention?: {
    id: string
    material: boolean
    interrupts_user: boolean
  }
  reviewer?: {
    workItemId: string
    assignmentId: string
    runId: string
    independent: boolean
    rejected: boolean
  }
  terminal: {
    passed: boolean
    falseCompletion: boolean
    pendingWorkItemCount: number
    pendingReceiptCount: number
    pendingMutationCount: number
    pendingGateCount: number
  }
  quiescenceBlockers: { kind: string; id: string }[]
  recovery?: B5CandidateRecoveryResult
}

export async function produceB5CandidateFacts(input: B5ProducerArguments) {
  const prepared = await prepareB5CandidateAttempt(input)
  const startedAt = Date.now()
  process.env.AGENTCOMPANY_DB = prepared.paths.databasePath
  process.env.AGENTCOMPANY_HOME = prepared.paths.runtimeHome
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
  process.env.AGENTCOMPANY_DISABLE_MODELS_FETCH = "true"
  const Database = await import("../src/storage")
  const ProjectInstance = await import("../src/project/instance")
  const [
    AgentRun,
    CompanyAgent,
    CompanyProjectExecution,
    CompanyProject,
    CompanyWorkFacts,
    CompanyRecruitment,
    CompanyGraphMutation,
    CompanyValidationGate,
    CompanyAttention,
    GraphSupervisor,
    CapabilityMaterializer,
    DispatchCoordinator,
    QuiescenceService,
    GateObservation,
    CompanyRollout,
    PersistedFactExporter,
    PersistedFactArtifactReader,
    SeedGrowMetricReporter,
    ProjectTables,
    RecruitmentTables,
    scenarioModule,
  ] = await Promise.all([
    import("../src/agent-run/agent-run"),
    import("../src/company-agent/company-agent"),
    import("../src/company-project/execution"),
    import("../src/company-project/company-project"),
    import("../src/company-project/work-facts"),
    import("../src/company-recruitment/company-recruitment"),
    import("../src/company-project/graph-mutation"),
    import("../src/company-project/validation-gate"),
    import("../src/company-project/attention"),
    import("../src/project-orchestrator/graph-supervisor"),
    import("../src/project-orchestrator/capability-materializer"),
    import("../src/project-orchestrator/dispatch"),
    import("../src/project-orchestrator/quiescence"),
    import("../src/metrics/gate-observation"),
    import("../src/company-rollout/company-rollout"),
    import("../src/metrics/persisted-fact-exporter"),
    import("../src/metrics/persisted-fact-artifact"),
    import("../src/metrics/seed-grow-reporter"),
    import("../src/company-project/company-project.sql"),
    import("../src/company-recruitment/company-recruitment.sql"),
    import("../src/metrics/b5-candidate-scenarios"),
  ])
  await import("../src/server/projectors").then((module) => module.initProjectors())
  const providerId = process.env.B5_PROVIDER_ID
  const modelId = process.env.B5_MODEL_ID
  if (Boolean(providerId) !== Boolean(modelId))
    throw new Error("B5_PROVIDER_ID and B5_MODEL_ID must be provided together")
  const layer = Layer.mergeAll(
    AgentRun.defaultLayer,
    CompanyAgent.defaultLayer,
    CompanyProjectExecution.defaultLayer,
    CompanyProject.defaultLayer,
    CompanyRecruitment.defaultLayer,
    CompanyGraphMutation.defaultLayer,
    GraphSupervisor.defaultLayer,
    CapabilityMaterializer.defaultLayer,
    CompanyValidationGate.defaultLayer,
    CompanyAttention.defaultLayer,
    DispatchCoordinator.defaultLayer,
    QuiescenceService.defaultLayer,
    GateObservation.defaultLayer,
  )
  const run = await ProjectInstance.Instance.provide({
    directory: prepared.paths.worktree,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
      const agentRuns = yield* AgentRun.Service
      const agents = yield* CompanyAgent.Service
      const execution = yield* CompanyProjectExecution.Service
      const projects = yield* CompanyProject.Service
      const recruitment = yield* CompanyRecruitment.Service
      const graph = yield* CompanyGraphMutation.Service
      const supervisor = yield* GraphSupervisor.Service
      const shadowSupervisor = yield* Effect.gen(function* () {
        return yield* GraphSupervisor.Service
      }).pipe(
        Effect.provide(
          GraphSupervisor.makeLayer({ mode: "shadow" }).pipe(
            Layer.provide(CompanyProject.defaultLayer),
            Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
            Layer.provide(CompanyGraphMutation.defaultLayer),
          ),
        ),
      )
      const concurrentSupervisor = yield* Effect.gen(function* () {
        return yield* GraphSupervisor.Service
      }).pipe(
        Effect.provide(
          GraphSupervisor.makeLayer().pipe(
            Layer.provide(CompanyProject.defaultLayer),
            Layer.provide(CompanyWorkFacts.makeLayer({ recoverOnStart: false })),
            Layer.provide(CompanyGraphMutation.defaultLayer),
          ),
        ),
      )
      const capabilityMaterializer = yield* CapabilityMaterializer.Service
      const validation = yield* CompanyValidationGate.Service
      const attention = yield* CompanyAttention.Service
      const dispatch = yield* DispatchCoordinator.Service
      const quiescence = yield* QuiescenceService.Service
      const observations = yield* GateObservation.Service
      const runtime = {
        agentRuns,
        agents,
        execution,
        projects,
        recruitment,
        graph,
        supervisor,
        shadowSupervisor,
        concurrentSupervisor,
        capabilityMaterializer,
        validation,
        attention,
        dispatch,
        quiescence,
      }
      for (const phase of ["shadow", "opt_in", "dogfood_default"] as const)
        CompanyRollout.transition({
          idempotencyKey: `b5-${prepared.arguments.attemptId}-${prepared.attemptIsolationId}-${phase}`,
          to: phase,
          reason: `B5 isolated candidate automation entered ${phase}`,
          actorId: "b5-candidate-producer",
        })
      CompanyRollout.recordAction({
        kind: "register_candidate",
        idempotencyKey: `b5-${prepared.arguments.attemptId}-${prepared.attemptIsolationId}-candidate`,
        candidate: {
          id: stableId(
            "rolloutCandidate",
            `${prepared.git.headSha}:${prepared.arguments.attemptId}:${prepared.attemptIsolationId}`,
          ),
          candidateSha: prepared.git.headSha,
          targetRef: "refs/heads/main",
        },
      })

      const rollbackProbe = Effect.fn("B5CandidateProducer.rollbackProbe")(function* (
        target: "kill_switch" | "legacy_fallback",
      ) {
        process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
        const before = rolloutStatus(CompanyRollout.status())
        const existing = yield* projects.create({
          goal: `Observe ${target} without changing in-flight business facts`,
          title: `B5 ${target} in-flight rollback probe`,
          execution_strategy: "seed_and_grow",
          seed_mode: "direct_single",
        })
        yield* projects.transition({ id: existing.id, status: "planning" })
        yield* projects.transition({ id: existing.id, status: "executing" })
        const existingBefore = (yield* projects.get(existing.id))!
        const businessStateSha256Before = CompanyRollout.projectBusinessStateSha256(existing.id)
        const businessRowsBefore = CompanyRollout.valueSha256({
          id: existingBefore.id,
          status: existingBefore.status,
          strategy: existingBefore.execution_strategy,
        })
        if (target === "kill_switch")
          process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
        const dispatchResult = yield* dispatch.dispatchReady(existing.id)
        const observedAt = Date.now()
        const after = rolloutStatus(CompanyRollout.status())
        const resolvedNewProjectStrategy = CompanyRollout.resolveNewProjectStrategy(
          target === "legacy_fallback" ? "legacy_full_plan" : undefined,
        )
        const resolvedExplicitFallbackStrategy =
          CompanyRollout.resolveNewProjectStrategy("legacy_full_plan")
        const created = yield* projects.create({
          goal: `Verify ${target} strategy resolution`,
          title: `B5 ${target} post-action project`,
          execution_strategy: resolvedNewProjectStrategy,
          ...(resolvedNewProjectStrategy === "seed_and_grow"
            ? { seed_mode: "direct_single" as const }
            : {}),
        })
        const existingAfter = (yield* projects.get(existing.id))!
        const createdAfter = (yield* projects.get(created.id))!
        const businessStateSha256After = CompanyRollout.projectBusinessStateSha256(existing.id)
        const result = B5RollbackObservation.parse({
          schemaVersion: 1,
          kind: "seed-grow-b5-rollback-observation",
          candidateSha: prepared.git.headSha,
          attemptId: prepared.arguments.attemptId,
          attemptIsolationId: prepared.attemptIsolationId,
          target,
          outcome: "completed",
          phaseAtAction: "dogfood_default",
          before,
          after,
          inFlightProject: {
            id: existing.id,
            status: existingBefore.status,
            strategyBefore: existingBefore.execution_strategy,
            strategyAfter: existingAfter.execution_strategy,
            businessStateSha256Before,
            businessStateSha256After,
          },
          process: {
            pid: process.pid,
            producerPath,
            producerSha256: prepared.git.producerSha256,
            startedAt,
          },
          dispatch: {
            coordinator: "DispatchCoordinator",
            action: target,
            projectId: existing.id,
            result: dispatchResult,
            resultSha256: CompanyRollout.valueSha256(dispatchResult),
            observedAt,
          },
          businessRows: {
            beforeSha256: businessRowsBefore,
            afterSha256: CompanyRollout.valueSha256({
              existing: {
                id: existingAfter.id,
                status: existingAfter.status,
                strategy: existingAfter.execution_strategy,
              },
              created: {
                id: createdAfter.id,
                status: createdAfter.status,
                strategy: createdAfter.execution_strategy,
              },
            }),
            newProjectId: createdAfter.id,
            newProjectStrategy: createdAfter.execution_strategy,
            existingProjectId: existingAfter.id,
            existingProjectStrategyBefore: existingBefore.execution_strategy,
            existingProjectStrategyAfter: existingAfter.execution_strategy,
          },
          resolvedNewProjectStrategy,
          resolvedExplicitFallbackStrategy,
          isolation: {
            database: "fresh_local_sqlite",
            databasePathSha256: environmentPathDigest(prepared.paths.databasePath),
            productionDatabaseInherited: false,
            productionProcessUsed: false,
            networkPortsUsed: [],
          },
          observedAt,
        })
        yield* projects.transition({
          id: existing.id,
          status: "blocked",
          reason: `B5 ${target} rollback probe sealed`,
        })
        yield* projects.transition({
          id: created.id,
          status: "blocked",
          reason: `B5 ${target} strategy probe sealed`,
        })
        process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
        return result
      })
      const rollbackKillSwitch = yield* rollbackProbe("kill_switch")
      const rollbackLegacyFallback = yield* rollbackProbe("legacy_fallback")
      yield* Effect.promise(() =>
        Promise.all([
          writeJSON(prepared.paths.rollbackKillSwitch, rollbackKillSwitch),
          writeJSON(prepared.paths.rollbackLegacyFallback, rollbackLegacyFallback),
        ]),
      )

      const records: ScenarioRecord[] = []
      const recordByKey = new Map<string, ScenarioRecord>()
      for (const snapshot of prepared.snapshots) {
        for (const strategy of B5StrategyOrder) {
          const runId = b5AttemptRunId({
            attemptId: prepared.arguments.attemptId,
            attemptIsolationId: prepared.attemptIsolationId,
            scenarioId: snapshot.scenario.id,
            strategy,
            candidateSha: prepared.git.headSha,
          })
          const recoveryOutputDirectory = path.join(
            prepared.paths.isolationRoot,
            "recovery",
            `${snapshot.scenario.id}-${strategy}`,
          )
          const driven = yield* scenarioModule.runB5Scenario(
            {
              snapshot,
              strategy,
              runId,
              ...(providerId && modelId ? { providerId, modelId } : {}),
              candidateSha: prepared.git.headSha,
              databasePath: prepared.paths.databasePath,
              runtimeHomePath: prepared.paths.runtimeHome,
              worktreePath: prepared.paths.worktree,
              recoveryOutputDirectory,
            },
            runtime,
          )
          const result = scenarioModule.B5ScenarioRunResult.parse({
            ...driven,
            binding: {
              ...driven.binding,
              runId,
            },
          })
          yield* projects.recordEvent({
            project_id: result.binding.projectId,
            type: "local_gate.run_bound",
            actor_id: "b5-candidate-producer",
            data: {
              candidateSha: prepared.git.headSha,
              projectId: result.binding.projectId,
              runId,
              scenarioId: result.binding.scenarioId,
              strategy: result.binding.strategy,
              snapshotDigest: result.binding.snapshotDigest,
            },
          })
          const reviewer =
            result.oracle.kind === "s18_risk_reviewer"
              ? {
                  workItemId: result.oracle.reviewerWorkItemId,
                  assignmentId: result.oracle.reviewerAssignmentId,
                  runId: result.oracle.reviewerAgentRunId,
                  independent: result.oracle.independent,
                  rejected: result.oracle.rejected,
                }
              : undefined
          const items = yield* projects.listWorkItems(result.binding.projectId)
          const s18Oracle =
            result.oracle.kind === "s18_risk_reviewer" ? result.oracle : undefined
          const probeItem =
            s18Oracle
              ? items.find((item) => item.id === s18Oracle.workerWorkItemId)
              : items.find((item) => item.kind !== "reviewer")
          if (!probeItem) throw new Error(`${snapshot.scenario.id} has no command probe WorkItem`)
          const probe = yield* scenarioModule.runB5LocalProbe(
            {
              snapshot,
              strategy,
              runId,
              candidateSha: prepared.git.headSha,
              databasePath: prepared.paths.databasePath,
              runtimeHomePath: prepared.paths.runtimeHome,
              worktreePath: prepared.paths.worktree,
            },
            runtime,
            result.binding.projectId,
            probeItem.id,
            probeItem.owner_agent_id ?? stableId("agent", `${runId}:probe`),
          )
          const deliveryRequired = requiredB5ObservationTypes(
            snapshot.scenario.id,
            strategy,
          ).includes("delivery.checked")
          const referencedArtifactIds = new Set(
            result.sourceRefs
              .filter((reference) => reference.kind === "artifact")
              .map((reference) => reference.id),
          )
          const gates = yield* validation.list(result.binding.projectId)
          const deliveryMatch = deliveryRequired
            ? gates
                .filter((candidate) => candidate.status === "passed")
                .flatMap((candidate) =>
                  candidate.criteria
                    .filter((criterion) =>
                      snapshot.scenario.acceptanceCriteria.some(
                        (expected) => expected.statement === criterion.statement,
                      ),
                    )
                    .flatMap((criterion) =>
                      candidate.evidence_refs
                        .filter(
                          (reference) =>
                            reference.kind === "artifact" &&
                            referencedArtifactIds.has(reference.id),
                        )
                        .map((reference) => ({
                          artifactId: reference.id,
                          criterion,
                          gate: candidate,
                        })),
                    ),
                )
                .at(-1)
            : undefined
          const delivery = deliveryMatch
            ? (yield* projects.listArtifacts(result.binding.projectId)).find(
                (artifact) => artifact.id === deliveryMatch.artifactId,
              )
            : undefined
          const deliveryBytes = delivery
            ? yield* Effect.promise(() =>
                delivery.path
                  ? Bun.file(delivery.path).arrayBuffer().then((value) => new Uint8Array(value))
                  : Promise.resolve(new TextEncoder().encode(delivery.content ?? "")),
              )
            : undefined
          const deliveryBinding = delivery && deliveryBytes?.length
            ? {
                id: delivery.id,
                sha256: sha256(deliveryBytes),
              }
            : undefined
          const approvalGate =
            snapshot.scenario.id === "S15" && strategy === "seed_and_grow"
              ? (yield* projects.listGates(result.binding.projectId)).find(
                  (gate) => gate.kind === "risk_approval",
                )
              : undefined
          const validationRequired = requiredB5ObservationTypes(
            snapshot.scenario.id,
            strategy,
          ).includes("validation_anchor.checked")
          const gate = validationRequired
            ? snapshot.scenario.id === "S18"
              ? gates.find(
                  (candidate) =>
                    candidate.status === "passed" &&
                    candidate.criteria.some(
                      (criterion) => criterion.id === "s18-low-risk-quality",
                    ) &&
                    items.some(
                      (item) =>
                        item.id === candidate.work_item_id &&
                        item.risk_level === "low" &&
                        item.review_status === "not_required",
                    ),
                )
              : gates.findLast((candidate) => candidate.status === "passed")
            : undefined
          const deliveryCriterion = deliveryBinding ? deliveryMatch?.criterion : undefined
          const deliveryGate = deliveryBinding ? deliveryMatch?.gate : undefined
          if (
            deliveryRequired &&
            (!deliveryBinding || !deliveryCriterion || !deliveryGate)
          )
            throw new Error(
              `${snapshot.scenario.id} ${strategy} has no runtime delivery bound to a passed acceptance Gate`,
            )
          if (validationRequired && !gate)
            throw new Error(
              `${snapshot.scenario.id} ${strategy} has no runtime ValidationGate anchor`,
            )
          const interruptionRequired = requiredB5ObservationTypes(
            snapshot.scenario.id,
            strategy,
          ).includes("interruption.checked")
          const scenarioAttention =
            !interruptionRequired
              ? undefined
              : snapshot.scenario.id === "S15"
                ? (
                    yield* attention.create({
                      project_id: result.binding.projectId,
                      idempotency_key: `b5-s15-external-attention-${runId}`,
                      issue: {
                        issue_kind: "external_side_effect",
                        risk: "high",
                        materiality: "external_side_effect",
                      },
                      title: "S15 external side effect requires approval",
                      summary: "Dispatch remains paused until the explicit external-side-effect approval is resolved",
                      required_decision: "Approve or reject the external side effect",
                      source_refs: [{ kind: "approval_gate", id: approvalGate!.id }],
                    })
                  ).record
                : snapshot.scenario.id === "S22"
                  ? (yield* attention.list({ project_id: result.binding.projectId })).find(
                      (candidate) => candidate.material && candidate.interrupts_user,
                    )
                  : undefined
          const quiescenceResult =
            snapshot.scenario.id === "S24" && strategy === "seed_and_grow"
              ? yield* quiescence.check(result.binding.projectId)
              : undefined
          if (quiescenceResult && (quiescenceResult.status !== "blocked" || quiescenceResult.ready))
            throw new Error("S24 did not remain blocked by real Quiescence facts")
          const recovery = ["S19", "S20", "S27"].includes(snapshot.scenario.id) &&
              strategy === "seed_and_grow"
            ? yield* Effect.promise(async () => {
                const files = (await readdir(recoveryOutputDirectory)).filter((file) =>
                  file.endsWith(".json"),
                )
                if (files.length !== 1)
                  throw new Error(`${snapshot.scenario.id} recovery emitted ${files.length} reports`)
                const reportPath = path.join(recoveryOutputDirectory, files[0]!)
                const source = new Uint8Array(await Bun.file(reportPath).arrayBuffer())
                return B5CandidateRecoveryResult.parse({
                  ...(JSON.parse(new TextDecoder().decode(source)) as Record<string, unknown>),
                  report: {
                    path: reportPath,
                    sha256: sha256(source),
                  },
                })
              })
            : undefined
          const terminal = yield* Effect.sync(() =>
            Database.Database.use((database) => {
              const project = database
                .select()
                .from(ProjectTables.CompanyProjectTable)
                .where(Database.eq(ProjectTables.CompanyProjectTable.id, result.binding.projectId))
                .get()!
              const pendingWorkItemCount = database
                .select()
                .from(ProjectTables.CompanyWorkItemTable)
                .where(Database.eq(ProjectTables.CompanyWorkItemTable.project_id, result.binding.projectId))
                .all()
                .filter((item) => !["completed", "superseded", "cancelled"].includes(item.status)).length
              const pendingReceiptCount = database
                .select()
                .from(ProjectTables.CompanyWorkReceiptTable)
                .where(Database.eq(ProjectTables.CompanyWorkReceiptTable.project_id, result.binding.projectId))
                .all()
                .filter((item) => item.processing_status !== "processed").length
              const pendingMutationCount = database
                .select()
                .from(ProjectTables.CompanyGraphMutationTable)
                .where(Database.eq(ProjectTables.CompanyGraphMutationTable.project_id, result.binding.projectId))
                .all()
                .filter((item) => !["applied", "rejected", "superseded"].includes(item.status)).length
              const pendingGateCount =
                database
                  .select()
                  .from(ProjectTables.CompanyValidationGateTable)
                  .where(Database.eq(ProjectTables.CompanyValidationGateTable.project_id, result.binding.projectId))
                  .all()
                  .filter((item) => ["pending", "running"].includes(item.status)).length +
                database
                  .select()
                  .from(ProjectTables.CompanyApprovalGateTable)
                  .where(Database.eq(ProjectTables.CompanyApprovalGateTable.project_id, result.binding.projectId))
                  .all()
                  .filter((item) => item.status === "pending").length
              const falseCompletion =
                project.status === "completed" &&
                pendingWorkItemCount +
                  pendingReceiptCount +
                  pendingMutationCount +
                  pendingGateCount >
                  0
              return {
                passed: !falseCompletion,
                falseCompletion,
                pendingWorkItemCount,
                pendingReceiptCount,
                pendingMutationCount,
                pendingGateCount,
              }
            }),
          )
          const quiescenceBlockers =
            snapshot.scenario.id === "S24" && strategy === "seed_and_grow"
              ? yield* Effect.sync(() =>
                  Database.Database.use((database) =>
                    [
                      ...database
                        .select()
                        .from(ProjectTables.CompanyWorkItemTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyWorkItemTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter(
                          (item) =>
                            !["completed", "superseded", "cancelled"].includes(item.status),
                        )
                        .map((item) => ({ kind: "work_item", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyWorkAttemptTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyWorkAttemptTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => item.status === "running")
                        .map((item) => ({ kind: "work_attempt", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyWorkReceiptTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyWorkReceiptTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => item.processing_status !== "processed")
                        .map((item) => ({ kind: "work_receipt", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyGraphMutationTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyGraphMutationTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => ["proposed", "validated"].includes(item.status))
                        .map((item) => ({ kind: "graph_mutation", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyValidationGateTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyValidationGateTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => ["pending", "running", "failed"].includes(item.status))
                        .map((item) => ({ kind: "validation_gate", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyApprovalGateTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyApprovalGateTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => item.status === "pending")
                        .map((item) => ({ kind: "approval_gate", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyAttentionTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyAttentionTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter(
                          (item) =>
                            item.status === "open" && item.material,
                        )
                        .map((item) => ({ kind: "attention", id: item.id })),
                      ...database
                        .select()
                        .from(ProjectTables.CompanyProjectActionTable)
                        .where(
                          Database.eq(
                            ProjectTables.CompanyProjectActionTable.project_id,
                            result.binding.projectId,
                          ),
                        )
                        .all()
                        .filter((item) => item.status === "claimed")
                        .map((item) => ({ kind: "project_action", id: item.id })),
                    ].sort((left, right) =>
                      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
                    ),
                  ),
                )
              : []
          const reportPath = path.join(
            prepared.paths.observationReports,
            `${snapshot.scenario.id}-${strategy}.json`,
          )
          const currentProject = (yield* projects.get(result.binding.projectId))!
          const observationReport = B5ScenarioObservationReport.parse({
            schemaVersion: 1,
            kind: "seed-grow-b5-scenario-observation",
            candidateSha: prepared.git.headSha,
            attemptId: prepared.arguments.attemptId,
            attemptIsolationId: prepared.attemptIsolationId,
            result,
            binding: result.binding,
            projectStatus: currentProject.status,
            terminalDecision: result.terminalDecision,
            oracle: result.oracle,
            sourceRefs: result.sourceRefs,
            probe,
            reviewer,
            delivery: deliveryBinding,
            validationGate: gate
              ? { id: gate.id, status: gate.status }
              : undefined,
            approvalGate: approvalGate
              ? { id: approvalGate.id, status: approvalGate.status }
              : undefined,
            attention: scenarioAttention
              ? {
                  id: scenarioAttention.id,
                  material: scenarioAttention.material,
                  interrupts_user: scenarioAttention.interrupts_user,
                }
              : undefined,
            terminal,
            quiescence: quiescenceResult,
            quiescenceBlockers,
            recovery,
          })
          const report = yield* Effect.promise(() =>
            writeJSON(reportPath, observationReport),
          )
          const record: ScenarioRecord = {
            result,
            report,
            probe,
            delivery: deliveryBinding,
            validationGate: gate,
            approvalGate,
            attention: scenarioAttention,
            reviewer,
            terminal,
            quiescenceBlockers,
            recovery,
          }
          records.push(record)
          recordByKey.set(`${snapshot.scenario.id}:${strategy}`, record)
          const legacy = recordByKey.get(`${snapshot.scenario.id}:legacy_full_plan`)
          const external = { kind: "external_report" as const, id: report.path }
          for (const eventType of requiredB5ObservationTypes(
            snapshot.scenario.id,
            strategy,
          )) {
            const checkedEventType =
              GateObservation.GateObservationEventType.parse(eventType)
            const paired = ["quality_pair.checked", "shadow_pair.checked"].includes(eventType)
              ? legacy
              : undefined
            if (paired && strategy !== "seed_and_grow")
              throw new Error(`${eventType} cannot bind a legacy run`)
            const baseRefs = [{ kind: "project" as const, id: result.binding.projectId }]
            const observation =
              eventType === "scenario.fixture_checked"
                ? {
                    properties: {
                      scenarioId: snapshot.scenario.id,
                      snapshotSha256: snapshot.snapshotDigest,
                    },
                    sourceRefs: [external],
                  }
                : eventType === "command.probe_checked"
                  ? {
                      properties: {
                        agentRunId: probe.runId,
                        commandId: probe.commandId,
                        exitCode: 0,
                        stdoutSha256: probe.stdoutSha256,
                        stderrSha256: probe.stderrSha256,
                      },
                      sourceRefs: [
                        { kind: "agent_run" as const, id: probe.runId },
                        external,
                      ],
                    }
                  : eventType === "git.blob_checked"
                    ? {
                        properties: {
                          path: producerPath,
                          candidateBlobSha256: prepared.git.producerSha256,
                          runtimeSha256: prepared.git.producerSha256,
                        },
                        sourceRefs: [external],
                      }
                    : eventType === "report.file_checked"
                      ? {
                          properties: {
                            reportClass: "fact_report",
                            path: report.path,
                            sha256: report.sha256,
                          },
                          sourceRefs: [external],
                        }
                      : eventType === "terminal.invariant_checked"
                        ? {
                            properties: {
                              ...terminal,
                              invariantReportSha256: report.sha256,
                            },
                            sourceRefs: [...baseRefs, external],
                          }
                        : eventType === "benchmark.checked"
                          ? {
                              properties: {
                                terminalDecision: result.terminalDecision,
                                oracleKind: result.oracle.kind,
                              },
                              sourceRefs: [...baseRefs, external],
                            }
                          : eventType === "model.usage_checked"
                            ? {
                                properties: {
                                  agentRunId: probe.runId,
                                  purpose:
                                    probeItem.purpose === "discovery"
                                      ? "wayfinder"
                                      : probeItem.purpose === "first_slice"
                                        ? "builder"
                                        : "worker",
                                },
                                sourceRefs: [
                                  { kind: "agent_run" as const, id: probe.runId },
                                  external,
                                ],
                              }
                            : eventType === "delivery.checked"
                              ? {
                                  properties: {
                                    deliveryId: `delivery:${result.binding.projectId}`,
                                    artifactId: deliveryBinding!.id,
                                    artifactSha256: deliveryBinding!.sha256,
                                    validationGateId: deliveryGate!.id,
                                    criterionId: deliveryCriterion!.id,
                                    criterionStatus:
                                      deliveryGate!.status === "passed"
                                        ? "pass"
                                        : "fail",
                                    risk:
                                      snapshot.scenario.id === "S14"
                                        ? "low"
                                        : snapshot.scenario.id === "S18"
                                          ? "high"
                                          : "medium",
                                    opened: true,
                                  },
                                  sourceRefs: [
                                    { kind: "artifact" as const, id: deliveryBinding!.id },
                                    {
                                      kind: "validation_gate" as const,
                                      id: deliveryGate!.id,
                                    },
                                    external,
                                  ],
                                }
                              : eventType === "receipt.recovery_checked"
                                ? {
                                    properties: {
                                      lostAt: result.oracle.kind === "b5_process_recovery"
                                        ? result.oracle.lostAt
                                        : 0,
                                      recoveredAt: result.oracle.kind === "b5_process_recovery"
                                        ? result.oracle.recoveredAt
                                        : 1,
                                      duplicate: false,
                                      consistent: true,
                                    },
                                    sourceRefs: [
                                      result.sourceRefs.find(
                                        (reference) => reference.kind === "work_receipt",
                                      )!,
                                      external,
                                    ],
                                  }
                                : eventType === "graph_mutation.recovery_checked"
                                  ? {
                                      properties: {
                                        lostAt: result.oracle.kind === "b5_process_recovery"
                                          ? result.oracle.lostAt
                                          : 0,
                                        recoveredAt: result.oracle.kind === "b5_process_recovery"
                                          ? result.oracle.recoveredAt
                                          : 1,
                                        consistent: true,
                                        duplicateSideEffects: 0,
                                      },
                                      sourceRefs: [
                                        result.sourceRefs.find(
                                          (reference) => reference.kind === "graph_mutation",
                                        )!,
                                        external,
                                      ],
                                    }
                                  : eventType === "validation_anchor.checked"
                                    ? {
                                        properties: {
                                          gateId: gate!.id,
                                          passed: gate!.status === "passed",
                                          anchorPassed: gate!.status === "passed",
                                        },
                                        sourceRefs: [
                                          { kind: "validation_gate" as const, id: gate!.id },
                                          ...gate!.evidence_refs,
                                          external,
                                        ],
                                      }
                                    : eventType === "approval_gate.checked"
                                      ? {
                                          properties: {
                                            gateId: approvalGate!.id,
                                            status: approvalGate!.status,
                                            dispatchPaused: true,
                                            anchorPassed: false,
                                          },
                                          sourceRefs: [
                                            { kind: "approval_gate" as const, id: approvalGate!.id },
                                            external,
                                          ],
                                        }
                                      : eventType === "quiescence.checked"
                                        ? {
                                            properties: {
                                              status: "blocked",
                                              ready: false,
                                              criterionId:
                                                snapshot.scenario.acceptanceCriteria[0]!.id,
                                              criterionStatus: "fail",
                                              risk: "medium",
                                              blockerEntityIds: quiescenceBlockers.map(
                                                (blocker) => blocker.id,
                                              ),
                                            },
                                            sourceRefs: [
                                              ...baseRefs,
                                              ...quiescenceBlockers,
                                              external,
                                            ],
                                          }
                                        : eventType === "interruption.checked"
                                          ? {
                                              properties: {
                                                attentionId: scenarioAttention?.id ?? null,
                                                presented: Boolean(scenarioAttention),
                                                needed: Boolean(scenarioAttention),
                                              },
                                              sourceRefs: [
                                                ...baseRefs,
                                                ...(scenarioAttention
                                                  ? [
                                                      {
                                                        kind: "attention" as const,
                                                        id: scenarioAttention.id,
                                                      },
                                                    ]
                                                  : []),
                                                external,
                                              ],
                                            }
                                          : eventType === "review_presence.checked"
                                            ? {
                                                properties: {
                                                  risk:
                                                    snapshot.scenario.id === "S14"
                                                      ? "low"
                                                      : "high",
                                                  invoked: Boolean(reviewer),
                                                  independent:
                                                    reviewer?.independent ?? false,
                                                  rejected: reviewer?.rejected ?? false,
                                                  findingConfirmed: Boolean(reviewer),
                                                },
                                                sourceRefs: [
                                                  ...baseRefs,
                                                  ...(reviewer
                                                    ? [
                                                        {
                                                          kind: "work_item" as const,
                                                          id: reviewer.workItemId,
                                                        },
                                                        {
                                                          kind: "project_assignment" as const,
                                                          id: reviewer.assignmentId,
                                                        },
                                                        {
                                                          kind: "agent_run" as const,
                                                          id: reviewer.runId,
                                                        },
                                                      ]
                                                    : []),
                                                  external,
                                                ],
                                              }
                                            : eventType === "quality_pair.checked"
                                              ? {
                                                  properties: {
                                                    legacyRunId: paired!.result.binding.runId,
                                                    seedGrowRunId: result.binding.runId,
                                                  },
                                                  sourceRefs: [
                                                    ...baseRefs,
                                                    ...(snapshot.scenario.id === "S14"
                                                      ? [
                                                          {
                                                            kind: "artifact" as const,
                                                            id: deliveryBinding!.id,
                                                          },
                                                          {
                                                            kind: "validation_gate" as const,
                                                            id: deliveryGate!.id,
                                                          },
                                                        ]
                                                      : [
                                                          {
                                                            kind: "validation_gate" as const,
                                                            id: gate!.id,
                                                          },
                                                          ...gate!.evidence_refs,
                                                        ]),
                                                    external,
                                                  ],
                                                }
                                              : eventType === "shadow_pair.checked"
                                                ? {
                                                    properties: {
                                                      legacyRunId: paired!.result.binding.runId,
                                                      seedGrowRunId: result.binding.runId,
                                                    },
                                                    sourceRefs: [...baseRefs, external],
                                                }
                                              : eventType === "repair.circuit_checked"
                                                ? result.oracle.kind ===
                                                  "s22_repair_circuit"
                                                  ? {
                                                      properties: {
                                                        workItemId:
                                                          result.oracle.workItemId,
                                                        attentionId:
                                                          result.oracle.attentionId,
                                                        attemptCount: 3,
                                                      },
                                                      sourceRefs: [
                                                        {
                                                          kind: "attention" as const,
                                                          id: result.oracle.attentionId,
                                                        },
                                                        {
                                                          kind: "validation_gate" as const,
                                                          id: result.oracle.validationGateId,
                                                        },
                                                        external,
                                                      ],
                                                    }
                                                  : undefined
                                                : undefined
            if (!observation)
              throw new Error(
                `No B5 observation producer for ${snapshot.scenario.id}/${strategy}/${eventType}`,
              )
            const sourceRefs =
              GateObservation.GateObservationInput.shape.sourceRefs.parse(
                observation.sourceRefs,
              )
            yield* observations.record({
              id: b5ObservationId(
                prepared.attemptIsolationId,
                runId,
                checkedEventType,
              ),
              projectId: result.binding.projectId,
              ...(paired
                ? { pairedProjectId: paired!.result.binding.projectId }
                : {}),
              candidateSha: prepared.git.headSha,
              scenarioId: snapshot.scenario.id,
              runId,
              subjectId: `${runId}:${eventType}`,
              strategy,
              snapshotSha256: snapshot.snapshotDigest,
              eventType: checkedEventType,
              properties: observation.properties,
              sourceRefs,
              evidence: {
                report: {
                  class: reportClass[checkedEventType],
                  path: report.path,
                  sha256: report.sha256,
                },
              },
              producerPath,
              producerSha256: prepared.git.producerSha256,
            })
          }
        }
      }
      return {
        records,
        rollbackKillSwitch,
        rollbackLegacyFallback,
      }
        }).pipe(Effect.provide(layer)),
      ),
  })
  await rm(path.join(prepared.paths.isolationRoot, "recovery"), {
    recursive: true,
    force: true,
  })
  const metricContract = MetricContract.parse(
    JSON.parse(await Bun.file(path.join(root, metricContractPath)).text()) as unknown,
  )
  const orderedRunBindings = exactB5RunBindings(
    run.records.map((record) => record.result.binding),
  )
  const finishedAt = Date.now()
  const exported = await PersistedFactExporter.exportPersistedFactArtifact({
    id: `b5-facts-${prepared.git.headSha.slice(0, 12)}-${prepared.arguments.attemptId}-${prepared.attemptIsolationId}`,
    candidateSha: prepared.git.headSha,
    metricContract,
    window: {
      id: `b5-window-${prepared.arguments.attemptId}-${prepared.attemptIsolationId}`,
      startedAt: new Date(startedAt - 1_000).toISOString(),
      endedAt: new Date(finishedAt + 1_000).toISOString(),
    },
    runBindings: orderedRunBindings,
    outputPath: prepared.paths.facts,
    evidenceProfile: "b5_real_candidate",
    isolationRoot: prepared.paths.outputDirectory,
  })
  const adapter = await PersistedFactArtifactReader.makePersistedFactArtifactAdapter(
    exported.reference,
  )
  const reports = await Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* SeedGrowMetricReporter.Service
      return {
        metric: yield* reporter.report({
          contract: metricContract,
          candidateSha: prepared.git.headSha,
          metricIds: [...PrePublicScenarioMetricIds],
          strategy: "seed_and_grow",
        }),
        shadow: yield* reporter.compareShadow({
          contract: metricContract,
          candidateSha: prepared.git.headSha,
          comparisonId: `b5-shadow-${prepared.git.headSha.slice(0, 12)}-${prepared.arguments.attemptId}-${prepared.attemptIsolationId}`,
          scenarioIds: [...B5ScenarioIds],
        }),
      }
    }).pipe(Effect.provide(SeedGrowMetricReporter.makeLayer(adapter))),
  )
  await Promise.all([
    writeJSON(prepared.paths.metricReport, reports.metric),
    writeJSON(prepared.paths.shadowReport, reports.shadow),
  ])
  Database.Database.close()
  const metricIds = reports.metric.results.map((result) => result.metricId)
  const deferredMetric = reports.metric.results.find(
    (result) => result.metricId === "complex_initial_assignment_median",
  )
  if (
    reports.metric.status !== "blocked" ||
    metricIds.length !== PrePublicScenarioMetricIds.length ||
    PrePublicScenarioMetricIds.some(
      (metricId) => metricIds.filter((candidate) => candidate === metricId).length !== 1,
    ) ||
    !deferredMetric ||
    deferredMetric.status !== "blocked" ||
    deferredMetric.sampleSize !== 1 ||
    deferredMetric.blockedReasons.length !== 1 ||
    deferredMetric.blockedReasons[0] !== "insufficient_sample" ||
    reports.metric.results.some(
      (result) =>
        result.metricId !== "complex_initial_assignment_median" &&
        result.status !== "pass",
    )
  )
    throw new Error("B5 candidate metric report has an unexpected single-attempt result")
  if (
    reports.shadow.status !== "blocked" ||
    reports.shadow.blockedReasons.length !== 1 ||
    reports.shadow.blockedReasons[0] !== "insufficient_sample" ||
    reports.shadow.scenarioIds.length !== B5ScenarioIds.length ||
    B5ScenarioIds.some(
      (scenarioId) =>
        reports.shadow.scenarioIds.filter((candidate) => candidate === scenarioId)
          .length !== 1,
    ) ||
    reports.shadow.legacyRunIds.length !== B5ScenarioIds.length ||
    reports.shadow.seedAndGrowRunIds.length !== B5ScenarioIds.length ||
    reports.shadow.checks.some((check) => check.status !== "blocked")
  )
    throw new Error("B5 candidate shadow report has an unexpected single-attempt result")
  const strictObservationReports = await Promise.all(
    orderedRunBindings.map(async (binding) =>
      B5ScenarioObservationReport.parse(
        JSON.parse(
          await Bun.file(
            path.join(
              prepared.paths.observationReports,
              `${binding.scenarioId}-${binding.strategy}.json`,
            ),
          ).text(),
        ) as unknown,
      ),
    ),
  )
  const observationReports = await Promise.all(
    orderedRunBindings.map((binding) =>
      relativeFile(
        prepared.paths.outputDirectory,
        path.join(
          prepared.paths.observationReports,
          `${binding.scenarioId}-${binding.strategy}.json`,
        ),
      ),
    ),
  )
  const normalizedResultSha256 = b5CanonicalNormalizedResultSha256({
    scenarioReports: strictObservationReports,
    metricReport: reports.metric,
    shadowReport: reports.shadow,
    rollbackObservations: [run.rollbackKillSwitch, run.rollbackLegacyFallback],
  })
  const outputIsolationSha256 = await stateSha256(
    prepared.paths.outputDirectory,
    new Set(["summary.json"]),
  )
  const summary = B5CandidateAttemptSummary.parse({
    schemaVersion: 1,
    kind: "seed-grow-b5-candidate-attempt",
    candidate: {
      requestedSha: prepared.git.requestedSha,
      headSha: prepared.git.headSha,
      treeSha: prepared.git.treeSha,
      parentSha: prepared.git.parentSha,
    },
    attemptId: prepared.arguments.attemptId,
    attemptIsolationId: prepared.attemptIsolationId,
    producer: {
      path: producerPath,
      sha256: prepared.git.producerSha256,
    },
    environment: {
      worktree: {
        absolutePathSha256: environmentPathDigest(prepared.paths.worktree),
        stateSha256: sha256(prepared.git.treeSha),
      },
      runtimeHome: {
        absolutePathSha256: environmentPathDigest(prepared.paths.runtimeHome),
        stateSha256: await stateSha256(prepared.paths.runtimeHome),
      },
      database: {
        absolutePathSha256: environmentPathDigest(prepared.paths.databasePath),
        stateSha256: await stateSha256(prepared.paths.databasePath),
      },
      output: {
        absolutePathSha256: environmentPathDigest(prepared.paths.outputDirectory),
        stateSha256: outputIsolationSha256,
      },
      isolationRoot: {
        absolutePathSha256: environmentPathDigest(prepared.paths.isolationRoot),
        stateSha256: await stateSha256(prepared.paths.isolationRoot),
      },
      productionDataInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    window: {
      startedAt,
      finishedAt,
    },
    orderedRunBindings,
    files: {
      facts: await relativeFile(prepared.paths.outputDirectory, prepared.paths.facts),
      summary: {
        relativePath: "summary.json",
        mediaType: "application/json",
      },
      metricReport: await relativeFile(
        prepared.paths.outputDirectory,
        prepared.paths.metricReport,
      ),
      shadowReport: await relativeFile(
        prepared.paths.outputDirectory,
        prepared.paths.shadowReport,
      ),
      rollbackKillSwitch: await relativeFile(
        prepared.paths.outputDirectory,
        prepared.paths.rollbackKillSwitch,
      ),
      rollbackLegacyFallback: await relativeFile(
        prepared.paths.outputDirectory,
        prepared.paths.rollbackLegacyFallback,
      ),
      observationReports,
    },
    normalizedResultSha256,
    outputIsolationSha256,
    singleAttemptMetricGate: {
      status: "deferred",
      deferredMetricIds: ["complex_initial_assignment_median"],
      unexpectedMetricIds: [],
    },
    singleAttemptShadowGate: {
      status: "deferred",
      blockedReasons: ["insufficient_sample"],
    },
    attemptStatus: "completed",
    promotionClaimed: false,
  })
  await writeJSON(prepared.paths.summary, summary)
  return summary
}
if (import.meta.main) {
  const input = parseB5ProducerArguments(process.argv.slice(2))
  await produceB5CandidateFacts(input)
}
