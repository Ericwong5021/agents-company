import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  canonicalize,
  contractPath,
  evidenceRunnerPath,
  evidenceSchemaPath,
  exactCommit,
  expandCommand,
  loadContract,
  normalizeCommandOutput,
  parseStage,
  root,
  runGit,
  sha256,
  sourceBinding,
  stageCommands,
  treeSha,
  validateContractSafety,
  writeFileBinding,
} from "./founder-os-stage-core"

function parseArguments(args: string[]) {
  const flags = new Set(["--stage", "--ref", "--base", "--attempt", "--out"])
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
    throw new Error("Required: --stage <id> --ref <sha> --base <sha> --attempt <attempt-01|attempt-02> --out <directory>")
  const attemptId = values.get("--attempt")!
  if (!["attempt-01", "attempt-02"].includes(attemptId)) throw new Error("Invalid --attempt")
  return {
    stage: parseStage(values.get("--stage")),
    candidateSha: exactCommit(values.get("--ref")!, "--ref"),
    baseSha: exactCommit(values.get("--base")!, "--base"),
    attemptId: attemptId as "attempt-01" | "attempt-02",
    outputDirectory: path.resolve(values.get("--out")!),
  }
}

function childEnvironment(values: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export async function collectFounderOSStageEvidence(options: ReturnType<typeof parseArguments>) {
  if (runGit(["rev-parse", "HEAD"]).stdout.trim() !== options.candidateSha)
    throw new Error("Current worktree HEAD does not match --ref")
  if (runGit(["symbolic-ref", "-q", "HEAD"], root, [0, 1]).exitCode === 0)
    throw new Error("Evidence must run from a detached exact-commit worktree")
  if (runGit(["status", "--porcelain", "--untracked-files=no"]).stdout.trim())
    throw new Error("Tracked files differ from the exact candidate")
  if (runGit(["merge-base", "--is-ancestor", options.baseSha, options.candidateSha], root, [0, 1]).exitCode !== 0)
    throw new Error("--base must be an ancestor of --ref")
  await fs.mkdir(path.dirname(options.outputDirectory), { recursive: true })
  await fs.mkdir(options.outputDirectory)
  const contract = validateContractSafety(loadContract(options.candidateSha))
  const startedAt = new Date().toISOString()
  const attemptNonce = randomUUID()
  const candidateSha = await writeFileBinding(
    options.outputDirectory,
    "candidate-sha.txt",
    `${options.candidateSha}\n`,
    "text/plain",
  )
  const baseSha = await writeFileBinding(
    options.outputDirectory,
    "base-sha.txt",
    `${options.baseSha}\n`,
    "text/plain",
  )
  const advisory = {
    humanAuthorization: { status: "not_confirmed" as const, blocking: false as const },
    realSamples: { status: "not_confirmed" as const, blocking: false as const },
  }
  const advisoryReport = await writeFileBinding(
    options.outputDirectory,
    "advisory-report.json",
    `${JSON.stringify({
      schemaVersion: 1,
      stage: options.stage,
      ...advisory,
      statement: "Human authorization and real-sample observation remain advisory during Pre-Public development.",
    }, null, 2)}\n`,
    "application/json",
  )
  const commands = []
  for (const command of stageCommands(contract, options.stage)) {
    const reportRelativePath = command.reportPath.replaceAll("{stage}", options.stage.toLowerCase())
    const reportPath = path.join(options.outputDirectory, reportRelativePath)
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    const argv = expandCommand(command, options.stage, options.candidateSha, reportPath)
    const result = Bun.spawnSync(argv, {
      cwd: path.join(root, command.cwd),
      env: childEnvironment({
        ...process.env,
        FOUNDER_OS_GATE_ATTEMPT_ID: options.attemptId,
        FOUNDER_OS_GATE_ATTEMPT_NONCE: attemptNonce,
      }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdoutSource = result.stdout.toString()
    const stderrSource = result.stderr.toString()
    const stdout = await writeFileBinding(
      options.outputDirectory,
      `commands/${command.id}.stdout.txt`,
      stdoutSource,
      "text/plain",
    )
    const stderr = await writeFileBinding(
      options.outputDirectory,
      `commands/${command.id}.stderr.txt`,
      stderrSource,
      "text/plain",
    )
    const normalizedOutputDigest = sha256(canonicalize({
      exitCode: result.exitCode,
      stdout: normalizeCommandOutput(stdoutSource),
      stderr: normalizeCommandOutput(stderrSource),
    }))
    const reportSource = command.kind === "production_contract"
      ? await Bun.file(reportPath).text().catch(() => "")
      : `${JSON.stringify({
          schemaVersion: 1,
          stage: options.stage,
          commandId: command.id,
          kind: command.kind,
          exitCode: result.exitCode,
          normalizedOutputDigest,
          status: result.exitCode === 0 ? "pass" : "failed",
        }, null, 2)}\n`
    if (!reportSource) throw new Error(`${command.id} did not produce a report`)
    if (command.kind !== "production_contract") await Bun.write(reportPath, reportSource)
    const report = JSON.parse(reportSource) as {
      status: "pass" | "failed"
      normalizedDigest?: string
      normalizedOutputDigest?: string
    }
    const reportBinding = await writeFileBinding(
      options.outputDirectory,
      reportRelativePath,
      reportSource,
      "application/json",
    )
    commands.push({
      id: command.id,
      kind: command.kind,
      argv,
      cwd: command.cwd,
      exitCode: result.exitCode,
      status: report.status,
      normalizedDigest: report.normalizedDigest ?? report.normalizedOutputDigest ?? normalizedOutputDigest,
      stdout,
      stderr,
      report: reportBinding,
    })
  }
  if (runGit(["status", "--porcelain", "--untracked-files=no"]).stdout.trim())
    throw new Error("Validation commands modified tracked candidate files")
  const normalizedDigest = sha256(canonicalize({
    stage: options.stage,
    candidateTreeSha: treeSha(options.candidateSha),
    baseSha: options.baseSha,
    commands: commands.map((command) => ({
      id: command.id,
      kind: command.kind,
      exitCode: command.exitCode,
      status: command.status,
      normalizedDigest: command.normalizedDigest,
    })),
    advisory,
  }))
  const status = commands.every((command) => command.exitCode === 0 && command.status === "pass")
    ? "pass"
    : "failed"
  const manifest = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    stage: options.stage,
    attemptId: options.attemptId,
    attemptNonce,
    candidateSha: options.candidateSha,
    candidateTreeSha: treeSha(options.candidateSha),
    baseSha: options.baseSha,
    contractBinding: sourceBinding(options.candidateSha, contractPath),
    schemaBinding: sourceBinding(options.candidateSha, evidenceSchemaPath),
    runnerBinding: sourceBinding(options.candidateSha, evidenceRunnerPath),
    isolation: {
      mode: "detached_exact_commit_worktree",
      detachedHead: true,
      cleanTrackedFiles: true,
      baseAncestor: true,
    },
    githubActions: {
      status: "unavailable",
      blocking: false,
      replacement: "two_local_exact_sha_runs",
    },
    advisory,
    artifacts: { candidateSha, baseSha, advisoryReport },
    startedAt,
    finishedAt: new Date().toISOString(),
    commands,
    normalizedDigest,
    status,
  }
  await Bun.write(
    path.join(options.outputDirectory, "evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

if (import.meta.main) {
  await Promise.resolve()
    .then(() => collectFounderOSStageEvidence(parseArguments(Bun.argv.slice(2))))
    .then((manifest) => {
      console.log(JSON.stringify(manifest))
      process.exitCode = manifest.status === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
