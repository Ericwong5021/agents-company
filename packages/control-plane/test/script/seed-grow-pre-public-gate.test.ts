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

function gitSource(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: path.resolve(import.meta.dir, "../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout)
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function candidateFromVerifier() {
  const verifierSha = git("rev-parse", "HEAD")
  return {
    verifierSha,
    candidateSha: git(
      "commit-tree",
      git("rev-parse", `${verifierSha}^{tree}`),
      "-p",
      verifierSha,
      "-m",
      "seed-grow gate test candidate",
    ),
  }
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
  const dispatch = {
    barrier: input.target === "kill_switch" ? "paused" : "open",
    dispatched_work_item_ids: [],
    eligible_work_item_ids: [],
    project_id: "isolated-probe-project",
    status: input.target === "kill_switch" ? "paused" : "idle",
  }
  return {
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-${input.target}`,
    inputSha256: input.inputSha256,
    candidateSha: input.candidateSha,
    localRepeat: input.repeat,
    observation: {
      schemaVersion: 1,
      kind: "seed-grow-b5-rollback-observation",
      candidateSha: input.candidateSha,
      attemptId: "automatic",
      attemptIsolationId: "1".repeat(16),
      target: input.target,
      outcome: "completed",
      phaseAtAction: "dogfood_default",
      before: {
        phase: "dogfood_default",
        executionMode: "active",
        newProjectPolicy: {
          defaultStrategy: "seed_and_grow",
          seedOptInAllowed: true,
          explicitLegacyFallbackAllowed: true,
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
        result: dispatch,
        resultSha256: sha256(JSON.stringify(dispatch)),
        observedAt: 2,
      },
      businessRows: {
        beforeSha256: sha256(`before-${input.target}`),
        afterSha256: sha256(`after-${input.target}`),
        newProjectId: `new-${input.target}`,
        newProjectStrategy: "legacy_full_plan",
        existingProjectId: "isolated-probe-project",
        existingProjectStrategyBefore: "seed_and_grow",
        existingProjectStrategyAfter: "seed_and_grow",
      },
      resolvedNewProjectStrategy: "legacy_full_plan",
      resolvedExplicitFallbackStrategy: "legacy_full_plan",
      isolation: {
        database: "fresh_local_sqlite",
        databasePathSha256: sha256("isolated-database"),
        productionDatabaseInherited: false,
        productionProcessUsed: false,
        networkPortsUsed: [],
      },
      observedAt: 2,
    },
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

  test("rejects a side-loaded evidence directory instead of trusting it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-gate-request-"))
    directories.push(directory)
    const candidate = candidateFromVerifier()
    const requestPath = path.join(directory, "request.json")
    const outputDirectory = path.join(directory, "output")
    await Bun.write(
      requestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        mode: "bootstrap",
        candidate: {
          candidateSha: candidate.candidateSha,
          verifierSha: candidate.verifierSha,
          targetRef: candidate.candidateSha,
          evidenceDirectory: path.join(directory, "missing-evidence"),
        },
        outputDirectory,
      })}\n`,
    )
    const process = Bun.spawn(["bun", "script/seed-grow-pre-public-gate.ts", requestPath], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...globalThis.process.env,
        AGENTCOMPANY_TRUSTED_VERIFIER_SHA: candidate.verifierSha,
        AGENTCOMPANY_VERIFIER_LAUNCHER_SHA256: sha256(
          gitSource("show", `${candidate.verifierSha}:packages/control-plane/script/seed-grow-pre-public-launcher.ts`),
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    expect(exitCode).toBe(64)
    expect(JSON.parse(stdout)).toMatchObject({ status: "invalid" })
    expect(await Bun.file(path.join(outputDirectory, "decision.json")).exists()).toBe(false)
  })
})
