import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import path from "node:path"
import {
  MetricContract,
  MetricObservation,
  MetricQueryCore,
  MetricSourceRef,
  metricContractDigest,
  type MetricDefinition,
} from "@agents-company/shared/seed-grow-metrics"
import {
  ShadowComparisonCore,
  type ShadowFact,
  type ShadowStrategy,
  type ShadowStrategyAggregate,
} from "@agents-company/shared/seed-grow-shadow"
import { Effect } from "effect"
import z from "zod"
import type { MetricFactAdapter, MetricFactReadRequest, ShadowFactReadRequest } from "./seed-grow-reporter"

const CandidateSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Identifier = z.string().trim().min(1).max(500)
const Timestamp = z.string().datetime()
const Strategy = z.enum(["legacy_full_plan", "seed_and_grow"])
export type PersistedFactStrategy = z.infer<typeof Strategy>
const CrossStrategyMetricIds = new Set(["reviewer_invocation_ratio_vs_legacy", "candidate_reuse_delta_vs_legacy"])

const Window = z
  .object({
    id: Identifier,
    startedAt: Timestamp,
    endedAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) <= Date.parse(value.startedAt))
      context.addIssue({ code: "custom", message: "Fact window must end after it starts" })
  })

export const PersistedFactRunBinding = z
  .object({
    runId: Identifier,
    projectId: Identifier,
    strategy: Strategy,
    scenarioId: Identifier,
    snapshotDigest: Digest,
  })
  .strict()
export type PersistedFactRunBinding = z.infer<typeof PersistedFactRunBinding>

export const PersistedMetricEvent = z
  .object({
    eventId: Identifier,
    eventType: z.string().trim().min(1).max(240),
    occurredAt: Timestamp,
    projectId: Identifier,
    scenarioId: Identifier,
    runId: Identifier,
    strategy: Strategy,
    subjectId: Identifier,
    source: MetricSourceRef,
    properties: z.record(z.string(), z.unknown()),
  })
  .strict()
export type PersistedMetricEvent = z.infer<typeof PersistedMetricEvent>

const PersistedFactArtifactCoreShape = {
  schemaVersion: z.literal(1),
  kind: z.literal("seed-grow-local-gate-persisted-facts"),
  id: Identifier,
  producer: z
    .object({
      kind: z.literal("local_gate"),
      commandId: Identifier,
      version: Identifier,
      executableDigest: Digest,
    })
    .strict(),
  candidateSha: CandidateSha,
  metricContractDigest: Digest,
  metricQueryVersion: z.literal("seed-grow-metric-query.v1"),
  shadowQueryVersion: z.literal("seed-grow-shadow-query.v1"),
  window: Window,
  runBindings: z.array(PersistedFactRunBinding).min(1).max(10_000),
  events: z.array(PersistedMetricEvent).max(500_000),
} as const

export const PersistedFactArtifactCore = z.object(PersistedFactArtifactCoreShape).strict()
export type PersistedFactArtifactCore = z.infer<typeof PersistedFactArtifactCore>

export const PersistedFactArtifact = z
  .object({
    ...PersistedFactArtifactCoreShape,
    snapshotDigest: Digest,
  })
  .strict()
  .superRefine((value, context) => {
    const runIds = value.runBindings.map((binding) => binding.runId)
    const eventIds = value.events.map((event) => event.eventId)
    const sourceIds = value.events.map((event) => `${event.source.kind}:${event.source.id}`)
    if (new Set(runIds).size !== runIds.length)
      context.addIssue({ code: "custom", message: "Run bindings must be unique" })
    if (new Set(eventIds).size !== eventIds.length)
      context.addIssue({ code: "custom", message: "Persisted event identifiers must be unique" })
    if (new Set(sourceIds).size !== sourceIds.length)
      context.addIssue({ code: "custom", message: "Persisted source bindings must be unique" })
    for (const event of value.events) {
      const binding = value.runBindings.find((item) => item.runId === event.runId)
      if (
        !binding ||
        binding.projectId !== event.projectId ||
        binding.strategy !== event.strategy ||
        binding.scenarioId !== event.scenarioId
      )
        context.addIssue({ code: "custom", message: `Event ${event.eventId} has no exact run binding` })
      if (event.source.candidateSha !== value.candidateSha || event.source.runId !== event.runId)
        context.addIssue({ code: "custom", message: `Event ${event.eventId} has a mismatched source binding` })
      const boundProperties = [
        ["candidateSha", value.candidateSha],
        ["projectId", event.projectId],
        ["scenarioId", event.scenarioId],
        ["runId", event.runId],
        ["strategy", event.strategy],
      ] as const
      for (const [key, expected] of boundProperties) {
        if (Object.prototype.hasOwnProperty.call(event.properties, key) && event.properties[key] !== expected)
          context.addIssue({
            code: "custom",
            message: `Event ${event.eventId} property ${key} has a mismatched binding`,
          })
      }
      if (
        Date.parse(event.occurredAt) < Date.parse(value.window.startedAt) ||
        Date.parse(event.occurredAt) > Date.parse(value.window.endedAt)
      )
        context.addIssue({ code: "custom", message: `Event ${event.eventId} is outside the fact window` })
    }
  })
export type PersistedFactArtifact = z.infer<typeof PersistedFactArtifact>

export const PersistedFactArtifactReference = z
  .object({
    path: z.string().refine((value) => path.isAbsolute(value)),
    sha256: Digest,
  })
  .strict()
export type PersistedFactArtifactReference = z.infer<typeof PersistedFactArtifactReference>

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

function normalizedArtifact(raw: unknown) {
  const artifact = PersistedFactArtifactCore.parse(
    typeof raw === "object" && raw !== null
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "snapshotDigest"))
      : raw,
  )
  return {
    ...artifact,
    runBindings: [...artifact.runBindings].sort((left, right) => canonical(left).localeCompare(canonical(right))),
    events: [...artifact.events].sort((left, right) => canonical(left).localeCompare(canonical(right))),
  }
}

export function persistedFactSnapshotDigest(raw: unknown) {
  return sha256(canonical(normalizedArtifact(raw)))
}

export function persistedMetricContractDigest(raw: unknown) {
  return metricContractDigest(raw)
}

export function bindPersistedFactArtifact(raw: unknown) {
  const artifact = PersistedFactArtifactCore.parse(raw)
  return PersistedFactArtifact.parse({
    ...artifact,
    snapshotDigest: persistedFactSnapshotDigest(artifact),
  })
}

export async function loadPersistedFactArtifact(raw: unknown) {
  const reference = PersistedFactArtifactReference.parse(raw)
  const info = await lstat(reference.path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Metric fact artifact is not a regular file: ${reference.path}`)
  const bytes = new Uint8Array(await Bun.file(reference.path).arrayBuffer())
  if (sha256(bytes) !== reference.sha256) throw new Error(`Metric fact artifact digest mismatch: ${reference.path}`)
  const artifact = PersistedFactArtifact.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  if (persistedFactSnapshotDigest(artifact) !== artifact.snapshotDigest)
    throw new Error(`Metric fact snapshot digest mismatch: ${reference.path}`)
  return artifact
}

function property(event: PersistedMetricEvent, key: string) {
  return event.properties[key]
}

function stringProperty(event: PersistedMetricEvent, key: string) {
  const value = property(event, key)
  return typeof value === "string" ? value : undefined
}

function numberProperty(event: PersistedMetricEvent, key: string) {
  const value = property(event, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanProperty(event: PersistedMetricEvent, key: string) {
  const value = property(event, key)
  return typeof value === "boolean" ? value : undefined
}

function candidateShaProperty(event: PersistedMetricEvent, key: string) {
  const value = stringProperty(event, key)
  return value && CandidateSha.safeParse(value).success ? value : undefined
}

function digestProperty(event: PersistedMetricEvent, key: string) {
  const value = stringProperty(event, key)
  return value && Digest.safeParse(value).success ? value : undefined
}

function eventsOf(events: PersistedMetricEvent[], eventType: string) {
  return events.filter((event) => event.eventType === eventType)
}

function uniqueSourceRefs(sources: MetricSourceRef[]) {
  return [
    ...new Map(
      sources
        .sort((left, right) => canonical(left).localeCompare(canonical(right)))
        .map((source) => [canonical(source), source]),
    ).values(),
  ]
}

function uniqueSources(events: PersistedMetricEvent[]) {
  return uniqueSourceRefs(events.map((event) => event.source))
}

function groupedByRun(events: PersistedMetricEvent[], runIds: string[]) {
  return runIds.map((runId) => events.filter((event) => event.runId === runId))
}

type MetricAggregate = {
  numerator: number
  denominator: number
  sampleSize: number
  values?: number[]
}

function ratio(numerator: number, denominator: number): MetricAggregate {
  return { numerator, denominator, sampleSize: denominator }
}

function matchedRunPairCount(events: PersistedMetricEvent[]) {
  const legacyRunIds = new Set(
    events.filter((event) => event.strategy === "legacy_full_plan").map((event) => event.runId),
  )
  const seedRunIds = new Set(events.filter((event) => event.strategy === "seed_and_grow").map((event) => event.runId))
  if (!legacyRunIds.size || legacyRunIds.size !== seedRunIds.size) return undefined
  return seedRunIds.size
}

function successfulTerminalCheck(event: PersistedMetricEvent) {
  return (
    candidateShaProperty(event, "candidateSha") === event.source.candidateSha &&
    stringProperty(event, "localGate") === "success" &&
    stringProperty(event, "deployment") === "success" &&
    stringProperty(event, "rollback") === "success" &&
    booleanProperty(event, "reproducible") === true
  )
}

function consecutiveCandidateAggregate(events: PersistedMetricEvent[], runIds: string[]): MetricAggregate | undefined {
  const checks = eventsOf(events, "candidate.terminal_checked")
  const benchmarks = eventsOf(events, "benchmark.completed")
  const previousCandidateShas = checks
    .map((event) => candidateShaProperty(event, "previousCandidateSha"))
    .filter((value): value is string => value !== undefined)
  const terminalEvidenceDigests = checks
    .map((event) => digestProperty(event, "terminalEvidenceDigest"))
    .filter((value): value is string => value !== undefined)
  const isolatedRunIndexes = checks
    .map((event) => numberProperty(event, "isolatedRunIndex"))
    .sort((left, right) => (left ?? 0) - (right ?? 0))
  if (
    runIds.length !== 2 ||
    checks.length !== 2 ||
    new Set(checks.map((event) => event.runId)).size !== 2 ||
    !runIds.every((runId) => checks.some((event) => event.runId === runId)) ||
    !runIds.every((runId) =>
      benchmarks.some((event) => event.runId === runId && stringProperty(event, "finalDecision") === "pass"),
    ) ||
    isolatedRunIndexes[0] !== 1 ||
    isolatedRunIndexes[1] !== 2 ||
    checks.some((event) => !successfulTerminalCheck(event)) ||
    checks.some((event) => booleanProperty(event, "immediateAncestry") !== true) ||
    previousCandidateShas.length !== 2 ||
    new Set(previousCandidateShas).size !== 1 ||
    previousCandidateShas[0] === checks[0]?.source.candidateSha ||
    terminalEvidenceDigests.length !== 2 ||
    new Set(terminalEvidenceDigests).size !== 2
  )
    return undefined
  return {
    numerator: 2,
    denominator: 2,
    sampleSize: 2,
  }
}

function metricAggregate(
  metricId: string,
  events: PersistedMetricEvent[],
  runIds: string[],
): MetricAggregate | undefined {
  const benchmarks = eventsOf(events, "benchmark.completed")
  const projects = eventsOf(events, "project.completed")
  const criteria = eventsOf(events, "delivery.criterion_evaluated")
  const assignments = eventsOf(events, "project_assignment.activated")
  const selections = eventsOf(events, "candidate.selected")
  const reviews = eventsOf(events, "review.completed")
  const usages = eventsOf(events, "model.usage_recorded")

  if (metricId === "false_completion_count")
    return {
      numerator: eventsOf(events, "trust.false_state_detected").filter(
        (event) => stringProperty(event, "kind") === "false_completion",
      ).length,
      denominator: projects.length,
      sampleSize: projects.length,
    }
  if (metricId === "acceptance_criterion_evidence_coverage")
    return ratio(criteria.filter((event) => (numberProperty(event, "evidenceCount") ?? 0) > 0).length, criteria.length)
  if (metricId === "graph_repair_success_rate") {
    const repairs = eventsOf(events, "graph_repair.completed")
    return ratio(
      repairs.filter((event) => booleanProperty(event, "passedOriginalCriterion") === true).length,
      repairs.length,
    )
  }
  if (metricId === "blind_retry_rate") {
    const repairs = eventsOf(events, "graph_repair.completed")
    return ratio(
      repairs.reduce((total, event) => total + (numberProperty(event, "blindRetryCount") ?? 0), 0),
      repairs.reduce((total, event) => total + (numberProperty(event, "attemptCount") ?? 0), 0),
    )
  }
  if (metricId === "validation_gate_false_pass_rate") {
    const gates = eventsOf(events, "validation_gate.evaluated").filter(
      (event) => booleanProperty(event, "passed") === true,
    )
    return ratio(gates.filter((event) => booleanProperty(event, "falsePass") === true).length, gates.length)
  }
  if (metricId === "delivery_consumability_rate") {
    const presented = eventsOf(events, "delivery.presented")
    const opened = eventsOf(events, "delivery.artifact_opened")
    return ratio(
      presented.filter((delivery) => {
        const deliveryId = stringProperty(delivery, "deliveryId")
        return (
          opened.some(
            (event) =>
              stringProperty(event, "deliveryId") === deliveryId && booleanProperty(event, "succeeded") === true,
          ) ||
          (numberProperty(delivery, "artifactCount") === 0 && Boolean(stringProperty(delivery, "noFileReason")?.trim()))
        )
      }).length,
      presented.length,
    )
  }
  if (metricId === "recovery_success_rate") {
    const losses = eventsOf(events, "connection.lost")
    const recoveries = eventsOf(events, "connection.recovered")
    return ratio(
      recoveries.filter(
        (event) =>
          booleanProperty(event, "contextPreserved") === true && numberProperty(event, "duplicateSideEffects") === 0,
      ).length,
      losses.length,
    )
  }
  if (metricId === "complex_initial_assignment_median") {
    const values = groupedByRun(assignments, runIds).map(
      (items) => items.filter((event) => booleanProperty(event, "initial") === true).length,
    )
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "agent_count_before_first_receipt") {
    const values = groupedByRun(events, runIds).map((items) => {
      const firstReceipt = eventsOf(items, "work_receipt.submitted")
        .map((event) => Date.parse(event.occurredAt))
        .sort((left, right) => left - right)[0]
      if (firstReceipt === undefined) return 0
      return new Set(
        eventsOf(items, "project_assignment.activated")
          .filter((event) => Date.parse(event.occurredAt) <= firstReceipt)
          .map((event) => stringProperty(event, "agentId"))
          .filter((value): value is string => value !== undefined),
      ).size
    })
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "agent_count_added_after_receipt") {
    const values = groupedByRun(events, runIds).map((items) => {
      const firstReceipt = eventsOf(items, "work_receipt.submitted")
        .map((event) => Date.parse(event.occurredAt))
        .sort((left, right) => left - right)[0]
      if (firstReceipt === undefined) return 0
      return new Set(
        eventsOf(items, "project_assignment.activated")
          .filter((event) => Date.parse(event.occurredAt) > firstReceipt)
          .map((event) => stringProperty(event, "agentId"))
          .filter((value): value is string => value !== undefined),
      ).size
    })
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "reviewer_invocation_ratio_vs_legacy") {
    const pairCount = matchedRunPairCount(events)
    const legacyReviews = reviews.filter((event) => event.strategy === "legacy_full_plan")
    const seedReviews = reviews.filter((event) => event.strategy === "seed_and_grow")
    const legacyBenchmarks = benchmarks.filter((event) => event.strategy === "legacy_full_plan")
    const seedBenchmarks = benchmarks.filter((event) => event.strategy === "seed_and_grow")
    if (!pairCount || !legacyBenchmarks.length || !seedBenchmarks.length) return undefined
    return {
      numerator:
        seedReviews.filter((event) => booleanProperty(event, "invoked") === true).length * legacyBenchmarks.length,
      denominator:
        legacyReviews.filter((event) => booleanProperty(event, "invoked") === true).length * seedBenchmarks.length,
      sampleSize: pairCount,
    }
  }
  if (metricId === "candidate_reuse_rate")
    return ratio(selections.filter((event) => booleanProperty(event, "reused") === true).length, selections.length)
  if (metricId === "candidate_reuse_delta_vs_legacy") {
    const pairCount = matchedRunPairCount(selections)
    const legacySelections = selections.filter((event) => event.strategy === "legacy_full_plan")
    const seedSelections = selections.filter((event) => event.strategy === "seed_and_grow")
    if (!pairCount || !legacySelections.length || !seedSelections.length) return undefined
    const delta =
      seedSelections.filter((event) => booleanProperty(event, "reused") === true).length / seedSelections.length -
      legacySelections.filter((event) => booleanProperty(event, "reused") === true).length / legacySelections.length
    return {
      numerator: delta * pairCount,
      denominator: pairCount,
      sampleSize: pairCount,
    }
  }
  if (metricId === "new_candidate_per_completed_project")
    return ratio(
      selections.filter((event) => booleanProperty(event, "createdForNeed") === true).length,
      benchmarks.length,
    )
  if (metricId === "unnecessary_reviewer_rate") {
    const lowRisk = reviews.filter((event) => stringProperty(event, "risk") === "low")
    return ratio(lowRisk.filter((event) => booleanProperty(event, "invoked") === true).length, lowRisk.length)
  }
  if (metricId === "reviewer_rejection_precision") {
    const rejected = reviews.filter((event) => booleanProperty(event, "rejected") === true)
    return ratio(
      rejected.filter((event) => booleanProperty(event, "findingConfirmed") === true).length,
      rejected.length,
    )
  }
  if (metricId === "agent_load_balance") {
    const values = groupedByRun(assignments, runIds).map((items) => {
      const counts = new Map<string, number>()
      items.forEach((event) => {
        const agentId = stringProperty(event, "agentId")
        if (agentId) counts.set(agentId, (counts.get(agentId) ?? 0) + 1)
      })
      return items.length ? Math.max(0, ...counts.values()) / items.length : 0
    })
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "automated_graph_decision_rate") {
    const decisions = eventsOf(events, "graph_decision.recorded")
    return ratio(decisions.filter((event) => booleanProperty(event, "automated") === true).length, decisions.length)
  }
  if (metricId === "user_attention_count")
    return {
      numerator: eventsOf(events, "attention.opened").filter(
        (event) => booleanProperty(event, "interruptsUser") === true,
      ).length,
      denominator: benchmarks.length,
      sampleSize: benchmarks.length,
    }
  if (metricId === "invalid_interruption_rate") {
    const judged = eventsOf(events, "user.interruption_judged")
    return ratio(judged.filter((event) => booleanProperty(event, "needed") === false).length, judged.length)
  }
  if (metricId === "material_attention_precision") {
    const judged = eventsOf(events, "attention.judged")
    return ratio(judged.filter((event) => booleanProperty(event, "valid") === true).length, judged.length)
  }
  if (metricId === "unresolved_ask_latency_ms") {
    const values = eventsOf(events, "attention.resolved")
      .map((event) => numberProperty(event, "latencyMs"))
      .filter((value): value is number => value !== undefined)
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "three_round_circuit_breaker_count")
    return {
      numerator: eventsOf(events, "repair.circuit_opened").length,
      denominator: benchmarks.length,
      sampleSize: benchmarks.length,
    }
  if (metricId === "accepted_delivery_cost")
    return ratio(
      eventsOf(events, "model.cost_recorded").reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
      eventsOf(events, "delivery.accepted").length,
    )
  if (metricId === "wayfinder_cost") {
    const records = usages.filter((event) => stringProperty(event, "purpose") === "wayfinder")
    return ratio(
      records.reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
      records.length,
    )
  }
  if (metricId === "reviewer_cost") {
    const records = usages.filter((event) => stringProperty(event, "purpose") === "reviewer")
    return ratio(
      records.reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
      records.length,
    )
  }
  if (metricId === "total_model_calls_by_strategy")
    return {
      numerator: usages.reduce((total, event) => total + (numberProperty(event, "modelCalls") ?? 0), 0),
      denominator: benchmarks.length,
      sampleSize: benchmarks.length,
    }
  if (metricId === "failed_attempt_cost_reuse_rate") {
    const attempts = eventsOf(events, "work_attempt.finished").filter(
      (event) => stringProperty(event, "outcome") === "failed",
    )
    return ratio(
      attempts
        .filter((event) => booleanProperty(event, "reusableKnowledge") === true)
        .reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
      attempts.reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
    )
  }
  if (metricId === "graph_growth_node_count") {
    const values = eventsOf(events, "graph_decision.recorded")
      .map((event) => numberProperty(event, "addedNodeCount"))
      .filter((value): value is number => value !== undefined)
    return {
      numerator: values.reduce((total, value) => total + value, 0),
      denominator: values.length,
      sampleSize: values.length,
      values,
    }
  }
  if (metricId === "graph_mutation_without_evidence_rate") {
    const mutations = eventsOf(events, "graph_mutation.evaluated")
    return ratio(mutations.filter((event) => numberProperty(event, "evidenceCount") === 0).length, mutations.length)
  }
  if (metricId === "receipt_recovery_success_rate") {
    const losses = eventsOf(events, "connection.lost")
    return ratio(
      eventsOf(events, "work_receipt.processed").filter(
        (event) => booleanProperty(event, "recovered") === true && booleanProperty(event, "duplicate") === false,
      ).length,
      losses.length,
    )
  }
  if (metricId === "graph_mutation_recovery_success_rate") {
    const losses = eventsOf(events, "connection.lost")
    return ratio(
      eventsOf(events, "graph_mutation.recovered").filter(
        (event) => booleanProperty(event, "consistent") === true && numberProperty(event, "duplicateSideEffects") === 0,
      ).length,
      losses.length,
    )
  }
  if (metricId === "acceptance_determinability_rate")
    return ratio(
      criteria.filter(
        (event) =>
          stringProperty(event, "status") !== "not_evaluated" && (numberProperty(event, "evidenceCount") ?? 0) > 0,
      ).length,
      criteria.length,
    )
  if (metricId === "low_risk_quality_ratio_vs_legacy") {
    const compared = eventsOf(events, "delivery.quality_compared").filter(
      (event) => stringProperty(event, "risk") === "low",
    )
    return ratio(
      compared.reduce((total, event) => total + (numberProperty(event, "seedGrowScore") ?? 0), 0),
      compared.reduce((total, event) => total + (numberProperty(event, "legacyScore") ?? 0), 0),
    )
  }
  if (metricId === "core_task_completion_rate")
    return ratio(
      benchmarks.filter((event) => stringProperty(event, "finalDecision") === "pass").length,
      benchmarks.length,
    )
  if (metricId === "exact_sha_terminal_success_rate") {
    const checks = eventsOf(events, "candidate.terminal_checked")
    return ratio(checks.filter(successfulTerminalCheck).length, checks.length)
  }
  if (metricId === "consecutive_reproducible_candidate_count") return consecutiveCandidateAggregate(events, runIds)
  return undefined
}

function validEvents(artifact: PersistedFactArtifact, contract: MetricContract) {
  return artifact.events.filter((event) => {
    const eventContract = contract.eventTypes.find((item) => item.id === event.eventType)
    return eventContract?.requiredProperties.every((key) => Object.prototype.hasOwnProperty.call(event.properties, key))
  })
}

function validShadowPairs(events: PersistedMetricEvent[], bindings: PersistedFactRunBinding[]) {
  const comparisons = eventsOf(events, "shadow.compared")
  const legacyBindings = bindings.filter((binding) => binding.strategy === "legacy_full_plan")
  const seedBindings = bindings.filter((binding) => binding.strategy === "seed_and_grow")
  const pairs = comparisons.flatMap((event) => {
    const legacyRunId = stringProperty(event, "legacyRunId")
    const seedRunId = stringProperty(event, "seedGrowRunId")
    if (!legacyRunId || !seedRunId) return []
    return [{ event, legacyRunId, seedRunId }]
  })
  if (
    !legacyBindings.length ||
    legacyBindings.length !== seedBindings.length ||
    pairs.length !== seedBindings.length ||
    new Set(pairs.map((pair) => pair.legacyRunId)).size !== legacyBindings.length ||
    new Set(pairs.map((pair) => pair.seedRunId)).size !== seedBindings.length ||
    !legacyBindings.every((binding) => pairs.some((pair) => pair.legacyRunId === binding.runId)) ||
    !seedBindings.every((binding) => pairs.some((pair) => pair.seedRunId === binding.runId))
  )
    return false
  return pairs.every((pair) => {
    const legacy = legacyBindings.find((binding) => binding.runId === pair.legacyRunId)
    const seed = seedBindings.find((binding) => binding.runId === pair.seedRunId)
    return (
      pair.event.runId === pair.seedRunId &&
      legacy?.scenarioId === seed?.scenarioId &&
      legacy?.snapshotDigest === seed?.snapshotDigest
    )
  })
}

function observation(
  metric: MetricDefinition,
  records: PersistedMetricEvent[],
  calculationRunIds: string[],
  observationRunIds: string[],
  strategy: PersistedFactStrategy,
  artifactSources: MetricSourceRef[],
  bindings: PersistedFactRunBinding[],
): MetricObservation | undefined {
  if (!metric.eventSource || !metric.timeWindow || !metric.minimumSampleSize) return undefined
  const sources = records.filter((event) => metric.eventSource?.includes(event.eventType))
  if (!sources.length) return undefined
  const aggregate = metricAggregate(metric.id, sources, calculationRunIds)
  if (!aggregate) return undefined
  const coveredEventTypes =
    metric.id === "false_completion_count"
      ? calculationRunIds.every((runId) =>
          ["project.completed", "benchmark.completed"].every((eventType) =>
            sources.some((event) => event.runId === runId && event.eventType === eventType),
          ),
        )
        ? [...metric.eventSource]
        : []
      : metric.id === "candidate_reuse_delta_vs_legacy"
        ? validShadowPairs(sources, bindings) &&
          calculationRunIds.every((runId) =>
            sources.some((event) => event.runId === runId && event.eventType === "candidate.selected"),
          )
          ? [...metric.eventSource]
          : []
        : metric.eventSource.filter((eventType) =>
            calculationRunIds.every((runId) =>
              sources.some((event) => event.runId === runId && event.eventType === eventType),
            ),
          )
  if (coveredEventTypes.length !== metric.eventSource.length) return undefined
  return MetricObservation.parse({
    metricId: metric.id,
    aggregation: metric.aggregation,
    numerator: aggregate.numerator,
    denominator: aggregate.denominator,
    sampleSize: aggregate.sampleSize,
    values: aggregate.values,
    eventTypes: coveredEventTypes,
    sourceRefs: uniqueSourceRefs([...uniqueSources(sources), ...artifactSources]),
    runIds: observationRunIds,
    timeWindow: metric.timeWindow,
    dimensions: metric.requiredDimensions?.includes("strategy") ? { strategy } : undefined,
  })
}

function shadowFact(
  events: PersistedMetricEvent[],
  numerator: number,
  denominator: number,
  artifactSources: MetricSourceRef[],
): ShadowFact {
  const eventRunIds = new Set(events.map((event) => event.runId))
  const boundArtifactSources = artifactSources.filter((source) => eventRunIds.has(source.runId))
  return {
    numerator,
    denominator,
    sampleSize: denominator,
    sourceRefIds: uniqueSourceRefs([...uniqueSources(events), ...boundArtifactSources]).map((source) => source.id),
  }
}

function shadowAggregate(
  strategy: ShadowStrategy,
  candidateSha: string,
  snapshotDigest: string,
  scenarioIds: string[],
  runIds: string[],
  records: PersistedMetricEvent[],
  artifactSources: MetricSourceRef[],
): ShadowStrategyAggregate {
  const benchmarks = eventsOf(records, "benchmark.completed")
  const usages = eventsOf(records, "model.usage_recorded")
  const reviews = eventsOf(records, "review.completed")
  const receipts = eventsOf(records, "work_receipt.submitted")
  const selections = eventsOf(records, "candidate.selected")
  const lowRiskCriteria = eventsOf(records, "delivery.criterion_evaluated").filter(
    (event) => stringProperty(event, "risk") === "low",
  )
  return {
    strategy,
    candidateSha,
    snapshotDigest,
    scenarioIds,
    runIds,
    sourceRefs: uniqueSourceRefs([...uniqueSources(records), ...artifactSources]),
    facts: {
      completeness: shadowFact(
        benchmarks,
        benchmarks.filter((event) => stringProperty(event, "finalDecision") === "pass").length,
        benchmarks.length,
        artifactSources,
      ),
      totalModelCalls: shadowFact(
        usages,
        usages.reduce((total, event) => total + (numberProperty(event, "modelCalls") ?? 0), 0),
        runIds.length,
        artifactSources,
      ),
      totalCost: shadowFact(
        usages,
        usages.reduce((total, event) => total + (numberProperty(event, "cost") ?? 0), 0),
        runIds.length,
        artifactSources,
      ),
      reviewerInvocations: shadowFact(
        reviews,
        reviews.filter((event) => booleanProperty(event, "invoked") === true).length,
        runIds.length,
        artifactSources,
      ),
      unknownsDiscovered: shadowFact(
        receipts,
        receipts.reduce((total, event) => total + (numberProperty(event, "unknownCount") ?? 0), 0),
        runIds.length,
        artifactSources,
      ),
      errorRate: shadowFact(
        benchmarks,
        benchmarks.filter((event) => stringProperty(event, "finalDecision") === "fail").length,
        benchmarks.length,
        artifactSources,
      ),
      candidateReuseRate: shadowFact(
        selections,
        selections.filter((event) => booleanProperty(event, "reused") === true).length,
        selections.length,
        artifactSources,
      ),
      lowRiskQualityRate: shadowFact(
        lowRiskCriteria,
        lowRiskCriteria.filter((event) => stringProperty(event, "status") === "pass").length,
        lowRiskCriteria.length,
        artifactSources,
      ),
    },
  }
}

function matchedBindings(artifact: PersistedFactArtifact, scenarioIds: string[]) {
  return scenarioIds.flatMap((scenarioId) => {
    const candidates = artifact.runBindings.filter((binding) => binding.scenarioId === scenarioId)
    const digests = [...new Set(candidates.map((binding) => binding.snapshotDigest))]
    const matched = digests.filter(
      (digest) =>
        candidates.some((binding) => binding.snapshotDigest === digest && binding.strategy === "legacy_full_plan") &&
        candidates.some((binding) => binding.snapshotDigest === digest && binding.strategy === "seed_and_grow"),
    )
    if (matched.length !== 1) return []
    return candidates.filter((binding) => binding.snapshotDigest === matched[0])
  })
}

function matchedMetricBindings(artifact: PersistedFactArtifact, strategy: PersistedFactStrategy) {
  const requested = artifact.runBindings.filter((binding) => binding.strategy === strategy)
  const scenarios = [...new Set(requested.map((binding) => binding.scenarioId))]
  const matches = scenarios.map((scenarioId) => {
    const requestedScenario = requested.filter((binding) => binding.scenarioId === scenarioId)
    const snapshotDigests = [...new Set(requestedScenario.map((binding) => binding.snapshotDigest))]
    if (snapshotDigests.length !== 1) return undefined
    const bindings = artifact.runBindings.filter(
      (binding) => binding.scenarioId === scenarioId && binding.snapshotDigest === snapshotDigests[0],
    )
    const legacyCount = bindings.filter((binding) => binding.strategy === "legacy_full_plan").length
    const seedCount = bindings.filter((binding) => binding.strategy === "seed_and_grow").length
    if (!legacyCount || legacyCount !== seedCount || requestedScenario.length !== legacyCount) return undefined
    return bindings
  })
  if (!requested.length || matches.some((bindings) => !bindings)) return undefined
  return matches.flatMap((bindings) => bindings ?? [])
}

export async function makePersistedFactArtifactAdapter(raw: unknown): Promise<MetricFactAdapter> {
  const reference = PersistedFactArtifactReference.parse(raw)
  const artifact = await loadPersistedFactArtifact(reference)
  const artifactSources = (runIds: string[]) =>
    runIds.map((runId) => ({
      kind: "gate_report" as const,
      id: `local-gate-${sha256(`${artifact.id}:${runId}`).slice(0, 32)}`,
      candidateSha: artifact.candidateSha,
      runId,
      digest: reference.sha256,
    }))
  return {
    readMetricFacts: (request: MetricFactReadRequest) =>
      Effect.sync(() => {
        const strategyBindings = artifact.runBindings.filter((binding) => binding.strategy === request.strategy)
        const requiresCrossStrategy = request.metricIds.some((metricId) => CrossStrategyMetricIds.has(metricId))
        const crossStrategyBindings = requiresCrossStrategy
          ? matchedMetricBindings(artifact, request.strategy)
          : undefined
        const bindings = crossStrategyBindings ?? strategyBindings
        const runIds = bindings.map((binding) => binding.runId).sort()
        const records =
          persistedMetricContractDigest(request.contract) === artifact.metricContractDigest
            ? validEvents(artifact, request.contract).filter((event) => runIds.includes(event.runId))
            : []
        const observations = request.metricIds.flatMap((metricId) => {
          const metric = request.contract.metrics.find((item) => item.id === metricId)
          const crossStrategy = CrossStrategyMetricIds.has(metricId)
          if (!metric || (crossStrategy && !crossStrategyBindings)) return []
          const calculationBindings = crossStrategy
            ? bindings
            : bindings.filter((binding) => binding.strategy === request.strategy)
          const calculationRunIds = calculationBindings.map((binding) => binding.runId).sort()
          const metricRecords = crossStrategy ? records : records.filter((event) => event.strategy === request.strategy)
          const value = observation(
            metric,
            metricRecords,
            calculationRunIds,
            runIds,
            request.strategy,
            artifactSources(runIds),
            calculationBindings,
          )
          return value ? [value] : []
        })
        return MetricQueryCore.parse({
          candidateSha: artifact.candidateSha,
          queryVersion: artifact.metricQueryVersion,
          metricIds: request.metricIds,
          runIds,
          window: artifact.window,
          observations,
        })
      }),
    readShadowFacts: (request: ShadowFactReadRequest) =>
      Effect.sync(() => {
        const bindings = matchedBindings(artifact, request.scenarioIds)
        const scenarios = [...new Set(bindings.map((binding) => binding.scenarioId))].sort()
        const snapshotDigest = sha256(
          canonical(
            scenarios.map((scenarioId) => ({
              scenarioId,
              snapshotDigest: bindings.find((binding) => binding.scenarioId === scenarioId)?.snapshotDigest,
            })),
          ),
        )
        const records =
          persistedMetricContractDigest(request.contract) === artifact.metricContractDigest
            ? validEvents(artifact, request.contract)
            : []
        const legacyRunIds = bindings
          .filter((binding) => binding.strategy === "legacy_full_plan")
          .map((binding) => binding.runId)
          .sort()
        const seedRunIds = bindings
          .filter((binding) => binding.strategy === "seed_and_grow")
          .map((binding) => binding.runId)
          .sort()
        const legacyArtifactSources = artifactSources(legacyRunIds)
        const seedArtifactSources = artifactSources(seedRunIds)
        return ShadowComparisonCore.parse({
          comparisonId: request.comparisonId,
          candidateSha: artifact.candidateSha,
          queryVersion: artifact.shadowQueryVersion,
          snapshotDigest,
          scenarioIds: request.scenarioIds,
          legacy: shadowAggregate(
            "legacy",
            artifact.candidateSha,
            snapshotDigest,
            scenarios,
            legacyRunIds,
            records.filter((event) => legacyRunIds.includes(event.runId)),
            legacyArtifactSources,
          ),
          seedAndGrow: shadowAggregate(
            "seed_and_grow",
            artifact.candidateSha,
            snapshotDigest,
            scenarios,
            seedRunIds,
            records.filter((event) => seedRunIds.includes(event.runId)),
            seedArtifactSources,
          ),
        })
      }),
  }
}

export * as PersistedFactArtifactReader from "./persisted-fact-artifact"
