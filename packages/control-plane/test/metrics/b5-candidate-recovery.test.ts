import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { produceB5CandidateRecovery } from "../../src/metrics/b5-candidate-recovery"
import { tmpdir } from "../fixture/fixture"

function recoveryEnvironment(database: string, home: string) {
  const previousDatabase = process.env.AGENTCOMPANY_DB
  const previousHome = process.env.AGENTCOMPANY_HOME
  process.env.AGENTCOMPANY_DB = database
  process.env.AGENTCOMPANY_HOME = home
  return {
    [Symbol.dispose]() {
      if (previousDatabase) process.env.AGENTCOMPANY_DB = previousDatabase
      if (!previousDatabase) delete process.env.AGENTCOMPANY_DB
      if (previousHome) process.env.AGENTCOMPANY_HOME = previousHome
      if (!previousHome) delete process.env.AGENTCOMPANY_HOME
    },
  }
}

test.serial(
  "S19 kills a committed pending Receipt child and reopens it exactly once",
  async () => {
    await using directory = await tmpdir()
    using environment = recoveryEnvironment(path.join(directory.path, "s19.db"), path.join(directory.path, "home"))
    const result = await produceB5CandidateRecovery({
      candidateSha: "a".repeat(40),
      scenarioId: "S19",
      snapshotDigest: "b".repeat(64),
      runId: "b5-s19-child-kill-reopen",
      outputDirectory: path.join(directory.path, "reports"),
    })
    expect(result.process).toEqual({
      crashedPid: expect.any(Number),
      recoveryPid: expect.any(Number),
      signal: "SIGKILL",
    })
    expect(result.process?.crashedPid).not.toBe(result.process?.recoveryPid)
    expect(result.receiptRecovery).toEqual({
      beforeStatus: "pending",
      afterStatus: "processed",
      firstRecoverProcessedCount: 1,
      secondRecoverProcessedCount: 0,
    })
    expect(result.entityIds.receiptIds).toHaveLength(1)
    expect(result.exactlyOnce).toBe(true)
    expect(result.duplicateSideEffects).toBe(0)
    expect(result.recoveredAt).toBeGreaterThan(result.lostAt)
    const content = await Bun.file(result.report.path).text()
    expect(createHash("sha256").update(content).digest("hex")).toBe(result.report.sha256)
    expect(JSON.parse(content)).toMatchObject({
      scenarioId: "S19",
      projectId: result.projectId,
      entityIds: {
        receiptIds: result.entityIds.receiptIds,
        mutationIds: result.entityIds.mutationIds,
      },
      exactlyOnce: true,
      duplicateSideEffects: 0,
    })
  },
  { timeout: 30_000 },
)

test.serial(
  "S20 reopens complete old or new graph state at every transaction boundary",
  async () => {
    await using directory = await tmpdir()
    using environment = recoveryEnvironment(path.join(directory.path, "s20.db"), path.join(directory.path, "home"))
    const result = await produceB5CandidateRecovery({
      candidateSha: "c".repeat(40),
      scenarioId: "S20",
      snapshotDigest: "d".repeat(64),
      runId: "b5-s20-atomic-boundaries",
      outputDirectory: path.join(directory.path, "reports"),
    })
    expect(result.boundaries.map((item) => item.boundary)).toEqual([
      "before_transaction",
      "after_mutation_write",
      "after_commit",
    ])
    expect(result.boundaries.map((item) => item.atomicState)).toEqual(["old", "old", "new"])
    expect(result.boundaries.map((item) => item.replayed)).toEqual([false, false, true])
    expect(
      result.boundaries.every(
        (item) =>
          item.crashedPid !== item.recoveryPid &&
          item.signal === "SIGKILL" &&
          item.markerVerified &&
          item.beforeRevision === 0 &&
          item.afterRevision === 1 &&
          item.duplicateSideEffects === 0,
      ),
    ).toBe(true)
    expect(result.entityIds.projectIds).toHaveLength(3)
    expect(result.entityIds.receiptIds).toHaveLength(3)
    expect(result.entityIds.mutationIds).toHaveLength(3)
    expect(result.exactlyOnce).toBe(true)
    expect(result.duplicateSideEffects).toBe(0)
  },
  { timeout: 30_000 },
)

test.serial(
  "S27 completes startup reconciliation before dispatch and converges the projection watermark",
  async () => {
    await using directory = await tmpdir()
    using environment = recoveryEnvironment(path.join(directory.path, "s27.db"), path.join(directory.path, "home"))
    const result = await produceB5CandidateRecovery({
      candidateSha: "e".repeat(40),
      scenarioId: "S27",
      snapshotDigest: "f".repeat(64),
      runId: "b5-s27-startup-recovery",
      outputDirectory: path.join(directory.path, "reports"),
    })
    expect(result.process?.crashedPid).not.toBe(result.process?.recoveryPid)
    expect(result.process?.signal).toBe("SIGKILL")
    expect(result.startup).toMatchObject({
      dispatchAfterReconcile: true,
      phases: ["company_project", "receipt_graph", "project_orchestrator", "projection"],
      projectionConverged: true,
    })
    expect(result.startup?.reconciledAt).toBeGreaterThanOrEqual(result.startup?.recoveryStartedAt ?? Infinity)
    expect(result.startup?.dispatchProbedAt).toBeGreaterThanOrEqual(result.startup?.reconciledAt ?? Infinity)
    expect(result.startup?.projectionWatermarkAfter).not.toBe(result.startup?.projectionWatermarkBefore)
    expect(result.entityIds.receiptIds).toHaveLength(1)
    expect(result.entityIds.mutationIds).toHaveLength(1)
    expect(result.exactlyOnce).toBe(true)
    expect(result.duplicateSideEffects).toBe(0)
  },
  { timeout: 30_000 },
)
