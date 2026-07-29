import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { RolloutPromotionEvaluationRequest } from "@agents-company/shared/rollout"
import {
  MetricContract,
  PrePublicCandidateMetricIds,
  PrePublicMetricContractSha256,
} from "@agents-company/shared/seed-grow-metrics"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { bindPersistedFactArtifact, loadPersistedFactArtifact } from "../../src/metrics/persisted-fact-artifact"
import {
  PrePublicGateError,
  validateRollbackPair,
  verifyPromotionDatabaseForTest,
} from "../../script/seed-grow-pre-public-gate"
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

function gitSource(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
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

const stageIds = ["A0", "A1", "A2", "A3", "A4", "B0", "B1", "B2", "B3", "B4", "B5"] as const
const rolloutIndexes = [
  "company_rollout_promotion_created_idx",
  "company_rollout_promotion_status_idx",
  "company_rollout_shadow_project_idx",
  "company_rollout_shadow_receipt_idx",
  "company_rollout_shadow_source_idx",
] as const
const rolloutIndexReconciliationMigration = "20260729130000_rollout_index_reconciliation"

function gateCandidateEvidence(directory: string, candidateSha: string, candidateIndex: number) {
  const repeats = ([1, 2] as const).map((ordinal) => ({
    runId: `gate-run-${candidateIndex + 1}-${ordinal}-${candidateSha.slice(0, 8)}`,
    ordinal,
    environmentSha256: sha256(`environment-${candidateIndex + 1}-${ordinal}-${candidateSha}`),
    evidenceSha256: sha256(`evidence-${candidateIndex + 1}-${ordinal}-${candidateSha}`),
    normalizedResultSha256: sha256(`normalized-${candidateSha}`),
    startedAt: candidateIndex * 200 + ordinal * 100,
    finishedAt: candidateIndex * 200 + ordinal * 100 + 50,
  }))
  return {
    evidenceDirectory: path.join(directory, `candidate-${candidateIndex + 1}`),
    finalRun: {
      path: path.join(directory, `candidate-${candidateIndex + 1}`, "final-run.json"),
      sha256: sha256(`final-run-${candidateSha}`),
    },
    finalDecision: {
      path: path.join(directory, `candidate-${candidateIndex + 1}`, "final-decision.json"),
      sha256: sha256(`final-decision-${candidateSha}`),
    },
    stageRunSha256s: Object.fromEntries(
      stageIds.map((stage) => [stage, sha256(`stage-run-${stage}-${candidateSha}`)]),
    ),
    stageDecisionSha256s: Object.fromEntries(
      stageIds.map((stage) => [stage, sha256(`stage-decision-${stage}-${candidateSha}`)]),
    ),
    runtime: {
      bun: {
        pathSha256: sha256("bun-path"),
        fileSha256: sha256("bun-file"),
      },
      git: {
        pathSha256: sha256("git-path"),
        fileSha256: sha256("git-file"),
      },
    },
    repeats,
  }
}

function activeRolloutStatus() {
  return {
    phase: "dogfood_default",
    executionMode: "active",
    newProjectPolicy: {
      defaultStrategy: "seed_and_grow",
      seedOptInAllowed: true,
      explicitLegacyFallbackAllowed: true,
    },
  } as const
}

function disabledRolloutStatus() {
  return {
    phase: "dogfood_default",
    executionMode: "off",
    newProjectPolicy: {
      defaultStrategy: "legacy_full_plan",
      seedOptInAllowed: false,
      explicitLegacyFallbackAllowed: false,
    },
  } as const
}

function gateRollbackObservation(
  candidateSha: string,
  target: "kill_switch" | "legacy_fallback",
  observedAt: number,
) {
  const projectId = `rollback-project-${target}`
  const result =
    target === "kill_switch"
      ? {
          project_id: projectId,
          status: "paused" as const,
          barrier: "paused" as const,
          eligible_work_item_ids: [] as [],
          dispatched_work_item_ids: [] as [],
        }
      : {
          project_id: projectId,
          status: "idle" as const,
          barrier: "open" as const,
          eligible_work_item_ids: [] as [],
          dispatched_work_item_ids: [] as [],
        }
  return {
    schemaVersion: 1,
    kind: "seed-grow-b5-rollback-observation",
    candidateSha,
    attemptId: target === "kill_switch" ? "attempt-01" : "attempt-02",
    attemptIsolationId: sha256(`isolation-${target}`).slice(0, 16),
    outcome: "completed",
    phaseAtAction: "dogfood_default",
    target,
    before: activeRolloutStatus(),
    after: target === "kill_switch" ? disabledRolloutStatus() : activeRolloutStatus(),
    inFlightProject: {
      id: projectId,
      status: "executing",
      strategyBefore: "seed_and_grow",
      strategyAfter: "seed_and_grow",
      businessStateSha256Before: sha256(`business-${target}`),
      businessStateSha256After: sha256(`business-${target}`),
    },
    process: {
      pid: process.pid,
      producerPath: "packages/control-plane/script/produce-seed-grow-candidate-facts.ts",
      producerSha256: sha256("producer"),
      startedAt: observedAt - 1,
    },
    businessRows: {
      beforeSha256: sha256(`rows-before-${target}`),
      afterSha256: sha256(`rows-after-${target}`),
      newProjectId: `new-project-${target}`,
      newProjectStrategy: "legacy_full_plan",
      existingProjectId: projectId,
      existingProjectStrategyBefore: "seed_and_grow",
      existingProjectStrategyAfter: "seed_and_grow",
    },
    dispatch: {
      coordinator: "DispatchCoordinator",
      action: target,
      projectId,
      result,
      resultSha256: CompanyRollout.valueSha256(result),
      observedAt,
    },
    resolvedNewProjectStrategy: "legacy_full_plan",
    resolvedExplicitFallbackStrategy: "legacy_full_plan",
    isolation: {
      database: "fresh_local_sqlite",
      databasePathSha256: sha256(`database-${target}`),
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [] as [],
    },
    observedAt,
  } as const
}

function promotionDatabaseInput(directory: string, previousSha: string, currentSha: string) {
  const verifierSha = git("rev-parse", "HEAD~2")
  const candidateIds = [
    `candidate-01-${previousSha.slice(0, 16)}`,
    `candidate-02-${currentSha.slice(0, 16)}`,
  ] as const
  const candidates = [
    {
      id: candidateIds[0],
      candidate: {
        candidateSha: previousSha,
        verifierSha,
        targetRef: "refs/heads/main",
      },
      evidence: gateCandidateEvidence(directory, previousSha, 0),
    },
    {
      id: candidateIds[1],
      candidate: {
        candidateSha: currentSha,
        verifierSha,
        targetRef: "refs/heads/main",
      },
      evidence: gateCandidateEvidence(directory, currentSha, 1),
    },
  ] as const
  const inputSha256 = sha256("promotion-database-input")
  const observations = [
    gateRollbackObservation(currentSha, "kill_switch", 1_000),
    gateRollbackObservation(currentSha, "legacy_fallback", 2_000),
  ] as const
  const rollbacks = observations.map((observation, index) => ({
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-${observation.target}-${currentSha.slice(0, 16)}-${index + 1}`,
    inputSha256,
    candidateSha: currentSha,
    localRepeat: candidates[1].evidence.repeats[index],
    observation,
  }))
  const promotionId = `promotion-${currentSha.slice(0, 16)}`
  return {
    schemaVersion: 1,
    candidateIds,
    candidates,
    rollbacks,
    rollbackEvidenceSha256s: rollbacks.map((item) => sha256(JSON.stringify(item))),
    promotionRequest: RolloutPromotionEvaluationRequest.parse({
      id: promotionId,
      candidateIds,
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
        commandEvidenceSha256: sha256("git-parent-proof"),
      },
    }),
    transitionRequest: {
      idempotencyKey: `pre-public-transition-${currentSha.slice(0, 16)}`,
      to: "pre_public_default",
      reason: "Two exact-SHA candidates passed all automatic Pre-Public gates",
      actorId: "seed-grow-pre-public-gate",
      promotionDecisionId: promotionId,
    },
  }
}

async function tamperedDatabase(
  directory: string,
  source: string,
  name: string,
  mutate: (database: SQLiteDatabase) => void,
) {
  const target = path.join(directory, `${name}.db`)
  await copyFile(source, target)
  const database = new SQLiteDatabase(target)
  mutate(database)
  database.close()
  return target
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

async function linkNodeModules(worktree: string) {
  const source = path.join(root, "packages/control-plane/node_modules")
  const destination = path.join(worktree, "packages/control-plane/node_modules")
  await mkdir(destination, { recursive: true })
  await Promise.all(
    (await readdir(source)).map((entry) => symlink(path.join(source, entry), path.join(destination, entry))),
  )
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
    await linkNodeModules(worktree)
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
      {
        ...process.env,
        AGENTCOMPANY_TRUSTED_VERIFIER_SHA: candidate.verifierSha,
        AGENTCOMPANY_VERIFIER_LAUNCHER_SHA256: sha256(
          gitSource("show", `${candidate.verifierSha}:packages/control-plane/script/seed-grow-pre-public-launcher.ts`),
        ),
      },
    )
    if (!result.stdout) throw new Error(result.stderr)
    const decision = JSON.parse(result.stdout) as { status: string; reasons: string[] }
    expect(result.exitCode).toBe(64)
    expect(decision.status).toBe("invalid")
    expect(decision.reasons.join("\n")).toMatch(/dirty|runtime|runner binding|exact Git tree/i)
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
    await linkNodeModules(worktree)
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
    const reset = Bun.spawnSync(["git", "reset", "--hard", verifierSha], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (reset.exitCode !== 0) throw new Error(reset.stderr.toString())
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
      path.join(worktree, "packages/control-plane"),
      {
        ...process.env,
        AGENTCOMPANY_TRUSTED_VERIFIER_SHA: verifierSha,
        AGENTCOMPANY_VERIFIER_LAUNCHER_SHA256: sha256(
          gitSource("show", `${verifierSha}:packages/control-plane/script/seed-grow-pre-public-launcher.ts`),
        ),
      },
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

  test("creates rollout indexes for fresh databases and reconciles legacy databases", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-rollout-indexes-"))
    directories.push(directory)
    const probe = `
const { Database } = await import("./src/storage/index.ts")
const database = Database.Client().$client
const result = {
  indexes: database
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${rolloutIndexes.map(() => "?").join(", ")}) ORDER BY name")
    .all(${rolloutIndexes.map((name) => JSON.stringify(name)).join(", ")})
    .map((row) => row.name),
  migrationCount: database
    .query("SELECT count(*) AS count FROM __drizzle_migrations WHERE name = ?")
    .get(${JSON.stringify(rolloutIndexReconciliationMigration)}).count,
}
Database.close()
process.stdout.write(JSON.stringify(result))
`
    const fresh = await runBun(["-e", probe], path.join(root, "packages/control-plane"), {
      ...process.env,
      AGENTCOMPANY_DB: path.join(directory, "fresh.db"),
      AGENTCOMPANY_HOME: path.join(directory, "fresh-home"),
    })
    expect(fresh.exitCode, fresh.stderr).toBe(0)
    expect(JSON.parse(fresh.stdout)).toEqual({
      indexes: [...rolloutIndexes],
      migrationCount: 1,
    })

    const upgradeEnv = {
      ...process.env,
      AGENTCOMPANY_DB: path.join(directory, "upgrade.db"),
      AGENTCOMPANY_HOME: path.join(directory, "upgrade-home"),
    }
    const legacy = await runBun(
      [
        "-e",
        `
const { Database } = await import("./src/storage/index.ts")
const database = Database.Client().$client
for (const name of ${JSON.stringify(rolloutIndexes)})
  database.exec("DROP INDEX \`" + name + "\`")
database.query("DELETE FROM __drizzle_migrations WHERE name = ?").run(${JSON.stringify(
          rolloutIndexReconciliationMigration,
        )})
Database.close()
`,
      ],
      path.join(root, "packages/control-plane"),
      upgradeEnv,
    )
    expect(legacy.exitCode, legacy.stderr).toBe(0)
    const upgraded = await runBun(["-e", probe], path.join(root, "packages/control-plane"), upgradeEnv)
    expect(upgraded.exitCode, upgraded.stderr).toBe(0)
    expect(JSON.parse(upgraded.stdout)).toEqual({
      indexes: [...rolloutIndexes],
      migrationCount: 1,
    })
  })

  test("attests the restarted promotion database and rejects persistence tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-grow-persisted-transition-"))
    directories.push(directory)
    await mkdir(path.join(directory, "home"), { recursive: true })
    const previousSha = git("rev-parse", "HEAD^")
    const currentSha = git("rev-parse", "HEAD")
    const input = promotionDatabaseInput(directory, previousSha, currentSha)
    const inputPath = path.join(directory, "promotion-input.json")
    await writeFile(inputPath, `${JSON.stringify(input)}\n`)
    const databasePath = path.join(directory, "rollout.db")
    const env = {
      ...process.env,
      AGENTCOMPANY_DB: databasePath,
      AGENTCOMPANY_HOME: path.join(directory, "home"),
      PROMOTION_INPUT_PATH: inputPath,
    }
    const first = await runBun(
      [
        "-e",
        `
const path = await import("node:path")
const CompanyRollout = await import("./src/company-rollout/company-rollout.ts")
const { Database } = await import("./src/storage/index.ts")
const inputSource = await Bun.file(process.env.PROMOTION_INPUT_PATH).text()
const input = JSON.parse(inputSource)
const currentSha = input.candidates[1].candidate.candidateSha
const digest = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
for (const [to, id] of [["shadow", "shadow"], ["opt_in", "opt-in"], ["dogfood_default", "dogfood"]])
  CompanyRollout.transition({
    idempotencyKey: "pre-public-" + id + "-" + currentSha.slice(0, 12),
    to,
    reason: "Isolated Pre-Public candidate gate enters " + to,
    actorId: "seed-grow-pre-public-gate",
  })
for (const [candidateIndex, item] of input.candidates.entries()) {
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: "register-" + (candidateIndex + 1) + "-" + item.candidate.candidateSha.slice(0, 16),
    candidate: {
      id: item.id,
      candidateSha: item.candidate.candidateSha,
      targetRef: item.candidate.targetRef,
    },
  })
  for (const repeat of item.evidence.repeats)
    CompanyRollout.recordAction({
      kind: "record_local_repeat",
      idempotencyKey:
        "record-" + (candidateIndex + 1) + "-" + repeat.ordinal + "-" + item.candidate.candidateSha.slice(0, 12),
      repeat: {
        id: "repeat-" + (candidateIndex + 1) + "-" + repeat.ordinal + "-" + item.candidate.candidateSha.slice(0, 12),
        candidateId: item.id,
        ...repeat,
        outcome: "completed",
      },
    })
}
for (const [index, rollback] of input.rollbacks.entries()) {
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION =
    rollback.observation.target === "kill_switch" ? "off" : "active"
  CompanyRollout.recordAction({
    kind: "record_rollback",
    idempotencyKey: "record-" + rollback.id,
    rollback: {
      id: rollback.id,
      candidateId: input.candidateIds[1],
      target: rollback.observation.target,
      phaseAtAction: rollback.observation.phaseAtAction,
      executionModeAfter: rollback.observation.after.executionMode,
      outcome: rollback.observation.outcome,
      evidenceSha256: input.rollbackEvidenceSha256s[index],
      observedAt: rollback.observation.observedAt,
    },
  })
}
delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
const promotion = CompanyRollout.evaluatePrePublicPromotion(input.promotionRequest)
const persistedPromotion = CompanyRollout.getPromotionDecision(promotion.id)
const transition = CompanyRollout.transition(input.transitionRequest)
const persistedStatus = CompanyRollout.status()
const evidence = CompanyRollout.evidence()
const journal = CompanyRollout.listJournal()
const result = {
  schemaVersion: 1,
  inputSha256: digest(inputSource),
  promotion,
  persistedPromotion,
  transition,
  persistedStatus,
  persistedEvidenceSha256: CompanyRollout.valueSha256(evidence),
  persistedJournalSha256: CompanyRollout.valueSha256(journal),
  process: {
    pid: process.pid,
    databasePathSha256: digest(path.resolve(process.env.AGENTCOMPANY_DB)),
    homePathSha256: digest(path.resolve(process.env.AGENTCOMPANY_HOME)),
  },
}
Database.close()
process.stdout.write(JSON.stringify(result))
`,
      ],
      path.join(root, "packages/control-plane"),
      env,
    )
    expect(first.exitCode, first.stderr).toBe(0)
    const child = JSON.parse(first.stdout) as unknown
    const second = await runBun(
      [
        "-e",
        `
const CompanyRollout = await import("./src/company-rollout/company-rollout.ts")
const { Database } = await import("./src/storage/index.ts")
const input = await Bun.file(process.env.PROMOTION_INPUT_PATH).json()
const result = {
  promotion: CompanyRollout.getPromotionDecision(input.promotionRequest.id),
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
      promotion: { id: input.promotionRequest.id, status: "pass" },
      status: { state: { phase: "pre_public_default" } },
      journal: {
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "transition",
          }),
        ]),
      },
    })
    expect(await verifyPromotionDatabaseForTest(databasePath, input, child)).toMatch(/^[a-f0-9]{64}$/)

    const journalMode = await tamperedDatabase(directory, databasePath, "journal-mode", (database) => {
      database.query("PRAGMA journal_mode = DELETE").get()
    })
    const schema = await tamperedDatabase(directory, databasePath, "schema", (database) => {
      database.exec("CREATE INDEX company_rollout_tampered_idx ON company_rollout_candidate(target_ref)")
    })
    const promotion = await tamperedDatabase(directory, databasePath, "promotion", (database) => {
      database
        .query("UPDATE company_rollout_promotion_decision SET repeat_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(["fake-1", "fake-2", "fake-3", "fake-4"]), input.promotionRequest.id)
    })
    const actionJournal = await tamperedDatabase(directory, databasePath, "action-journal", (database) => {
      database
        .query(
          `UPDATE company_rollout_journal
           SET payload_json = '{}'
           WHERE id = (
             SELECT id FROM company_rollout_journal
             WHERE kind = 'action' AND action_kind = 'register_candidate'
             ORDER BY created_at, id
             LIMIT 1
           )`,
        )
        .run()
    })
    for (const target of [journalMode, schema, promotion, actionJournal]) {
      const error = await verifyPromotionDatabaseForTest(target, input, child).then(
        () => null,
        (reason: unknown) => reason,
      )
      expect(error).toMatchObject({ status: "invalid" })
    }
  })
})
