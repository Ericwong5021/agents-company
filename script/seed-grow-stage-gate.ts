import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  loadAutomaticEvidenceGovernance,
  validateAutomaticEvidencePackage,
  writeStructuralAutomaticEvidenceFixture,
  type AutomaticEvidenceGovernance,
} from "./experience-automatic-evidence"
import { canonicalize, sha256 } from "./experience-benchmark"
import {
  assertExactCandidate,
  automaticPackageCreatedAt,
  exactKeys,
  isRecord,
  isSensitiveEvidence,
  loadCurrentSeedGrowGovernance,
  loadSeedGrowGovernance,
  normalizeAutomaticPackage,
  resolveConfinedFile,
  root,
  runGit,
  sourceBinding,
  stageCoverage,
  stageDefinition,
  stageGatePath,
  stageIDs,
  stageRunnerPath,
  validDate,
  validateFileBinding,
  writeFileBinding,
  type FileBinding,
  type SeedGrowGovernance,
  type StageID,
} from "./seed-grow-stage-core"

type StageStatus = "pass" | "failed" | "blocked" | "invalid"

type GateEvaluation = {
  status: StageStatus
  required: string[]
  passed: string[]
  failed: string[]
  missing: string[]
  invalid: string[]
  advisory: string[]
  normalizedDigest: string
  evidencePackageSha256: string | null
}

const runKeys = [
  "schemaVersion",
  "packageVersion",
  "packageId",
  "stage",
  "capabilityPackage",
  "buildSha",
  "buildTreeSha",
  "contractBinding",
  "schemaBinding",
  "runnerBinding",
  "validationProfile",
  "githubActions",
  "createdAt",
  "finishedAt",
  "attempts",
  "coverage",
  "overallStatus",
  "advisory",
]

function mappedStatus(status: string): StageStatus {
  if (status === "pass") return "pass"
  if (status === "fail") return "failed"
  if (status === "incomplete") return "blocked"
  return "invalid"
}

function recomputedStatus(statuses: StageStatus[], digests: string[], missing: string[], invalid: string[]) {
  if (invalid.length || statuses.includes("invalid")) return "invalid"
  if (statuses.includes("failed")) return "failed"
  if (missing.length || statuses.includes("blocked") || statuses.length !== 2) return "blocked"
  return new Set(digests).size === 1 ? "pass" : "invalid"
}

function dateIsFresh(value: string, now: number, governance: SeedGrowGovernance) {
  const timestamp = Date.parse(value)
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now - governance.contract.freshness.maxAgeMs &&
    timestamp <= now + governance.contract.freshness.futureToleranceMs
  )
}

function sourceBindingValid(
  value: unknown,
  expectedPath: string,
  expectedDigest: string,
  errors: string[],
  label: string,
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["path", "sha256"]) ||
    value.path !== expectedPath ||
    value.sha256 !== expectedDigest
  ) {
    errors.push(`${label}: source binding mismatch`)
    return false
  }
  return true
}

async function sensitiveLogs(
  automaticDirectory: string,
  packageValue: unknown,
  errors: string[],
  label: string,
) {
  if (!isRecord(packageValue) || !Array.isArray(packageValue.commands)) return
  for (const command of packageValue.commands) {
    if (!isRecord(command)) continue
    for (const field of ["stdout", "stderr"] as const) {
      const binding = command[field]
      if (!isRecord(binding) || typeof binding.relativePath !== "string") continue
      const file = await resolveConfinedFile(automaticDirectory, binding.relativePath)
      if (file && isSensitiveEvidence(await Bun.file(file).text())) {
        errors.push(`${label}: sensitive value detected in ${field}`)
      }
    }
  }
}

export async function evaluateSeedGrowStageEvidence(options: {
  buildSha: string
  stage: StageID
  evidenceDirectory: string
  governance?: SeedGrowGovernance
  automaticGovernance?: AutomaticEvidenceGovernance
  runnerSource?: string
  now?: number
  allowStructuralFixtures?: boolean
}): Promise<GateEvaluation> {
  const governance = options.governance ?? (await loadSeedGrowGovernance(options.buildSha))
  const stage = stageDefinition(governance.contract, options.stage)
  const automaticGovernance =
    options.automaticGovernance ?? (await loadAutomaticEvidenceGovernance(options.buildSha))
  const runnerSource =
    options.runnerSource ??
    runGit(["show", `${options.buildSha}:${stageRunnerPath}`]).stdout
  const required = [
    ...stage.criteria.map((criterion) => `criterion:${criterion.id}`),
    "attempt:attempt-01",
    "attempt:attempt-02",
    "runner:two_local_exact_sha_runs",
    "ci:availability",
  ]
  const errors: string[] = []
  const failures: string[] = []
  const missing: string[] = []
  const passed: string[] = []
  const evidenceDirectory = path.resolve(options.evidenceDirectory)
  const directoryStat = await fs.lstat(evidenceDirectory).catch(() => null)
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    return {
      status: "invalid",
      required,
      passed,
      failed: failures,
      missing,
      invalid: ["evidence directory is missing, not a directory, or a symlink"],
      advisory: [],
      normalizedDigest: sha256(canonicalize({ status: "invalid", reason: "evidence_directory" })),
      evidencePackageSha256: null,
    }
  }
  const runPath = path.join(evidenceDirectory, "run.json")
  const source = await Bun.file(runPath)
    .text()
    .catch(() => null)
  if (!source) {
    return {
      status: "blocked",
      required,
      passed,
      failed: failures,
      missing: ["evidence:run.json"],
      invalid: errors,
      advisory: [],
      normalizedDigest: sha256(canonicalize({ status: "blocked", reason: "missing_run" })),
      evidencePackageSha256: null,
    }
  }
  const run = await Promise.resolve()
    .then(() => JSON.parse(source) as unknown)
    .catch(() => null)
  if (!isRecord(run) || !exactKeys(run, runKeys)) {
    return {
      status: "invalid",
      required,
      passed,
      failed: failures,
      missing,
      invalid: ["run.json has invalid JSON or top-level fields"],
      advisory: [],
      normalizedDigest: sha256(canonicalize({ status: "invalid", reason: "run_shape" })),
      evidencePackageSha256: sha256(source),
    }
  }
  const now = options.now ?? Date.now()
  if (
    run.schemaVersion !== 1 ||
    run.packageVersion !== "1.0.0" ||
    typeof run.packageId !== "string" ||
    !new RegExp(
      `^SEED-GROW-${options.stage}-${options.buildSha.slice(0, 12)}[a-f0-9]{0,28}-[a-z0-9][a-z0-9-]{0,63}$`,
    ).test(run.packageId) ||
    run.stage !== options.stage ||
    run.capabilityPackage !== stage.capabilityPackage ||
    run.buildSha !== options.buildSha ||
    run.buildTreeSha !== governance.buildTreeSha ||
    run.validationProfile !== governance.contract.validationProfile
  ) {
    errors.push("run.json build, stage, identity, tree, or profile mismatch")
  }
  sourceBindingValid(
    run.contractBinding,
    "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
    governance.contractSha256,
    errors,
    "contract",
  )
  sourceBindingValid(
    run.schemaBinding,
    "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
    governance.schemaSha256,
    errors,
    "schema",
  )
  sourceBindingValid(
    run.runnerBinding,
    stageRunnerPath,
    sha256(runnerSource),
    errors,
    "runner",
  )
  if (
    !validDate(run.createdAt) ||
    !validDate(run.finishedAt) ||
    Date.parse(String(run.finishedAt)) < Date.parse(String(run.createdAt)) ||
    !dateIsFresh(String(run.createdAt), now, governance) ||
    !dateIsFresh(String(run.finishedAt), now, governance)
  ) {
    errors.push("run.json timestamp is invalid, stale, or from the future")
  }
  if (
    !isRecord(run.githubActions) ||
    !exactKeys(run.githubActions, ["status", "blocking", "replacement", "evidence"]) ||
    run.githubActions.status !== "unavailable" ||
    run.githubActions.blocking !== false ||
    run.githubActions.replacement !== "two_local_exact_sha_runs"
  ) {
    errors.push("GitHub Actions availability was forged or made blocking")
  }
  const ci = await validateFileBinding(
    evidenceDirectory,
    isRecord(run.githubActions) ? run.githubActions.evidence : null,
    "application/json",
    errors,
    "CI availability",
  )
  const ciValue = ci
    ? await Promise.resolve()
        .then(() => JSON.parse(ci.source) as unknown)
        .catch(() => null)
    : null
  if (
    !isRecord(ciValue) ||
    !exactKeys(ciValue, [
      "schemaVersion",
      "provider",
      "status",
      "blocking",
      "replacement",
      "fabricatedRunIdentity",
      "localPlatform",
    ]) ||
    ciValue.schemaVersion !== 1 ||
    ciValue.provider !== "github_actions" ||
    ciValue.status !== "unavailable" ||
    ciValue.blocking !== false ||
    ciValue.replacement !== "two_local_exact_sha_runs" ||
    ciValue.fabricatedRunIdentity !== false ||
    typeof ciValue.localPlatform !== "string"
  ) {
    errors.push("CI availability evidence is invalid")
  } else {
    passed.push("ci:availability")
  }
  const expectedCoverage = stageCoverage(stage)
  if (canonicalize(run.coverage) !== canonicalize(expectedCoverage)) {
    errors.push("stage Task or criterion coverage mismatch")
  }
  const attempts = Array.isArray(run.attempts) ? run.attempts : []
  if (!Array.isArray(run.attempts)) errors.push("attempts must be an array")
  if (attempts.length < 2) {
    const missingAttempts = ["attempt-01", "attempt-02"]
      .filter((id) => !attempts.some((attempt) => isRecord(attempt) && attempt.id === id))
    missingAttempts.forEach((id) => missing.push(`attempt:${id}`))
  }
  if (attempts.length > 2) errors.push("more than two attempts are not allowed")
  const attemptIDs = attempts.flatMap((attempt) =>
    isRecord(attempt) && typeof attempt.id === "string" ? [attempt.id] : [],
  )
  const attemptDirectories = attempts.flatMap((attempt) =>
    isRecord(attempt) && typeof attempt.relativeDirectory === "string"
      ? [attempt.relativeDirectory]
      : [],
  )
  if (
    new Set(attemptIDs).size !== attemptIDs.length ||
    new Set(attemptDirectories).size !== attemptDirectories.length
  ) {
    errors.push("attempt IDs and directories must be unique")
  }
  const statuses: StageStatus[] = []
  const digests: string[] = []
  for (const attempt of attempts) {
    if (
      !isRecord(attempt) ||
      !exactKeys(attempt, [
        "id",
        "relativeDirectory",
        "automaticRunnerBinding",
        "automaticPackage",
        "normalizedDigest",
        "status",
      ]) ||
      !["attempt-01", "attempt-02"].includes(String(attempt.id)) ||
      attempt.relativeDirectory !== `attempts/${String(attempt.id)}` ||
      typeof attempt.normalizedDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(attempt.normalizedDigest) ||
      !["pass", "failed", "blocked", "invalid"].includes(String(attempt.status))
    ) {
      errors.push("attempt record is malformed")
      continue
    }
    const runner = await validateFileBinding(
      evidenceDirectory,
      attempt.automaticRunnerBinding,
      "application/json",
      errors,
      `${attempt.id} automatic runner binding`,
    )
    const runnerValue = runner
      ? await Promise.resolve()
          .then(() => JSON.parse(runner.source) as unknown)
          .catch(() => null)
      : null
    if (
      !isRecord(runnerValue) ||
      !exactKeys(runnerValue, [
        "schemaVersion",
        "id",
        "buildSha",
        "stage",
        "attemptId",
        "stageRunnerSha256",
      ]) ||
      runnerValue.schemaVersion !== 1 ||
      runnerValue.id !== "agent-company-seed-grow-automatic-runner-binding" ||
      runnerValue.buildSha !== options.buildSha ||
      runnerValue.stage !== options.stage ||
      runnerValue.attemptId !== attempt.id ||
      runnerValue.stageRunnerSha256 !== sha256(runnerSource)
    ) {
      errors.push(`${attempt.id}: automatic runner binding content mismatch`)
    }
    const automatic = await validateFileBinding(
      evidenceDirectory,
      attempt.automaticPackage,
      "application/json",
      errors,
      `${attempt.id} automatic package`,
    )
    if (!automatic || !runner) {
      statuses.push("invalid")
      continue
    }
    const automaticValue = await Promise.resolve()
      .then(() => JSON.parse(automatic.source) as unknown)
      .catch(() => null)
    if (attempt.status === "blocked") {
      if (
        !isRecord(automaticValue) ||
        !exactKeys(automaticValue, ["schemaVersion", "status", "reason"]) ||
        automaticValue.schemaVersion !== 1 ||
        automaticValue.status !== "blocked" ||
        typeof automaticValue.reason !== "string"
      ) {
        errors.push(`${attempt.id}: blocked attempt artifact is invalid`)
        statuses.push("invalid")
        continue
      }
      statuses.push("blocked")
      missing.push(`attempt:${attempt.id}:automatic_execution`)
      digests.push(String(attempt.normalizedDigest))
      continue
    }
    if (
      !isRecord(attempt.automaticPackage) ||
      attempt.automaticPackage.relativePath !==
        `${attempt.relativeDirectory}/automatic/automatic-evidence-package.json`
    ) {
      errors.push(`${attempt.id}: automatic package path mismatch`)
    }
    const automaticCreatedAt = automaticPackageCreatedAt(automaticValue)
    if (
      !automaticCreatedAt ||
      !dateIsFresh(automaticCreatedAt, now, governance) ||
      Date.parse(automaticCreatedAt) < Date.parse(String(run.createdAt)) - 300_000 ||
      Date.parse(automaticCreatedAt) > Date.parse(String(run.finishedAt)) + 300_000
    ) {
      errors.push(`${attempt.id}: automatic evidence is stale or outside the stage interval`)
    }
    const runnerDigest =
      isRecord(attempt.automaticRunnerBinding) &&
      typeof attempt.automaticRunnerBinding.sha256 === "string"
        ? attempt.automaticRunnerBinding.sha256
        : ""
    const validation = await validateAutomaticEvidencePackage({
      packagePath: automatic.file,
      buildSha: options.buildSha,
      runnerSha256: runnerDigest,
      governance: automaticGovernance,
      packageSource: automatic.source,
      allowStructuralFixture: options.allowStructuralFixtures,
    })
    const status = mappedStatus(validation.status)
    statuses.push(status)
    if (attempt.status !== status) errors.push(`${attempt.id}: forged attempt status`)
    if (validation.status === "invalid") {
      errors.push(...validation.errors.map((error) => `${attempt.id}: ${error}`))
    }
    if (validation.status === "incomplete") {
      missing.push(...validation.missing.map((item) => `${attempt.id}:${item}`))
    }
    if (validation.status === "fail") {
      failures.push(...validation.failures.map((item) => `${attempt.id}:${item}`))
    }
    const digest = await Promise.resolve()
      .then(() => normalizeAutomaticPackage(automaticValue, stage.requiredCommandIds))
      .catch((error) => {
        errors.push(`${attempt.id}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
    if (digest) {
      digests.push(digest)
      if (attempt.normalizedDigest !== digest) errors.push(`${attempt.id}: normalized digest mismatch`)
    }
    await sensitiveLogs(path.dirname(automatic.file), automaticValue, errors, String(attempt.id))
    if (status === "pass") passed.push(`attempt:${String(attempt.id)}`)
  }
  const status = recomputedStatus(statuses, digests, missing, errors)
  if (run.overallStatus !== status) errors.push("run.json contains a forged overall status")
  const finalStatus = errors.length ? "invalid" : status
  if (finalStatus === "pass") {
    passed.push(
      ...stage.criteria.map((criterion) => `criterion:${criterion.id}`),
      "runner:two_local_exact_sha_runs",
    )
  }
  const advisory =
    Array.isArray(run.advisory) && run.advisory.every((item) => typeof item === "string")
      ? run.advisory
      : []
  if (!Array.isArray(run.advisory) || advisory.length !== run.advisory.length) {
    errors.push("advisory must contain strings only")
  }
  const decisionStatus = errors.length ? "invalid" : finalStatus
  const uniqueMissing = [...new Set(missing)].sort()
  const uniqueFailures = [...new Set(failures)].sort()
  const uniqueErrors = [...new Set(errors)].sort()
  const uniquePassed = [...new Set(passed)].sort()
  return {
    status: decisionStatus,
    required,
    passed: uniquePassed,
    failed: uniqueFailures,
    missing: uniqueMissing,
    invalid: uniqueErrors,
    advisory,
    normalizedDigest: sha256(
      canonicalize({
        stage: options.stage,
        buildSha: options.buildSha,
        status: decisionStatus,
        required,
        passed: uniquePassed,
        failed: uniqueFailures,
        missing: uniqueMissing,
        invalid: uniqueErrors,
      }),
    ),
    evidencePackageSha256: sha256(source),
  }
}

export async function evaluateAndWriteSeedGrowStageGate(options: {
  buildSha: string
  stage: StageID
  evidenceDirectory: string
  outputPath: string
}) {
  const governance = await loadSeedGrowGovernance(options.buildSha)
  const expectedRoot = path.join(root, ".agent/runs/agent-company-seed-grow")
  const evidenceDirectory = path.resolve(options.evidenceDirectory)
  const evidenceStat = await fs.lstat(evidenceDirectory).catch(() => null)
  const relative = path.relative(expectedRoot, evidenceDirectory)
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`--evidence must be one direct run directory inside ${expectedRoot}.`)
  }
  if (!evidenceStat?.isDirectory() || evidenceStat.isSymbolicLink()) {
    throw new Error("--evidence must be a regular directory.")
  }
  const [expectedRootReal, evidenceReal] = await Promise.all([
    fs.realpath(expectedRoot),
    fs.realpath(evidenceDirectory),
  ])
  if (path.dirname(evidenceReal) !== expectedRootReal) {
    throw new Error("--evidence escaped the Seed-and-Grow run root.")
  }
  if (path.resolve(options.outputPath) !== path.join(evidenceDirectory, "stage-decision.json")) {
    throw new Error("--out must be <evidence-directory>/stage-decision.json.")
  }
  const stage = stageDefinition(governance.contract, options.stage)
  if (!governance.contract.implementedStages.includes(options.stage)) {
    throw new Error(`Seed-and-Grow stage ${options.stage} is not implemented yet.`)
  }
  assertExactCandidate(options.buildSha, stage)
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-seed-grow-gate-snapshot-"))
  const snapshotDirectory = path.join(snapshotRoot, "evidence")
  const evaluation = await Promise.resolve()
    .then(async () => {
      await fs.cp(evidenceDirectory, snapshotDirectory, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      })
      return evaluateSeedGrowStageEvidence({
        buildSha: options.buildSha,
        stage: options.stage,
        evidenceDirectory: snapshotDirectory,
        governance,
      })
    })
    .finally(() => fs.rm(snapshotRoot, { recursive: true, force: true }))
  const gateSource = runGit(["show", `${options.buildSha}:${stageGatePath}`]).stdout
  const decision = {
    schemaVersion: 1,
    decisionVersion: "1.0.0",
    decisionId: `SEED-GROW-${options.stage}-DECISION-${options.buildSha.slice(0, 16)}`,
    stage: options.stage,
    capabilityPackage: stage.capabilityPackage,
    buildSha: options.buildSha,
    evidencePackage: {
      relativePath: "run.json",
      sha256: evaluation.evidencePackageSha256,
    },
    contractBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
      governance.contractSource,
    ),
    schemaBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
      governance.schemaSource,
    ),
    gateBinding: sourceBinding(stageGatePath, gateSource),
    evaluatedAt: new Date().toISOString(),
    status: evaluation.status,
    required: evaluation.required,
    passed: evaluation.passed,
    failed: evaluation.failed,
    missing: evaluation.missing,
    invalid: evaluation.invalid,
    advisory: evaluation.advisory,
    normalizedDigest: evaluation.normalizedDigest,
  }
  await writeStageDecision(evidenceDirectory, options.outputPath, `${JSON.stringify(decision, null, 2)}\n`)
  return decision
}

async function writeStageDecision(evidenceDirectory: string, outputPath: string, source: string) {
  const [evidenceReal, parentReal] = await Promise.all([
    fs.realpath(evidenceDirectory),
    fs.realpath(path.dirname(outputPath)),
  ])
  if (evidenceReal !== parentReal || path.basename(outputPath) !== "stage-decision.json") {
    throw new Error("Stage decision output escaped the evidence directory.")
  }
  const existing = await fs.lstat(outputPath).catch(() => null)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("Stage decision output must be a regular file, never a symlink.")
  }
  const temporary = path.join(evidenceReal, `.stage-decision-${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (existing) await fs.rm(outputPath, { force: true })
    await fs.rename(temporary, outputPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function fixtureBinding(base: string, relativePath: string) {
  const bytes = new Uint8Array(await Bun.file(path.join(base, relativePath)).arrayBuffer())
  return {
    relativePath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType: "application/json",
  } satisfies FileBinding
}

async function writeFixtureRun(
  directory: string,
  governance: SeedGrowGovernance,
  buildSha: string,
  runnerSource: string,
  automaticGovernance: AutomaticEvidenceGovernance,
) {
  const stage = stageDefinition(governance.contract, "A0")
  const now = new Date().toISOString()
  const attempts = []
  for (const attemptId of ["attempt-01", "attempt-02"]) {
    const relativeDirectory = `attempts/${attemptId}`
    const runnerBinding = await writeFileBinding(
      directory,
      `${relativeDirectory}/runner-binding.json`,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "agent-company-seed-grow-automatic-runner-binding",
          buildSha,
          stage: "A0",
          attemptId,
          stageRunnerSha256: sha256(runnerSource),
        },
        null,
        2,
      )}\n`,
      "application/json",
    )
    const fixture = await writeStructuralAutomaticEvidenceFixture(
      path.join(directory, relativeDirectory, "automatic"),
      buildSha,
      governance.buildTreeSha,
      runnerBinding.sha256,
    )
    fixture.packageValue.createdAt = now
    await Bun.write(fixture.packagePath, `${JSON.stringify(fixture.packageValue, null, 2)}\n`)
    attempts.push({
      id: attemptId,
      relativeDirectory,
      automaticRunnerBinding: runnerBinding,
      automaticPackage: await fixtureBinding(
        directory,
        `${relativeDirectory}/automatic/automatic-evidence-package.json`,
      ),
      normalizedDigest: normalizeAutomaticPackage(fixture.packageValue, stage.requiredCommandIds),
      status: "pass",
    })
  }
  const ci = await writeFileBinding(
    directory,
    "ci/availability.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        provider: "github_actions",
        status: "unavailable",
        blocking: false,
        replacement: "two_local_exact_sha_runs",
        fabricatedRunIdentity: false,
        localPlatform: "fixture",
      },
      null,
      2,
    )}\n`,
    "application/json",
  )
  const run = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    packageId: `SEED-GROW-A0-${buildSha.slice(0, 16)}-self-test`,
    stage: "A0",
    capabilityPackage: stage.capabilityPackage,
    buildSha,
    buildTreeSha: governance.buildTreeSha,
    contractBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
      governance.contractSource,
    ),
    schemaBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
      governance.schemaSource,
    ),
    runnerBinding: sourceBinding(stageRunnerPath, runnerSource),
    validationProfile: governance.contract.validationProfile,
    githubActions: {
      ...governance.contract.githubActions,
      evidence: ci,
    },
    createdAt: now,
    finishedAt: now,
    attempts,
    coverage: stageCoverage(stage),
    overallStatus: "pass",
    advisory: [],
  }
  await Bun.write(path.join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  return { run, automaticGovernance }
}

export async function runSeedGrowStageSelfTest() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-seed-grow-gate-self-test-"))
  const buildSha = "a".repeat(40)
  const buildTreeSha = "c".repeat(40)
  const governance = await loadCurrentSeedGrowGovernance(buildTreeSha)
  const runnerSource = await Bun.file(path.join(root, stageRunnerPath)).text()
  const automaticFixture = await writeStructuralAutomaticEvidenceFixture(
    path.join(directory, "governance-fixture"),
    buildSha,
    buildTreeSha,
    "b".repeat(64),
  )
  await fs.rm(path.join(directory, "governance-fixture"), { recursive: true, force: true })
  const fixture = await writeFixtureRun(
    directory,
    governance,
    buildSha,
    runnerSource,
    automaticFixture.governance,
  )
  const evaluate = () =>
    evaluateSeedGrowStageEvidence({
      buildSha,
      stage: "A0",
      evidenceDirectory: directory,
      governance,
      automaticGovernance: fixture.automaticGovernance,
      runnerSource,
      now: Date.now(),
      allowStructuralFixtures: true,
    })
  const structuralFixtureRejected = await evaluateSeedGrowStageEvidence({
    buildSha,
    stage: "A0",
    evidenceDirectory: directory,
    governance,
    automaticGovernance: fixture.automaticGovernance,
    runnerSource,
    now: Date.now(),
  })
  const valid = await evaluate()
  const originalSource = await Bun.file(path.join(directory, "run.json")).text()
  const original = JSON.parse(originalSource) as Record<string, unknown>
  const mutated = async (
    mutate: (value: Record<string, unknown>) => void,
    expected: StageStatus,
  ) => {
    const value = structuredClone(original)
    mutate(value)
    await Bun.write(path.join(directory, "run.json"), `${JSON.stringify(value, null, 2)}\n`)
    const result = await evaluate()
    await Bun.write(path.join(directory, "run.json"), originalSource)
    return result.status === expected
  }
  const wrongBuildRejected = await mutated((value) => {
    value.buildSha = "d".repeat(40)
  }, "invalid")
  const missingAttemptBlocked = await mutated((value) => {
    const attempts = value.attempts as unknown[]
    attempts.pop()
    value.overallStatus = "blocked"
  }, "blocked")
  const duplicateAttemptRejected = await mutated((value) => {
    const attempts = value.attempts as Array<Record<string, unknown>>
    attempts[1] = structuredClone(attempts[0]!)
  }, "invalid")
  const pathEscapeRejected = await mutated((value) => {
    const attempts = value.attempts as Array<Record<string, unknown>>
    const automaticPackage = attempts[0]!.automaticPackage as Record<string, unknown>
    automaticPackage.relativePath = "../escaped.json"
  }, "invalid")
  const staleRejected = await mutated((value) => {
    value.createdAt = "2020-01-01T00:00:00.000Z"
    value.finishedAt = "2020-01-01T00:00:01.000Z"
  }, "invalid")
  const forgedPassRejected = await mutated((value) => {
    value.overallStatus = "failed"
  }, "invalid")
  const digestMismatchRejected = await mutated((value) => {
    const attempts = value.attempts as Array<Record<string, unknown>>
    attempts[0]!.normalizedDigest = "f".repeat(64)
  }, "invalid")
  const humanFieldRejected = await mutated((value) => {
    value.humanEvidence = { status: "pass" }
  }, "invalid")
  const fabricatedCIRejected = await mutated((value) => {
    const githubActions = value.githubActions as Record<string, unknown>
    githubActions.status = "success"
  }, "invalid")
  const firstAttempt = fixture.run.attempts[0]!
  const packageValue: unknown = await Bun.file(
    path.join(directory, firstAttempt.automaticPackage.relativePath),
  ).json()
  const firstCommand =
    isRecord(packageValue) && Array.isArray(packageValue.commands) && isRecord(packageValue.commands[0])
      ? packageValue.commands[0]
      : null
  const stdoutPath =
    firstCommand && isRecord(firstCommand.stdout) && typeof firstCommand.stdout.relativePath === "string"
      ? path.join(
          directory,
          path.dirname(firstAttempt.automaticPackage.relativePath),
          firstCommand.stdout.relativePath,
        )
      : ""
  const stdoutSource = stdoutPath ? await Bun.file(stdoutPath).text() : ""
  if (stdoutPath) await Bun.write(stdoutPath, `${stdoutSource}tampered\n`)
  const tamperedLogRejected = stdoutPath ? (await evaluate()).status === "invalid" : false
  if (stdoutPath) await Bun.write(stdoutPath, stdoutSource)
  const victimPath = path.join(directory, "stage-decision-victim.json")
  const outputPath = path.join(directory, "stage-decision.json")
  await Bun.write(victimPath, "unchanged\n")
  await fs.symlink(victimPath, outputPath)
  const outputSymlinkRejected = await writeStageDecision(directory, outputPath, "tampered\n").then(
    () => false,
    () => true,
  )
  const outputSymlinkVictimUnchanged = (await Bun.file(victimPath).text()) === "unchanged\n"
  await fs.rm(outputPath, { force: true })
  const assertions = [
    {
      name: "structural_fixture_cannot_pass_production_gate",
      passed: structuralFixtureRejected.status === "invalid",
    },
    { name: "valid_complete_double_run_passes", passed: valid.status === "pass" },
    { name: "wrong_build_rejected", passed: wrongBuildRejected },
    { name: "missing_attempt_blocked", passed: missingAttemptBlocked },
    { name: "duplicate_attempt_rejected", passed: duplicateAttemptRejected },
    { name: "path_escape_rejected", passed: pathEscapeRejected },
    { name: "stale_evidence_rejected", passed: staleRejected },
    { name: "forged_pass_rejected", passed: forgedPassRejected },
    { name: "normalized_digest_mismatch_rejected", passed: digestMismatchRejected },
    { name: "human_field_cannot_substitute", passed: humanFieldRejected },
    { name: "fabricated_ci_success_rejected", passed: fabricatedCIRejected },
    { name: "tampered_log_rejected", passed: tamperedLogRejected },
    {
      name: "decision_output_symlink_rejected_without_overwrite",
      passed: outputSymlinkRejected && outputSymlinkVictimUnchanged,
    },
  ]
  await fs.rm(directory, { recursive: true, force: true })
  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(`Seed-and-Grow stage Gate self-test failed: ${JSON.stringify(assertions)}`)
  }
  return {
    result: "pass",
    stages: governance.contract.stages.length,
    tasks: governance.contract.stages.flatMap((stage) => stage.taskIds).length,
    criteria: governance.contract.stages.flatMap((stage) => stage.criteria).length,
    negativeCases: assertions.slice(2),
  }
}

function parseArguments(args: string[]) {
  const requiredFlags = new Set(["--ref", "--stage", "--evidence", "--out"])
  const values = new Map<string, string>()
  let requirePass = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    if (key === "--require-pass") {
      if (requirePass) throw new Error("Duplicate argument: --require-pass")
      requirePass = true
      continue
    }
    if (!requiredFlags.has(key)) throw new Error(`Unknown argument: ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    values.set(key, value)
    index += 1
  }
  if (!requirePass || [...requiredFlags].some((flag) => !values.has(flag))) {
    throw new Error(
      "Required arguments: --ref <full-sha> --stage <A0-B5> --evidence <run-directory> --out <decision.json> --require-pass",
    )
  }
  const stage = values.get("--stage")!
  if (!stageIDs.includes(stage as StageID)) throw new Error(`Invalid Seed-and-Grow stage: ${stage}`)
  return {
    buildSha: values.get("--ref")!,
    stage: stage as StageID,
    evidenceDirectory: values.get("--evidence")!,
    outputPath: values.get("--out")!,
  }
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === "--self-test") {
    console.log(JSON.stringify(await runSeedGrowStageSelfTest(), null, 2))
  } else {
    await Promise.resolve()
      .then(() => evaluateAndWriteSeedGrowStageGate(parseArguments(Bun.argv.slice(2))))
      .then(
        (decision) => {
          console.log(JSON.stringify(decision, null, 2))
          process.exitCode =
            decision.status === "pass" ? 0 : decision.status === "failed" ? 1 : decision.status === "blocked" ? 2 : 64
        },
        (error) => {
          console.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 64
        },
      )
  }
}
