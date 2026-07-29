import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RolloutPromotionEvaluationRequest } from "@agents-company/shared/rollout"
import {
  MetricContract,
  PrePublicCandidateMetricIds,
  PrePublicMetricContractSha256,
} from "@agents-company/shared/seed-grow-metrics"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { bindPersistedFactArtifact, loadPersistedFactArtifact } from "../../src/metrics/persisted-fact-artifact"
import { PrePublicGateError, validateRollbackPair } from "../../script/seed-grow-pre-public-gate"
import { resetDatabase } from "../fixture/db"

const root = path.resolve(import.meta.dir, "../../../..")
const directories: string[] = []
const worktrees: string[] = []
const metricContract = MetricContract.parse(
  JSON.parse(
    readFileSync(path.join(root, "docs/product-design/experience-refactor/metric-contract.v1.json"), "utf8"),
  ) as unknown,
)
let previousExecutionMode: string | undefined

beforeEach(async () => {
  previousExecutionMode = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
  worktrees.splice(0).forEach((worktree) => {
    Bun.spawnSync(["git", "worktree", "remove", "--force", worktree], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
  })
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  if (previousExecutionMode === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previousExecutionMode
})

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
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
      "seed-grow gate security candidate",
    ),
  }
}

function passingValue(operator: string, target: number) {
  if (operator === "<") return target - 1
  if (operator === ">") return target + 1
  return target
}

function metricReport(candidateSha: string) {
  const runIds = [`${candidateSha.slice(0, 8)}-metric-1`, `${candidateSha.slice(0, 8)}-metric-2`]
  return {
    schemaVersion: 1 as const,
    queryVersion: metricContract.queryVersion,
    candidateSha,
    inputDigest: "1".repeat(64),
    runIds,
    status: "pass" as const,
    results: PrePublicCandidateMetricIds.map((metricId) => {
      const metric = metricContract.metrics.find((item) => item.id === metricId)
      if (!metric || metric.target.value === null) throw new Error(`Missing blocking metric ${metricId}`)
      const value = passingValue(metric.target.operator, metric.target.value)
      return {
        metricId,
        blocking: true,
        status: "pass" as const,
        value,
        numerator: value,
        denominator: 1,
        sampleSize: 2,
        meetsThreshold: true,
        threshold: metric.target,
        blockedReasons: [],
        sourceRefs: runIds.map((runId, index) => ({
          kind: "gate_report" as const,
          id: `${metricId}-${index}`,
          candidateSha,
          runId,
          digest: String(index + 2).repeat(64),
        })),
      }
    }),
  }
}

function shadowReport(candidateSha: string) {
  if (!metricContract.shadowComparison) throw new Error("Missing shadow comparison policy")
  const values = Object.fromEntries(
    metricContract.shadowComparison.checks.map((check) => [check.field, passingValue(check.operator, check.value)]),
  )
  const legacyRunIds = [`${candidateSha.slice(0, 8)}-legacy-1`, `${candidateSha.slice(0, 8)}-legacy-2`]
  const seedAndGrowRunIds = [`${candidateSha.slice(0, 8)}-seed-1`, `${candidateSha.slice(0, 8)}-seed-2`]
  return ShadowComparisonReport.parse({
    schemaVersion: 1,
    queryVersion: metricContract.shadowComparison.queryVersion,
    comparisonId: `comparison-${candidateSha.slice(0, 8)}`,
    candidateSha,
    inputDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64),
    scenarioIds: ["S13", "S18"],
    legacyRunIds,
    seedAndGrowRunIds,
    status: "pass",
    blockedReasons: [],
    deltas: {
      completenessRateDelta: values.completenessRateDelta,
      modelCallsPerUnitDelta: -1,
      costPerUnitDelta: -1,
      reviewerInvocationRatio: values.reviewerInvocationRatio,
      unknownDiscoveryRateDelta: 1,
      errorRateDelta: values.errorRateDelta,
      candidateReuseRateDelta: values.candidateReuseRateDelta,
      lowRiskQualityRatio: values.lowRiskQualityRatio,
    },
    checks: metricContract.shadowComparison.checks.map((check) => ({
      id: check.id,
      field: check.field,
      operator: check.operator,
      target: check.value,
      blocking: check.blocking,
      status: "pass",
      value: values[check.field],
    })),
    sourceRefs: [...legacyRunIds, ...seedAndGrowRunIds].map((runId, index) => ({
      kind: "shadow_report",
      id: `shadow-source-${candidateSha.slice(0, 8)}-${index}`,
      candidateSha,
      runId,
      digest: String(index + 5).repeat(64),
    })),
  })
}

function promotionRequest(previousSha: string, currentSha: string) {
  return RolloutPromotionEvaluationRequest.parse({
    id: "promotion-security",
    candidateIds: ["candidate-previous", "candidate-current"],
    metricContract,
    metricContractSha256: PrePublicMetricContractSha256,
    metricReports: [metricReport(previousSha), metricReport(currentSha)],
    shadowReports: [shadowReport(previousSha), shadowReport(currentSha)],
    ancestry: {
      previousCandidateSha: previousSha,
      currentCandidateSha: currentSha,
      parentSha: previousSha,
      targetRef: "refs/heads/main",
      verified: true,
      commandEvidenceSha256: "f".repeat(64),
    },
  })
}

function advanceToDogfood() {
  for (const [to, id] of [
    ["shadow", "phase-shadow"],
    ["opt_in", "phase-opt-in"],
    ["dogfood_default", "phase-dogfood"],
  ] as const)
    CompanyRollout.transition({
      idempotencyKey: id,
      to,
      reason: `advance to ${to}`,
    })
}

function registerCandidate(id: string, candidateSha: string) {
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: `register-${id}`,
    candidate: {
      id,
      candidateSha,
      targetRef: "refs/heads/main",
    },
  })
  for (const ordinal of [1, 2] as const)
    CompanyRollout.recordAction({
      kind: "record_local_repeat",
      idempotencyKey: `repeat-${id}-${ordinal}`,
      repeat: {
        id: `repeat-${id}-${ordinal}`,
        candidateId: id,
        runId: `copied-package-${id}-${ordinal}`,
        ordinal,
        outcome: "completed",
        environmentSha256: "8".repeat(64),
        evidenceSha256: (ordinal === 1 ? "9" : "a").repeat(64),
        normalizedResultSha256: candidateSha.slice(0, 1).repeat(64),
        startedAt: ordinal * 100,
        finishedAt: ordinal * 100 + 50,
      },
    })
}

function recordSyntheticRollbacks(candidateId = "candidate-current") {
  for (const [target, executionModeAfter, digestValue] of [
    ["kill_switch", "off", "c"],
    ["legacy_fallback", "active", "d"],
  ] as const) {
    process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = executionModeAfter
    CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: `rollback-${target}`,
      rollback: {
        id: `rollback-${target}`,
        candidateId,
        target,
        phaseAtAction: "dogfood_default",
        executionModeAfter,
        outcome: "completed",
        evidenceSha256: digestValue.repeat(64),
        observedAt: Date.now(),
      },
    })
  }
}

function repeat(ordinal: 1 | 2) {
  return {
    runId: `run-${ordinal}`,
    ordinal,
    environmentSha256: "8".repeat(64),
    evidenceSha256: (ordinal === 1 ? "9" : "a").repeat(64),
    normalizedResultSha256: "b".repeat(64),
    startedAt: ordinal * 100,
    finishedAt: ordinal * 100 + 50,
  }
}

function rollback(candidateSha: string, inputSha256: string, target: "kill_switch" | "legacy_fallback") {
  const executionMode = target === "kill_switch" ? "off" : "active"
  const defaultStrategy = target === "kill_switch" ? "legacy_full_plan" : "seed_and_grow"
  return {
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-${target}`,
    inputSha256,
    candidateSha,
    localRepeat: repeat(target === "kill_switch" ? 1 : 2),
    target,
    outcome: "completed",
    phaseAtAction: "dogfood_default",
    before: {
      phase: "dogfood_default",
      executionMode: target === "kill_switch" ? "active" : "off",
      newProjectPolicy: {
        defaultStrategy: target === "kill_switch" ? "seed_and_grow" : "legacy_full_plan",
        seedOptInAllowed: target === "kill_switch",
        explicitLegacyFallbackAllowed: target === "kill_switch",
      },
    },
    after: {
      phase: "dogfood_default",
      executionMode,
      newProjectPolicy: {
        defaultStrategy,
        seedOptInAllowed: target === "legacy_fallback",
        explicitLegacyFallbackAllowed: target === "legacy_fallback",
      },
    },
    inFlightProject: {
      id: "synthetic-project",
      status: "executing",
      strategyBefore: "seed_and_grow",
      strategyAfter: "seed_and_grow",
      businessStateSha256Before: "e".repeat(64),
      businessStateSha256After: "e".repeat(64),
    },
    resolvedNewProjectStrategy: defaultStrategy,
    resolvedExplicitFallbackStrategy: "legacy_full_plan",
    isolation: {
      database: "fresh_local_sqlite",
      databasePathSha256: "f".repeat(64),
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    observedAt: Date.now(),
  }
}

async function runBun(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(["bun", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe.serial("Seed-and-Grow Pre-Public gate security", () => {
  test("rejects a dirty side-loaded verifier before consuming candidate evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-dirty-verifier-"))
    directories.push(directory)
    const worktree = path.join(directory, "worktree")
    const added = Bun.spawnSync(["git", "worktree", "add", "--detach", worktree, git("rev-parse", "HEAD")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (added.exitCode !== 0) throw new Error(added.stderr.toString())
    worktrees.push(worktree)
    await symlink(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "dir")
    await symlink(
      path.join(root, "packages/control-plane/node_modules"),
      path.join(worktree, "packages/control-plane/node_modules"),
      "dir",
    )
    const verifier = path.join(worktree, "script/experience-automatic-evidence.ts")
    await writeFile(verifier, `${await readFile(verifier, "utf8")}\n`)
    const requestPath = path.join(directory, "request.json")
    const candidate = candidateFromVerifier()
    await writeFile(
      requestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        mode: "bootstrap",
        candidate: {
          candidateSha: candidate.candidateSha,
          verifierSha: candidate.verifierSha,
          targetRef: candidate.candidateSha,
        },
        outputDirectory: path.join(directory, "output"),
      })}\n`,
    )
    const result = await runBun(
      ["script/seed-grow-pre-public-gate.ts", requestPath],
      path.join(worktree, "packages/control-plane"),
    )
    if (!result.stdout) throw new Error(result.stderr)
    const decision = JSON.parse(result.stdout) as { status: string; reasons: string[] }
    expect(result.exitCode).toBe(64)
    expect(decision.status).toBe("invalid")
    expect(decision.reasons.join("\n")).toMatch(/dirty|runtime|runner binding/i)
  })

  test("rejects a candidate that changes the pinned acceptance suite", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-acceptance-candidate-"))
    directories.push(directory)
    const worktree = path.join(directory, "worktree")
    const verifierSha = git("rev-parse", "HEAD")
    const added = Bun.spawnSync(["git", "worktree", "add", "--detach", worktree, verifierSha], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (added.exitCode !== 0) throw new Error(added.stderr.toString())
    worktrees.push(worktree)
    const manifest = path.join(worktree, "packages/control-plane/package.json")
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\n`)
    const staged = Bun.spawnSync(["git", "add", "packages/control-plane/package.json"], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (staged.exitCode !== 0) throw new Error(staged.stderr.toString())
    const tree = Bun.spawnSync(["git", "write-tree"], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (tree.exitCode !== 0) throw new Error(tree.stderr.toString())
    const candidateSha = git(
      "commit-tree",
      tree.stdout.toString().trim(),
      "-p",
      verifierSha,
      "-m",
      "tamper acceptance suite",
    )
    const requestPath = path.join(directory, "request.json")
    await writeFile(
      requestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        mode: "bootstrap",
        candidate: {
          candidateSha,
          verifierSha,
          targetRef: candidateSha,
        },
        outputDirectory: path.join(directory, "output"),
      })}\n`,
    )
    const result = await runBun(
      ["script/seed-grow-pre-public-gate.ts", requestPath],
      path.join(root, "packages/control-plane"),
    )
    if (!result.stdout) throw new Error(result.stderr)
    const decision = JSON.parse(result.stdout) as { status: string; reasons: string[] }
    expect(result.exitCode).toBe(64)
    expect(decision.status).toBe("invalid")
    expect(decision.reasons.join("\n")).toContain("pinned acceptance assets")
  })

  test("rejects copied repeat packages whose only difference can be ignored timestamps", () => {
    const previousSha = git("rev-parse", "HEAD^")
    const currentSha = git("rev-parse", "HEAD")
    advanceToDogfood()
    registerCandidate("candidate-previous", previousSha)
    registerCandidate("candidate-current", currentSha)
    recordSyntheticRollbacks()
    const decision = CompanyRollout.evaluatePrePublicPromotion(promotionRequest(previousSha, currentSha))
    expect(decision.status).toBe("failed")
    expect(decision.reasons).toContain("candidate_repeat_not_independent:candidate-previous")
    expect(decision.reasons).toContain("candidate_repeat_not_independent:candidate-current")
  })

  test("rejects a side-loaded fact artifact with an unbound producer digest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-fact-sideload-"))
    directories.push(directory)
    const source = `${JSON.stringify(
      bindPersistedFactArtifact({
        schemaVersion: 1,
        kind: "seed-grow-local-gate-persisted-facts",
        id: "side-loaded-facts",
        producer: {
          kind: "local_gate",
          commandId: "side-loaded-producer",
          version: "1.0.0",
          executableDigest: "f".repeat(64),
        },
        candidateSha: git("rev-parse", "HEAD"),
        metricContractDigest: PrePublicMetricContractSha256,
        metricQueryVersion: "seed-grow-metric-query.v1",
        shadowQueryVersion: "seed-grow-shadow-query.v1",
        window: {
          id: "window",
          startedAt: "2026-07-29T00:00:00.000Z",
          endedAt: "2026-07-29T01:00:00.000Z",
        },
        runBindings: [
          {
            runId: "side-loaded-run",
            projectId: "side-loaded-project",
            strategy: "seed_and_grow",
            scenarioId: "S13",
            snapshotDigest: "e".repeat(64),
          },
        ],
        events: [],
      }),
      null,
      2,
    )}\n`
    const target = path.join(directory, "facts.json")
    await writeFile(target, source)
    await expect(loadPersistedFactArtifact({ path: target, sha256: sha256(source) })).rejects.toThrow(
      /producer|executable|trusted/i,
    )
  })

  test("rejects rollback artifacts without a real process and dispatch observation", () => {
    const candidateSha = git("rev-parse", "HEAD")
    const inputSha256 = "1".repeat(64)
    expect(() =>
      validateRollbackPair(
        [rollback(candidateSha, inputSha256, "kill_switch"), rollback(candidateSha, inputSha256, "legacy_fallback")],
        candidateSha,
        [repeat(1), repeat(2)],
        inputSha256,
      ),
    ).toThrow(PrePublicGateError)
  })

  test("reopens the isolated database in a new process and reads the persisted promotion transition", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-persisted-transition-"))
    directories.push(directory)
    await mkdir(path.join(directory, "home"), { recursive: true })
    const previousSha = git("rev-parse", "HEAD^")
    const currentSha = git("rev-parse", "HEAD")
    const requestPath = path.join(directory, "promotion-request.json")
    await writeFile(requestPath, `${JSON.stringify(promotionRequest(previousSha, currentSha))}\n`)
    const env = {
      ...process.env,
      AGENTCOMPANY_DB: path.join(directory, "rollout.db"),
      AGENTCOMPANY_HOME: path.join(directory, "home"),
      AGENTCOMPANY_SEED_GROW_ORCHESTRATION: "active",
      PROMOTION_REQUEST_PATH: requestPath,
    }
    const first = await runBun(
      [
        "-e",
        `
const CompanyRollout = await import("./src/company-rollout/company-rollout.ts")
const { Database } = await import("./src/storage/index.ts")
for (const [to, id] of [["shadow", "shadow"], ["opt_in", "opt-in"], ["dogfood_default", "dogfood"]])
  CompanyRollout.transition({ idempotencyKey: id, to, reason: to })
const request = await Bun.file(process.env.PROMOTION_REQUEST_PATH).json()
for (const [index, candidateSha] of [request.ancestry.previousCandidateSha, request.ancestry.currentCandidateSha].entries()) {
  const candidateId = request.candidateIds[index]
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: "register-" + candidateId,
    candidate: { id: candidateId, candidateSha, targetRef: request.ancestry.targetRef },
  })
  for (const ordinal of [1, 2])
    CompanyRollout.recordAction({
      kind: "record_local_repeat",
      idempotencyKey: "repeat-" + candidateId + "-" + ordinal,
      repeat: {
        id: "repeat-" + candidateId + "-" + ordinal,
        candidateId,
        runId: "run-" + candidateId + "-" + ordinal,
        ordinal,
        outcome: "completed",
        environmentSha256: String(index * 2 + ordinal).repeat(64),
        evidenceSha256: String(index * 2 + ordinal + 4).repeat(64),
        normalizedResultSha256: String(index + 5).repeat(64),
        startedAt: (index * 2 + ordinal) * 100,
        finishedAt: (index * 2 + ordinal) * 100 + 50,
      },
    })
}
for (const [target, executionModeAfter, digest] of [["kill_switch", "off", "c"], ["legacy_fallback", "active", "d"]]) {
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = executionModeAfter
  CompanyRollout.recordAction({
    kind: "record_rollback",
    idempotencyKey: "rollback-" + target,
    rollback: {
      id: "rollback-" + target,
      candidateId: request.candidateIds[1],
      target,
      phaseAtAction: "dogfood_default",
      executionModeAfter,
      outcome: "completed",
      evidenceSha256: digest.repeat(64),
      observedAt: Date.now(),
    },
  })
}
const promotion = CompanyRollout.evaluatePrePublicPromotion(request)
const transition = CompanyRollout.transition({
  idempotencyKey: "pre-public",
  to: "pre_public_default",
  reason: "persisted restart proof",
  promotionDecisionId: promotion.id,
})
Database.close()
process.stdout.write(JSON.stringify({ promotion, transition }))
`,
      ],
      path.join(root, "packages/control-plane"),
      env,
    )
    expect(first.exitCode, first.stderr).toBe(0)
    const second = await runBun(
      [
        "-e",
        `
const CompanyRollout = await import("./src/company-rollout/company-rollout.ts")
const { Database } = await import("./src/storage/index.ts")
const result = {
  promotion: CompanyRollout.getPromotionDecision("promotion-security"),
  status: CompanyRollout.status(),
  journal: CompanyRollout.listJournal(),
}
Database.close()
process.stdout.write(JSON.stringify(result))
`,
      ],
      path.join(root, "packages/control-plane"),
      env,
    )
    expect(second.exitCode, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({
      promotion: { id: "promotion-security", status: "pass" },
      status: { state: { phase: "pre_public_default" } },
      journal: {
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "transition",
          }),
        ]),
      },
    })
  })
})
