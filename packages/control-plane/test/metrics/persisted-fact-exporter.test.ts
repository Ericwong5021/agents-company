import { createHash } from "node:crypto"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MetricContract } from "@agents-company/shared/seed-grow-metrics"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { CompanyRolloutJournalTable } from "../../src/company-rollout/company-rollout.sql"
import {
  CompanyAttentionTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
} from "../../src/company-project/company-project.sql"
import {
  ApprovalGateObservation,
  exportPersistedFactArtifact,
  QuiescenceObservation,
  RepairCircuitObservation,
  requireExactB5CheckedObservations,
  validateB5RepairCircuitEvidence,
  validateB5ReviewPresenceEvidence,
  type PersistedFactExportRequest,
} from "../../src/metrics/persisted-fact-exporter"
import { loadPersistedFactArtifact, PersistedFactArtifactReference } from "../../src/metrics/persisted-fact-artifact"
import { Database, eq } from "../../src/storage"
import { GateObservationEventType } from "../../src/metrics/gate-observation"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const candidateSha = "a".repeat(40)
const snapshotDigest = "b".repeat(64)
const contractPath = path.resolve(
  import.meta.dir,
  "../../../../docs/product-design/experience-refactor/metric-contract.v1.json",
)
const contract = MetricContract.parse(JSON.parse(await Bun.file(contractPath).text()) as unknown)

beforeEach(resetDatabase)
afterEach(resetDatabase)

function seed(now = Date.now()) {
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: "candidate-action",
    candidate: {
      id: "candidate-1",
      candidateSha,
      targetRef: "refs/heads/main",
    },
  })
  CompanyRollout.recordAction({
    kind: "record_local_repeat",
    idempotencyKey: "repeat-action",
    repeat: {
      id: "repeat-1",
      candidateId: "candidate-1",
      runId: "run-1",
      ordinal: 1,
      outcome: "completed",
      environmentSha256: "c".repeat(64),
      evidenceSha256: "d".repeat(64),
      normalizedResultSha256: "e".repeat(64),
      startedAt: now - 100,
      finishedAt: now,
    },
  })
  Database.use((db) => {
    db.insert(CompanyProjectTable)
      .values({
        id: "project-1",
        goal: "Verify persisted product facts",
        title: "Local Gate fact export",
        status: "completed",
        active_run_id: "run-1",
        output_dir: "/tmp/project-1",
        execution_strategy: "seed_and_grow",
        seed_mode: "discovery_first",
        orchestration_state: "quiescent",
        orchestrator_version: 1,
        dispatch_paused: false,
        graph_revision: 0,
        created_at: now - 500,
        updated_at: now,
        completed_at: now,
      })
      .run()
    db.insert(CompanyProjectEventTable)
      .values([
        {
          id: "event-run-bound",
          project_id: "project-1",
          type: "local_gate.run_bound",
          actor_id: "local_gate",
          data_json: JSON.stringify({
            candidateSha,
            projectId: "project-1",
            runId: "run-1",
            scenarioId: "S13",
            strategy: "seed_and_grow",
            snapshotDigest,
          }),
          created_at: now - 300,
        },
        {
          id: "event-benchmark",
          project_id: "project-1",
          type: "benchmark.completed",
          actor_id: "local_gate",
          data_json: JSON.stringify({
            candidateSha,
            projectId: "project-1",
            runId: "run-1",
            scenarioId: "S13",
            strategy: "seed_and_grow",
            snapshotDigest,
            finalDecision: "pass",
          }),
          created_at: now - 200,
        },
      ])
      .run()
  })
  return now
}

function request(
  outputPath: string,
  now: number,
  overrides: Partial<PersistedFactExportRequest> = {},
): PersistedFactExportRequest {
  return {
    id: "persisted-facts-1",
    candidateSha,
    metricContract: contract,
    window: {
      id: "candidate-window",
      startedAt: new Date(now - 10_000).toISOString(),
      endedAt: new Date(now + 10_000).toISOString(),
    },
    runBindings: [
      {
        runId: "run-1",
        projectId: "project-1",
        strategy: "seed_and_grow",
        scenarioId: "S13",
        snapshotDigest,
      },
    ],
    outputPath,
    ...overrides,
  }
}

async function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("Expected operation to reject"),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
}

describe("PersistedFactExporter", () => {
  test("only accepts raw checked observation types for the trusted B5 exporter", () => {
    expect(GateObservationEventType.safeParse("terminal.invariant_checked").success).toBe(true)
    expect(GateObservationEventType.safeParse("quality_pair.checked").success).toBe(true)
    expect(GateObservationEventType.safeParse("approval_gate.checked").success).toBe(true)
    expect(GateObservationEventType.safeParse("quiescence.checked").success).toBe(true)
    expect(GateObservationEventType.safeParse("benchmark.completed").success).toBe(false)
    expect(GateObservationEventType.safeParse("candidate.terminal_checked").success).toBe(false)
  })

  test("requires exactly one observation for every checked B5 oracle", () => {
    expect(() =>
      requireExactB5CheckedObservations(
        ["terminal.invariant_checked", "terminal.invariant_checked"],
        ["terminal.invariant_checked"],
        "run-1",
      ),
    ).toThrow("exactly one")
    expect(() => requireExactB5CheckedObservations([], ["approval_gate.checked"], "run-s15")).toThrow(
      "received 0",
    )
    expect(() =>
      requireExactB5CheckedObservations(
        ["approval_gate.checked", "validation_anchor.checked"],
        ["approval_gate.checked"],
        "run-s15",
      ),
    ).toThrow("non-required validation_anchor.checked")
  })

  test("keeps Approval and Quiescence checks distinct from synthetic delivery evidence", () => {
    expect(
      ApprovalGateObservation.parse({
        gateId: "approval-s15",
        status: "pending",
        dispatchPaused: true,
        anchorPassed: false,
      }),
    ).toMatchObject({ status: "pending", dispatchPaused: true })
    expect(
      QuiescenceObservation.parse({
        status: "blocked",
        ready: false,
        criterionId: "criterion-s24",
        criterionStatus: "fail",
        risk: "medium",
        blockerEntityIds: ["receipt-s24"],
      }),
    ).toMatchObject({ status: "blocked", criterionStatus: "fail" })
    expect(() =>
      QuiescenceObservation.parse({
        status: "completed",
        ready: true,
        criterionId: "criterion-s24",
        criterionStatus: "pass",
        risk: "medium",
        blockerEntityIds: [],
      }),
    ).toThrow()
  })

  test("requires exactly three persisted repairs and one bound Attention for S22", () => {
    expect(() =>
      RepairCircuitObservation.parse({
        workItemId: "work-s22",
        attentionId: "attention-s22",
        attemptCount: 4,
      }),
    ).toThrow()
    expect(() =>
      validateB5RepairCircuitEvidence({
        attemptCount: 3,
        repairCount: 4,
        repairRound: 3,
        maxRepairRounds: 3,
        attentionId: "attention-s22",
        circuitAttentionIds: ["attention-s22"],
      }),
    ).toThrow()
    expect(() =>
      validateB5RepairCircuitEvidence({
        attemptCount: 3,
        repairCount: 3,
        repairRound: 3,
        maxRepairRounds: 3,
        attentionId: "attention-s22",
        circuitAttentionIds: ["attention-s22", "attention-duplicate"],
      }),
    ).toThrow()
  })

  test("recomputes Reviewer invocation and rejects unrelated builder runs as absence evidence", () => {
    const claimed = {
      risk: "low" as const,
      invoked: false,
      independent: false,
      rejected: false,
      findingConfirmed: false,
    }
    expect(
      validateB5ReviewPresenceEvidence({
        claimed,
        chains: [],
        unboundReviewerRunIds: [],
        rejected: false,
        references: [{ kind: "project", id: "project-1" }],
      }),
    ).toMatchObject({ invoked: false, independent: false })
    expect(() =>
      validateB5ReviewPresenceEvidence({
        claimed,
        chains: [],
        unboundReviewerRunIds: [],
        rejected: false,
        references: [
          { kind: "project", id: "project-1" },
          { kind: "agent_run", id: "builder-run" },
        ],
      }),
    ).toThrow("unrelated AgentRun")
    expect(() =>
      validateB5ReviewPresenceEvidence({
        claimed: { ...claimed, invoked: true, independent: true },
        chains: [
          {
            workItemId: "reviewer-work",
            assignmentId: "reviewer-assignment",
            runId: "reviewer-run",
            independent: true,
          },
        ],
        unboundReviewerRunIds: [],
        rejected: false,
        references: [{ kind: "project", id: "project-1" }],
      }),
    ).toThrow("exact Reviewer source chain")
  })

  test("exports digest-bound facts from an isolated persisted database", async () => {
    const directory = await tmpdir()
    const now = seed()
    const outputPath = path.join(directory.path, "facts.json")
    const requestPath = path.join(directory.path, "request.json")
    const databasePath = path.join(directory.path, "facts.db")
    await Bun.write(
      requestPath,
      JSON.stringify({
        ...request(outputPath, now),
        metricContract: undefined,
        metricContractPath: contractPath,
      }),
    )
    Database.Client().$client.run("VACUUM INTO ?", [databasePath])
    const process = Bun.spawn(["bun", "script/export-seed-grow-persisted-facts.ts", requestPath], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        AGENTCOMPANY_DB: databasePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stderr)
    const reference = PersistedFactArtifactReference.parse(JSON.parse(stdout) as unknown)
    const artifact = await loadPersistedFactArtifact(reference)
    expect(reference.path).toBe(outputPath)
    expect(reference.sha256).toBe(
      createHash("sha256")
        .update(await Bun.file(outputPath).text())
        .digest("hex"),
    )
    expect(artifact.snapshotDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(artifact.producer).toMatchObject({
      kind: "local_gate",
      commandId: "seed-grow-persisted-fact-exporter",
      executableDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(artifact.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "benchmark.completed",
        "project.completed",
        "fact.project_event",
        "fact.rollout_candidate",
        "fact.rollout_local_repeat",
      ]),
    )
    await directory[Symbol.asyncDispose]()
  })

  test.each([
    [
      "project",
      (value: PersistedFactExportRequest) => ({
        ...value,
        runBindings: [{ ...value.runBindings[0], projectId: "missing-project" }],
      }),
      "unavailable project",
    ],
    [
      "run",
      (value: PersistedFactExportRequest) => ({
        ...value,
        runBindings: [{ ...value.runBindings[0], runId: "wrong-run" }],
      }),
      "mismatched runId",
    ],
    [
      "strategy",
      (value: PersistedFactExportRequest) => ({
        ...value,
        runBindings: [{ ...value.runBindings[0], strategy: "legacy_full_plan" as const }],
      }),
      "mismatched execution strategy",
    ],
    [
      "candidate",
      (value: PersistedFactExportRequest) => ({
        ...value,
        candidateSha: "f".repeat(40),
      }),
      "is not registered",
    ],
  ])("rejects a mismatched %s binding", async (_kind, mutate, message) => {
    const directory = await tmpdir()
    const now = seed()
    expect(
      (await rejected(exportPersistedFactArtifact(mutate(request(path.join(directory.path, "facts.json"), now)))))
        .message,
    ).toContain(message)
    await directory[Symbol.asyncDispose]()
  })

  test("rejects a source reference that is unavailable in the bound project", async () => {
    const directory = await tmpdir()
    const now = seed()
    Database.use((db) =>
      db
        .insert(CompanyAttentionTable)
        .values({
          id: "attention-invalid",
          project_id: "project-1",
          idempotency_key: "attention-invalid",
          issue_kind: "unresolved_material_risk",
          risk: "high",
          materiality: "unresolved_risk",
          route: "user",
          material: true,
          interrupts_user: true,
          title: "Missing source",
          summary: "The source must exist",
          required_decision: "Resolve",
          allowed_actions_json: JSON.stringify(["resolve_blocker"]),
          source_refs_json: JSON.stringify([{ kind: "work_receipt", id: "missing-receipt" }]),
          input_sha256: "f".repeat(64),
          status: "open",
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .run(),
    )
    expect(
      (await rejected(exportPersistedFactArtifact(request(path.join(directory.path, "facts.json"), now)))).message,
    ).toContain("unavailable source fact")
    await directory[Symbol.asyncDispose]()
  })

  test("rejects a binding whose persisted scenario and snapshot anchor is missing", async () => {
    const directory = await tmpdir()
    const now = seed()
    Database.use((db) => db.delete(CompanyProjectEventTable).run())
    expect(
      (await rejected(exportPersistedFactArtifact(request(path.join(directory.path, "facts.json"), now)))).message,
    ).toContain("persisted scenario binding")
    await directory[Symbol.asyncDispose]()
  })

  test("detects artifact byte tampering after export", async () => {
    const directory = await tmpdir()
    const now = seed()
    const result = await exportPersistedFactArtifact(request(path.join(directory.path, "facts.json"), now))
    await Bun.write(result.reference.path, `${await Bun.file(result.reference.path).text()} `)
    expect((await rejected(loadPersistedFactArtifact(result.reference))).message).toContain("artifact digest mismatch")
    await directory[Symbol.asyncDispose]()
  })

  test("rejects tampered persisted rollout journal bytes", async () => {
    const directory = await tmpdir()
    const now = seed()
    Database.use((db) =>
      db
        .update(CompanyRolloutJournalTable)
        .set({ payload_json: "{}" })
        .where(eq(CompanyRolloutJournalTable.idempotency_key, "candidate-action"))
        .run(),
    )
    expect(
      (await rejected(exportPersistedFactArtifact(request(path.join(directory.path, "facts.json"), now)))).message,
    ).toContain("payload digest")
    await directory[Symbol.asyncDispose]()
  })
})
