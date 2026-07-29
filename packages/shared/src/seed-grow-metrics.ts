import { createHash } from "node:crypto"
import z from "zod"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Identifier = z.string().trim().min(1).max(500)
const EventType = z.string().trim().min(1).max(240)
const QueryVersion = z.string().trim().min(1).max(100)
const Timestamp = z.string().datetime()
const Strategy = z.enum(["legacy_full_plan", "seed_and_grow"])

function unique(values: string[]) {
  return new Set(values).size === values.length
}

const UniqueIdentifiers = z
  .array(Identifier)
  .min(1)
  .max(500)
  .superRefine((values, context) => {
    if (!unique(values)) context.addIssue({ code: "custom", message: "Values must be unique" })
  })

const UniqueIdentifiersAllowEmpty = z
  .array(Identifier)
  .max(500)
  .superRefine((values, context) => {
    if (!unique(values)) context.addIssue({ code: "custom", message: "Values must be unique" })
  })

const UniqueEventTypes = z
  .array(EventType)
  .min(1)
  .max(500)
  .superRefine((values, context) => {
    if (!unique(values)) context.addIssue({ code: "custom", message: "Event types must be unique" })
  })

export const SeedGrowMetricId = z.enum([
  "false_completion_count",
  "acceptance_criterion_evidence_coverage",
  "graph_repair_success_rate",
  "blind_retry_rate",
  "validation_gate_false_pass_rate",
  "delivery_consumability_rate",
  "recovery_success_rate",
  "complex_initial_assignment_median",
  "agent_count_before_first_receipt",
  "agent_count_added_after_receipt",
  "candidate_reuse_rate",
  "candidate_reuse_delta_vs_legacy",
  "new_candidate_per_completed_project",
  "unnecessary_reviewer_rate",
  "reviewer_rejection_precision",
  "reviewer_invocation_ratio_vs_legacy",
  "agent_load_balance",
  "automated_graph_decision_rate",
  "user_attention_count",
  "invalid_interruption_rate",
  "material_attention_precision",
  "unresolved_ask_latency_ms",
  "three_round_circuit_breaker_count",
  "accepted_delivery_cost",
  "wayfinder_cost",
  "reviewer_cost",
  "total_model_calls_by_strategy",
  "failed_attempt_cost_reuse_rate",
  "graph_growth_node_count",
  "graph_mutation_without_evidence_rate",
  "receipt_recovery_success_rate",
  "graph_mutation_recovery_success_rate",
  "acceptance_determinability_rate",
  "low_risk_quality_ratio_vs_legacy",
  "core_task_completion_rate",
  "exact_sha_terminal_success_rate",
  "consecutive_reproducible_candidate_count",
])
export type SeedGrowMetricId = z.infer<typeof SeedGrowMetricId>

export const PrePublicScenarioMetricIds = [
  "false_completion_count",
  "graph_mutation_without_evidence_rate",
  "complex_initial_assignment_median",
  "receipt_recovery_success_rate",
  "graph_mutation_recovery_success_rate",
  "delivery_consumability_rate",
  "acceptance_determinability_rate",
  "validation_gate_false_pass_rate",
  "blind_retry_rate",
  "invalid_interruption_rate",
  "reviewer_invocation_ratio_vs_legacy",
  "candidate_reuse_rate",
  "candidate_reuse_delta_vs_legacy",
  "new_candidate_per_completed_project",
  "low_risk_quality_ratio_vs_legacy",
  "core_task_completion_rate",
] as const satisfies readonly SeedGrowMetricId[]

export const PrePublicCandidateMetricIds = [
  ...PrePublicScenarioMetricIds,
  "exact_sha_terminal_success_rate",
] as const satisfies readonly SeedGrowMetricId[]

export const PrePublicCrossStrategyMetricIds = [
  "reviewer_invocation_ratio_vs_legacy",
  "candidate_reuse_delta_vs_legacy",
  "low_risk_quality_ratio_vs_legacy",
] as const satisfies readonly SeedGrowMetricId[]

export const PrePublicBlockingMetricIds = [
  ...PrePublicCandidateMetricIds,
  "consecutive_reproducible_candidate_count",
] as const satisfies readonly SeedGrowMetricId[]

export const PrePublicScenarioApplicability = {
  false_completion_count: [
    "S13",
    "S14",
    "S15",
    "S16",
    "S17",
    "S18",
    "S19",
    "S20",
    "S21",
    "S22",
    "S23",
    "S24",
    "S25",
    "S26",
    "S27",
  ],
  graph_mutation_without_evidence_rate: ["S16", "S17", "S20", "S21", "S23", "S27"],
  complex_initial_assignment_median: ["S13"],
  receipt_recovery_success_rate: ["S19", "S27"],
  graph_mutation_recovery_success_rate: ["S20", "S27"],
  delivery_consumability_rate: ["S14"],
  acceptance_determinability_rate: [
    "S13",
    "S14",
    "S16",
    "S17",
    "S18",
    "S19",
    "S20",
    "S21",
    "S23",
    "S24",
    "S25",
    "S26",
    "S27",
  ],
  validation_gate_false_pass_rate: ["S15", "S16", "S18", "S22", "S23", "S24", "S27"],
  blind_retry_rate: ["S16", "S22"],
  invalid_interruption_rate: ["S14", "S15", "S22"],
  reviewer_invocation_ratio_vs_legacy: ["S14", "S18"],
  candidate_reuse_rate: ["S17", "S25", "S26"],
  candidate_reuse_delta_vs_legacy: ["S17", "S25", "S26"],
  new_candidate_per_completed_project: ["S17", "S26"],
  low_risk_quality_ratio_vs_legacy: ["S14", "S18"],
  core_task_completion_rate: [
    "S13",
    "S14",
    "S15",
    "S16",
    "S17",
    "S18",
    "S19",
    "S20",
    "S21",
    "S22",
    "S23",
    "S24",
    "S25",
    "S26",
    "S27",
  ],
} as const satisfies Record<(typeof PrePublicScenarioMetricIds)[number], readonly string[]>

export const PrePublicMetricContractSha256 = "975d7c42fb5b4f629107b4a09c79cf10eba6d87bb3c6a11c983c4dee090e68a2"

export const MetricOperator = z.enum(["=", "<", "<=", ">", ">=", "observe"])
export type MetricOperator = z.infer<typeof MetricOperator>

export const MetricTarget = z
  .object({
    gate: z.enum(["R0", "R1", "R2", "R3", "R4"]),
    operator: MetricOperator,
    value: z.number().finite().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operator === "observe" && value.value !== null)
      context.addIssue({ code: "custom", message: "Observed metrics cannot declare a numeric threshold" })
    if (value.operator !== "observe" && value.value === null)
      context.addIssue({ code: "custom", message: "Threshold metrics require a numeric value" })
  })

export const MetricDefinition = z
  .object({
    id: Identifier,
    label: z.string().trim().min(1).max(500),
    definition: z.string().trim().min(1).max(8_000),
    formula: z.string().trim().min(1).max(8_000),
    numerator: z.string().trim().min(1).max(2_000).optional(),
    denominator: z.string().trim().min(1).max(2_000).optional(),
    eventSource: UniqueEventTypes.optional(),
    timeWindow: z.string().trim().min(1).max(500).optional(),
    minimumSampleSize: z.number().int().positive().optional(),
    applicableScenarioIds: UniqueIdentifiers.optional(),
    requiredDimensions: UniqueIdentifiers.optional(),
    unit: z.string().trim().min(1).max(100),
    aggregation: z.enum(["ratio", "median", "p95", "sum", "max"]),
    collectionMode: z.enum(["automated", "hybrid", "human_research"]),
    minimumEvidence: UniqueIdentifiers,
    target: MetricTarget,
    cannotBeInferredFrom: UniqueIdentifiers.optional(),
  })
  .strict()
export type MetricDefinition = z.infer<typeof MetricDefinition>

const PrivacyContract = z
  .object({
    storage: z.literal("local_first"),
    externalUploadDefault: z.literal(false),
    prohibitedProperties: UniqueIdentifiers,
    retention: z.string().trim().min(1).max(2_000),
  })
  .strict()

const EventEnvelopeContract = z
  .object({
    requiredFields: z.record(z.string(), z.string().min(1)),
    requiredOrdering: UniqueIdentifiers,
    duplicateKey: Identifier,
    clockPolicy: z.string().trim().min(1).max(2_000),
  })
  .strict()

const EventTypeContract = z
  .object({
    id: EventType,
    requiredProperties: UniqueIdentifiers,
  })
  .strict()

const ReleaseThreshold = z
  .object({
    metricId: Identifier,
    operator: z.enum(["=", "<", "<=", ">", ">="]),
    value: z.number().finite(),
    evidenceStatus: z.string().trim().min(1).max(200).optional(),
    scope: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

const HumanEvidenceRequirement = z
  .object({
    id: Identifier,
    name: z.string().trim().min(1).max(500),
    status: z.string().trim().min(1).max(100),
    automationSubstituteAllowed: z.boolean(),
    blocking: z.boolean(),
  })
  .strict()

const ReleaseGate = z
  .object({
    id: z.enum(["R0", "R1", "R2", "R3", "R4"]),
    currentStatus: z.string().trim().min(1).max(100).optional(),
    requiredThresholds: z.array(ReleaseThreshold).min(1).max(200),
    requiredHumanEvidence: z.array(HumanEvidenceRequirement).max(100).optional(),
    requiredStructuralEvidence: UniqueIdentifiers,
  })
  .strict()

const CurrentCollectionStatus = z
  .object({
    buildRef: CandidateSha,
    automatedProductMetrics: z.enum(["not_collectable", "collectable"]),
    humanResearchMetrics: z.enum(["not_scheduled", "scheduled", "in_progress", "completed"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()

export const ShadowCheckId = z.enum([
  "completeness_not_lower",
  "reviewer_invocations_lower",
  "error_rate_not_higher",
  "candidate_reuse_higher",
  "low_risk_quality_not_lower",
])
export type ShadowCheckId = z.infer<typeof ShadowCheckId>

const ShadowCheckFieldById = {
  completeness_not_lower: "completenessRateDelta",
  reviewer_invocations_lower: "reviewerInvocationRatio",
  error_rate_not_higher: "errorRateDelta",
  candidate_reuse_higher: "candidateReuseRateDelta",
  low_risk_quality_not_lower: "lowRiskQualityRatio",
} as const satisfies Record<ShadowCheckId, string>

const ShadowCheckPolicy = z
  .object({
    id: ShadowCheckId,
    field: z.enum([
      "completenessRateDelta",
      "reviewerInvocationRatio",
      "errorRateDelta",
      "candidateReuseRateDelta",
      "lowRiskQualityRatio",
    ]),
    operator: z.enum(["=", "<", "<=", ">", ">="]),
    value: z.number().finite(),
    blocking: z.boolean(),
  })
  .strict()

export const ShadowComparisonPolicy = z
  .object({
    queryVersion: z.literal("seed-grow-shadow-query.v1"),
    minimumSampleSize: z.number().int().positive(),
    checks: z.array(ShadowCheckPolicy).length(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.checks.map((item) => item.id)))
      context.addIssue({ code: "custom", message: "Shadow check identifiers must be unique" })
    if (!unique(value.checks.map((item) => item.field)))
      context.addIssue({ code: "custom", message: "Shadow check fields must be unique" })
    for (const check of value.checks) {
      if (check.field !== ShadowCheckFieldById[check.id])
        context.addIssue({ code: "custom", message: `Shadow check ${check.id} uses the wrong field` })
    }
  })
export type ShadowComparisonPolicy = z.infer<typeof ShadowComparisonPolicy>

const PrePublicGate = z
  .object({
    id: z.literal("pre_public_default"),
    requiredMetricIds: z.array(SeedGrowMetricId).min(1),
    minimumConsecutiveCandidates: z.number().int().min(2),
    minimumIsolatedRunsPerCandidate: z.number().int().min(2),
  })
  .strict()

export const MetricContract = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("agent-company-experience-metrics"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    queryVersion: z.literal("seed-grow-metric-query.v1"),
    privacy: PrivacyContract,
    eventEnvelope: EventEnvelopeContract,
    eventTypes: z.array(EventTypeContract).min(1).max(500),
    metrics: z.array(MetricDefinition).min(1).max(500),
    prePublicGate: PrePublicGate,
    shadowComparison: ShadowComparisonPolicy.optional(),
    releaseGates: z.array(ReleaseGate).length(5),
    currentCollectionStatus: CurrentCollectionStatus,
  })
  .strict()
  .superRefine((value, context) => {
    const metricIDs = value.metrics.map((metric) => metric.id)
    const eventTypes = value.eventTypes.map((event) => event.id)
    if (!unique(metricIDs)) context.addIssue({ code: "custom", message: "Metric identifiers must be unique" })
    if (!unique(eventTypes)) context.addIssue({ code: "custom", message: "Metric event types must be unique" })
    for (const id of SeedGrowMetricId.options) {
      const metric = value.metrics.find((item) => item.id === id)
      if (!metric) {
        context.addIssue({ code: "custom", message: `Missing Seed-and-Grow metric ${id}` })
        continue
      }
      if (
        !metric.numerator ||
        !metric.denominator ||
        !metric.eventSource ||
        !metric.timeWindow ||
        !metric.minimumSampleSize
      )
        context.addIssue({ code: "custom", message: `Metric ${id} has an incomplete evaluator contract` })
      for (const eventType of metric.eventSource ?? []) {
        if (!eventTypes.includes(eventType))
          context.addIssue({
            code: "custom",
            message: `Metric ${id} references unknown event type ${eventType}`,
          })
      }
    }
    for (const id of PrePublicScenarioMetricIds) {
      const metric = value.metrics.find((item) => item.id === id)
      if (!metric || !sameValues(metric.applicableScenarioIds ?? [], [...PrePublicScenarioApplicability[id]]))
        context.addIssue({ code: "custom", message: `Metric ${id} has mismatched applicable scenarios` })
    }
    if (
      !unique(value.prePublicGate.requiredMetricIds) ||
      value.prePublicGate.requiredMetricIds.length !== PrePublicBlockingMetricIds.length ||
      !PrePublicBlockingMetricIds.every((id) => value.prePublicGate.requiredMetricIds.includes(id))
    )
      context.addIssue({ code: "custom", message: "Pre-Public blocking metric set is incomplete" })
    const r4 = value.releaseGates.find((gate) => gate.id === "R4")
    for (const id of value.prePublicGate.requiredMetricIds) {
      const metric = value.metrics.find((item) => item.id === id)
      const threshold = r4?.requiredThresholds.find((item) => item.metricId === id)
      if (!metric || !threshold) {
        context.addIssue({ code: "custom", message: `R4 is missing Pre-Public threshold ${id}` })
        continue
      }
      if (metric.target.operator !== threshold.operator || metric.target.value !== threshold.value)
        context.addIssue({ code: "custom", message: `R4 threshold for ${id} differs from its metric target` })
    }
    for (const gate of value.releaseGates) {
      for (const threshold of gate.requiredThresholds) {
        if (!metricIDs.includes(threshold.metricId))
          context.addIssue({
            code: "custom",
            message: `Release gate ${gate.id} references unknown metric ${threshold.metricId}`,
          })
      }
    }
    for (const metric of value.metrics.filter((item) => item.collectionMode === "human_research")) {
      if (!metric.cannotBeInferredFrom)
        context.addIssue({
          code: "custom",
          message: `Human research metric ${metric.id} must reject automated substitutes`,
        })
    }
  })
export type MetricContract = z.infer<typeof MetricContract>

export const MetricSourceRef = z
  .object({
    kind: z.enum([
      "project_event",
      "work_attempt",
      "work_receipt",
      "graph_mutation",
      "project_assignment",
      "validation_gate",
      "attention",
      "agent_run",
      "benchmark_report",
      "gate_report",
      "deployment_report",
      "rollback_report",
      "shadow_report",
    ]),
    id: Identifier,
    candidateSha: CandidateSha,
    runId: Identifier,
    digest: Digest,
  })
  .strict()
export type MetricSourceRef = z.infer<typeof MetricSourceRef>

export const MetricObservation = z
  .object({
    metricId: Identifier,
    aggregation: z.enum(["ratio", "median", "p95", "sum", "max"]),
    numerator: z.number().finite(),
    denominator: z.number().finite().nonnegative(),
    sampleSize: z.number().int().nonnegative(),
    values: z.array(z.number().finite()).max(100_000).optional(),
    eventTypes: UniqueEventTypes,
    sourceRefs: z.array(MetricSourceRef).min(1).max(10_000),
    runIds: UniqueIdentifiers,
    timeWindow: z.string().trim().min(1).max(500),
    dimensions: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
  })
  .strict()
export type MetricObservation = z.infer<typeof MetricObservation>

const MetricWindow = z
  .object({
    id: Identifier,
    startedAt: Timestamp,
    endedAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) <= Date.parse(value.startedAt))
      context.addIssue({ code: "custom", message: "Metric window must end after it starts" })
  })

const MetricQueryCoreShape = {
  candidateSha: CandidateSha,
  queryVersion: QueryVersion,
  strategy: Strategy,
  metricIds: UniqueIdentifiers,
  runIds: UniqueIdentifiersAllowEmpty,
  runBindings: z
    .array(
      z
        .object({
          runId: Identifier,
          scenarioId: Identifier,
          strategy: Strategy,
        })
        .strict(),
    )
    .max(500),
  applicableRunIds: z.record(Identifier, UniqueIdentifiersAllowEmpty),
  window: MetricWindow,
  observations: z.array(MetricObservation).max(10_000),
} as const

export const MetricQueryCore = z.object(MetricQueryCoreShape).strict()
export type MetricQueryCore = z.infer<typeof MetricQueryCore>

export const MetricQueryInput = z
  .object({
    ...MetricQueryCoreShape,
    inputDigest: Digest,
  })
  .strict()
export type MetricQueryInput = z.infer<typeof MetricQueryInput>

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

export function metricContractDigest(raw: unknown) {
  return createHash("sha256")
    .update(canonical(MetricContract.parse(raw)))
    .digest("hex")
}

function normalizedQuery(raw: unknown) {
  const input = MetricQueryCore.parse(raw)
  return {
    ...input,
    metricIds: [...input.metricIds].sort(),
    runIds: [...input.runIds].sort(),
    runBindings: [...input.runBindings].sort((left, right) => canonical(left).localeCompare(canonical(right))),
    applicableRunIds: Object.fromEntries(
      Object.entries(input.applicableRunIds)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([metricId, runIds]) => [metricId, [...runIds].sort()]),
    ),
    observations: input.observations
      .map((observation) => ({
        ...observation,
        eventTypes: [...observation.eventTypes].sort(),
        runIds: [...observation.runIds].sort(),
        sourceRefs: [...observation.sourceRefs].sort((left, right) => canonical(left).localeCompare(canonical(right))),
        values: observation.values ? [...observation.values].sort((left, right) => left - right) : undefined,
      }))
      .sort((left, right) => left.metricId.localeCompare(right.metricId)),
  }
}

export function metricQueryDigest(raw: unknown) {
  return createHash("sha256")
    .update(canonical(normalizedQuery(raw)))
    .digest("hex")
}

export function bindMetricQuery(raw: unknown) {
  const input = MetricQueryCore.parse(raw)
  return MetricQueryInput.parse({ ...input, inputDigest: metricQueryDigest(input) })
}

export const MetricBlockedReason = z.enum([
  "unknown_metric",
  "missing_observation",
  "duplicate_observation",
  "missing_source_event",
  "zero_denominator",
  "insufficient_sample",
  "aggregation_mismatch",
  "missing_values",
  "sample_size_mismatch",
  "time_window_mismatch",
  "missing_dimension",
  "query_version_mismatch",
  "input_digest_mismatch",
  "candidate_sha_mismatch",
  "missing_run",
  "run_binding_mismatch",
  "source_binding_mismatch",
])
export type MetricBlockedReason = z.infer<typeof MetricBlockedReason>

const MetricResult = z
  .object({
    metricId: Identifier,
    blocking: z.boolean(),
    status: z.enum(["pass", "failed", "blocked", "observed"]),
    value: z.number().finite().nullable(),
    numerator: z.number().finite().nullable(),
    denominator: z.number().finite().nonnegative().nullable(),
    sampleSize: z.number().int().nonnegative().nullable(),
    meetsThreshold: z.boolean().nullable(),
    threshold: MetricTarget.nullable(),
    blockedReasons: z.array(MetricBlockedReason),
    sourceRefs: z.array(MetricSourceRef),
  })
  .strict()

export const MetricEvaluationReport = z
  .object({
    schemaVersion: z.literal(1),
    queryVersion: QueryVersion,
    candidateSha: CandidateSha,
    inputDigest: Digest,
    runIds: UniqueIdentifiersAllowEmpty,
    status: z.enum(["pass", "failed", "blocked", "observed"]),
    results: z.array(MetricResult).min(1),
  })
  .strict()
export type MetricEvaluationReport = z.infer<typeof MetricEvaluationReport>

export const MetricEvaluationRequest = z
  .object({
    contract: MetricContract,
    query: MetricQueryInput,
    expectedCandidateSha: CandidateSha,
    expectedQueryVersion: QueryVersion,
  })
  .strict()
export type MetricEvaluationRequest = z.infer<typeof MetricEvaluationRequest>

function threshold(value: number, operator: Exclude<MetricOperator, "observe">, target: number) {
  if (operator === "=") return value === target
  if (operator === "<") return value < target
  if (operator === "<=") return value <= target
  if (operator === ">") return value > target
  return value >= target
}

function sameValues(left: string[], right: string[]) {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index])
}

function metricValue(metric: MetricDefinition, observation: MetricObservation) {
  if (metric.aggregation === "ratio") return observation.numerator / observation.denominator
  if (metric.aggregation === "sum") return observation.numerator
  const values = [...(observation.values ?? [])].sort((left, right) => left - right)
  if (metric.aggregation === "max") return values.at(-1)!
  if (metric.aggregation === "median") {
    const middle = Math.floor(values.length / 2)
    return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]
  }
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]
}

export function evaluateMetrics(raw: unknown): MetricEvaluationReport {
  const input = MetricEvaluationRequest.parse(raw)
  const digest = metricQueryDigest({
    candidateSha: input.query.candidateSha,
    queryVersion: input.query.queryVersion,
    strategy: input.query.strategy,
    metricIds: input.query.metricIds,
    runIds: input.query.runIds,
    runBindings: input.query.runBindings,
    window: input.query.window,
    observations: input.query.observations,
    applicableRunIds: input.query.applicableRunIds,
  })
  const globalReasons = [
    input.query.queryVersion !== input.expectedQueryVersion || input.query.queryVersion !== input.contract.queryVersion
      ? "query_version_mismatch"
      : undefined,
    input.query.inputDigest !== digest ? "input_digest_mismatch" : undefined,
    input.query.candidateSha !== input.expectedCandidateSha ? "candidate_sha_mismatch" : undefined,
    input.query.runIds.length === 0 ? "missing_run" : undefined,
  ].filter((reason): reason is MetricBlockedReason => reason !== undefined)
  const results = input.query.metricIds.map((metricId) => {
    const metric = input.contract.metrics.find((item) => item.id === metricId)
    const observations = input.query.observations.filter((item) => item.metricId === metricId)
    const observation = observations[0]
    const applicableRunIds = input.query.applicableRunIds[metricId]
    const contractedRunIds = metric?.applicableScenarioIds
      ? input.query.runBindings
          .filter(
            (binding) =>
              metric.applicableScenarioIds!.includes(binding.scenarioId) &&
              (PrePublicCrossStrategyMetricIds.includes(metricId as (typeof PrePublicCrossStrategyMetricIds)[number]) ||
                binding.strategy === input.query.strategy),
          )
          .map((binding) => binding.runId)
      : applicableRunIds
    const blocking = input.contract.prePublicGate.requiredMetricIds.some((id) => id === metricId)
    const reasons = [...globalReasons]
    if (!metric) reasons.push("unknown_metric")
    if (!applicableRunIds) reasons.push("run_binding_mismatch")
    if (
      !contractedRunIds ||
      !applicableRunIds ||
      !sameValues(applicableRunIds, contractedRunIds) ||
      !sameValues(
        input.query.runIds,
        input.query.runBindings.map((binding) => binding.runId),
      )
    )
      reasons.push("run_binding_mismatch")
    if (!observation) reasons.push("missing_observation")
    if (observations.length > 1) reasons.push("duplicate_observation")
    if (metric && observation) {
      if (metric.aggregation !== observation.aggregation) reasons.push("aggregation_mismatch")
      if (metric.eventSource?.some((eventType) => !observation.eventTypes.includes(eventType)))
        reasons.push("missing_source_event")
      if (metric.timeWindow !== observation.timeWindow) reasons.push("time_window_mismatch")
      if (metric.requiredDimensions?.some((dimension) => observation.dimensions?.[dimension] === undefined))
        reasons.push("missing_dimension")
      if (
        !applicableRunIds ||
        !sameValues(observation.runIds, applicableRunIds) ||
        observation.runIds.some((runId) => !input.query.runIds.includes(runId))
      )
        reasons.push("run_binding_mismatch")
      if (
        observation.sourceRefs.some(
          (source) => source.candidateSha !== input.query.candidateSha || !observation.runIds.includes(source.runId),
        ) ||
        observation.runIds.some((runId) => !observation.sourceRefs.some((source) => source.runId === runId))
      )
        reasons.push("source_binding_mismatch")
      if (observation.denominator === 0) reasons.push("zero_denominator")
      if (observation.sampleSize < (metric.minimumSampleSize ?? 1)) reasons.push("insufficient_sample")
      if (["median", "p95", "max"].includes(metric.aggregation)) {
        if (!observation.values?.length) reasons.push("missing_values")
        if (observation.values && observation.values.length !== observation.sampleSize)
          reasons.push("sample_size_mismatch")
      }
    }
    const blockedReasons = [...new Set(reasons)]
    if (!metric || !observation || blockedReasons.length)
      return MetricResult.parse({
        metricId,
        blocking,
        status: "blocked",
        value: null,
        numerator: observation?.numerator ?? null,
        denominator: observation?.denominator ?? null,
        sampleSize: observation?.sampleSize ?? null,
        meetsThreshold: null,
        threshold: metric?.target ?? null,
        blockedReasons,
        sourceRefs: observation?.sourceRefs ?? [],
      })
    const value = metricValue(metric, observation)
    const meetsThreshold =
      metric.target.operator === "observe" ? null : threshold(value, metric.target.operator, metric.target.value!)
    return MetricResult.parse({
      metricId,
      blocking,
      status: !blocking ? "observed" : meetsThreshold ? "pass" : "failed",
      value,
      numerator: observation.numerator,
      denominator: observation.denominator,
      sampleSize: observation.sampleSize,
      meetsThreshold,
      threshold: metric.target,
      blockedReasons: [],
      sourceRefs: observation.sourceRefs,
    })
  })
  const status = results.some((result) => result.status === "blocked")
    ? "blocked"
    : results.some((result) => result.status === "failed")
      ? "failed"
      : results.some((result) => result.blocking)
        ? "pass"
        : "observed"
  return MetricEvaluationReport.parse({
    schemaVersion: 1,
    queryVersion: input.query.queryVersion,
    candidateSha: input.query.candidateSha,
    inputDigest: input.query.inputDigest,
    runIds: input.query.runIds,
    status,
    results,
  })
}
