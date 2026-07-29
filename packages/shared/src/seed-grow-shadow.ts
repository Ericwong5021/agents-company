import { createHash } from "node:crypto"
import z from "zod"
import {
  MetricSourceRef,
  ShadowComparisonPolicy,
  type MetricOperator,
  type ShadowComparisonPolicy as ShadowComparisonPolicyType,
} from "./seed-grow-metrics"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Identifier = z.string().trim().min(1).max(500)
const QueryVersion = z.string().trim().min(1).max(100)

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

export const ShadowStrategy = z.enum(["legacy", "seed_and_grow"])
export type ShadowStrategy = z.infer<typeof ShadowStrategy>

export const ShadowFactId = z.enum([
  "completeness",
  "totalModelCalls",
  "totalCost",
  "reviewerInvocations",
  "unknownsDiscovered",
  "errorRate",
  "candidateReuseRate",
  "lowRiskQualityRate",
])
export type ShadowFactId = z.infer<typeof ShadowFactId>

export const ShadowFact = z
  .object({
    numerator: z.number().finite().nonnegative(),
    denominator: z.number().finite().nonnegative(),
    sampleSize: z.number().int().nonnegative(),
    sourceRefIds: UniqueIdentifiersAllowEmpty,
  })
  .strict()
export type ShadowFact = z.infer<typeof ShadowFact>

const ShadowFacts = z
  .object({
    completeness: ShadowFact,
    totalModelCalls: ShadowFact,
    totalCost: ShadowFact,
    reviewerInvocations: ShadowFact,
    unknownsDiscovered: ShadowFact,
    errorRate: ShadowFact,
    candidateReuseRate: ShadowFact,
    lowRiskQualityRate: ShadowFact,
  })
  .strict()

export const ShadowStrategyAggregate = z
  .object({
    strategy: ShadowStrategy,
    candidateSha: CandidateSha,
    snapshotDigest: Digest,
    scenarioIds: UniqueIdentifiersAllowEmpty,
    runIds: UniqueIdentifiersAllowEmpty,
    sourceRefs: z.array(MetricSourceRef).max(10_000),
    facts: ShadowFacts,
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.sourceRefs.map((source) => source.id)))
      context.addIssue({ code: "custom", message: "Source reference identifiers must be unique" })
  })
export type ShadowStrategyAggregate = z.infer<typeof ShadowStrategyAggregate>

const ShadowComparisonCoreShape = {
  comparisonId: Identifier,
  candidateSha: CandidateSha,
  queryVersion: QueryVersion,
  snapshotDigest: Digest,
  scenarioIds: UniqueIdentifiers,
  legacy: ShadowStrategyAggregate,
  seedAndGrow: ShadowStrategyAggregate,
} as const

export const ShadowComparisonCore = z.object(ShadowComparisonCoreShape).strict()
export type ShadowComparisonCore = z.infer<typeof ShadowComparisonCore>

export const ShadowComparisonInput = z
  .object({
    ...ShadowComparisonCoreShape,
    inputDigest: Digest,
  })
  .strict()
export type ShadowComparisonInput = z.infer<typeof ShadowComparisonInput>

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

function normalizedAggregate(aggregate: ShadowStrategyAggregate) {
  return {
    ...aggregate,
    scenarioIds: [...aggregate.scenarioIds].sort(),
    runIds: [...aggregate.runIds].sort(),
    sourceRefs: [...aggregate.sourceRefs].sort((left, right) => canonical(left).localeCompare(canonical(right))),
    facts: Object.fromEntries(
      Object.entries(aggregate.facts).map(([key, fact]) => [
        key,
        {
          ...fact,
          sourceRefIds: [...fact.sourceRefIds].sort(),
        },
      ]),
    ),
  }
}

function normalizedComparison(raw: unknown) {
  const input = ShadowComparisonCore.parse(raw)
  return {
    ...input,
    scenarioIds: [...input.scenarioIds].sort(),
    legacy: normalizedAggregate(input.legacy),
    seedAndGrow: normalizedAggregate(input.seedAndGrow),
  }
}

export function shadowComparisonDigest(raw: unknown) {
  return createHash("sha256")
    .update(canonical(normalizedComparison(raw)))
    .digest("hex")
}

export function bindShadowComparison(raw: unknown) {
  const input = ShadowComparisonCore.parse(raw)
  return ShadowComparisonInput.parse({ ...input, inputDigest: shadowComparisonDigest(input) })
}

export const ShadowBlockedReason = z.enum([
  "query_version_mismatch",
  "input_digest_mismatch",
  "candidate_sha_mismatch",
  "strategy_binding_mismatch",
  "snapshot_binding_mismatch",
  "scenario_binding_mismatch",
  "missing_matched_run",
  "run_binding_mismatch",
  "source_binding_mismatch",
  "zero_denominator",
  "insufficient_sample",
  "comparison_baseline_zero",
])
export type ShadowBlockedReason = z.infer<typeof ShadowBlockedReason>

const ShadowDeltas = z
  .object({
    completenessRateDelta: z.number().finite(),
    modelCallsPerUnitDelta: z.number().finite(),
    costPerUnitDelta: z.number().finite(),
    reviewerInvocationRatio: z.number().finite(),
    unknownDiscoveryRateDelta: z.number().finite(),
    errorRateDelta: z.number().finite(),
    candidateReuseRateDelta: z.number().finite(),
    lowRiskQualityRatio: z.number().finite(),
  })
  .strict()
export type ShadowDeltas = z.infer<typeof ShadowDeltas>

const ShadowCheckResult = z
  .object({
    id: z.string().trim().min(1).max(500),
    field: z.enum([
      "completenessRateDelta",
      "reviewerInvocationRatio",
      "errorRateDelta",
      "candidateReuseRateDelta",
      "lowRiskQualityRatio",
    ]),
    operator: z.enum(["=", "<", "<=", ">", ">="]),
    target: z.number().finite(),
    blocking: z.boolean(),
    status: z.enum(["pass", "failed", "blocked"]),
    value: z.number().finite().nullable(),
  })
  .strict()

export const ShadowComparisonReport = z
  .object({
    schemaVersion: z.literal(1),
    queryVersion: QueryVersion,
    comparisonId: Identifier,
    candidateSha: CandidateSha,
    inputDigest: Digest,
    snapshotDigest: Digest,
    scenarioIds: UniqueIdentifiers,
    legacyRunIds: UniqueIdentifiersAllowEmpty,
    seedAndGrowRunIds: UniqueIdentifiersAllowEmpty,
    status: z.enum(["pass", "failed", "blocked"]),
    blockedReasons: z.array(ShadowBlockedReason),
    deltas: ShadowDeltas.nullable(),
    checks: z.array(ShadowCheckResult).length(5),
    sourceRefs: z.array(MetricSourceRef),
  })
  .strict()
export type ShadowComparisonReport = z.infer<typeof ShadowComparisonReport>

export const ShadowComparisonRequest = z
  .object({
    policy: ShadowComparisonPolicy,
    query: ShadowComparisonInput,
    expectedCandidateSha: CandidateSha,
    expectedQueryVersion: QueryVersion,
  })
  .strict()

function sameValues(left: string[], right: string[]) {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index])
}

function threshold(value: number, operator: Exclude<MetricOperator, "observe">, target: number) {
  if (operator === "=") return value === target
  if (operator === "<") return value < target
  if (operator === "<=") return value <= target
  if (operator === ">") return value > target
  return value >= target
}

function factRate(fact: ShadowFact) {
  return fact.numerator / fact.denominator
}

function aggregateReasons(
  query: ShadowComparisonInput,
  aggregate: ShadowStrategyAggregate,
  expectedStrategy: ShadowStrategy,
  minimumSampleSize: number,
) {
  const reasons: ShadowBlockedReason[] = []
  if (aggregate.strategy !== expectedStrategy) reasons.push("strategy_binding_mismatch")
  if (aggregate.candidateSha !== query.candidateSha) reasons.push("candidate_sha_mismatch")
  if (aggregate.snapshotDigest !== query.snapshotDigest) reasons.push("snapshot_binding_mismatch")
  if (!sameValues(aggregate.scenarioIds, query.scenarioIds)) reasons.push("scenario_binding_mismatch")
  if (
    aggregate.sourceRefs.some(
      (source) => source.candidateSha !== query.candidateSha || !aggregate.runIds.includes(source.runId),
    ) ||
    aggregate.runIds.some((runId) => !aggregate.sourceRefs.some((source) => source.runId === runId))
  )
    reasons.push("source_binding_mismatch")
  for (const fact of Object.values(aggregate.facts)) {
    if (fact.denominator === 0) reasons.push("zero_denominator")
    if (fact.sampleSize < minimumSampleSize) reasons.push("insufficient_sample")
    if (fact.sourceRefIds.some((id) => !aggregate.sourceRefs.some((source) => source.id === id)))
      reasons.push("source_binding_mismatch")
    if (
      aggregate.runIds.some(
        (runId) =>
          !fact.sourceRefIds.some((id) =>
            aggregate.sourceRefs.some((source) => source.id === id && source.runId === runId),
          ),
      )
    )
      reasons.push("source_binding_mismatch")
  }
  return reasons
}

function deltas(query: ShadowComparisonInput) {
  const legacy = query.legacy.facts
  const seed = query.seedAndGrow.facts
  return ShadowDeltas.parse({
    completenessRateDelta: factRate(seed.completeness) - factRate(legacy.completeness),
    modelCallsPerUnitDelta: factRate(seed.totalModelCalls) - factRate(legacy.totalModelCalls),
    costPerUnitDelta: factRate(seed.totalCost) - factRate(legacy.totalCost),
    reviewerInvocationRatio: factRate(seed.reviewerInvocations) / factRate(legacy.reviewerInvocations),
    unknownDiscoveryRateDelta: factRate(seed.unknownsDiscovered) - factRate(legacy.unknownsDiscovered),
    errorRateDelta: factRate(seed.errorRate) - factRate(legacy.errorRate),
    candidateReuseRateDelta: factRate(seed.candidateReuseRate) - factRate(legacy.candidateReuseRate),
    lowRiskQualityRatio: factRate(seed.lowRiskQualityRate) / factRate(legacy.lowRiskQualityRate),
  })
}

function blockedChecks(policy: ShadowComparisonPolicyType) {
  return policy.checks.map((check) =>
    ShadowCheckResult.parse({
      id: check.id,
      field: check.field,
      operator: check.operator,
      target: check.value,
      blocking: check.blocking,
      status: "blocked",
      value: null,
    }),
  )
}

export function evaluateShadowComparison(raw: unknown): ShadowComparisonReport {
  const input = ShadowComparisonRequest.parse(raw)
  const digest = shadowComparisonDigest({
    comparisonId: input.query.comparisonId,
    candidateSha: input.query.candidateSha,
    queryVersion: input.query.queryVersion,
    snapshotDigest: input.query.snapshotDigest,
    scenarioIds: input.query.scenarioIds,
    legacy: input.query.legacy,
    seedAndGrow: input.query.seedAndGrow,
  })
  const reasons = [
    input.query.queryVersion !== input.expectedQueryVersion || input.query.queryVersion !== input.policy.queryVersion
      ? "query_version_mismatch"
      : undefined,
    input.query.inputDigest !== digest ? "input_digest_mismatch" : undefined,
    input.query.candidateSha !== input.expectedCandidateSha ? "candidate_sha_mismatch" : undefined,
    ...aggregateReasons(input.query, input.query.legacy, "legacy", input.policy.minimumSampleSize),
    ...aggregateReasons(input.query, input.query.seedAndGrow, "seed_and_grow", input.policy.minimumSampleSize),
    input.query.legacy.runIds.some((runId) => input.query.seedAndGrow.runIds.includes(runId))
      ? "run_binding_mismatch"
      : undefined,
    input.query.legacy.runIds.length === 0 || input.query.seedAndGrow.runIds.length === 0
      ? "missing_matched_run"
      : undefined,
    input.query.legacy.sourceRefs.some((left) =>
      input.query.seedAndGrow.sourceRefs.some((right) => left.id === right.id),
    )
      ? "source_binding_mismatch"
      : undefined,
    factRate(input.query.legacy.facts.reviewerInvocations) === 0 ||
    factRate(input.query.legacy.facts.lowRiskQualityRate) === 0
      ? "comparison_baseline_zero"
      : undefined,
  ].filter((reason): reason is ShadowBlockedReason => reason !== undefined)
  const blockedReasons = [...new Set(reasons)]
  const sourceRefs = [...input.query.legacy.sourceRefs, ...input.query.seedAndGrow.sourceRefs]
  if (blockedReasons.length)
    return ShadowComparisonReport.parse({
      schemaVersion: 1,
      queryVersion: input.query.queryVersion,
      comparisonId: input.query.comparisonId,
      candidateSha: input.query.candidateSha,
      inputDigest: input.query.inputDigest,
      snapshotDigest: input.query.snapshotDigest,
      scenarioIds: input.query.scenarioIds,
      legacyRunIds: input.query.legacy.runIds,
      seedAndGrowRunIds: input.query.seedAndGrow.runIds,
      status: "blocked",
      blockedReasons,
      deltas: null,
      checks: blockedChecks(input.policy),
      sourceRefs,
    })
  const comparisonDeltas = deltas(input.query)
  const checks = input.policy.checks.map((check) => {
    const value = comparisonDeltas[check.field]
    return ShadowCheckResult.parse({
      id: check.id,
      field: check.field,
      operator: check.operator,
      target: check.value,
      blocking: check.blocking,
      status: threshold(value, check.operator, check.value) ? "pass" : "failed",
      value,
    })
  })
  return ShadowComparisonReport.parse({
    schemaVersion: 1,
    queryVersion: input.query.queryVersion,
    comparisonId: input.query.comparisonId,
    candidateSha: input.query.candidateSha,
    inputDigest: input.query.inputDigest,
    snapshotDigest: input.query.snapshotDigest,
    scenarioIds: input.query.scenarioIds,
    legacyRunIds: input.query.legacy.runIds,
    seedAndGrowRunIds: input.query.seedAndGrow.runIds,
    status: checks.some((check) => check.blocking && check.status === "failed") ? "failed" : "pass",
    blockedReasons: [],
    deltas: comparisonDeltas,
    checks,
    sourceRefs,
  })
}
