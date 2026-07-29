import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect } from "bun:test"
import { MetricContract, type MetricSourceRef } from "@agents-company/shared/seed-grow-metrics"
import { Effect } from "effect"
import {
  bindPersistedFactArtifact,
  makePersistedFactArtifactAdapter,
  persistedMetricContractDigest,
  type PersistedFactArtifactCore,
  type PersistedFactRunBinding,
  type PersistedMetricEvent,
} from "../../src/metrics/persisted-fact-artifact"
import * as SeedGrowMetricReporter from "../../src/metrics/seed-grow-reporter"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const candidateSha = "a".repeat(40)
const snapshotDigest = "b".repeat(64)
const contract = MetricContract.parse(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../../docs/product-design/experience-refactor/metric-contract.v1.json"),
      "utf8",
    ),
  ) as unknown,
)
const it = testEffect(CrossSpawnSpawner.defaultLayer)

function runBindings(): PersistedFactRunBinding[] {
  return [
    {
      runId: "legacy-a",
      projectId: "legacy-project-a",
      strategy: "legacy_full_plan",
      scenarioId: "S13",
      snapshotDigest,
    },
    {
      runId: "legacy-b",
      projectId: "legacy-project-b",
      strategy: "legacy_full_plan",
      scenarioId: "S13",
      snapshotDigest,
    },
    {
      runId: "seed-a",
      projectId: "seed-project-a",
      strategy: "seed_and_grow",
      scenarioId: "S13",
      snapshotDigest,
    },
    {
      runId: "seed-b",
      projectId: "seed-project-b",
      strategy: "seed_and_grow",
      scenarioId: "S13",
      snapshotDigest,
    },
  ]
}

function sourceKind(eventType: string): MetricSourceRef["kind"] {
  if (eventType === "model.usage_recorded") return "agent_run"
  if (eventType === "work_receipt.submitted") return "work_receipt"
  if (eventType === "candidate.selected") return "project_assignment"
  if (eventType === "review.completed" || eventType === "delivery.criterion_evaluated") return "validation_gate"
  if (eventType === "benchmark.completed") return "benchmark_report"
  return "project_event"
}

function event(
  binding: PersistedFactRunBinding,
  eventType: string,
  suffix: string,
  properties: Record<string, unknown>,
): PersistedMetricEvent {
  const eventId = `${binding.runId}-${suffix}`
  return {
    eventId,
    eventType,
    occurredAt: "2026-07-29T00:30:00.000Z",
    projectId: binding.projectId,
    scenarioId: binding.scenarioId,
    runId: binding.runId,
    strategy: binding.strategy,
    subjectId: eventId,
    source: {
      kind: sourceKind(eventType),
      id: `source-${eventId}`,
      candidateSha,
      runId: binding.runId,
      digest: createHash("sha256").update(JSON.stringify(properties)).digest("hex"),
    },
    properties,
  }
}

function runEvents(binding: PersistedFactRunBinding, index: number) {
  const legacy = binding.strategy === "legacy_full_plan"
  return [
    event(binding, "trust.false_state_detected", "trust", {
      surface: "project",
      kind: "audit_clear",
    }),
    event(binding, "project.completed", "project", {
      projectId: binding.projectId,
      strategy: binding.strategy,
    }),
    event(binding, "benchmark.completed", "benchmark", {
      scenarioId: binding.scenarioId,
      finalDecision: "pass",
    }),
    event(binding, "model.usage_recorded", "usage", {
      runId: binding.runId,
      strategy: binding.strategy,
      purpose: "worker",
      modelCalls: legacy ? 5 : 4,
      tokens: legacy ? 1_000 : 800,
      cost: legacy ? 10 : 8,
    }),
    event(binding, "review.completed", "review", {
      risk: "low",
      invoked: legacy || index === 0,
      rejected: false,
      findingConfirmed: false,
    }),
    event(binding, "work_receipt.submitted", "receipt", {
      receiptId: `${binding.runId}-receipt`,
      attemptId: `${binding.runId}-attempt`,
      sourceRefCount: 1,
      unknownCount: legacy ? 1 : 2,
    }),
    event(binding, "candidate.selected", "candidate", {
      candidateId: `${binding.runId}-candidate`,
      reused: !legacy || index === 0,
      createdForNeed: legacy && index === 1,
    }),
    event(binding, "delivery.criterion_evaluated", "criterion", {
      deliveryId: `${binding.runId}-delivery`,
      criterionId: `${binding.runId}-criterion`,
      status: "pass",
      evidenceCount: 1,
      risk: "low",
      strategy: binding.strategy,
    }),
  ]
}

function artifactCore(): PersistedFactArtifactCore {
  const bindings = runBindings()
  return {
    schemaVersion: 1,
    kind: "seed-grow-local-gate-persisted-facts",
    id: "persisted-facts-001",
    producer: {
      kind: "local_gate",
      commandId: "seed-grow-persisted-fact-collector",
      version: "v1",
      executableDigest: "c".repeat(64),
    },
    candidateSha,
    metricContractDigest: persistedMetricContractDigest(contract),
    metricQueryVersion: contract.queryVersion,
    shadowQueryVersion: "seed-grow-shadow-query.v1",
    window: {
      id: "candidate-window",
      startedAt: "2026-07-29T00:00:00.000Z",
      endedAt: "2026-07-29T01:00:00.000Z",
    },
    runBindings: bindings,
    events: bindings.flatMap((binding, index) => runEvents(binding, index % 2)),
  }
}

async function adapter(
  directory: string,
  options: {
    expectedDigest?: string
    core?: PersistedFactArtifactCore
  } = {},
) {
  const source = `${JSON.stringify(bindPersistedFactArtifact(options.core ?? artifactCore()), null, 2)}\n`
  const target = path.join(directory, "persisted-facts.json")
  await Bun.write(target, source)
  return makePersistedFactArtifactAdapter({
    path: target,
    sha256: options.expectedDigest ?? createHash("sha256").update(source).digest("hex"),
  })
}

function reportWith(facts: Awaited<ReturnType<typeof makePersistedFactArtifactAdapter>>, metricIds: string[]) {
  return SeedGrowMetricReporter.Service.use((reporter) =>
    reporter.report({
      contract,
      candidateSha,
      metricIds,
    }),
  ).pipe(Effect.provide(SeedGrowMetricReporter.makeLayer(facts)))
}

describe("SeedGrowMetricReporter", () => {
  it.live("calculates metrics from a digest-bound persisted raw fact artifact", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const facts = yield* Effect.promise(() => adapter(directory))
      const report = yield* reportWith(facts, ["false_completion_count"])
      expect(report).toMatchObject({
        status: "pass",
        candidateSha,
        results: [
          {
            metricId: "false_completion_count",
            status: "pass",
            value: 0,
            numerator: 0,
            denominator: 2,
            sampleSize: 2,
          },
        ],
      })
      expect(report.results[0]?.sourceRefs).toHaveLength(8)
      expect(report.results[0]?.sourceRefs.filter((source) => source.kind === "gate_report")).toHaveLength(2)
    }),
  )

  it.live("keeps unconnected B2 and B3 facts blocked instead of synthesizing pass", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const facts = yield* Effect.promise(() => adapter(directory))
      const report = yield* reportWith(facts, ["graph_mutation_without_evidence_rate", "receipt_recovery_success_rate"])
      expect(report.status).toBe("blocked")
      expect(report.results.every((result) => result.status === "blocked")).toBe(true)
      expect(report.results.find((result) => result.metricId === "graph_mutation_without_evidence_rate")).toMatchObject(
        {
          blockedReasons: ["missing_observation"],
          sourceRefs: [],
        },
      )
      expect(report.results.find((result) => result.metricId === "receipt_recovery_success_rate")).toMatchObject({
        blockedReasons: ["missing_observation"],
      })
    }),
  )

  it.live("blocks a metric when any contracted source event is absent", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const core = artifactCore()
      const facts = yield* Effect.promise(() =>
        adapter(directory, {
          core: {
            ...core,
            events: core.events.filter((event) => event.eventType !== "trust.false_state_detected"),
          },
        }),
      )
      const report = yield* reportWith(facts, ["false_completion_count"])
      expect(report).toMatchObject({
        status: "blocked",
        results: [
          {
            metricId: "false_completion_count",
            status: "blocked",
            blockedReasons: ["missing_observation"],
          },
        ],
      })
    }),
  )

  it.live("derives matched legacy and seed_and_grow Shadow facts inside the reporter", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const facts = yield* Effect.promise(() => adapter(directory))
      const report = yield* SeedGrowMetricReporter.Service.use((reporter) =>
        reporter.compareShadow({
          contract,
          candidateSha,
          comparisonId: "shadow-001",
          scenarioIds: ["S13"],
        }),
      ).pipe(Effect.provide(SeedGrowMetricReporter.makeLayer(facts)))
      expect(report).toMatchObject({
        status: "pass",
        candidateSha,
        deltas: {
          completenessRateDelta: 0,
          modelCallsPerUnitDelta: -1,
          costPerUnitDelta: -2,
          reviewerInvocationRatio: 0.5,
          unknownDiscoveryRateDelta: 1,
          errorRateDelta: 0,
          candidateReuseRateDelta: 0.5,
          lowRiskQualityRatio: 1,
        },
      })
    }),
  )

  it.live("rejects an artifact whose bytes do not match the bound digest", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const rejected = yield* Effect.promise(() =>
        adapter(directory, { expectedDigest: "f".repeat(64) }).then(
          () => false,
          () => true,
        ),
      )
      expect(rejected).toBe(true)
    }),
  )

  it.live("blocks metric evaluation when the artifact contract digest is stale", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const core = artifactCore()
      const facts = yield* Effect.promise(() =>
        adapter(directory, {
          core: {
            ...core,
            metricContractDigest: "f".repeat(64),
          },
        }),
      )
      const report = yield* reportWith(facts, ["false_completion_count"])
      expect(report).toMatchObject({
        status: "blocked",
        results: [
          {
            metricId: "false_completion_count",
            status: "blocked",
            blockedReasons: ["missing_observation"],
          },
        ],
      })
    }),
  )

  it.live("blocks Shadow comparison when one matched run lacks a required raw fact", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const core = artifactCore()
      const facts = yield* Effect.promise(() =>
        adapter(directory, {
          core: {
            ...core,
            events: core.events.filter((record) => record.eventId !== "seed-b-usage"),
          },
        }),
      )
      const report = yield* SeedGrowMetricReporter.Service.use((reporter) =>
        reporter.compareShadow({
          contract,
          candidateSha,
          comparisonId: "shadow-missing-fact",
          scenarioIds: ["S13"],
        }),
      ).pipe(Effect.provide(SeedGrowMetricReporter.makeLayer(facts)))
      expect(report).toMatchObject({
        status: "blocked",
        blockedReasons: expect.arrayContaining(["source_binding_mismatch"]),
        deltas: null,
      })
    }),
  )
})
