import fs from "node:fs/promises"
import path from "node:path"
import { evaluateFounderOSStageContract } from "./founder-os-stage-contract"
import {
  canonicalize,
  confinedRelativePath,
  contractPath,
  evidenceRunnerPath,
  evidenceSchemaPath,
  exactCommit,
  exactKeys,
  expandCommand,
  gateRunnerPath,
  isRecord,
  loadContract,
  normalizeCommandOutput,
  parseStage,
  resolveBoundFile,
  root,
  runGit,
  sha256,
  sourceBinding,
  stageCommands,
  treeSha,
  validateContractSafety,
  writeFileBinding,
  type FileBinding,
} from "./founder-os-stage-core"

type AttemptEvaluation = {
  attemptId: string
  attemptNonce: string | null
  status: "pass" | "failed" | "invalid" | "blocked"
  normalizedDigest: string | null
  manifestSha256: string | null
  errors: string[]
}

function parseArguments(args: string[]) {
  const flags = new Set(["--stage", "--ref", "--base", "--attempt-01", "--attempt-02", "--out"])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !flags.has(key)) throw new Error(`Unknown argument: ${key ?? ""}`)
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if ([...flags].some((flag) => !values.has(flag)))
    throw new Error("Required: --stage <id> --ref <sha> --base <sha> --attempt-01 <dir> --attempt-02 <dir> --out <dir>")
  return {
    stage: parseStage(values.get("--stage")),
    candidateSha: exactCommit(values.get("--ref")!, "--ref"),
    baseSha: exactCommit(values.get("--base")!, "--base"),
    attempts: [
      { id: "attempt-01", directory: path.resolve(values.get("--attempt-01")!) },
      { id: "attempt-02", directory: path.resolve(values.get("--attempt-02")!) },
    ] as const,
    outputDirectory: path.resolve(values.get("--out")!),
  }
}

function fileBinding(value: unknown): value is FileBinding {
  return isRecord(value)
    && exactKeys(value, ["relativePath", "sha256", "byteLength", "mediaType"])
    && confinedRelativePath(value.relativePath)
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isInteger(value.byteLength)
    && (value.mediaType === "application/json" || value.mediaType === "text/plain")
}

async function evaluateAttempt(options: {
  id: "attempt-01" | "attempt-02"
  directory: string
  stage: ReturnType<typeof parseStage>
  candidateSha: string
  baseSha: string
}) {
  const errors: string[] = []
  const manifestPath = path.join(options.directory, "evidence-manifest.json")
  const source = await Bun.file(manifestPath).text().catch(() => null)
  if (!source)
    return {
      attemptId: options.id,
      attemptNonce: null,
      status: "blocked",
      normalizedDigest: null,
      manifestSha256: null,
      errors: ["evidence-manifest.json is missing"],
    } satisfies AttemptEvaluation
  const value = await Promise.resolve().then(() => JSON.parse(source) as unknown).catch(() => null)
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion",
    "packageVersion",
    "stage",
    "attemptId",
    "attemptNonce",
    "candidateSha",
    "candidateTreeSha",
    "baseSha",
    "contractBinding",
    "schemaBinding",
    "runnerBinding",
    "isolation",
    "githubActions",
    "advisory",
    "artifacts",
    "startedAt",
    "finishedAt",
    "commands",
    "normalizedDigest",
    "status",
  ]))
    return {
      attemptId: options.id,
      attemptNonce: null,
      status: "invalid",
      normalizedDigest: null,
      manifestSha256: sha256(source),
      errors: ["Evidence manifest shape is invalid"],
    } satisfies AttemptEvaluation
  if (value.schemaVersion !== 1 || value.packageVersion !== "1.0.0") errors.push("Evidence manifest version is invalid")
  if (value.stage !== options.stage || value.attemptId !== options.id) errors.push("Stage or attempt identity mismatch")
  if (typeof value.attemptNonce !== "string" || !/^[0-9a-f-]{36}$/.test(value.attemptNonce))
    errors.push("Attempt nonce is invalid")
  if (value.candidateSha !== options.candidateSha
    || value.candidateTreeSha !== treeSha(options.candidateSha)
    || value.baseSha !== options.baseSha)
    errors.push("Candidate, tree, or base binding mismatch")
  const expectedBindings = [
    ["contractBinding", sourceBinding(options.candidateSha, contractPath)],
    ["schemaBinding", sourceBinding(options.candidateSha, evidenceSchemaPath)],
    ["runnerBinding", sourceBinding(options.candidateSha, evidenceRunnerPath)],
  ] as const
  expectedBindings.forEach(([key, expected]) => {
    if (canonicalize(value[key]) !== canonicalize(expected)) errors.push(`${key} mismatch`)
  })
  if (!isRecord(value.isolation)
    || !exactKeys(value.isolation, ["mode", "detachedHead", "cleanTrackedFiles", "baseAncestor"])
    || value.isolation.mode !== "detached_exact_commit_worktree"
    || value.isolation.detachedHead !== true
    || value.isolation.cleanTrackedFiles !== true
    || value.isolation.baseAncestor !== true)
    errors.push("Isolation proof is invalid")
  if (!isRecord(value.githubActions)
    || value.githubActions.status !== "unavailable"
    || value.githubActions.blocking !== false
    || value.githubActions.replacement !== "two_local_exact_sha_runs")
    errors.push("GitHub Actions replacement record is invalid")
  if (!isRecord(value.advisory)
    || !isRecord(value.advisory.humanAuthorization)
    || !isRecord(value.advisory.realSamples)
    || value.advisory.humanAuthorization.blocking !== false
    || value.advisory.humanAuthorization.status !== "not_confirmed"
    || value.advisory.realSamples.blocking !== false
    || value.advisory.realSamples.status !== "not_confirmed")
    errors.push("Advisory weak-gate record is invalid")
  if (!isRecord(value.artifacts)
    || !exactKeys(value.artifacts, ["candidateSha", "baseSha", "advisoryReport"])
    || !fileBinding(value.artifacts.candidateSha)
    || !fileBinding(value.artifacts.baseSha)
    || !fileBinding(value.artifacts.advisoryReport))
    errors.push("Core artifact bindings are invalid")
  if (!errors.length && isRecord(value.artifacts)) {
    await Promise.all([
      resolveBoundFile(options.directory, value.artifacts.candidateSha as FileBinding),
      resolveBoundFile(options.directory, value.artifacts.baseSha as FileBinding),
      resolveBoundFile(options.directory, value.artifacts.advisoryReport as FileBinding),
    ]).then(([candidate, base, advisory]) => {
      if (new TextDecoder().decode(candidate.bytes) !== `${options.candidateSha}\n`) errors.push("Candidate artifact mismatch")
      if (new TextDecoder().decode(base.bytes) !== `${options.baseSha}\n`) errors.push("Base artifact mismatch")
      const advisoryValue = JSON.parse(new TextDecoder().decode(advisory.bytes)) as unknown
      if (!isRecord(advisoryValue)
        || advisoryValue.stage !== options.stage
        || !isRecord(advisoryValue.humanAuthorization)
        || advisoryValue.humanAuthorization.status !== "not_confirmed"
        || !isRecord(advisoryValue.realSamples)
        || advisoryValue.realSamples.status !== "not_confirmed")
        errors.push("Advisory artifact mismatch")
    }).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error))
    })
  }
  const contract = validateContractSafety(loadContract(options.candidateSha))
  const expectedCommands = stageCommands(contract, options.stage)
  if (!Array.isArray(value.commands) || value.commands.length !== expectedCommands.length) {
    errors.push("Command coverage is incomplete")
  } else {
    for (let index = 0; index < expectedCommands.length; index += 1) {
      const expected = expectedCommands[index]!
      const actual = value.commands[index]
      if (!isRecord(actual) || !exactKeys(actual, [
        "id",
        "kind",
        "argv",
        "cwd",
        "exitCode",
        "status",
        "normalizedDigest",
        "stdout",
        "stderr",
        "report",
      ])) {
        errors.push(`Command ${expected.id} shape is invalid`)
        continue
      }
      if (!fileBinding(actual.stdout) || !fileBinding(actual.stderr) || !fileBinding(actual.report)) {
        errors.push(`Command ${expected.id} artifact bindings are invalid`)
        continue
      }
      const reportPath = path.join(options.directory, actual.report.relativePath)
      const expectedArgv = expandCommand(expected, options.stage, options.candidateSha, reportPath)
      if (actual.id !== expected.id
        || actual.kind !== expected.kind
        || actual.cwd !== expected.cwd
        || !Array.isArray(actual.argv)
        || canonicalize(actual.argv) !== canonicalize(expectedArgv))
        errors.push(`Command ${expected.id} invocation mismatch`)
      const [stdout, stderr, report] = await Promise.all([
        resolveBoundFile(options.directory, actual.stdout),
        resolveBoundFile(options.directory, actual.stderr),
        resolveBoundFile(options.directory, actual.report),
      ]).catch((error) => {
        errors.push(error instanceof Error ? error.message : String(error))
        return []
      })
      if (!stdout || !stderr || !report) continue
      const reportValue = await Promise.resolve()
        .then(() => JSON.parse(new TextDecoder().decode(report.bytes)) as unknown)
        .catch(() => null)
      if (!isRecord(reportValue)) {
        errors.push(`Command ${expected.id} report is invalid JSON`)
        continue
      }
      if (expected.kind === "production_contract") {
        const recomputed = evaluateFounderOSStageContract(options.candidateSha, options.stage)
        if (canonicalize(reportValue) !== canonicalize(recomputed))
          errors.push("Production contract report was not reproduced from the candidate")
      } else {
        const normalizedOutputDigest = sha256(canonicalize({
          exitCode: actual.exitCode,
          stdout: normalizeCommandOutput(new TextDecoder().decode(stdout.bytes)),
          stderr: normalizeCommandOutput(new TextDecoder().decode(stderr.bytes)),
        }))
        if (!exactKeys(reportValue, [
          "schemaVersion",
          "stage",
          "commandId",
          "kind",
          "exitCode",
          "normalizedOutputDigest",
          "status",
        ])
          || reportValue.schemaVersion !== 1
          || reportValue.stage !== options.stage
          || reportValue.commandId !== expected.id
          || reportValue.kind !== expected.kind
          || reportValue.exitCode !== actual.exitCode
          || reportValue.normalizedOutputDigest !== normalizedOutputDigest)
          errors.push(`Command ${expected.id} report does not match captured output`)
      }
      if (actual.normalizedDigest !== reportValue.normalizedDigest
        && actual.normalizedDigest !== reportValue.normalizedOutputDigest)
        errors.push(`Command ${expected.id} normalized digest mismatch`)
      if (actual.exitCode !== 0 || actual.status !== "pass" || reportValue.status !== "pass")
        errors.push(`Command ${expected.id} did not pass`)
    }
  }
  const commands = Array.isArray(value.commands) ? value.commands : []
  const normalizedDigest = sha256(canonicalize({
    stage: options.stage,
    candidateTreeSha: treeSha(options.candidateSha),
    baseSha: options.baseSha,
    commands: commands.map((command) => isRecord(command) ? {
      id: command.id,
      kind: command.kind,
      exitCode: command.exitCode,
      status: command.status,
      normalizedDigest: command.normalizedDigest,
    } : command),
    advisory: value.advisory,
  }))
  if (value.normalizedDigest !== normalizedDigest) errors.push("Attempt normalized digest mismatch")
  if (value.status !== "pass") errors.push("Attempt status is not pass")
  return {
    attemptId: options.id,
    attemptNonce: typeof value.attemptNonce === "string" ? value.attemptNonce : null,
    status: errors.length ? "invalid" : "pass",
    normalizedDigest: typeof value.normalizedDigest === "string" ? value.normalizedDigest : null,
    manifestSha256: sha256(source),
    errors,
  } satisfies AttemptEvaluation
}

export async function evaluateFounderOSStageGate(options: ReturnType<typeof parseArguments>) {
  if (runGit(["rev-parse", "HEAD"]).stdout.trim() !== options.candidateSha)
    throw new Error("Gate must run from the exact candidate")
  if (runGit(["symbolic-ref", "-q", "HEAD"], root, [0, 1]).exitCode === 0)
    throw new Error("Gate must run from a detached exact-commit worktree")
  if (runGit(["status", "--porcelain", "--untracked-files=no"]).stdout.trim())
    throw new Error("Tracked files differ from the exact candidate")
  if (runGit(["merge-base", "--is-ancestor", options.baseSha, options.candidateSha], root, [0, 1]).exitCode !== 0)
    throw new Error("--base must be an ancestor of --ref")
  const resolvedAttempts = await Promise.all(options.attempts.map(async (attempt) => ({
    ...attempt,
    realpath: await fs.realpath(attempt.directory),
  })))
  if (resolvedAttempts[0].realpath === resolvedAttempts[1].realpath)
    throw new Error("Attempts must use different isolated directories")
  const attempts = await Promise.all(resolvedAttempts.map((attempt) =>
    evaluateAttempt({
      id: attempt.id,
      directory: attempt.realpath,
      stage: options.stage,
      candidateSha: options.candidateSha,
      baseSha: options.baseSha,
    }),
  ))
  const errors = [
    ...attempts.flatMap((attempt) => attempt.errors.map((error) => `${attempt.attemptId}: ${error}`)),
    ...(attempts[0].attemptNonce && attempts[0].attemptNonce === attempts[1].attemptNonce
      ? ["Attempt nonces are identical; copied attempts are not accepted"]
      : []),
    ...(attempts[0].normalizedDigest && attempts[0].normalizedDigest !== attempts[1].normalizedDigest
      ? ["Attempt normalized digests differ"]
      : []),
  ]
  const status = attempts.some((attempt) => attempt.status === "blocked")
    ? "blocked"
    : errors.length
      ? "invalid"
      : "pass"
  await fs.mkdir(options.outputDirectory)
  const attemptBindings = await Promise.all(attempts.map(async (attempt) =>
    writeFileBinding(
      options.outputDirectory,
      `${attempt.attemptId}-evaluation.json`,
      `${JSON.stringify(attempt, null, 2)}\n`,
      "application/json",
    ),
  ))
  const evidenceManifest = {
    schemaVersion: 1,
    stage: options.stage,
    candidateSha: options.candidateSha,
    candidateTreeSha: treeSha(options.candidateSha),
    baseSha: options.baseSha,
    contractBinding: sourceBinding(options.candidateSha, contractPath),
    schemaBinding: sourceBinding(options.candidateSha, evidenceSchemaPath),
    gateRunnerBinding: sourceBinding(options.candidateSha, gateRunnerPath),
    attemptBindings,
    attempts,
    normalizedDigest: attempts[0].normalizedDigest,
    status,
  }
  const evidenceBinding = await writeFileBinding(
    options.outputDirectory,
    "evidence-manifest.json",
    `${JSON.stringify(evidenceManifest, null, 2)}\n`,
    "application/json",
  )
  const decision = {
    schemaVersion: 1,
    stage: options.stage,
    candidateSha: options.candidateSha,
    candidateTreeSha: treeSha(options.candidateSha),
    baseSha: options.baseSha,
    evidenceManifest: evidenceBinding,
    machineGate: { status, blocking: true, errors },
    githubActions: { status: "unavailable", blocking: false, replacement: "two_local_exact_sha_runs" },
    advisories: {
      humanAuthorization: { status: "not_confirmed", blocking: false },
      realSamples: { status: "not_confirmed", blocking: false },
    },
    decision: status === "pass" ? "pass" : "fail_closed",
  }
  await Bun.write(
    path.join(options.outputDirectory, "stage-decision.json"),
    `${JSON.stringify(decision, null, 2)}\n`,
  )
  return decision
}

if (import.meta.main) {
  await Promise.resolve()
    .then(() => evaluateFounderOSStageGate(parseArguments(Bun.argv.slice(2))))
    .then((decision) => {
      console.log(JSON.stringify(decision))
      process.exitCode = decision.decision === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
