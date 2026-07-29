import {
  MetricContract,
  MetricQueryCore,
  bindMetricQuery,
  evaluateMetrics,
  type MetricEvaluationReport,
} from "@agents-company/shared/seed-grow-metrics"
import {
  ShadowComparisonCore,
  bindShadowComparison,
  evaluateShadowComparison,
  type ShadowComparisonReport,
} from "@agents-company/shared/seed-grow-shadow"
import { Context, Effect, Layer } from "effect"
import z from "zod"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Identifier = z.string().trim().min(1).max(500)
const UniqueIdentifiers = z
  .array(Identifier)
  .min(1)
  .max(500)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Values must be unique" })
  })
const Strategy = z.enum(["legacy_full_plan", "seed_and_grow"])

export const MetricFactReadRequest = z
  .object({
    contract: MetricContract,
    candidateSha: CandidateSha,
    queryVersion: z.string().trim().min(1).max(100),
    metricIds: UniqueIdentifiers,
    strategy: Strategy,
  })
  .strict()
export type MetricFactReadRequest = z.infer<typeof MetricFactReadRequest>

export const ShadowFactReadRequest = z
  .object({
    contract: MetricContract,
    candidateSha: CandidateSha,
    queryVersion: z.string().trim().min(1).max(100),
    comparisonId: Identifier,
    scenarioIds: UniqueIdentifiers,
  })
  .strict()
export type ShadowFactReadRequest = z.infer<typeof ShadowFactReadRequest>

export interface MetricFactAdapter {
  readonly readMetricFacts: (request: MetricFactReadRequest) => Effect.Effect<MetricQueryCore>
  readonly readShadowFacts: (request: ShadowFactReadRequest) => Effect.Effect<ShadowComparisonCore>
}

export const MetricReportRequest = z
  .object({
    contract: MetricContract,
    candidateSha: CandidateSha,
    metricIds: UniqueIdentifiers,
    strategy: Strategy.default("seed_and_grow"),
  })
  .strict()
export type MetricReportRequest = z.input<typeof MetricReportRequest>

export const ShadowReportRequest = z
  .object({
    contract: MetricContract,
    candidateSha: CandidateSha,
    comparisonId: Identifier,
    scenarioIds: UniqueIdentifiers,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.contract.shadowComparison)
      context.addIssue({ code: "custom", message: "Metric contract has no Shadow comparison policy" })
  })
export type ShadowReportRequest = z.infer<typeof ShadowReportRequest>

export interface Interface {
  readonly report: (request: MetricReportRequest) => Effect.Effect<MetricEvaluationReport>
  readonly compareShadow: (request: ShadowReportRequest) => Effect.Effect<ShadowComparisonReport>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/SeedGrowMetricReporter") {}

export function makeLayer(adapter: MetricFactAdapter) {
  return Layer.succeed(
    Service,
    Service.of({
      report: (raw) =>
        Effect.gen(function* () {
          const request = MetricReportRequest.parse(raw)
          const facts = yield* adapter.readMetricFacts({
            contract: request.contract,
            candidateSha: request.candidateSha,
            queryVersion: request.contract.queryVersion,
            metricIds: request.metricIds,
            strategy: request.strategy,
          })
          return evaluateMetrics({
            contract: request.contract,
            query: bindMetricQuery(facts),
            expectedCandidateSha: request.candidateSha,
            expectedQueryVersion: request.contract.queryVersion,
          })
        }),
      compareShadow: (raw) =>
        Effect.gen(function* () {
          const request = ShadowReportRequest.parse(raw)
          const policy = request.contract.shadowComparison
          if (!policy) return yield* Effect.die(new Error("Metric contract has no Shadow comparison policy"))
          const facts = yield* adapter.readShadowFacts({
            contract: request.contract,
            candidateSha: request.candidateSha,
            queryVersion: policy.queryVersion,
            comparisonId: request.comparisonId,
            scenarioIds: request.scenarioIds,
          })
          return evaluateShadowComparison({
            policy,
            query: bindShadowComparison(facts),
            expectedCandidateSha: request.candidateSha,
            expectedQueryVersion: policy.queryVersion,
          })
        }),
    }),
  )
}

export * as SeedGrowMetricReporter from "./seed-grow-reporter"
