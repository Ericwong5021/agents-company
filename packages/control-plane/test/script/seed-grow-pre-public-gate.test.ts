import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  PrePublicGateError,
  readBoundJSON,
  validateRollbackPair,
  verifyDirectParent,
} from "../../script/seed-grow-pre-public-gate"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: path.resolve(import.meta.dir, "../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function errorOf(operation: () => unknown) {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("Expected operation to fail")
}

function rollback(input: {
  candidateSha: string
  inputSha256: string
  target: "kill_switch" | "legacy_fallback"
  repeat: {
    runId: string
    ordinal: 1 | 2
    environmentSha256: string
    evidenceSha256: string
    normalizedResultSha256: string
    startedAt: number
    finishedAt: number
  }
}) {
  const afterMode = input.target === "kill_switch" ? "off" : "active"
  const afterDefault = input.target === "kill_switch" ? "legacy_full_plan" : "seed_and_grow"
  return {
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-${input.target}`,
    inputSha256: input.inputSha256,
    candidateSha: input.candidateSha,
    localRepeat: input.repeat,
    target: input.target,
    outcome: "completed",
    phaseAtAction: "dogfood_default",
    before: {
      phase: "dogfood_default",
      executionMode: input.target === "kill_switch" ? "active" : "off",
      newProjectPolicy: {
        defaultStrategy: input.target === "kill_switch" ? "seed_and_grow" : "legacy_full_plan",
        seedOptInAllowed: input.target === "kill_switch",
        explicitLegacyFallbackAllowed: input.target === "kill_switch",
      },
    },
    after: {
      phase: "dogfood_default",
      executionMode: afterMode,
      newProjectPolicy: {
        defaultStrategy: afterDefault,
        seedOptInAllowed: input.target === "legacy_fallback",
        explicitLegacyFallbackAllowed: input.target === "legacy_fallback",
      },
    },
    inFlightProject: {
      id: "isolated-probe-project",
      status: "executing",
      strategyBefore: "seed_and_grow",
      strategyAfter: "seed_and_grow",
      businessStateSha256Before: sha256("project-state"),
      businessStateSha256After: sha256("project-state"),
    },
    process: {
      pid: 1,
      producerPath: "packages/control-plane/script/produce-seed-grow-candidate-facts.ts",
      producerSha256: sha256("producer"),
      startedAt: 1,
    },
    dispatch: {
      coordinator: "DispatchCoordinator",
      action: input.target,
      projectId: "isolated-probe-project",
      resultSha256: sha256(`dispatch-${input.target}`),
      observedAt: 2,
    },
    businessRows: {
      beforeSha256: sha256(`before-${input.target}`),
      afterSha256: sha256(`after-${input.target}`),
      newProjectId: `new-${input.target}`,
      newProjectStrategy: afterDefault,
      existingProjectId: "isolated-probe-project",
      existingProjectStrategyBefore: "seed_and_grow",
      existingProjectStrategyAfter: "seed_and_grow",
    },
    resolvedNewProjectStrategy: afterDefault,
    resolvedExplicitFallbackStrategy: "legacy_full_plan",
    isolation: {
      database: "fresh_local_sqlite",
      databasePathSha256: sha256("isolated-database"),
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    observedAt: 1,
  }
}

describe("Seed-and-Grow Pre-Public candidate gate", () => {
  test("uses real Git ancestry and rejects a non-parent candidate", () => {
    const current = git("rev-parse", "HEAD")
    const parent = git("rev-parse", "HEAD^")
    const nonParent = git("rev-parse", "HEAD~2")
    expect(verifyDirectParent(parent, current)).toMatchObject({
      previousCandidateSha: parent,
      currentCandidateSha: current,
      parentSha: parent,
      verified: true,
    })
    const error = errorOf(() => verifyDirectParent(nonParent, current))
    expect(error).toBeInstanceOf(PrePublicGateError)
    expect((error as PrePublicGateError).status).toBe("invalid")
  })

  test("classifies missing evidence as blocked and a wrong digest as invalid", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-bound-json-"))
    directories.push(directory)
    const target = path.join(directory, "artifact.json")
    await Bun.write(target, `${JSON.stringify({ status: "pass" })}\n`)
    await expect(
      readBoundJSON({ path: path.join(directory, "missing.json"), sha256: sha256("missing") }, "Artifact"),
    ).rejects.toMatchObject({ status: "blocked" })
    await expect(readBoundJSON({ path: target, sha256: sha256("wrong") }, "Artifact")).rejects.toMatchObject({
      status: "invalid",
    })
  })

  test("rejects duplicate and incorrectly bound rollback evidence", () => {
    const candidateSha = git("rev-parse", "HEAD")
    const inputSha256 = sha256("request")
    const repeats = [
      {
        runId: "actual-attempt-01",
        ordinal: 1 as const,
        environmentSha256: sha256("environment-01"),
        evidenceSha256: sha256("evidence-01"),
        normalizedResultSha256: sha256("normalized"),
        startedAt: 1,
        finishedAt: 2,
      },
      {
        runId: "actual-attempt-02",
        ordinal: 2 as const,
        environmentSha256: sha256("environment-02"),
        evidenceSha256: sha256("evidence-02"),
        normalizedResultSha256: sha256("normalized"),
        startedAt: 3,
        finishedAt: 4,
      },
    ]
    const kill = rollback({ candidateSha, inputSha256, target: "kill_switch", repeat: repeats[0] })
    const fallback = rollback({ candidateSha, inputSha256, target: "legacy_fallback", repeat: repeats[1] })
    expect(validateRollbackPair([kill, fallback], candidateSha, repeats, inputSha256)).toHaveLength(2)
    const duplicate = errorOf(() =>
      validateRollbackPair([kill, { ...fallback, id: kill.id }], candidateSha, repeats, inputSha256),
    )
    expect(duplicate).toBeInstanceOf(PrePublicGateError)
    expect((duplicate as PrePublicGateError).status).toBe("invalid")
    const wrongCandidate = errorOf(() =>
      validateRollbackPair(
        [kill, { ...fallback, candidateSha: git("rev-parse", "HEAD^") }],
        candidateSha,
        repeats,
        inputSha256,
      ),
    )
    expect(wrongCandidate).toBeInstanceOf(PrePublicGateError)
    expect((wrongCandidate as PrePublicGateError).status).toBe("invalid")
  })

  test("returns a machine-readable blocked decision when request input is absent", async () => {
    const process = Bun.spawn(["bun", "script/seed-grow-pre-public-gate.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    expect(exitCode).toBe(2)
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "seed-grow-pre-public-gate-decision",
      status: "blocked",
    })
  })

  test("persists a blocked decision when required exact-SHA evidence is absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-gate-request-"))
    directories.push(directory)
    const candidateSha = git("rev-parse", "HEAD")
    const requestPath = path.join(directory, "request.json")
    const outputDirectory = path.join(directory, "output")
    await Bun.write(
      requestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        mode: "bootstrap",
        candidate: {
          candidateSha,
          targetRef: "HEAD",
          evidenceDirectory: path.join(directory, "missing-evidence"),
          factArtifact: {
            path: path.join(directory, "missing-facts.json"),
            sha256: sha256("missing-facts"),
          },
          comparisonId: "comparison",
          scenarioIds: ["scenario-01", "scenario-02"],
        },
        outputDirectory,
      })}\n`,
    )
    const process = Bun.spawn(["bun", "script/seed-grow-pre-public-gate.ts", requestPath], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    expect(exitCode).toBe(2)
    expect(JSON.parse(stdout)).toMatchObject({ mode: "bootstrap", status: "blocked" })
    expect(await Bun.file(path.join(outputDirectory, "decision.json")).json()).toMatchObject({
      mode: "bootstrap",
      status: "blocked",
    })
  })
})
