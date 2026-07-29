import fs from "node:fs/promises"
import path from "node:path"
import {
  evaluateFounderOSBoundary,
  normalizedFounderOSBoundaryReport,
  type BoundaryReport,
} from "./founder-os-boundary"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const schemaPath = "docs/product-design/founder-os/w0-evidence.v1.json"
const evidenceRunnerPath = "script/founder-os-evidence.ts"
const gateRunnerPath = "script/founder-os-gate.ts"

type SourceBinding = {
  path: string
  sha256: string
}

type GateContract = {
  planBinding: {
    path: string
  }
  baselineBinding: {
    path: string
    snapshotCommit: string
  }
  taskIds: string[]
  governedPaths: string[]
  exactCommitGate: {
    attempts: string[]
    isolation: string
    requireCleanTrackedFiles: boolean
    requireSameNormalizedDigest: boolean
    githubActions: {
      status: string
      blocking: boolean
      replacement: string
    }
    humanAuthorization: {
      blocking: boolean
      mode: string
      allowedStatuses: string[]
      defaultStatus: string
    }
  }
}

type AttemptEvaluation = {
  id: string
  status: "pass" | "failed" | "blocked" | "invalid"
  normalizedDigest: string | null
  authorizationStatus: string | null
  manifestSha256: string | null
  errors: string[]
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function runGit(args: string[], allowFailure = false) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function exactCommit(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a full lowercase commit SHA`)
  if (runGit(["rev-parse", `${value}^{commit}`]).stdout.trim() !== value) {
    throw new Error(`${label} must identify the exact commit`)
  }
  return value
}

function readAtRef(ref: string, file: string) {
  return runGit(["show", `${ref}:${file}`]).stdout
}

function sourceBinding(ref: string, file: string) {
  return { path: file, sha256: sha256(readAtRef(ref, file)) }
}

async function readBoundFile(
  directory: string,
  value: unknown,
  expectedPath: string,
  expectedType: "application/json" | "text/plain",
  errors: string[],
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["relativePath", "sha256", "byteLength", "mediaType"]) ||
    value.relativePath !== expectedPath ||
    value.mediaType !== expectedType ||
    typeof value.sha256 !== "string" ||
    typeof value.byteLength !== "number"
  ) {
    errors.push(`${expectedPath}: invalid file binding`)
    return null
  }
  const base = await fs.realpath(directory).catch(() => null)
  const file = path.resolve(directory, expectedPath)
  const real = await fs.realpath(file).catch(() => null)
  if (!base || !real || !real.startsWith(`${base}${path.sep}`)) {
    errors.push(`${expectedPath}: missing, escaped, or symlinked file`)
    return null
  }
  const bytes = new Uint8Array(await Bun.file(real).arrayBuffer())
  if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    errors.push(`${expectedPath}: checksum or byte length mismatch`)
    return null
  }
  return { file: real, source: new TextDecoder().decode(bytes) }
}

function validSourceBinding(value: unknown, expected: SourceBinding) {
  return (
    isRecord(value) &&
    exactKeys(value, ["path", "sha256"]) &&
    value.path === expected.path &&
    value.sha256 === expected.sha256
  )
}

function validDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

async function evaluateAttempt(options: {
  directory: string
  id: string
  candidateSha: string
  candidateTreeSha: string
  baseSha: string
  contract: GateContract
  contractBinding: SourceBinding
  schemaBinding: SourceBinding
  runnerBinding: SourceBinding
  expectedBoundary: Awaited<ReturnType<typeof evaluateFounderOSBoundary>>
}) {
  const errors: string[] = []
  const manifestPath = path.join(options.directory, "run-manifest.json")
  const manifestSource = await Bun.file(manifestPath)
    .text()
    .catch(() => null)
  if (!manifestSource) {
    return {
      id: options.id,
      status: "blocked",
      normalizedDigest: null,
      authorizationStatus: null,
      manifestSha256: null,
      errors: ["run-manifest.json is missing"],
    } satisfies AttemptEvaluation
  }
  const manifest = await Promise.resolve()
    .then(() => JSON.parse(manifestSource) as unknown)
    .catch(() => null)
  if (
    !isRecord(manifest) ||
    !exactKeys(manifest, [
      "schemaVersion",
      "packageVersion",
      "attemptId",
      "candidateSha",
      "candidateTreeSha",
      "baseSha",
      "contractBinding",
      "schemaBinding",
      "runnerBinding",
      "isolation",
      "githubActions",
      "authorization",
      "artifacts",
      "startedAt",
      "finishedAt",
      "commands",
      "normalizedDigest",
      "status",
    ])
  ) {
    return {
      id: options.id,
      status: "invalid",
      normalizedDigest: null,
      authorizationStatus: null,
      manifestSha256: sha256(manifestSource),
      errors: ["run-manifest.json has invalid JSON or fields"],
    } satisfies AttemptEvaluation
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageVersion !== "1.0.0" ||
    manifest.attemptId !== options.id ||
    manifest.candidateSha !== options.candidateSha ||
    manifest.candidateTreeSha !== options.candidateTreeSha ||
    manifest.baseSha !== options.baseSha
  ) {
    errors.push("attempt identity or exact commit binding mismatch")
  }
  if (!validSourceBinding(manifest.contractBinding, options.contractBinding)) {
    errors.push("contract binding mismatch")
  }
  if (!validSourceBinding(manifest.schemaBinding, options.schemaBinding)) {
    errors.push("schema binding mismatch")
  }
  if (!validSourceBinding(manifest.runnerBinding, options.runnerBinding)) {
    errors.push("evidence runner binding mismatch")
  }
  if (
    !isRecord(manifest.isolation) ||
    !exactKeys(manifest.isolation, ["mode", "detachedHead", "cleanTrackedFiles"]) ||
    manifest.isolation.mode !== options.contract.exactCommitGate.isolation ||
    manifest.isolation.detachedHead !== true ||
    manifest.isolation.cleanTrackedFiles !== true
  ) {
    errors.push("detached exact-commit isolation was not proven")
  }
  if (
    !isRecord(manifest.githubActions) ||
    !exactKeys(manifest.githubActions, ["status", "blocking", "replacement"]) ||
    JSON.stringify(manifest.githubActions) !==
      JSON.stringify(options.contract.exactCommitGate.githubActions)
  ) {
    errors.push("GitHub Actions availability record is invalid")
  }
  const authorization = isRecord(manifest.authorization) ? manifest.authorization : null
  if (
    !authorization ||
    !exactKeys(authorization, ["status", "blocking", "confirmedBy", "confirmedAt"]) ||
    authorization.blocking !== false ||
    !options.contract.exactCommitGate.humanAuthorization.allowedStatuses.includes(
      String(authorization.status),
    ) ||
    (authorization.status === "confirmed" &&
      (typeof authorization.confirmedBy !== "string" || !validDate(authorization.confirmedAt))) ||
    (authorization.status !== "confirmed" &&
      (authorization.confirmedBy !== null || authorization.confirmedAt !== null))
  ) {
    errors.push("human authorization advisory record is invalid")
  }
  if (
    !validDate(manifest.startedAt) ||
    !validDate(manifest.finishedAt) ||
    Date.parse(String(manifest.finishedAt)) < Date.parse(String(manifest.startedAt))
  ) {
    errors.push("attempt timestamps are invalid")
  }
  const artifacts = isRecord(manifest.artifacts) ? manifest.artifacts : null
  if (!artifacts || !exactKeys(artifacts, ["candidateSha", "baseSha", "authorizationReport"])) {
    errors.push("attempt artifacts are invalid")
  }
  const candidate = await readBoundFile(
    options.directory,
    artifacts?.candidateSha,
    "candidate-sha.txt",
    "text/plain",
    errors,
  )
  const base = await readBoundFile(
    options.directory,
    artifacts?.baseSha,
    "base-sha.txt",
    "text/plain",
    errors,
  )
  const authorizationReport = await readBoundFile(
    options.directory,
    artifacts?.authorizationReport,
    "authorization-report.json",
    "application/json",
    errors,
  )
  if (candidate?.source !== `${options.candidateSha}\n`) errors.push("candidate-sha.txt mismatch")
  if (base?.source !== `${options.baseSha}\n`) errors.push("base-sha.txt mismatch")
  const authorizationValue = authorizationReport
    ? await Promise.resolve()
        .then(() => JSON.parse(authorizationReport.source) as unknown)
        .catch(() => null)
    : null
  if (
    !isRecord(authorizationValue) ||
    authorizationValue.status !== authorization?.status ||
    authorizationValue.blocking !== false ||
    authorizationValue.confirmedBy !== authorization?.confirmedBy ||
    authorizationValue.confirmedAt !== authorization?.confirmedAt
  ) {
    errors.push("authorization-report.json mismatch")
  }
  const commands = Array.isArray(manifest.commands) ? manifest.commands : []
  if (commands.length !== 1 || !isRecord(commands[0])) errors.push("exactly one boundary command is required")
  const command = isRecord(commands[0]) ? commands[0] : null
  if (
    !command ||
    !exactKeys(command, ["id", "argv", "cwd", "exitCode", "summary", "stdout", "stderr", "report"]) ||
    command.id !== "founder-os-boundary" ||
    !Array.isArray(command.argv) ||
    !command.argv.every((item) => typeof item === "string") ||
    command.cwd !== "." ||
    typeof command.exitCode !== "number" ||
    typeof command.summary !== "string"
  ) {
    errors.push("boundary command record is invalid")
  }
  await readBoundFile(
    options.directory,
    command?.stdout,
    "commands/founder-os-boundary.stdout.txt",
    "text/plain",
    errors,
  )
  await readBoundFile(
    options.directory,
    command?.stderr,
    "commands/founder-os-boundary.stderr.txt",
    "text/plain",
    errors,
  )
  const reportFile = await readBoundFile(
    options.directory,
    command?.report,
    "boundary-report.json",
    "application/json",
    errors,
  )
  const report = reportFile
    ? await Promise.resolve()
        .then(() => JSON.parse(reportFile.source) as BoundaryReport)
        .catch(() => null)
    : null
  if (
    !report ||
    JSON.stringify(normalizedFounderOSBoundaryReport(report)) !==
      JSON.stringify(normalizedFounderOSBoundaryReport(options.expectedBoundary))
  ) {
    errors.push("boundary report differs from exact-candidate evaluation")
  }
  const summary = report
    ? `${report.status}: ${report.scanned.founderFiles.length} founder files, ${report.scanned.workerFiles.length} worker files, ${report.violations.length} violations`
    : ""
  if (command?.summary !== summary) errors.push("boundary command summary mismatch")
  if (
    command?.exitCode !== (report?.status === "pass" ? 0 : 1) ||
    manifest.status !== (report?.status === "pass" ? "pass" : "failed")
  ) {
    errors.push("boundary command or attempt status was forged")
  }
  const normalizedDigest = report
    ? sha256(
        JSON.stringify({
          candidateSha: options.candidateSha,
          candidateTreeSha: options.candidateTreeSha,
          baseSha: options.baseSha,
          command: {
            id: "founder-os-boundary",
            exitCode: command?.exitCode,
            summary,
            report: normalizedFounderOSBoundaryReport(report),
          },
          authorization,
        }),
      )
    : null
  if (!normalizedDigest || manifest.normalizedDigest !== normalizedDigest) {
    errors.push("normalized attempt digest mismatch")
  }
  return {
    id: options.id,
    status: errors.length
      ? "invalid"
      : manifest.status === "pass"
        ? "pass"
        : "failed",
    normalizedDigest,
    authorizationStatus: typeof authorization?.status === "string" ? authorization.status : null,
    manifestSha256: sha256(manifestSource),
    errors: [...new Set(errors)].sort(),
  } satisfies AttemptEvaluation
}

export async function evaluateFounderOSW0Gate(options: {
  candidateSha: string
  baseSha: string
  evidenceDirectory: string
}) {
  const candidateSha = exactCommit(options.candidateSha, "--ref")
  const baseSha = exactCommit(options.baseSha, "--base")
  if (runGit(["merge-base", "--is-ancestor", baseSha, candidateSha], true).exitCode !== 0) {
    throw new Error("--base must be an ancestor of --ref")
  }
  const contractSource = readAtRef(candidateSha, contractPath)
  const contract = JSON.parse(contractSource) as GateContract
  const baseline = JSON.parse(
    readAtRef(candidateSha, contract.baselineBinding.path),
  ) as Record<string, unknown>
  const candidateTreeSha = runGit(["rev-parse", `${candidateSha}^{tree}`]).stdout.trim()
  const invalid: string[] = []
  if (
    baseline.snapshotCommit !== contract.baselineBinding.snapshotCommit ||
    baseline.snapshotTree !==
      runGit(["rev-parse", `${contract.baselineBinding.snapshotCommit}^{tree}`]).stdout.trim()
  ) {
    invalid.push("baseline audit snapshot binding is invalid")
  }
  for (const file of contract.governedPaths) {
    if (runGit(["cat-file", "-e", `${candidateSha}:${file}`], true).exitCode !== 0) {
      invalid.push(`governed path missing at candidate: ${file}`)
    }
  }
  const contractBinding = sourceBinding(candidateSha, contractPath)
  const schemaBinding = sourceBinding(candidateSha, schemaPath)
  const runnerBinding = sourceBinding(candidateSha, evidenceRunnerPath)
  const expectedBoundary = await evaluateFounderOSBoundary(candidateSha)
  const attempts = await Promise.all(
    contract.exactCommitGate.attempts.map((id) =>
      evaluateAttempt({
        directory: path.join(path.resolve(options.evidenceDirectory), id),
        id,
        candidateSha,
        candidateTreeSha,
        baseSha,
        contract,
        contractBinding,
        schemaBinding,
        runnerBinding,
        expectedBoundary,
      }),
    ),
  )
  invalid.push(
    ...attempts
      .filter((attempt) => attempt.status === "invalid")
      .flatMap((attempt) => attempt.errors.map((error) => `${attempt.id}: ${error}`)),
  )
  const missing = attempts
    .filter((attempt) => attempt.status === "blocked")
    .map((attempt) => `${attempt.id}:run-manifest`)
  const failed = attempts
    .filter((attempt) => attempt.status === "failed")
    .map((attempt) => `${attempt.id}:founder-os-boundary`)
  const digests = attempts.flatMap((attempt) =>
    attempt.normalizedDigest ? [attempt.normalizedDigest] : [],
  )
  if (
    contract.exactCommitGate.requireSameNormalizedDigest &&
    digests.length === attempts.length &&
    new Set(digests).size !== 1
  ) {
    invalid.push("isolated attempt normalized digests differ")
  }
  const status = invalid.length
    ? ("invalid" as const)
    : failed.length
      ? ("failed" as const)
      : missing.length
        ? ("blocked" as const)
        : attempts.every((attempt) => attempt.status === "pass") &&
            digests.length === attempts.length &&
            new Set(digests).size === 1
          ? ("pass" as const)
          : ("invalid" as const)
  const passed =
    status === "pass"
      ? [
          ...contract.taskIds,
          "boundary:founder_twin_dependency",
          "boundary:worker_graph_supervisor",
          "evidence:two_local_exact_sha_runs",
        ]
      : []
  return {
    schemaVersion: 1,
    decisionVersion: "1.0.0",
    decisionId: `FOUNDER-OS-W0-${candidateSha.slice(0, 16)}`,
    stage: "W0",
    candidateSha,
    candidateTreeSha,
    baseSha,
    contractBinding,
    planBinding: sourceBinding(candidateSha, contract.planBinding.path),
    schemaBinding,
    gateBinding: sourceBinding(candidateSha, gateRunnerPath),
    evidenceDirectory: path.basename(path.resolve(options.evidenceDirectory)),
    evaluatedAt: new Date().toISOString(),
    status,
    required: contract.taskIds,
    passed,
    failed,
    missing,
    invalid: [...new Set(invalid)].sort(),
    attempts,
    authorization: {
      blocking: false,
      mode: contract.exactCommitGate.humanAuthorization.mode,
      statuses: attempts.map((attempt) => ({
        attemptId: attempt.id,
        status: attempt.authorizationStatus,
      })),
    },
    normalizedDigest: sha256(
      JSON.stringify({
        stage: "W0",
        candidateSha,
        candidateTreeSha,
        baseSha,
        status,
        passed,
        failed,
        missing,
        invalid: [...new Set(invalid)].sort(),
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          normalizedDigest: attempt.normalizedDigest,
          manifestSha256: attempt.manifestSha256,
        })),
      }),
    ),
  }
}

function parseArguments(args: string[]) {
  const required = new Set(["--ref", "--base", "--evidence", "--out"])
  const values = new Map<string, string>()
  let requirePass = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === "--require-pass") {
      if (requirePass) throw new Error("Duplicate argument: --require-pass")
      requirePass = true
      continue
    }
    if (!key || !required.has(key)) throw new Error(`Unknown argument: ${key ?? ""}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
    index += 1
  }
  if (!requirePass || [...required].some((flag) => !values.has(flag))) {
    throw new Error(
      "Required arguments: --ref <candidate-sha> --base <base-sha> --evidence <run-directory> --out <stage-decision.json> --require-pass",
    )
  }
  return {
    candidateSha: values.get("--ref")!,
    baseSha: values.get("--base")!,
    evidenceDirectory: path.resolve(values.get("--evidence")!),
    outputPath: path.resolve(values.get("--out")!),
  }
}

if (import.meta.main) {
  await Promise.resolve()
    .then(async () => {
      const options = parseArguments(Bun.argv.slice(2))
      const decision = await evaluateFounderOSW0Gate(options)
      await Bun.write(options.outputPath, `${JSON.stringify(decision, null, 2)}\n`)
      console.log(JSON.stringify(decision, null, 2))
      process.exitCode =
        decision.status === "pass"
          ? 0
          : decision.status === "failed"
            ? 1
            : decision.status === "blocked"
              ? 2
              : 64
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
