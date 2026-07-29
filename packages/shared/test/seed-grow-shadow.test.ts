import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { MetricContract } from "../src/seed-grow-metrics"
import {
  ShadowComparisonInput,
  bindShadowComparison,
  evaluateShadowComparison,
  type ShadowComparisonCore,
  type ShadowFact,
  type ShadowFactId,
  type ShadowStrategy,
  type ShadowStrategyAggregate,
} from "../src/seed-grow-shadow"

const candidateSha = "a".repeat(40)
const otherCandidateSha = "b".repeat(40)
const snapshotDigest = "c".repeat(64)
const contract = MetricContract.parse(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../docs/product-design/experience-refactor/metric-contract.v1.json"),
      "utf8",
    ),
  ) as unknown,
)

function requiredPolicy() {
  if (!contract.shadowComparison) throw new Error("Missing shadow comparison policy")
  return contract.shadowComparison
}

const policy = requiredPolicy()

function runIds(strategy: ShadowStrategy) {
  return strategy === "legacy" ? ["legacy-a", "legacy-b"] : ["seed-a", "seed-b"]
}

function sourceRefs(strategy: ShadowStrategy, candidate = candidateSha) {
  return runIds(strategy).map((runId, index) => ({
    kind: "benchmark_report" as const,
    id: `${strategy}-report-${index}`,
    candidateSha: candidate,
    runId,
    digest: String(strategy === "legacy" ? index + 1 : index + 3).repeat(64),
  }))
}

function fact(strategy: ShadowStrategy, numerator: number, denominator = 2): ShadowFact {
  return {
    numerator,
    denominator,
    sampleSize: 2,
    sourceRefIds: sourceRefs(strategy).map((source) => source.id),
  }
}

function aggregate(strategy: ShadowStrategy): ShadowStrategyAggregate {
  const legacy = strategy === "legacy"
  return {
    strategy,
    candidateSha,
    snapshotDigest,
    scenarioIds: ["S13", "S18"],
    runIds: runIds(strategy),
    sourceRefs: sourceRefs(strategy),
    facts: {
      completeness: fact(strategy, 2),
      totalModelCalls: fact(strategy, legacy ? 10 : 8),
      totalCost: fact(strategy, legacy ? 20 : 16),
      reviewerInvocations: fact(strategy, legacy ? 4 : 2),
      unknownsDiscovered: fact(strategy, legacy ? 2 : 4),
      errorRate: fact(strategy, legacy ? 1 : 0),
      candidateReuseRate: fact(strategy, legacy ? 1 : 2),
      lowRiskQualityRate: fact(strategy, 2),
    },
  }
}

function core(overrides: Partial<ShadowComparisonCore> = {}): ShadowComparisonCore {
  return {
    comparisonId: "shadow-001",
    candidateSha,
    queryVersion: policy.queryVersion,
    snapshotDigest,
    scenarioIds: ["S13", "S18"],
    legacy: aggregate("legacy"),
    seedAndGrow: aggregate("seed_and_grow"),
    ...overrides,
  }
}

function replaceFact(
  value: ShadowStrategyAggregate,
  factId: ShadowFactId,
  overrides: Partial<ShadowFact>,
): ShadowStrategyAggregate {
  return {
    ...value,
    facts: {
      ...value.facts,
      [factId]: {
        ...value.facts[factId],
        ...overrides,
      },
    },
  }
}

function reverseAggregate(value: ShadowStrategyAggregate): ShadowStrategyAggregate {
  const reverseFact = (item: ShadowFact): ShadowFact => ({
    ...item,
    sourceRefIds: [...item.sourceRefIds].reverse(),
  })
  return {
    ...value,
    scenarioIds: [...value.scenarioIds].reverse(),
    runIds: [...value.runIds].reverse(),
    sourceRefs: [...value.sourceRefs].reverse(),
    facts: {
      completeness: reverseFact(value.facts.completeness),
      totalModelCalls: reverseFact(value.facts.totalModelCalls),
      totalCost: reverseFact(value.facts.totalCost),
      reviewerInvocations: reverseFact(value.facts.reviewerInvocations),
      unknownsDiscovered: reverseFact(value.facts.unknownsDiscovered),
      errorRate: reverseFact(value.facts.errorRate),
      candidateReuseRate: reverseFact(value.facts.candidateReuseRate),
      lowRiskQualityRate: reverseFact(value.facts.lowRiskQualityRate),
    },
  }
}

function evaluate(query = bindShadowComparison(core()), expectedCandidateSha = candidateSha) {
  return evaluateShadowComparison({
    policy,
    query,
    expectedCandidateSha,
    expectedQueryVersion: policy.queryVersion,
  })
}

describe("Seed-and-Grow shadow comparison", () => {
  test("binds equivalent source order to one digest and returns deterministic deltas", () => {
    const first = bindShadowComparison(core())
    const second = bindShadowComparison({
      ...core(),
      scenarioIds: [...core().scenarioIds].reverse(),
      legacy: reverseAggregate(aggregate("legacy")),
      seedAndGrow: reverseAggregate(aggregate("seed_and_grow")),
    })
    expect(second.inputDigest).toBe(first.inputDigest)
    expect(evaluate(first)).toMatchObject({
      status: "pass",
      candidateSha,
      snapshotDigest,
      blockedReasons: [],
      deltas: {
        completenessRateDelta: 0,
        modelCallsPerUnitDelta: -1,
        costPerUnitDelta: -2,
        reviewerInvocationRatio: 0.5,
        unknownDiscoveryRateDelta: 1,
        errorRateDelta: -0.5,
        candidateReuseRateDelta: 0.5,
        lowRiskQualityRatio: 1,
      },
      checks: [
        { id: "completeness_not_lower", status: "pass" },
        { id: "reviewer_invocations_lower", status: "pass" },
        { id: "error_rate_not_higher", status: "pass" },
        { id: "candidate_reuse_higher", status: "pass" },
        { id: "low_risk_quality_not_lower", status: "pass" },
      ],
    })
  })

  test("fails a bound comparison when a blocking delta misses policy", () => {
    const seedAndGrow = replaceFact(aggregate("seed_and_grow"), "reviewerInvocations", {
      numerator: 6,
    })
    const report = evaluate(bindShadowComparison(core({ seedAndGrow })))
    expect(report).toMatchObject({
      status: "failed",
      blockedReasons: [],
      deltas: { reviewerInvocationRatio: 1.5 },
    })
    expect(report.checks.find((check) => check.id === "reviewer_invocations_lower")).toMatchObject({
      status: "failed",
    })
  })

  test("blocks zero denominators, insufficient samples, and zero comparison baselines", () => {
    const cases = [
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: replaceFact(aggregate("seed_and_grow"), "errorRate", { denominator: 0 }),
          }),
        ),
        reason: "zero_denominator",
      },
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: replaceFact(aggregate("seed_and_grow"), "errorRate", { sampleSize: 1 }),
          }),
        ),
        reason: "insufficient_sample",
      },
      {
        query: bindShadowComparison(
          core({
            legacy: replaceFact(aggregate("legacy"), "reviewerInvocations", { numerator: 0 }),
          }),
        ),
        reason: "comparison_baseline_zero",
      },
    ] as const
    for (const item of cases) {
      const report = evaluate(item.query)
      expect(report).toMatchObject({
        status: "blocked",
        deltas: null,
        blockedReasons: expect.arrayContaining([item.reason]),
      })
      expect(report.checks.every((check) => check.status === "blocked" && check.value === null)).toBe(true)
    }
  })

  test("blocks query, digest, candidate, snapshot, scenario, run, and source mismatches", () => {
    const valid = bindShadowComparison(core())
    const seed = aggregate("seed_and_grow")
    const legacy = aggregate("legacy")
    const cases = [
      {
        query: bindShadowComparison(core({ queryVersion: "seed-grow-shadow-query.v0" })),
        expectedCandidateSha: candidateSha,
        reason: "query_version_mismatch",
      },
      {
        query: { ...valid, inputDigest: "f".repeat(64) },
        expectedCandidateSha: candidateSha,
        reason: "input_digest_mismatch",
      },
      {
        query: valid,
        expectedCandidateSha: otherCandidateSha,
        reason: "candidate_sha_mismatch",
      },
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: { ...seed, snapshotDigest: "d".repeat(64) },
          }),
        ),
        expectedCandidateSha: candidateSha,
        reason: "snapshot_binding_mismatch",
      },
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: { ...seed, scenarioIds: ["S99"] },
          }),
        ),
        expectedCandidateSha: candidateSha,
        reason: "scenario_binding_mismatch",
      },
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: { ...seed, runIds: [legacy.runIds[0], seed.runIds[1]] },
          }),
        ),
        expectedCandidateSha: candidateSha,
        reason: "run_binding_mismatch",
      },
      {
        query: bindShadowComparison(
          core({
            seedAndGrow: {
              ...seed,
              sourceRefs: [{ ...seed.sourceRefs[0], candidateSha: otherCandidateSha }, seed.sourceRefs[1]],
            },
          }),
        ),
        expectedCandidateSha: candidateSha,
        reason: "source_binding_mismatch",
      },
    ] as const
    for (const item of cases) {
      expect(evaluate(item.query, item.expectedCandidateSha)).toMatchObject({
        status: "blocked",
        blockedReasons: expect.arrayContaining([item.reason]),
      })
    }
  })

  test("rejects unknown input fields and policy field swaps", () => {
    expect(() => ShadowComparisonInput.parse({ ...bindShadowComparison(core()), unknown: true })).toThrow()
    expect(() =>
      MetricContract.parse({
        ...contract,
        shadowComparison: {
          ...policy,
          checks: policy.checks.map((check) =>
            check.id === "completeness_not_lower"
              ? { ...check, field: "errorRateDelta" }
              : check.id === "error_rate_not_higher"
                ? { ...check, field: "completenessRateDelta" }
                : check,
          ),
        },
      }),
    ).toThrow()
  })
})
