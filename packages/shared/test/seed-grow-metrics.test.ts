import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  MetricContract,
  PrePublicBlockingMetricIds,
  PrePublicMetricContractSha256,
  SeedGrowMetricId,
  bindMetricQuery,
  evaluateMetrics,
  metricContractDigest,
  type MetricObservation,
  type MetricQueryCore,
} from "../src/seed-grow-metrics"

const candidateSha = "a".repeat(40)
const otherCandidateSha = "b".repeat(40)
const runIds = ["run-a", "run-b"]
const contract = MetricContract.parse(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../docs/product-design/experience-refactor/metric-contract.v1.json"),
      "utf8",
    ),
  ) as unknown,
)

function sourceRefs(candidate = candidateSha) {
  return runIds.map((runId, index) => ({
    kind: "benchmark_report" as const,
    id: `report-${index}`,
    candidateSha: candidate,
    runId,
    digest: String(index + 1).repeat(64),
  }))
}

function observation(
  metricId = "false_completion_count",
  overrides: Partial<MetricObservation> = {},
): MetricObservation {
  const metric = contract.metrics.find((item) => item.id === metricId)
  if (!metric?.eventSource || !metric.timeWindow) throw new Error(`Missing evaluator contract: ${metricId}`)
  return {
    metricId,
    aggregation: metric.aggregation,
    numerator: 0,
    denominator: 2,
    sampleSize: 2,
    eventTypes: metric.eventSource,
    sourceRefs: sourceRefs(),
    runIds,
    timeWindow: metric.timeWindow,
    ...overrides,
  }
}

function core(
  observations: MetricObservation[] = [observation()],
  overrides: Partial<MetricQueryCore> = {},
): MetricQueryCore {
  const metricIds = overrides.metricIds ?? observations.map((item) => item.metricId)
  return {
    candidateSha,
    queryVersion: contract.queryVersion,
    strategy: "seed_and_grow",
    metricIds,
    runIds,
    runBindings: runIds.map((runId) => ({
      runId,
      scenarioId: "S13",
      strategy: "seed_and_grow" as const,
    })),
    applicableRunIds: overrides.applicableRunIds ?? Object.fromEntries(metricIds.map((metricId) => [metricId, runIds])),
    window: {
      id: "candidate-window",
      startedAt: "2026-07-29T00:00:00.000Z",
      endedAt: "2026-07-29T01:00:00.000Z",
    },
    observations,
    ...overrides,
  }
}

function evaluate(query = bindMetricQuery(core()), expectedCandidateSha = candidateSha) {
  return evaluateMetrics({
    contract,
    query,
    expectedCandidateSha,
    expectedQueryVersion: contract.queryVersion,
  })
}

describe("Seed-and-Grow metric contract", () => {
  test("strictly covers every planned and Pre-Public metric", () => {
    expect(metricContractDigest(contract)).toBe(PrePublicMetricContractSha256)
    expect(contract.metrics).toHaveLength(44)
    expect(SeedGrowMetricId.options.every((id) => contract.metrics.some((metric) => metric.id === id))).toBe(true)
    expect(contract.prePublicGate.requiredMetricIds).toEqual([...PrePublicBlockingMetricIds])
    for (const id of SeedGrowMetricId.options) {
      const metric = contract.metrics.find((item) => item.id === id)
      expect(typeof metric?.formula).toBe("string")
      expect(typeof metric?.numerator).toBe("string")
      expect(typeof metric?.denominator).toBe("string")
      expect(Array.isArray(metric?.eventSource)).toBe(true)
      expect(typeof metric?.timeWindow).toBe("string")
      expect(typeof metric?.minimumSampleSize).toBe("number")
      expect(metric?.target.gate).toMatch(/^R[0-4]$/)
    }
    expect(() => MetricContract.parse({ ...contract, unknown: true })).toThrow()
  })

  test("evaluates a bound observation deterministically and enforces its threshold", () => {
    const first = bindMetricQuery(core())
    const second = bindMetricQuery({
      ...core(),
      metricIds: [...core().metricIds].reverse(),
      runIds: [...runIds].reverse(),
      observations: [
        {
          ...observation(),
          eventTypes: [...observation().eventTypes].reverse(),
          runIds: [...runIds].reverse(),
          sourceRefs: [...sourceRefs()].reverse(),
        },
      ],
    })
    expect(second.inputDigest).toBe(first.inputDigest)
    expect(evaluate(first)).toMatchObject({
      status: "pass",
      candidateSha,
      inputDigest: first.inputDigest,
      results: [
        {
          metricId: "false_completion_count",
          blocking: true,
          status: "pass",
          value: 0,
          meetsThreshold: true,
          blockedReasons: [],
        },
      ],
    })
    expect(evaluate(bindMetricQuery(core([observation("false_completion_count", { numerator: 1 })])))).toMatchObject({
      status: "failed",
      results: [{ status: "failed", value: 1, meetsThreshold: false }],
    })
  })

  test("blocks missing events, zero denominators, insufficient samples, and missing observations", () => {
    const eventTypes = observation().eventTypes.slice(1)
    const cases = [
      {
        query: bindMetricQuery(core([observation("false_completion_count", { eventTypes })])),
        reason: "missing_source_event",
      },
      {
        query: bindMetricQuery(core([observation("false_completion_count", { denominator: 0 })])),
        reason: "zero_denominator",
      },
      {
        query: bindMetricQuery(core([observation("false_completion_count", { sampleSize: 1 })])),
        reason: "insufficient_sample",
      },
      {
        query: bindMetricQuery(core([], { metricIds: ["false_completion_count"] })),
        reason: "missing_observation",
      },
    ] as const
    for (const item of cases) {
      expect(evaluate(item.query)).toMatchObject({
        status: "blocked",
        results: [{ status: "blocked", blockedReasons: expect.arrayContaining([item.reason]) }],
      })
    }
  })

  test("blocks query version, digest, candidate SHA, run, and source binding mismatches", () => {
    const valid = bindMetricQuery(core())
    const cases = [
      {
        query: bindMetricQuery(core([observation()], { queryVersion: "seed-grow-metric-query.v0" })),
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
        query: bindMetricQuery(
          core([
            observation("false_completion_count", {
              runIds: ["run-a", "run-c"],
            }),
          ]),
        ),
        expectedCandidateSha: candidateSha,
        reason: "run_binding_mismatch",
      },
      {
        query: bindMetricQuery(
          core([
            observation("false_completion_count", {
              sourceRefs: sourceRefs(otherCandidateSha),
            }),
          ]),
        ),
        expectedCandidateSha: candidateSha,
        reason: "source_binding_mismatch",
      },
    ] as const
    for (const item of cases) {
      expect(evaluate(item.query, item.expectedCandidateSha)).toMatchObject({
        status: "blocked",
        results: [{ status: "blocked", blockedReasons: expect.arrayContaining([item.reason]) }],
      })
    }
  })

  test("never reports pass when an observational metric lacks facts", () => {
    expect(
      evaluate(
        bindMetricQuery(
          core([], {
            metricIds: ["user_attention_count"],
          }),
        ),
      ),
    ).toMatchObject({
      status: "blocked",
      results: [{ blocking: false, status: "blocked", blockedReasons: ["missing_observation"] }],
    })
  })

  test("blocks a fixed applicable scenario run omitted from the declared metric subset", () => {
    expect(
      evaluate(
        bindMetricQuery(
          core(
            [
              observation("false_completion_count", {
                runIds: ["run-a"],
                sourceRefs: [sourceRefs()[0]!],
              }),
            ],
            {
              applicableRunIds: {
                false_completion_count: ["run-a"],
              },
            },
          ),
        ),
      ),
    ).toMatchObject({
      status: "blocked",
      results: [
        {
          metricId: "false_completion_count",
          status: "blocked",
          blockedReasons: expect.arrayContaining(["run_binding_mismatch"]),
        },
      ],
    })
  })
})
