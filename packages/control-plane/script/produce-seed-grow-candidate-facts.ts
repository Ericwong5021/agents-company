import { createHash } from "node:crypto"
import { mkdir, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import {
  B5RunBinding,
  B5ScenarioIds,
  exactB5RunBindings,
  loadB5ScenarioSnapshots,
} from "../src/metrics/b5-candidate-scenarios"

const root = path.resolve(import.meta.dir, "../../..")
const producerPath = "packages/control-plane/script/produce-seed-grow-candidate-facts.ts"
const benchmarkPath =
  "docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json"
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Timestamp = z.number().int().nonnegative()
const AttemptId = z.enum(["attempt-01", "attempt-02"])
const AbsolutePath = z.string().refine((value) => path.isAbsolute(value))
const RelativeFile = z
  .object({
    relativePath: z.string().trim().min(1).refine((value) => !path.isAbsolute(value)),
    sha256: Digest,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()

export const B5ProducerArguments = z
  .object({
    candidateSha: CommitSha,
    attemptId: AttemptId,
    outputDirectory: AbsolutePath,
  })
  .strict()
export type B5ProducerArguments = z.infer<typeof B5ProducerArguments>

const EnvironmentBinding = z
  .object({
    absolutePathSha256: Digest,
    stateSha256: Digest,
  })
  .strict()

export const B5CandidateAttemptSummary = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-b5-candidate-attempt"),
    candidate: z
      .object({
        requestedSha: CommitSha,
        headSha: CommitSha,
        treeSha: CommitSha,
        parentSha: CommitSha,
      })
      .strict(),
    attemptId: AttemptId,
    producer: z
      .object({
        path: z.literal(producerPath),
        sha256: Digest,
      })
      .strict(),
    environment: z
      .object({
        worktree: EnvironmentBinding,
        runtimeHome: EnvironmentBinding,
        database: EnvironmentBinding,
        output: EnvironmentBinding,
        isolationRoot: EnvironmentBinding,
        productionDataInherited: z.literal(false),
        productionProcessUsed: z.literal(false),
        networkPortsUsed: z.tuple([]),
      })
      .strict(),
    window: z
      .object({
        startedAt: Timestamp,
        finishedAt: Timestamp,
      })
      .strict()
      .refine((value) => value.finishedAt >= value.startedAt),
    orderedRunBindings: z.array(B5RunBinding).length(30),
    files: z
      .object({
        facts: RelativeFile.extend({ relativePath: z.literal("facts.json") }).strict(),
        summary: RelativeFile.extend({ relativePath: z.literal("summary.json") }).strict(),
        metricReport: RelativeFile.extend({
          relativePath: z.literal("metric-report.json"),
        }).strict(),
        shadowReport: RelativeFile.extend({
          relativePath: z.literal("shadow-report.json"),
        }).strict(),
        rollbackKillSwitch: RelativeFile.extend({
          relativePath: z.literal("rollback-kill-switch.json"),
        }).strict(),
        rollbackLegacyFallback: RelativeFile.extend({
          relativePath: z.literal("rollback-legacy-fallback.json"),
        }).strict(),
        observationReports: z.array(RelativeFile).min(30),
      })
      .strict(),
    normalizedResultSha256: Digest,
    attemptStatus: z.literal("completed"),
    promotionClaimed: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      exactB5RunBindings(value.orderedRunBindings)
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["orderedRunBindings"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (value.candidate.requestedSha !== value.candidate.headSha)
      context.addIssue({
        code: "custom",
        path: ["candidate", "headSha"],
        message: "Candidate SHA must equal the checked-out HEAD",
      })
  })
export type B5CandidateAttemptSummary = z.infer<typeof B5CandidateAttemptSummary>

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return result.stdout.toString().trim()
}

function gitBytes(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return new Uint8Array(result.stdout)
}

function flagValue(argv: string[], name: string) {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1] || argv[index + 1]!.startsWith("--"))
    throw new Error(`Missing required ${name}`)
  if (argv.indexOf(name, index + 1) >= 0) throw new Error(`Duplicate ${name}`)
  return argv[index + 1]!
}

export function parseB5ProducerArguments(argv: string[]) {
  const known = new Set(["--candidate-sha", "--attempt-id", "--out"])
  const flags = argv.filter((value) => value.startsWith("--"))
  const unknown = flags.find((value) => !known.has(value))
  if (unknown) throw new Error(`Unknown argument ${unknown}`)
  if (argv.length !== 6) throw new Error("B5 producer requires exactly three named arguments")
  return B5ProducerArguments.parse({
    candidateSha: flagValue(argv, "--candidate-sha"),
    attemptId: flagValue(argv, "--attempt-id"),
    outputDirectory: path.resolve(flagValue(argv, "--out")),
  })
}

export async function resolveB5CandidateGit(candidateSha: string) {
  const requestedSha = CommitSha.parse(candidateSha)
  const headSha = CommitSha.parse(git(["rev-parse", "--verify", "HEAD^{commit}"]))
  if (requestedSha !== headSha)
    throw new Error(`Requested candidate ${requestedSha} is not checked out at HEAD ${headSha}`)
  const parents = git(["rev-list", "--parents", "-n", "1", headSha]).split(/\s+/)
  if (parents.length !== 2 || parents[0] !== headSha)
    throw new Error("B5 candidate must have exactly one direct Git parent")
  const producerBlob = gitBytes(["cat-file", "blob", `${headSha}:${producerPath}`])
  const currentProducer = new Uint8Array(
    await Bun.file(path.join(root, producerPath)).arrayBuffer(),
  )
  if (!producerBlob.length || sha256(producerBlob) !== sha256(currentProducer))
    throw new Error("B5 producer runtime source differs from its candidate Git blob")
  return {
    requestedSha,
    headSha,
    treeSha: CommitSha.parse(git(["rev-parse", `${headSha}^{tree}`])),
    parentSha: CommitSha.parse(parents[1]),
    producerSha256: sha256(producerBlob),
  }
}

export async function prepareB5CandidateAttempt(input: B5ProducerArguments) {
  const parsed = B5ProducerArguments.parse(input)
  const outputDirectory = path.resolve(parsed.outputDirectory)
  const existing = await readdir(outputDirectory).catch(() => [])
  if (existing.length) throw new Error("B5 producer output directory must be empty")
  await mkdir(outputDirectory, { recursive: true })
  const isolationRoot = path.join(outputDirectory, ".isolation")
  const runtimeHome = path.join(isolationRoot, "runtime-home")
  const databasePath = path.join(isolationRoot, "agent-company.db")
  await mkdir(runtimeHome, { recursive: true })
  const worktree = await realpath(root)
  const snapshots = loadB5ScenarioSnapshots(
    JSON.parse(await Bun.file(path.join(root, benchmarkPath)).text()) as unknown,
  )
  if (snapshots.length !== B5ScenarioIds.length)
    throw new Error("B5 producer did not load the complete benchmark scenario set")
  return {
    arguments: parsed,
    git: await resolveB5CandidateGit(parsed.candidateSha),
    snapshots,
    paths: {
      worktree,
      outputDirectory,
      isolationRoot,
      runtimeHome,
      databasePath,
      facts: path.join(outputDirectory, "facts.json"),
      summary: path.join(outputDirectory, "summary.json"),
      metricReport: path.join(outputDirectory, "metric-report.json"),
      shadowReport: path.join(outputDirectory, "shadow-report.json"),
      rollbackKillSwitch: path.join(outputDirectory, "rollback-kill-switch.json"),
      rollbackLegacyFallback: path.join(outputDirectory, "rollback-legacy-fallback.json"),
      observationReports: path.join(outputDirectory, "reports"),
    },
  }
}

export function environmentPathDigest(target: string) {
  return sha256(path.resolve(target))
}

export async function produceB5CandidateFacts(input: B5ProducerArguments): Promise<never> {
  await prepareB5CandidateAttempt(input)
  throw new Error("B5 producer is blocked until all S13-S27 scenario drivers are implemented")
}

if (import.meta.main) {
  const input = parseB5ProducerArguments(process.argv.slice(2))
  await produceB5CandidateFacts(input)
}
