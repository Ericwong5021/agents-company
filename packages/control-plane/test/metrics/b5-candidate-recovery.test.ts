import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { produceB5CandidateRecovery } from "../../src/metrics/b5-candidate-recovery"
import { tmpdir } from "../fixture/fixture"

test.serial("S19 kills a committed pending Receipt child and reopens it exactly once", async () => {
  await using directory = await tmpdir()
  process.env.AGENTCOMPANY_DB = path.join(directory.path, "s19.db")
  process.env.AGENTCOMPANY_HOME = path.join(directory.path, "home")
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
})
