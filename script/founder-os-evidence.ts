import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const contractPath = "docs/product-design/founder-os/w0-gate-contract.v1.json"
const schemaPath = "docs/product-design/founder-os/w0-evidence.v1.json"
const runnerPath = "script/founder-os-evidence.ts"

type FileBinding = {
  relativePath: string
  sha256: string
  byteLength: number
  mediaType: "application/json" | "text/plain"
}

type GateContract = {
  commandRegistry: {
    id: string
    runner: string
    check: string
    reportPath: string
  }[]
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
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

async function writeArtifact(
  directory: string,
  relativePath: string,
  source: string,
  mediaType: FileBinding["mediaType"],
) {
  const file = path.join(directory, relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, source)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  return {
    relativePath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  } satisfies FileBinding
}

function sourceBinding(path: string) {
  const source = runGit(["show", `HEAD:${path}`]).stdout
  return { path, sha256: sha256(source) }
}

function parseArguments(args: string[]) {
  const flags = new Set(["--ref", "--base", "--attempt", "--out"])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !flags.has(key)) throw new Error(`Unknown argument: ${key ?? ""}`)
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if ([...flags].some((flag) => !values.has(flag))) {
    throw new Error(
      "Required arguments: --ref <candidate-sha> --base <base-sha> --attempt <attempt-01|attempt-02> --out <attempt-directory>",
    )
  }
  const attemptId = values.get("--attempt")!
  if (!["attempt-01", "attempt-02"].includes(attemptId)) throw new Error("Invalid --attempt")
  return {
    candidateSha: exactCommit(values.get("--ref")!, "--ref"),
    baseSha: exactCommit(values.get("--base")!, "--base"),
    attemptId: attemptId as "attempt-01" | "attempt-02",
    outputDirectory: path.resolve(values.get("--out")!),
  }
}

export async function collectFounderOSW0Evidence(options: ReturnType<typeof parseArguments>) {
  if (runGit(["rev-parse", "HEAD"]).stdout.trim() !== options.candidateSha) {
    throw new Error("Current worktree HEAD does not match --ref")
  }
  if (runGit(["symbolic-ref", "-q", "HEAD"], true).exitCode === 0) {
    throw new Error("Evidence must run from a detached exact-commit worktree")
  }
  if (runGit(["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) {
    throw new Error("Tracked files differ from the exact candidate")
  }
  if (runGit(["merge-base", "--is-ancestor", options.baseSha, options.candidateSha], true).exitCode !== 0) {
    throw new Error("--base must be an ancestor of --ref")
  }
  const parent = path.dirname(options.outputDirectory)
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(options.outputDirectory)
  const startedAt = new Date().toISOString()
  const candidateSha = await writeArtifact(
    options.outputDirectory,
    "candidate-sha.txt",
    `${options.candidateSha}\n`,
    "text/plain",
  )
  const baseSha = await writeArtifact(
    options.outputDirectory,
    "base-sha.txt",
    `${options.baseSha}\n`,
    "text/plain",
  )
  const authorization = {
    status: "not_confirmed" as const,
    blocking: false as const,
    confirmedBy: null,
    confirmedAt: null,
  }
  const authorizationReport = await writeArtifact(
    options.outputDirectory,
    "authorization-report.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: "Founder OS W0",
        ...authorization,
        statement:
          "ADR owner confirmation is advisory during Pre-Public development and has not been asserted by this machine run.",
      },
      null,
      2,
    )}\n`,
    "application/json",
  )
  const contract = JSON.parse(
    runGit(["show", `${options.candidateSha}:${contractPath}`]).stdout,
  ) as GateContract
  const commands = []
  for (const registered of contract.commandRegistry) {
    const reportPath = path.join(options.outputDirectory, registered.reportPath)
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    const argv = [
      "bun",
      path.join(root, registered.runner),
      "--ref",
      options.candidateSha,
      "--check",
      registered.check,
      "--out",
      reportPath,
    ]
    const command = Bun.spawnSync(argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await writeArtifact(
      options.outputDirectory,
      `commands/${registered.id}.stdout.txt`,
      command.stdout.toString(),
      "text/plain",
    )
    const stderr = await writeArtifact(
      options.outputDirectory,
      `commands/${registered.id}.stderr.txt`,
      command.stderr.toString(),
      "text/plain",
    )
    const reportSource = await Bun.file(reportPath).text().catch(() => "")
    if (!reportSource) throw new Error(`${registered.id} did not produce a report`)
    const report = JSON.parse(reportSource) as {
      status: "pass" | "failed"
      normalizedDigest: string
      assertions?: unknown[]
      violations?: unknown[]
      cases?: unknown[]
    }
    const reportBinding = await writeArtifact(
      options.outputDirectory,
      registered.reportPath,
      reportSource,
      "application/json",
    )
    const count = report.assertions?.length ?? report.violations?.length ?? report.cases?.length ?? 0
    commands.push({
      id: registered.id,
      check: registered.check,
      argv,
      cwd: ".",
      exitCode: command.exitCode,
      summary: `${report.status}: ${count} checks`,
      normalizedDigest: report.normalizedDigest,
      stdout,
      stderr,
      report: reportBinding,
    })
  }
  const candidateTreeSha = runGit(["rev-parse", `${options.candidateSha}^{tree}`]).stdout.trim()
  const normalizedDigest = sha256(
    JSON.stringify({
      candidateSha: options.candidateSha,
      candidateTreeSha,
      baseSha: options.baseSha,
      commands: commands.map((command) => ({
        id: command.id,
        check: command.check,
        exitCode: command.exitCode,
        summary: command.summary,
        normalizedDigest: command.normalizedDigest,
      })),
      authorization,
    }),
  )
  const status = commands.every(
    (command) => command.exitCode === 0 && command.summary.startsWith("pass:"),
  )
    ? ("pass" as const)
    : ("failed" as const)
  const manifest = {
    schemaVersion: 1,
    packageVersion: "1.1.0",
    attemptId: options.attemptId,
    candidateSha: options.candidateSha,
    candidateTreeSha,
    baseSha: options.baseSha,
    contractBinding: sourceBinding(contractPath),
    schemaBinding: sourceBinding(schemaPath),
    runnerBinding: sourceBinding(runnerPath),
    isolation: {
      mode: "detached_exact_commit_worktree",
      detachedHead: true,
      cleanTrackedFiles: true,
    },
    githubActions: {
      status: "unavailable",
      blocking: false,
      replacement: "two_local_exact_sha_runs",
    },
    authorization,
    artifacts: {
      candidateSha,
      baseSha,
      authorizationReport,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    commands,
    normalizedDigest,
    status,
  }
  await Bun.write(
    path.join(options.outputDirectory, "run-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

if (import.meta.main) {
  await Promise.resolve()
    .then(() => collectFounderOSW0Evidence(parseArguments(Bun.argv.slice(2))))
    .then(
      (manifest) => {
        console.log(JSON.stringify(manifest, null, 2))
        process.exitCode = manifest.status === "pass" ? 0 : 1
      },
      (error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 64
      },
    )
}
