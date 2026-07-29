import { createHash } from "node:crypto"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MetricContract, metricContractDigest } from "@agents-company/shared/seed-grow-metrics"
import { Effect } from "effect"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import {
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyValidationRepairTable,
} from "../../src/company-project/company-project.sql"
import {
  bindPersistedFactArtifact,
  makePersistedFactArtifactAdapter,
  type PersistedFactArtifactCore,
  type PersistedFactRunBinding,
  type PersistedMetricEvent,
} from "../../src/metrics/persisted-fact-artifact"
import { exportPersistedFactArtifact } from "../../src/metrics/persisted-fact-exporter"
import { makeLayer, Service } from "../../src/metrics/seed-grow-reporter"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const candidateSha = "a".repeat(40)
const previousCandidateSha = "b".repeat(40)
const snapshotDigest = "c".repeat(64)
const now = Date.now()
const contract = MetricContract.parse(
  JSON.parse(
    await Bun.file(
      path.resolve(import.meta.dir, "../../../../docs/product-design/experience-refactor/metric-contract.v1.json"),
    ).text(),
  ) as unknown,
)

function binding(runId: string, strategy: PersistedFactRunBinding["strategy"], scenarioId: string) {
  return {
    runId,
    projectId: `project-${runId}`,
    strategy,
    scenarioId,
    snapshotDigest,
  } satisfies PersistedFactRunBinding
}

function event(
  run: PersistedFactRunBinding,
  eventType: string,
  suffix: string,
  properties: Record<string, unknown>,
): PersistedMetricEvent {
  return {
    eventId: `${run.runId}-${suffix}`,
    eventType,
    occurredAt: new Date(now).toISOString(),
    projectId: run.projectId,
    scenarioId: run.scenarioId,
    runId: run.runId,
    strategy: run.strategy,
    subjectId: `${run.runId}-${suffix}`,
    source: {
      kind: "project_event",
      id: `${run.runId}-${suffix}`,
      candidateSha,
      runId: run.runId,
      digest: createHash("sha256").update(JSON.stringify(properties)).digest("hex"),
    },
    properties,
  }
}

async function reportMetric(
  directory: string,
  metricId: string,
  runBindings: PersistedFactRunBinding[],
  events: PersistedMetricEvent[],
) {
  const artifact = bindPersistedFactArtifact({
    schemaVersion: 1,
    kind: "seed-grow-local-gate-persisted-facts",
    id: `negative-${metricId}`,
    producer: {
      kind: "local_gate",
      commandId: "negative-regression",
      version: "v1",
      executableDigest: "d".repeat(64),
    },
    candidateSha,
    metricContractDigest: metricContractDigest(contract),
    metricQueryVersion: contract.queryVersion,
    shadowQueryVersion: contract.shadowComparison!.queryVersion,
    window: {
      id: "negative-window",
      startedAt: new Date(now - 1_000).toISOString(),
      endedAt: new Date(now + 1_000).toISOString(),
    },
    runBindings,
    events,
  } satisfies PersistedFactArtifactCore)
  const source = `${JSON.stringify(artifact, null, 2)}\n`
  const artifactPath = path.join(directory, `${metricId}.json`)
  await Bun.write(artifactPath, source)
  const adapter = await makePersistedFactArtifactAdapter({
    path: artifactPath,
    sha256: createHash("sha256").update(source).digest("hex"),
  })
  return Effect.runPromise(
    Service.use((service) =>
      service.report({
        contract,
        candidateSha,
        metricIds: [metricId],
        strategy: "seed_and_grow",
      }),
    ).pipe(Effect.provide(makeLayer(adapter))),
  )
}

function seedExportProject(run: PersistedFactRunBinding) {
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: "negative-candidate",
    candidate: {
      id: "negative-candidate",
      candidateSha,
      targetRef: "refs/heads/main",
    },
  })
  CompanyRollout.recordAction({
    kind: "record_local_repeat",
    idempotencyKey: "negative-repeat",
    repeat: {
      id: "negative-repeat",
      candidateId: "negative-candidate",
      runId: run.runId,
      ordinal: 1,
      outcome: "completed",
      environmentSha256: "e".repeat(64),
      evidenceSha256: "f".repeat(64),
      normalizedResultSha256: "1".repeat(64),
      startedAt: now - 100,
      finishedAt: now,
    },
  })
  Database.use((db) => {
    db.insert(CompanyProjectTable)
      .values({
        id: run.projectId,
        goal: "Reject unbound metric observations",
        title: "Negative metric semantics",
        status: "executing",
        active_run_id: run.runId,
        output_dir: `/tmp/${run.projectId}`,
        execution_strategy: run.strategy,
        seed_mode: "direct_single",
        orchestration_state: "idle",
        orchestrator_version: 1,
        dispatch_paused: false,
        graph_revision: 0,
        created_at: now - 500,
        updated_at: now,
      })
      .run()
    db.insert(CompanyProjectEventTable)
      .values({
        id: `${run.runId}-bound`,
        project_id: run.projectId,
        type: "local_gate.run_bound",
        actor_id: "local_gate",
        data_json: JSON.stringify({
          candidateSha,
          projectId: run.projectId,
          runId: run.runId,
          scenarioId: run.scenarioId,
          strategy: run.strategy,
          snapshotDigest: run.snapshotDigest,
        }),
        created_at: now - 400,
      })
      .run()
  })
}

async function exportFacts(directory: string, run: PersistedFactRunBinding) {
  return exportPersistedFactArtifact({
    id: `negative-export-${run.runId}`,
    candidateSha,
    metricContract: contract,
    window: {
      id: "negative-export-window",
      startedAt: new Date(now - 1_000).toISOString(),
      endedAt: new Date(now + 1_000).toISOString(),
    },
    runBindings: [run],
    outputPath: path.join(directory, `${run.runId}.json`),
  })
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("persisted fact semantic rejection", () => {
  test("rejects a generic metric event without an exact source binding", async () => {
    await using directory = await tmpdir()
    const run = binding("unbound-run", "seed_and_grow", "S13")
    seedExportProject(run)
    Database.use((db) =>
      db
        .insert(CompanyProjectEventTable)
        .values({
          id: "unbound-delivery",
          project_id: run.projectId,
          type: "delivery.presented",
          actor_id: "arbitrary-writer",
          data_json: JSON.stringify({
            deliveryId: "delivery-unbound",
            artifactCount: 1,
            noFileReason: "",
          }),
          created_at: now,
        })
        .run(),
    )
    expect(exportFacts(directory.path, run)).rejects.toThrow(/source binding/i)
  })

  test("does not pass false completion from omission of a positive invariant audit", async () => {
    await using directory = await tmpdir()
    const runs = [binding("false-a", "seed_and_grow", "S24"), binding("false-b", "seed_and_grow", "S27")]
    const report = await reportMetric(
      directory.path,
      "false_completion_count",
      runs,
      runs.flatMap((run) => [
        event(run, "project.completed", "project", {
          projectId: run.projectId,
          strategy: run.strategy,
        }),
        event(run, "benchmark.completed", "benchmark", {
          scenarioId: run.scenarioId,
          finalDecision: "pass",
        }),
      ]),
    )
    expect(report.results[0]?.status).toBe("blocked")
  })

  test("rejects delivery-open success without a real artifact row", async () => {
    await using directory = await tmpdir()
    const run = binding("delivery-run", "seed_and_grow", "S27")
    seedExportProject(run)
    Database.use((db) =>
      db
        .insert(CompanyProjectEventTable)
        .values([
          {
            id: "fake-delivery-presented",
            project_id: run.projectId,
            type: "delivery.presented",
            actor_id: "arbitrary-writer",
            data_json: JSON.stringify({
              deliveryId: "fake-delivery",
              artifactCount: 1,
              noFileReason: "",
            }),
            created_at: now,
          },
          {
            id: "fake-delivery-opened",
            project_id: run.projectId,
            type: "delivery.artifact_opened",
            actor_id: "arbitrary-writer",
            data_json: JSON.stringify({
              deliveryId: "fake-delivery",
              artifactId: "missing-artifact",
              succeeded: true,
            }),
            created_at: now,
          },
        ])
        .run(),
    )
    expect(exportFacts(directory.path, run)).rejects.toThrow(/artifact/i)
  })

  test("uses completed projects rather than benchmark events for new-candidate denominator", async () => {
    await using directory = await tmpdir()
    const runs = [binding("candidate-a", "seed_and_grow", "S17"), binding("candidate-b", "seed_and_grow", "S26")]
    const report = await reportMetric(
      directory.path,
      "new_candidate_per_completed_project",
      runs,
      runs.flatMap((run, index) => [
        ...(index === 0
          ? [
              event(run, "project.completed", "project", {
                projectId: run.projectId,
                strategy: run.strategy,
              }),
            ]
          : []),
        event(run, "benchmark.completed", "benchmark", {
          scenarioId: run.scenarioId,
          finalDecision: "pass",
        }),
        event(run, "candidate.selected", "candidate", {
          candidateId: `${run.runId}-candidate`,
          reused: index === 1,
          createdForNeed: index === 0,
        }),
      ]),
    )
    expect(report.results[0]?.status).toBe("failed")
    expect(report.results[0]?.denominator).toBe(1)
  })

  test("recomputes low-risk quality from matched legacy and seed criterion outcomes", async () => {
    await using directory = await tmpdir()
    const seedRuns = [
      binding("quality-seed-a", "seed_and_grow", "S14"),
      binding("quality-seed-b", "seed_and_grow", "S18"),
    ]
    const legacyRuns = [
      binding("quality-legacy-a", "legacy_full_plan", "S14"),
      binding("quality-legacy-b", "legacy_full_plan", "S18"),
    ]
    const events = [
      ...legacyRuns.map((run) =>
        event(run, "delivery.criterion_evaluated", "criterion", {
          deliveryId: `${run.runId}-delivery`,
          criterionId: `${run.runId}-criterion`,
          status: "pass",
          evidenceCount: 1,
          risk: "low",
          strategy: run.strategy,
        }),
      ),
      ...seedRuns.flatMap((run, index) => [
        event(run, "delivery.criterion_evaluated", "criterion", {
          deliveryId: `${run.runId}-delivery`,
          criterionId: `${run.runId}-criterion`,
          status: index === 0 ? "pass" : "fail",
          evidenceCount: 1,
          risk: "low",
          strategy: run.strategy,
        }),
        event(run, "delivery.quality_compared", "quality", {
          risk: "low",
          strategy: run.strategy,
          legacyScore: 1,
          seedGrowScore: 1,
        }),
      ]),
    ]
    const report = await reportMetric(
      directory.path,
      "low_risk_quality_ratio_vs_legacy",
      [...legacyRuns, ...seedRuns],
      events,
    )
    expect(report.results[0]?.status).toBe("failed")
    expect(report.results[0]?.value).toBe(0.5)
  })

  test("rejects a repair whose persisted diagnosis and diff do not prove a changed fact", async () => {
    await using directory = await tmpdir()
    const run = binding("repair-run", "seed_and_grow", "S16")
    seedExportProject(run)
    Database.use((db) => {
      db.insert(CompanyValidationGateTable)
        .values({
          id: "repair-gate",
          project_id: run.projectId,
          work_item_id: null,
          kind: "prerequisite",
          status: "passed",
          criteria_json: "[]",
          criteria_sha256: createHash("sha256").update("[]").digest("hex"),
          blocking_work_item_ids_json: "[]",
          evidence_refs_json: "[]",
          evaluator: "machine",
          repair_round: 1,
          max_repair_rounds: 3,
          failure_summary: null,
          supersedes_gate_id: null,
          created_at: now - 200,
          evaluated_at: now,
        })
        .run()
      db.insert(CompanyValidationRepairTable)
        .values({
          id: "empty-repair",
          gate_id: "repair-gate",
          round: 1,
          idempotency_key: "empty-repair",
          input_sha256: "2".repeat(64),
          failure_kind: "prerequisite",
          diagnosis_json: "{}",
          fix_summary: "retry",
          repair_diff_json: "[]",
          reverify_evidence_json: "[]",
          result: "passed",
          created_at: now,
        })
        .run()
    })
    expect(exportFacts(directory.path, run)).rejects.toThrow(/diagnosis|changed fact|repair diff/i)
  })

  test("does not count two isolated runs of one SHA as two consecutive candidates", async () => {
    await using directory = await tmpdir()
    const runs = [binding("terminal-a", "seed_and_grow", "S13"), binding("terminal-b", "seed_and_grow", "S27")]
    const report = await reportMetric(
      directory.path,
      "consecutive_reproducible_candidate_count",
      runs,
      runs.flatMap((run, index) => [
        event(run, "benchmark.completed", "benchmark", {
          scenarioId: run.scenarioId,
          finalDecision: "pass",
        }),
        event(run, "candidate.terminal_checked", "terminal", {
          candidateSha,
          previousCandidateSha,
          isolatedRunIndex: index + 1,
          localGate: "success",
          deployment: "success",
          rollback: "success",
          reproducible: true,
          terminalEvidenceDigest: createHash("sha256").update(run.runId).digest("hex"),
          immediateAncestry: true,
        }),
      ]),
    )
    expect(report.results[0]?.status).not.toBe("pass")
  })
})
