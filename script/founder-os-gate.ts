import fs from "node:fs/promises"
import path from "node:path"
import {
  evaluateFounderOSBoundary,
  evaluateFounderOSBoundaryNegative,
  normalizedFounderOSBoundaryNegativeReport,
  normalizedFounderOSBoundaryReport,
  type BoundaryNegativeReport,
  type BoundaryReport,
} from "./founder-os-boundary"
import {
  evaluateFounderOSContractCheck,
  normalizedFounderOSContractCheckReport,
  type ContractCheckReport,
  type FounderOSContractCheck,
} from "./founder-os-contract"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const schemaPath = "docs/product-design/founder-os/w0-evidence.v1.json"
const evidenceRunnerPath = "script/founder-os-evidence.ts"
const gateRunnerPath = "script/founder-os-gate.ts"
const requiredTaskEvidence = {
  "FOS-FND-001": ["founder-os-governed-files"],
  "FOS-ADR-001": ["founder-os-boundary", "founder-os-boundary-negative"],
  "FOS-ADR-002": [
    "founder-os-boundary",
    "founder-os-boundary-negative",
    "founder-os-typed-action-unknown-reject",
  ],
  "FOS-ADR-003": ["founder-os-correction-append-only"],
  "FOS-ADR-004": ["founder-os-contract-roundtrip"],
  "FOS-ADR-005": ["founder-os-correction-append-only", "founder-os-contract-roundtrip"],
  "FOS-ADR-006": ["founder-os-contract-roundtrip"],
  "FOS-FLAG-001": ["founder-os-flag-defaults", "founder-os-flag-invalid-values"],
  "FOS-FLAG-002": ["founder-os-flag-defaults", "founder-os-flag-invalid-values"],
  "FOS-CONTRACT-001": [
    "founder-os-contract-roundtrip",
    "founder-os-typed-action-unknown-reject",
    "founder-os-sdk-consistency",
  ],
  "FOS-CONTRACT-002": [
    "founder-os-contract-roundtrip",
    "founder-os-correction-append-only",
    "founder-os-sdk-consistency",
  ],
  "FOS-CONTRACT-003": [
    "founder-os-contract-roundtrip",
    "founder-os-typed-action-unknown-reject",
    "founder-os-sdk-consistency",
  ],
  "FOS-BOUNDARY-001": ["founder-os-boundary", "founder-os-boundary-negative"],
  "FOS-BOUNDARY-002": ["founder-os-boundary", "founder-os-boundary-negative"],
  "FOS-IA-001": ["founder-os-governed-files"],
  "FOS-QA-001": [
    "founder-os-governed-files",
    "founder-os-boundary",
    "founder-os-boundary-negative",
    "founder-os-flag-defaults",
    "founder-os-flag-invalid-values",
    "founder-os-contract-roundtrip",
    "founder-os-correction-append-only",
    "founder-os-typed-action-unknown-reject",
    "founder-os-sdk-consistency",
  ],
} as const
const requiredCommands = [
  ["founder-os-governed-files", "script/founder-os-contract.ts", "governed-files", "reports/governed-files.json"],
  ["founder-os-boundary", "script/founder-os-boundary.ts", "production", "reports/boundary-production.json"],
  ["founder-os-boundary-negative", "script/founder-os-boundary.ts", "negative", "reports/boundary-negative.json"],
  ["founder-os-flag-defaults", "script/founder-os-contract.ts", "flag-defaults", "reports/flag-defaults.json"],
  ["founder-os-flag-invalid-values", "script/founder-os-contract.ts", "flag-invalid-values", "reports/flag-invalid-values.json"],
  ["founder-os-contract-roundtrip", "script/founder-os-contract.ts", "contract-roundtrip", "reports/contract-roundtrip.json"],
  ["founder-os-correction-append-only", "script/founder-os-contract.ts", "correction-append-only", "reports/correction-append-only.json"],
  ["founder-os-typed-action-unknown-reject", "script/founder-os-contract.ts", "typed-action-unknown-reject", "reports/typed-action-unknown-reject.json"],
  ["founder-os-sdk-consistency", "script/founder-os-contract.ts", "sdk-consistency", "reports/sdk-consistency.json"],
] as const

type SourceBinding = {
  path: string
  sha256: string
}

type RegisteredCommand = {
  id: string
  runner: string
  check: string
  reportPath: string
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
  commandRegistry: RegisteredCommand[]
  taskEvidence: Record<string, string[]>
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

type CommandEvaluation = {
  id: string
  status: "pass" | "failed" | "invalid"
  normalizedDigest: string | null
}

type AttemptEvaluation = {
  id: string
  status: "pass" | "failed" | "blocked" | "invalid"
  normalizedDigest: string | null
  authorizationStatus: string | null
  manifestSha256: string | null
  commands: CommandEvaluation[]
  errors: string[]
}

type ExpectedReport =
  | Awaited<ReturnType<typeof evaluateFounderOSBoundary>>
  | Awaited<ReturnType<typeof evaluateFounderOSBoundaryNegative>>
  | Awaited<ReturnType<typeof evaluateFounderOSContractCheck>>

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

function normalizedReport(command: RegisteredCommand, report: unknown) {
  if (command.id === "founder-os-boundary") {
    return normalizedFounderOSBoundaryReport(report as BoundaryReport)
  }
  if (command.id === "founder-os-boundary-negative") {
    return normalizedFounderOSBoundaryNegativeReport(report as BoundaryNegativeReport)
  }
  return normalizedFounderOSContractCheckReport(report as ContractCheckReport)
}

function reportCheckCount(report: unknown) {
  if (!isRecord(report)) return 0
  if (Array.isArray(report.assertions)) return report.assertions.length
  if (Array.isArray(report.violations)) return report.violations.length
  if (Array.isArray(report.cases)) return report.cases.length
  return 0
}

async function expectedReports(candidateSha: string, contract: GateContract) {
  const reports = new Map<string, ExpectedReport>()
  for (const command of contract.commandRegistry) {
    const report =
      command.id === "founder-os-boundary"
        ? await evaluateFounderOSBoundary(candidateSha)
        : command.id === "founder-os-boundary-negative"
          ? await evaluateFounderOSBoundaryNegative(candidateSha)
          : await evaluateFounderOSContractCheck(
              candidateSha,
              command.check as FounderOSContractCheck,
            )
    reports.set(command.id, report)
  }
  return reports
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
  expectedReports: Map<string, ExpectedReport>
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
      commands: [],
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
      commands: [],
      errors: ["run-manifest.json has invalid JSON or fields"],
    } satisfies AttemptEvaluation
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageVersion !== "1.1.0" ||
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
  if (commands.length !== options.contract.commandRegistry.length) {
    errors.push("command registry evidence count mismatch")
  }
  if (
    JSON.stringify(
      commands.flatMap((command) => (isRecord(command) && typeof command.id === "string" ? [command.id] : [])),
    ) !== JSON.stringify(options.contract.commandRegistry.map((command) => command.id))
  ) {
    errors.push("command registry evidence order or identity mismatch")
  }
  const commandEvaluations: CommandEvaluation[] = []
  for (const registered of options.contract.commandRegistry) {
    const value = commands.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.id === registered.id,
    )
    const expected = options.expectedReports.get(registered.id)
    if (
      !value ||
      !expected ||
      !exactKeys(value, [
        "id",
        "check",
        "argv",
        "cwd",
        "exitCode",
        "summary",
        "normalizedDigest",
        "stdout",
        "stderr",
        "report",
      ]) ||
      value.check !== registered.check ||
      value.cwd !== "." ||
      !Array.isArray(value.argv) ||
      JSON.stringify(value.argv) !==
        JSON.stringify([
          "bun",
          path.join(root, registered.runner),
          "--ref",
          options.candidateSha,
          "--check",
          registered.check,
          "--out",
          path.join(options.directory, registered.reportPath),
        ])
    ) {
      errors.push(`${registered.id}: command record is invalid`)
      commandEvaluations.push({ id: registered.id, status: "invalid", normalizedDigest: null })
      continue
    }
    await readBoundFile(
      options.directory,
      value.stdout,
      `commands/${registered.id}.stdout.txt`,
      "text/plain",
      errors,
    )
    await readBoundFile(
      options.directory,
      value.stderr,
      `commands/${registered.id}.stderr.txt`,
      "text/plain",
      errors,
    )
    const reportFile = await readBoundFile(
      options.directory,
      value.report,
      registered.reportPath,
      "application/json",
      errors,
    )
    const report = reportFile
      ? await Promise.resolve()
          .then(() => JSON.parse(reportFile.source) as unknown)
          .catch(() => null)
      : null
    const reportMatches =
      report !== null &&
      JSON.stringify(normalizedReport(registered, report)) ===
        JSON.stringify(normalizedReport(registered, expected))
    if (!reportMatches) errors.push(`${registered.id}: report differs from exact-candidate evaluation`)
    const status =
      isRecord(report) && report.status === "pass"
        ? ("pass" as const)
        : isRecord(report) && report.status === "failed"
          ? ("failed" as const)
          : ("invalid" as const)
    const expectedSummary = `${status === "invalid" ? "failed" : status}: ${reportCheckCount(report)} checks`
    if (
      value.exitCode !== (status === "pass" ? 0 : 1) ||
      value.summary !== expectedSummary ||
      value.normalizedDigest !== expected.normalizedDigest
    ) {
      errors.push(`${registered.id}: command result or digest mismatch`)
      commandEvaluations.push({ id: registered.id, status: "invalid", normalizedDigest: null })
      continue
    }
    commandEvaluations.push({
      id: registered.id,
      status,
      normalizedDigest: expected.normalizedDigest,
    })
  }
  const normalizedDigest = sha256(
    JSON.stringify({
      candidateSha: options.candidateSha,
      candidateTreeSha: options.candidateTreeSha,
      baseSha: options.baseSha,
      commands: options.contract.commandRegistry.map((registered) => {
        const command = commands.find(
          (candidate) => isRecord(candidate) && candidate.id === registered.id,
        )
        return {
          id: registered.id,
          check: registered.check,
          exitCode: isRecord(command) ? command.exitCode : null,
          summary: isRecord(command) ? command.summary : null,
          normalizedDigest: isRecord(command) ? command.normalizedDigest : null,
        }
      }),
      authorization,
    }),
  )
  if (manifest.normalizedDigest !== normalizedDigest) {
    errors.push("normalized attempt digest mismatch")
  }
  const expectedStatus = commandEvaluations.every((command) => command.status === "pass")
    ? "pass"
    : "failed"
  if (manifest.status !== expectedStatus) errors.push("attempt status was forged")
  return {
    id: options.id,
    status: errors.length
      ? "invalid"
      : expectedStatus,
    normalizedDigest,
    authorizationStatus: typeof authorization?.status === "string" ? authorization.status : null,
    manifestSha256: sha256(manifestSource),
    commands: commandEvaluations,
    errors: [...new Set(errors)].sort(),
  } satisfies AttemptEvaluation
}

function validateContract(contract: GateContract) {
  const errors: string[] = []
  const taskIds = Object.keys(contract.taskEvidence)
  const commandIds = contract.commandRegistry.map((command) => command.id)
  if (
    JSON.stringify([...contract.taskIds].sort()) !==
    JSON.stringify(Object.keys(requiredTaskEvidence).sort())
  ) {
    errors.push("required W0 task set is incomplete")
  }
  if (JSON.stringify([...taskIds].sort()) !== JSON.stringify([...contract.taskIds].sort())) {
    errors.push("task evidence mapping does not exactly cover required tasks")
  }
  if (
    contract.taskIds.some((taskId) => {
      const evidence = contract.taskEvidence[taskId]
      return !evidence?.length || evidence.some((commandId) => !commandIds.includes(commandId))
    })
  ) {
    errors.push("task evidence mapping is empty or references an unknown command")
  }
  if (new Set(commandIds).size !== commandIds.length) {
    errors.push("command registry contains duplicate IDs")
  }
  if (
    commandIds.some(
      (commandId) =>
        !Object.values(contract.taskEvidence).some((evidence) => evidence.includes(commandId)),
    )
  ) {
    errors.push("command registry contains unbound evidence")
  }
  const actualCommands = contract.commandRegistry.map((command) => [
    command.id,
    command.runner,
    command.check,
    command.reportPath,
  ])
  if (JSON.stringify(actualCommands) !== JSON.stringify(requiredCommands)) {
    errors.push("required W0 command registry is incomplete or reordered")
  }
  if (
    Object.entries(requiredTaskEvidence).some(
      ([taskId, evidence]) =>
        JSON.stringify(contract.taskEvidence[taskId]) !== JSON.stringify(evidence),
    )
  ) {
    errors.push("required W0 task evidence mapping changed")
  }
  return errors
}

export async function evaluateFounderOSW0Gate(options: {
  candidateSha: string
  baseSha: string
  evidenceDirectory: string
}) {
  const candidateSha = exactCommit(options.candidateSha, "--ref")
  const baseSha = exactCommit(options.baseSha, "--base")
  if (runGit(["rev-parse", "HEAD"]).stdout.trim() !== candidateSha) {
    throw new Error("Gate must run from the exact candidate worktree")
  }
  if (runGit(["merge-base", "--is-ancestor", baseSha, candidateSha], true).exitCode !== 0) {
    throw new Error("--base must be an ancestor of --ref")
  }
  const contractSource = readAtRef(candidateSha, contractPath)
  const contract = JSON.parse(contractSource) as GateContract
  const baseline = JSON.parse(
    readAtRef(candidateSha, contract.baselineBinding.path),
  ) as Record<string, unknown>
  const candidateTreeSha = runGit(["rev-parse", `${candidateSha}^{tree}`]).stdout.trim()
  const invalid = validateContract(contract)
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
  const reports = await expectedReports(candidateSha, contract)
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
        expectedReports: reports,
      }),
    ),
  )
  invalid.push(
    ...attempts
      .filter((attempt) => attempt.status === "invalid")
      .flatMap((attempt) => attempt.errors.map((error) => `${attempt.id}: ${error}`)),
  )
  const taskStatus = contract.taskIds.map((taskId) => {
    const evidence = contract.taskEvidence[taskId] ?? []
    if (attempts.some((attempt) => attempt.status === "invalid")) {
      return { taskId, status: "invalid" as const }
    }
    if (attempts.some((attempt) => attempt.status === "blocked")) {
      return { taskId, status: "blocked" as const }
    }
    const statuses = attempts.flatMap((attempt) =>
      evidence.map(
        (commandId) =>
          attempt.commands.find((command) => command.id === commandId)?.status ??
          (attempt.status === "blocked" ? "blocked" : "invalid"),
      ),
    )
    return {
      taskId,
      status: statuses.includes("invalid")
        ? ("invalid" as const)
        : statuses.includes("failed")
          ? ("failed" as const)
          : statuses.includes("blocked")
            ? ("blocked" as const)
            : statuses.length === evidence.length * attempts.length &&
                statuses.every((status) => status === "pass")
              ? ("pass" as const)
              : ("invalid" as const),
    }
  })
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
  const passed = taskStatus.filter((task) => task.status === "pass").map((task) => task.taskId)
  const failed = taskStatus.filter((task) => task.status === "failed").map((task) => task.taskId)
  const missing = taskStatus.filter((task) => task.status === "blocked").map((task) => task.taskId)
  invalid.push(
    ...taskStatus
      .filter((task) => task.status === "invalid")
      .map((task) => `${task.taskId}: task evidence is invalid`),
  )
  const status = invalid.length
    ? ("invalid" as const)
    : failed.length
      ? ("failed" as const)
      : missing.length
        ? ("blocked" as const)
        : passed.length === contract.taskIds.length &&
            digests.length === attempts.length &&
            new Set(digests).size === 1
          ? ("pass" as const)
          : ("invalid" as const)
  return {
    schemaVersion: 1,
    decisionVersion: "1.1.0",
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
          commands: attempt.commands,
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
