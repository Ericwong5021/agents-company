import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import {
  MetricContract,
  MetricEvaluationReport,
  PrePublicBlockingMetricIds,
  PrePublicMetricContractSha256,
  metricContractDigest,
} from "@agents-company/shared/seed-grow-metrics"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import { Effect } from "effect"
import z from "zod"
import {
  PersistedFactArtifactReference,
  makePersistedFactArtifactAdapter,
} from "../src/metrics/persisted-fact-artifact"
import { Service, makeLayer } from "../src/metrics/seed-grow-reporter"

export type GateStatus = "pass" | "failed" | "blocked" | "invalid"

export class PrePublicGateError extends Error {
  readonly status: Exclude<GateStatus, "pass">

  constructor(status: Exclude<GateStatus, "pass">, message: string) {
    super(message)
    this.name = "PrePublicGateError"
    this.status = status
  }
}

const root = path.resolve(import.meta.dir, "../../..")
const stageIDs = ["A0", "A1", "A2", "A3", "A4", "B0", "B1", "B2", "B3", "B4", "B5"] as const
type StageID = (typeof stageIDs)[number]
type Governance = {
  buildTreeSha: string
  metricSource: string
  metricSha256: string
  automaticCommandIDs: string[]
}
const runnerPath = "packages/control-plane/script/seed-grow-pre-public-gate.ts"
const runtimeBindingPaths = [
  runnerPath,
  "script/seed-grow-stage-gate.ts",
  "script/seed-grow-stage-core.ts",
  "packages/control-plane/src/metrics/persisted-fact-artifact.ts",
  "packages/control-plane/src/metrics/persisted-fact-exporter.ts",
  "packages/control-plane/src/metrics/seed-grow-reporter.ts",
  "packages/shared/src/seed-grow-metrics.ts",
  "packages/shared/src/seed-grow-shadow.ts",
  "docs/product-design/experience-refactor/metric-contract.v1.json",
] as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const commitSha = z.string().regex(/^[a-f0-9]{40}$/)
const identifier = z.string().trim().min(1).max(240)
const longIdentifier = z.string().trim().min(1).max(500)
const absolutePath = z.string().refine((value) => path.isAbsolute(value))
const timestamp = z.number().int().nonnegative()
const stageStatus = z.enum(["pass", "failed", "blocked", "invalid"])
const sourceBinding = z
  .object({
    path: z.string().trim().min(1),
    sha256: digest,
  })
  .strict()
const fileBinding = z
  .object({
    relativePath: z.string().trim().min(1),
    sha256: digest,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1),
  })
  .strict()
const absoluteFileReference = z
  .object({
    path: absolutePath,
    sha256: digest,
  })
  .strict()
const uniqueStrings = z
  .array(longIdentifier)
  .min(2)
  .max(500)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Values must be unique" })
  })

const CandidateInput = z
  .object({
    candidateSha: commitSha,
    targetRef: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (value) =>
          !value.startsWith("-") &&
          !value.includes("..") &&
          !value.includes("@{") &&
          !value.includes("//") &&
          !value.endsWith("/") &&
          !value.endsWith(".lock"),
      ),
    evidenceDirectory: absolutePath,
    factArtifact: PersistedFactArtifactReference,
    comparisonId: longIdentifier,
    scenarioIds: uniqueStrings,
  })
  .strict()

const BootstrapRequest = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("bootstrap"),
    candidate: CandidateInput,
    outputDirectory: absolutePath,
  })
  .strict()

const PromoteRequest = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("promote"),
    previousBootstrap: absoluteFileReference,
    current: CandidateInput,
    databaseDirectory: absolutePath,
    outputDirectory: absolutePath,
  })
  .strict()
  .superRefine((value, context) => {
    const database = path.resolve(value.databaseDirectory)
    const output = path.resolve(value.outputDirectory)
    if (
      database === output ||
      database.startsWith(`${output}${path.sep}`) ||
      output.startsWith(`${database}${path.sep}`)
    )
      context.addIssue({
        code: "custom",
        path: ["databaseDirectory"],
        message: "Database and output directories must be disjoint",
      })
  })

const Request = z.discriminatedUnion("mode", [BootstrapRequest, PromoteRequest])

const StageSummary = z
  .object({
    stage: z.enum(stageIDs),
    evidenceDirectory: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
      .refine((value) => value !== "." && value !== ".."),
    runSha256: digest,
    decisionSha256: digest,
    status: stageStatus,
  })
  .strict()

const FinalRun = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("agent-company-seed-grow-final-candidate-evidence"),
    buildSha: commitSha,
    buildTreeSha: commitSha,
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    automaticAttempts: z
      .array(
        z
          .object({
            id: z.enum(["attempt-01", "attempt-02"]),
            status: stageStatus,
            normalizedDigest: digest,
          })
          .strict(),
      )
      .length(2),
    stages: z.array(StageSummary).length(stageIDs.length),
    status: stageStatus,
  })
  .strict()

const FinalDecision = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("agent-company-seed-grow-final-decision"),
    buildSha: commitSha,
    buildTreeSha: commitSha,
    finalRun: fileBinding,
    required: z.array(z.enum(stageIDs)),
    passed: z.array(z.enum(stageIDs)),
    failed: z.array(z.enum(stageIDs)),
    blocked: z.array(z.enum(stageIDs)),
    invalid: z.array(z.enum(stageIDs)),
    missing: z.array(z.enum(stageIDs)),
    stages: z.array(StageSummary).length(stageIDs.length),
    decidedAt: z.string().datetime(),
    status: stageStatus,
    advisory: z.array(z.string()),
  })
  .strict()

const StageDecision = z
  .object({
    schemaVersion: z.literal(1),
    decisionVersion: z.literal("1.0.0"),
    decisionId: z.string().trim().min(1),
    stage: z.enum(stageIDs),
    capabilityPackage: z.string().trim().min(1),
    buildSha: commitSha,
    evidencePackage: z
      .object({
        relativePath: z.literal("run.json"),
        sha256: digest,
      })
      .strict(),
    contractBinding: sourceBinding,
    schemaBinding: sourceBinding,
    gateBinding: sourceBinding,
    evaluatedAt: z.string().datetime(),
    status: stageStatus,
    required: z.array(z.string()),
    passed: z.array(z.string()),
    failed: z.array(z.string()),
    missing: z.array(z.string()),
    invalid: z.array(z.string()),
    advisory: z.array(z.string()),
    normalizedDigest: digest,
  })
  .strict()

const RepeatEvidence = z
  .object({
    runId: identifier,
    ordinal: z.union([z.literal(1), z.literal(2)]),
    environmentSha256: digest,
    evidenceSha256: digest,
    normalizedResultSha256: digest,
    startedAt: timestamp,
    finishedAt: timestamp,
  })
  .strict()

const CandidateEvidence = z
  .object({
    evidenceDirectory: absolutePath,
    finalRun: absoluteFileReference,
    finalDecision: absoluteFileReference,
    stageRunSha256s: z.record(z.enum(stageIDs), digest),
    stageDecisionSha256s: z.record(z.enum(stageIDs), digest),
    repeats: z.tuple([RepeatEvidence, RepeatEvidence]),
  })
  .strict()

const BootstrapArtifact = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-bootstrap-candidate"),
    inputSha256: digest,
    candidate: CandidateInput,
    runnerBinding: sourceBinding,
    metricContract: z
      .object({
        path: z.literal("docs/product-design/experience-refactor/metric-contract.v1.json"),
        sourceSha256: digest,
        contractSha256: digest,
      })
      .strict(),
    candidateEvidence: CandidateEvidence,
    metricReport: fileBinding,
    shadowReport: fileBinding,
    promotionClaimed: z.literal(false),
    status: z.literal("pass"),
    createdAt: timestamp,
  })
  .strict()

const RollbackArtifact = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("seed-grow-isolated-rollback-evidence"),
    id: identifier,
    inputSha256: digest,
    candidateSha: commitSha,
    localRepeat: RepeatEvidence,
    target: z.enum(["kill_switch", "legacy_fallback"]),
    outcome: z.literal("completed"),
    phaseAtAction: z.literal("dogfood_default"),
    before: z
      .object({
        phase: z.literal("dogfood_default"),
        executionMode: z.enum(["off", "active"]),
        newProjectPolicy: z
          .object({
            defaultStrategy: z.enum(["legacy_full_plan", "seed_and_grow"]),
            seedOptInAllowed: z.boolean(),
            explicitLegacyFallbackAllowed: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    after: z
      .object({
        phase: z.literal("dogfood_default"),
        executionMode: z.enum(["off", "active"]),
        newProjectPolicy: z
          .object({
            defaultStrategy: z.enum(["legacy_full_plan", "seed_and_grow"]),
            seedOptInAllowed: z.boolean(),
            explicitLegacyFallbackAllowed: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    inFlightProject: z
      .object({
        id: identifier,
        status: z.literal("executing"),
        strategyBefore: z.literal("seed_and_grow"),
        strategyAfter: z.literal("seed_and_grow"),
        businessStateSha256Before: digest,
        businessStateSha256After: digest,
      })
      .strict(),
    process: z
      .object({
        pid: z.number().int().positive(),
        producerPath: z.literal("packages/control-plane/script/produce-seed-grow-candidate-facts.ts"),
        producerSha256: digest,
        startedAt: timestamp,
      })
      .strict(),
    dispatch: z
      .object({
        coordinator: z.literal("DispatchCoordinator"),
        action: z.enum(["kill_switch", "legacy_fallback"]),
        projectId: identifier,
        resultSha256: digest,
        observedAt: timestamp,
      })
      .strict(),
    businessRows: z
      .object({
        beforeSha256: digest,
        afterSha256: digest,
        newProjectId: identifier,
        newProjectStrategy: z.enum(["legacy_full_plan", "seed_and_grow"]),
        existingProjectId: identifier,
        existingProjectStrategyBefore: z.literal("seed_and_grow"),
        existingProjectStrategyAfter: z.literal("seed_and_grow"),
      })
      .strict(),
    resolvedNewProjectStrategy: z.enum(["legacy_full_plan", "seed_and_grow"]),
    resolvedExplicitFallbackStrategy: z.literal("legacy_full_plan"),
    isolation: z
      .object({
        database: z.literal("fresh_local_sqlite"),
        databasePathSha256: digest,
        productionDatabaseInherited: z.literal(false),
        productionProcessUsed: z.literal(false),
        networkPortsUsed: z.tuple([]),
      })
      .strict(),
    observedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedMode = value.target === "kill_switch" ? "off" : "active"
    const expectedDefault = value.target === "kill_switch" ? "legacy_full_plan" : "seed_and_grow"
    if (value.after.executionMode !== expectedMode)
      context.addIssue({ code: "custom", path: ["after", "executionMode"], message: "Rollback mode mismatch" })
    if (value.after.newProjectPolicy.defaultStrategy !== expectedDefault)
      context.addIssue({
        code: "custom",
        path: ["after", "newProjectPolicy", "defaultStrategy"],
        message: "Rollback policy mismatch",
      })
    if (
      value.inFlightProject.businessStateSha256Before !== value.inFlightProject.businessStateSha256After ||
      value.inFlightProject.strategyBefore !== value.inFlightProject.strategyAfter
    )
      context.addIssue({
        code: "custom",
        path: ["inFlightProject"],
        message: "Rollback changed the in-flight project",
      })
    if (
      value.dispatch.action !== value.target ||
      value.dispatch.projectId !== value.inFlightProject.id ||
      value.businessRows.existingProjectId !== value.inFlightProject.id ||
      value.businessRows.existingProjectStrategyBefore !== value.inFlightProject.strategyBefore ||
      value.businessRows.existingProjectStrategyAfter !== value.inFlightProject.strategyAfter ||
      value.businessRows.newProjectStrategy !== value.resolvedNewProjectStrategy
    )
      context.addIssue({
        code: "custom",
        path: ["dispatch"],
        message: "Rollback process, dispatch, and business row observations are inconsistent",
      })
  })

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function canonical(value: unknown) {
  return JSON.stringify(normalized(value))
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function same(left: unknown, right: unknown) {
  return canonical(left) === canonical(right)
}

function fail(status: Exclude<GateStatus, "pass">, message: string): never {
  throw new PrePublicGateError(status, message)
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown, label: string) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) fail("invalid", `${label} is malformed: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

async function regularFile(target: string, label: string) {
  const info = await lstat(target).catch(() => null)
  if (!info) fail("blocked", `${label} is missing: ${target}`)
  if (!info.isFile() || info.isSymbolicLink()) fail("invalid", `${label} must be a regular file: ${target}`)
  const bytes = new Uint8Array(await Bun.file(target).arrayBuffer())
  return {
    bytes,
    source: new TextDecoder().decode(bytes),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }
}

async function regularDirectory(target: string, label: string) {
  const info = await lstat(target).catch(() => null)
  if (!info) fail("blocked", `${label} is missing: ${target}`)
  if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid", `${label} must be a regular directory: ${target}`)
  return realpath(target)
}

export async function readBoundJSON(reference: z.input<typeof absoluteFileReference>, label: string) {
  const parsed = parseOrInvalid(absoluteFileReference, reference, `${label} reference`)
  const file = await regularFile(parsed.path, label)
  if (file.sha256 !== parsed.sha256) fail("invalid", `${label} SHA-256 mismatch`)
  const value = await Promise.resolve()
    .then(() => JSON.parse(file.source) as unknown)
    .catch(() => fail("invalid", `${label} is not valid JSON`))
  return { ...file, value, path: parsed.path }
}

async function parseJSONFile<T>(target: string, schema: z.ZodType<T>, label: string) {
  const file = await regularFile(target, label)
  const value = await Promise.resolve()
    .then(() => JSON.parse(file.source) as unknown)
    .catch(() => fail("invalid", `${label} is not valid JSON`))
  return { ...file, value: parseOrInvalid(schema, value, label), path: target }
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    fail("invalid", `Git verification failed: ${new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)}`)
  return new TextDecoder().decode(result.stdout).trim()
}

function gitSource(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    fail("invalid", `Git verification failed: ${new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)}`)
  return new TextDecoder().decode(result.stdout)
}

function resolveCommit(value: string) {
  return git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])
}

function runnerSourceAt(candidateSha: string) {
  return gitSource(["show", `${candidateSha}:${runnerPath}`])
}

function verifyCurrentCandidate(candidate: z.infer<typeof CandidateInput>) {
  const head = resolveCommit("HEAD")
  const target = resolveCommit(candidate.targetRef)
  if (head !== candidate.candidateSha) fail("invalid", "Checked-out HEAD does not match the candidate SHA")
  if (target !== candidate.candidateSha) fail("invalid", "Target ref does not resolve to the candidate SHA")
  runtimeBindingPaths.forEach((relativePath) => {
    const candidateBlob = git(["rev-parse", "--verify", `${candidate.candidateSha}:${relativePath}`])
    const workingBlob = git(["hash-object", "--", relativePath])
    if (candidateBlob !== workingBlob)
      fail("invalid", `Runtime dependency is dirty and differs from the candidate Git blob: ${relativePath}`)
  })
}

export function verifyDirectParent(previousCandidateSha: string, currentCandidateSha: string) {
  parseOrInvalid(commitSha, previousCandidateSha, "Previous candidate SHA")
  parseOrInvalid(commitSha, currentCandidateSha, "Current candidate SHA")
  const command = ["rev-list", "--parents", "-n", "1", currentCandidateSha]
  const output = git(command)
  const commits = output.split(/\s+/)
  if (commits.length !== 2 || commits[0] !== currentCandidateSha || commits[1] !== previousCandidateSha)
    fail("invalid", "Previous candidate is not the current candidate's single direct parent")
  return {
    previousCandidateSha,
    currentCandidateSha,
    parentSha: commits[1],
    verified: true as const,
    commandEvidenceSha256: sha256(canonical({ argv: ["git", ...command], stdout: output })),
  }
}

async function fileInside(directory: string, relativePath: string, label: string) {
  if (
    path.isAbsolute(relativePath) ||
    !relativePath ||
    relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    fail("invalid", `${label} path escaped its evidence directory`)
  const target = path.resolve(directory, relativePath)
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`))
    fail("invalid", `${label} path escaped its evidence directory`)
  const file = await regularFile(target, label)
  const directoryReal = await realpath(directory)
  const fileReal = await realpath(target)
  if (!fileReal.startsWith(`${directoryReal}${path.sep}`))
    fail("invalid", `${label} resolved outside its evidence directory`)
  return { ...file, path: target }
}

function stageStatusError(status: GateStatus, label: string): never {
  if (status === "blocked") fail("blocked", `${label} is blocked`)
  if (status === "failed") fail("failed", `${label} failed`)
  fail("invalid", `${label} is invalid`)
}

function orderedStages(values: readonly string[]) {
  return values.length === stageIDs.length && stageIDs.every((stage, index) => values[index] === stage)
}

async function validateAllStageEvidence(candidate: z.infer<typeof CandidateInput>, governance: Governance) {
  const gateRuntime = await import(path.join(root, "script/seed-grow-stage-gate.ts"))
  const coreRuntime = await import(path.join(root, "script/seed-grow-stage-core.ts"))
  const evidenceDirectory = path.resolve(candidate.evidenceDirectory)
  await regularDirectory(evidenceDirectory, "All-stage evidence directory")
  const finalRun = await parseJSONFile(path.join(evidenceDirectory, "final-run.json"), FinalRun, "Final run")
  const finalDecision = await parseJSONFile(
    path.join(evidenceDirectory, "final-decision.json"),
    FinalDecision,
    "Final decision",
  )
  if (
    finalRun.value.buildSha !== candidate.candidateSha ||
    finalDecision.value.buildSha !== candidate.candidateSha ||
    finalRun.value.buildTreeSha !== governance.buildTreeSha ||
    finalDecision.value.buildTreeSha !== governance.buildTreeSha
  )
    fail("invalid", "Final evidence candidate or tree binding mismatch")
  if (
    finalRun.value.status !== "pass" ||
    finalDecision.value.status !== "pass" ||
    finalRun.value.automaticAttempts.some((attempt) => attempt.status !== "pass")
  )
    stageStatusError(
      finalRun.value.status !== "pass" ? finalRun.value.status : finalDecision.value.status,
      "Final all-stage evidence",
    )
  if (
    finalRun.value.automaticAttempts[0]?.id !== "attempt-01" ||
    finalRun.value.automaticAttempts[1]?.id !== "attempt-02" ||
    new Set(finalRun.value.automaticAttempts.map((attempt) => attempt.normalizedDigest)).size !== 1
  )
    fail("invalid", "Final attempts are not two reproducible local runs")
  if (
    !orderedStages(finalRun.value.stages.map((stage) => stage.stage)) ||
    !orderedStages(finalDecision.value.required) ||
    !orderedStages(finalDecision.value.passed) ||
    finalDecision.value.failed.length ||
    finalDecision.value.blocked.length ||
    finalDecision.value.invalid.length ||
    finalDecision.value.missing.length ||
    !same(finalRun.value.stages, finalDecision.value.stages) ||
    finalDecision.value.finalRun.relativePath !== "final-run.json" ||
    finalDecision.value.finalRun.sha256 !== finalRun.sha256 ||
    finalDecision.value.finalRun.byteLength !== finalRun.byteLength ||
    finalDecision.value.finalRun.mediaType !== "application/json"
  )
    fail("invalid", "Final run and decision are inconsistent")
  const stageRunSha256s = {} as Record<StageID, string>
  const stageDecisionSha256s = {} as Record<StageID, string>
  const packageByAttempt = new Map<string, { source: string; sha256: string; value: Record<string, unknown> }[]>()
  for (const summary of finalRun.value.stages) {
    if (summary.evidenceDirectory !== `${path.basename(evidenceDirectory)}-${summary.stage.toLowerCase()}`)
      fail("invalid", `${summary.stage} evidence directory name is not bound to the final run`)
    const stageDirectory = path.join(path.dirname(evidenceDirectory), summary.evidenceDirectory)
    await regularDirectory(stageDirectory, `${summary.stage} evidence directory`)
    const run = await regularFile(path.join(stageDirectory, "run.json"), `${summary.stage} run`)
    const decision = await parseJSONFile(
      path.join(stageDirectory, "stage-decision.json"),
      StageDecision,
      `${summary.stage} decision`,
    )
    if (run.sha256 !== summary.runSha256 || decision.sha256 !== summary.decisionSha256)
      fail("invalid", `${summary.stage} final summary digest mismatch`)
    const evaluation = await gateRuntime.evaluateSeedGrowStageEvidence({
      buildSha: candidate.candidateSha,
      stage: summary.stage,
      evidenceDirectory: stageDirectory,
      governance,
    })
    if (evaluation.status !== "pass") stageStatusError(evaluation.status, `${summary.stage} evidence`)
    if (
      decision.value.stage !== summary.stage ||
      decision.value.buildSha !== candidate.candidateSha ||
      decision.value.status !== evaluation.status ||
      decision.value.normalizedDigest !== evaluation.normalizedDigest ||
      decision.value.evidencePackage.sha256 !== run.sha256 ||
      !same(decision.value.required, evaluation.required) ||
      !same(decision.value.passed, evaluation.passed) ||
      !same(decision.value.failed, evaluation.failed) ||
      !same(decision.value.missing, evaluation.missing) ||
      !same(decision.value.invalid, evaluation.invalid)
    )
      fail("invalid", `${summary.stage} persisted decision differs from re-evaluation`)
    const runValue = await Promise.resolve()
      .then(() => JSON.parse(run.source) as unknown)
      .catch(() => fail("invalid", `${summary.stage} run is not valid JSON`))
    if (!runValue || typeof runValue !== "object" || !Array.isArray((runValue as Record<string, unknown>).attempts))
      fail("invalid", `${summary.stage} run attempts are malformed`)
    const attempts = (runValue as Record<string, unknown>).attempts as unknown[]
    for (const [index, attemptValue] of attempts.entries()) {
      if (
        !attemptValue ||
        typeof attemptValue !== "object" ||
        !("id" in attemptValue) ||
        !("automaticPackage" in attemptValue)
      )
        fail("invalid", `${summary.stage} attempt is malformed`)
      const attempt = attemptValue as Record<string, unknown>
      const binding = parseOrInvalid(
        fileBinding,
        attempt.automaticPackage,
        `${summary.stage} ${String(attempt.id)} package binding`,
      )
      const automatic = await fileInside(
        stageDirectory,
        binding.relativePath,
        `${summary.stage} ${String(attempt.id)} automatic package`,
      )
      if (
        automatic.sha256 !== binding.sha256 ||
        automatic.byteLength !== binding.byteLength ||
        binding.mediaType !== "application/json"
      )
        fail("invalid", `${summary.stage} ${String(attempt.id)} package digest mismatch`)
      const value = await Promise.resolve()
        .then(() => JSON.parse(automatic.source) as unknown)
        .catch(() => fail("invalid", `${summary.stage} automatic package is not valid JSON`))
      if (!value || typeof value !== "object") fail("invalid", `${summary.stage} automatic package is malformed`)
      const entries = packageByAttempt.get(String(attempt.id)) ?? []
      entries.push({
        source: automatic.source,
        sha256: automatic.sha256,
        value: value as Record<string, unknown>,
      })
      packageByAttempt.set(String(attempt.id), entries)
      if (index > 1) fail("invalid", `${summary.stage} has more than two attempts`)
    }
    stageRunSha256s[summary.stage] = run.sha256
    stageDecisionSha256s[summary.stage] = decision.sha256
  }
  const repeats = finalRun.value.automaticAttempts.map((attempt, index) => {
    const packages = packageByAttempt.get(attempt.id) ?? []
    if (packages.length !== stageIDs.length || new Set(packages.map((item) => item.sha256)).size !== 1)
      fail("invalid", `${attempt.id} is not the same independently executed package across every stage`)
    const automatic = packages[0]!
    if (
      automatic.value.overallStatus !== "pass" ||
      automatic.value.buildSha !== candidate.candidateSha ||
      automatic.value.buildTreeSha !== governance.buildTreeSha ||
      !automatic.value.provenance ||
      typeof automatic.value.provenance !== "object" ||
      (automatic.value.provenance as Record<string, unknown>).kind !== "executed" ||
      (automatic.value.provenance as Record<string, unknown>).worktreeHead !== candidate.candidateSha ||
      coreRuntime.normalizeAutomaticPackage(automatic.value, governance.automaticCommandIDs) !==
        attempt.normalizedDigest
    )
      fail("invalid", `${attempt.id} is not exact-SHA executed evidence`)
    const commands = Array.isArray(automatic.value.commands) ? automatic.value.commands : []
    const intervals = commands.flatMap((command) => {
      if (
        !command ||
        typeof command !== "object" ||
        typeof (command as Record<string, unknown>).startedAt !== "string" ||
        typeof (command as Record<string, unknown>).finishedAt !== "string"
      )
        return []
      return [
        {
          startedAt: Date.parse(String((command as Record<string, unknown>).startedAt)),
          finishedAt: Date.parse(String((command as Record<string, unknown>).finishedAt)),
        },
      ]
    })
    if (
      !commands.length ||
      intervals.length !== commands.length ||
      intervals.some(
        (interval) =>
          !Number.isFinite(interval.startedAt) ||
          !Number.isFinite(interval.finishedAt) ||
          interval.finishedAt < interval.startedAt,
      ) ||
      typeof automatic.value.packageId !== "string"
    )
      fail("invalid", `${attempt.id} has invalid execution identity or timestamps`)
    return RepeatEvidence.parse({
      runId: `${automatic.value.packageId}-${attempt.id}`,
      ordinal: index + 1,
      environmentSha256: sha256(
        canonical({
          buildTreeSha: automatic.value.buildTreeSha,
          runnerBinding: automatic.value.runnerBinding,
          provenance: automatic.value.provenance,
          isolation: automatic.value.isolation,
        }),
      ),
      evidenceSha256: automatic.sha256,
      normalizedResultSha256: attempt.normalizedDigest,
      startedAt: Math.min(...intervals.map((interval) => interval.startedAt)),
      finishedAt: Math.max(...intervals.map((interval) => interval.finishedAt)),
    })
  })
  if (
    new Set(repeats.map((repeat) => repeat.evidenceSha256)).size !== 2 ||
    new Set(repeats.map((repeat) => repeat.normalizedResultSha256)).size !== 1
  )
    fail("invalid", "The two local attempts are duplicated or not normalized-equivalent")
  return CandidateEvidence.parse({
    evidenceDirectory,
    finalRun: { path: finalRun.path, sha256: finalRun.sha256 },
    finalDecision: { path: finalDecision.path, sha256: finalDecision.sha256 },
    stageRunSha256s,
    stageDecisionSha256s,
    repeats,
  })
}

async function validateCandidate(candidateValue: z.infer<typeof CandidateInput>) {
  const candidate = CandidateInput.parse(candidateValue)
  const coreRuntime = await import(path.join(root, "script/seed-grow-stage-core.ts"))
  const governance = (await coreRuntime
    .loadSeedGrowGovernance(candidate.candidateSha)
    .catch((error: unknown) => fail("invalid", error instanceof Error ? error.message : String(error)))) as Governance
  const contractValue = await Promise.resolve()
    .then(() => JSON.parse(governance.metricSource) as unknown)
    .catch(() => fail("invalid", "Metric contract is not valid JSON"))
  const contract = parseOrInvalid(MetricContract, contractValue, "Metric contract")
  const contractSha256 = metricContractDigest(contract)
  if (contractSha256 !== PrePublicMetricContractSha256)
    fail("invalid", "Metric contract is not the supported Pre-Public contract")
  const evidence = await validateAllStageEvidence(candidate, governance)
  await readBoundJSON(candidate.factArtifact, "Persisted fact artifact")
  const adapter = await makePersistedFactArtifactAdapter(candidate.factArtifact).catch((error) =>
    fail("invalid", error instanceof Error ? error.message : String(error)),
  )
  const reports = await Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Service
      return {
        metric: yield* reporter.report({
          contract,
          candidateSha: candidate.candidateSha,
          metricIds: [...PrePublicBlockingMetricIds],
          strategy: "seed_and_grow",
        }),
        shadow: yield* reporter.compareShadow({
          contract,
          candidateSha: candidate.candidateSha,
          comparisonId: candidate.comparisonId,
          scenarioIds: candidate.scenarioIds,
        }),
      }
    }).pipe(Effect.provide(makeLayer(adapter))),
  ).catch((error) => fail("invalid", error instanceof Error ? error.message : String(error)))
  const metric = parseOrInvalid(MetricEvaluationReport, reports.metric, "Metric report")
  const shadow = parseOrInvalid(ShadowComparisonReport, reports.shadow, "Shadow report")
  if (
    metric.results.length !== PrePublicBlockingMetricIds.length ||
    new Set(metric.results.map((result) => result.metricId)).size !== PrePublicBlockingMetricIds.length ||
    !PrePublicBlockingMetricIds.every((metricId) => metric.results.some((result) => result.metricId === metricId))
  )
    fail("invalid", "Metric report does not contain exactly the 18 Pre-Public metrics")
  const status: GateStatus =
    metric.status === "blocked" || shadow.status === "blocked"
      ? "blocked"
      : metric.status !== "pass" || shadow.status !== "pass"
        ? "failed"
        : "pass"
  return {
    candidate,
    governance,
    contract,
    contractSha256,
    evidence,
    reports: { metric, shadow },
    status,
  }
}

async function emptyDirectory(target: string, label: string) {
  const resolved = path.resolve(target)
  const info = await lstat(resolved).catch(() => null)
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) fail("invalid", `${label} must be a regular directory`)
  if (info && (await readdir(resolved)).length) fail("invalid", `${label} must be absent or empty`)
  await mkdir(resolved, { recursive: true })
  return resolved
}

async function writeJSON(directory: string, name: string, value: unknown) {
  const source = `${JSON.stringify(value, null, 2)}\n`
  const target = path.join(directory, name)
  const handle = await open(target, "wx", 0o600).catch(() => fail("invalid", `Output file already exists: ${target}`))
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return {
    relativePath: name,
    sha256: sha256(source),
    byteLength: Buffer.byteLength(source),
    mediaType: "application/json",
  }
}

function runnerBindingAt(candidateSha: string) {
  return {
    path: runnerPath,
    sha256: sha256(runnerSourceAt(candidateSha)),
  }
}

async function writeReports(
  directory: string,
  prefix: string,
  reports: {
    metric: z.infer<typeof MetricEvaluationReport>
    shadow: z.infer<typeof ShadowComparisonReport>
  },
) {
  return {
    metric: await writeJSON(directory, `${prefix}metric-report.json`, reports.metric),
    shadow: await writeJSON(directory, `${prefix}shadow-report.json`, reports.shadow),
  }
}

async function bootstrap(request: z.infer<typeof BootstrapRequest>, inputSha256: string, outputDirectory: string) {
  verifyCurrentCandidate(request.candidate)
  const validated = await validateCandidate(request.candidate)
  const reportBindings = await writeReports(outputDirectory, "", validated.reports)
  if (validated.status !== "pass") stageStatusError(validated.status, "Candidate metric and shadow reports")
  const artifact = BootstrapArtifact.parse({
    schemaVersion: 1,
    kind: "seed-grow-bootstrap-candidate",
    inputSha256,
    candidate: validated.candidate,
    runnerBinding: runnerBindingAt(validated.candidate.candidateSha),
    metricContract: {
      path: "docs/product-design/experience-refactor/metric-contract.v1.json",
      sourceSha256: validated.governance.metricSha256,
      contractSha256: validated.contractSha256,
    },
    candidateEvidence: validated.evidence,
    metricReport: reportBindings.metric,
    shadowReport: reportBindings.shadow,
    promotionClaimed: false,
    status: "pass",
    createdAt: Date.now(),
  })
  const bootstrapBinding = await writeJSON(outputDirectory, "bootstrap-candidate.json", artifact)
  return {
    schemaVersion: 1,
    mode: "bootstrap" as const,
    inputSha256,
    candidateSha: validated.candidate.candidateSha,
    bootstrapCandidate: bootstrapBinding,
    metricReport: reportBindings.metric,
    shadowReport: reportBindings.shadow,
    promotionClaimed: false,
    status: "pass" as const,
  }
}

async function revalidateBootstrap(reference: z.infer<typeof absoluteFileReference>) {
  const source = await readBoundJSON(reference, "Previous bootstrap artifact")
  const artifact = parseOrInvalid(BootstrapArtifact, source.value, "Previous bootstrap artifact")
  if (!same(artifact.runnerBinding, runnerBindingAt(artifact.candidate.candidateSha)))
    fail("invalid", "Previous bootstrap runner binding mismatch")
  const validated = await validateCandidate(artifact.candidate)
  if (validated.status !== "pass") stageStatusError(validated.status, "Previous candidate reports")
  if (
    artifact.metricContract.sourceSha256 !== validated.governance.metricSha256 ||
    artifact.metricContract.contractSha256 !== validated.contractSha256 ||
    !same(artifact.candidateEvidence, validated.evidence)
  )
    fail("invalid", "Previous bootstrap evidence no longer revalidates")
  const directory = path.dirname(reference.path)
  const metric = await fileInside(directory, artifact.metricReport.relativePath, "Previous metric report")
  const shadow = await fileInside(directory, artifact.shadowReport.relativePath, "Previous shadow report")
  if (
    metric.sha256 !== artifact.metricReport.sha256 ||
    metric.byteLength !== artifact.metricReport.byteLength ||
    shadow.sha256 !== artifact.shadowReport.sha256 ||
    shadow.byteLength !== artifact.shadowReport.byteLength
  )
    fail("invalid", "Previous bootstrap report binding mismatch")
  const metricValue = await Promise.resolve()
    .then(() => JSON.parse(metric.source) as unknown)
    .catch(() => fail("invalid", "Previous metric report is not valid JSON"))
  const shadowValue = await Promise.resolve()
    .then(() => JSON.parse(shadow.source) as unknown)
    .catch(() => fail("invalid", "Previous shadow report is not valid JSON"))
  if (
    !same(parseOrInvalid(MetricEvaluationReport, metricValue, "Previous metric report"), validated.reports.metric) ||
    !same(parseOrInvalid(ShadowComparisonReport, shadowValue, "Previous shadow report"), validated.reports.shadow)
  )
    fail("invalid", "Previous bootstrap reports differ from persisted-fact re-evaluation")
  return { artifact, validated, reference }
}

export function validateRollbackPair(
  values: unknown[],
  candidateSha: string,
  repeats: z.infer<typeof RepeatEvidence>[],
  inputSha256: string,
) {
  if (values.length !== 2) fail("blocked", "Both rollback artifacts are required")
  const artifacts = values.map((value, index) =>
    parseOrInvalid(RollbackArtifact, value, `Rollback artifact ${index + 1}`),
  )
  if (
    new Set(artifacts.map((artifact) => artifact.id)).size !== 2 ||
    new Set(artifacts.map((artifact) => artifact.target)).size !== 2 ||
    new Set(artifacts.map((artifact) => artifact.localRepeat.runId)).size !== 2
  )
    fail("invalid", "Rollback artifacts are duplicated")
  artifacts.forEach((artifact) => {
    const repeat = repeats.find(
      (candidate) =>
        candidate.runId === artifact.localRepeat.runId &&
        candidate.evidenceSha256 === artifact.localRepeat.evidenceSha256,
    )
    if (
      artifact.candidateSha !== candidateSha ||
      artifact.inputSha256 !== inputSha256 ||
      !repeat ||
      !same(repeat, artifact.localRepeat)
    )
      fail("invalid", "Rollback artifact candidate, input, or local evidence binding mismatch")
  })
  return artifacts
}

async function isolatedPromotion(
  request: z.infer<typeof PromoteRequest>,
  inputSha256: string,
  outputDirectory: string,
  previous: Awaited<ReturnType<typeof revalidateBootstrap>>,
  current: Awaited<ReturnType<typeof validateCandidate>>,
  reportBindings: Awaited<ReturnType<typeof writeReports>>,
  ancestry: ReturnType<typeof verifyDirectParent>,
) {
  const databaseDirectory = await emptyDirectory(request.databaseDirectory, "Promotion database directory")
  const databasePath = path.join(databaseDirectory, "company-rollout.db")
  process.env.AGENTCOMPANY_DB = databasePath
  process.env.AGENTCOMPANY_HOME = path.join(databaseDirectory, "home")
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
  const CompanyRollout = await import("../src/company-rollout/company-rollout")
  const storage = await import("../src/storage")
  const projectSql = await import("../src/company-project/company-project.sql")
  const candidateIds: [string, string] = [
    `candidate-01-${previous.artifact.candidate.candidateSha.slice(0, 16)}`,
    `candidate-02-${current.candidate.candidateSha.slice(0, 16)}`,
  ]
  for (const [to, id] of [
    ["shadow", "shadow"],
    ["opt_in", "opt-in"],
    ["dogfood_default", "dogfood"],
  ] as const)
    CompanyRollout.transition({
      idempotencyKey: `pre-public-${id}-${current.candidate.candidateSha.slice(0, 12)}`,
      to,
      reason: `Isolated Pre-Public candidate gate enters ${to}`,
      actorId: "seed-grow-pre-public-gate",
    })
  ;[
    { id: candidateIds[0], candidate: previous.artifact.candidate },
    { id: candidateIds[1], candidate: current.candidate },
  ].forEach((item, candidateIndex) => {
    CompanyRollout.recordAction({
      kind: "register_candidate",
      idempotencyKey: `register-${candidateIndex + 1}-${item.candidate.candidateSha.slice(0, 16)}`,
      candidate: {
        id: item.id,
        candidateSha: item.candidate.candidateSha,
        targetRef: item.candidate.targetRef,
      },
    })
    const evidence = candidateIndex === 0 ? previous.validated.evidence : current.evidence
    evidence.repeats.forEach((repeat) =>
      CompanyRollout.recordAction({
        kind: "record_local_repeat",
        idempotencyKey: `record-${candidateIndex + 1}-${repeat.ordinal}-${item.candidate.candidateSha.slice(0, 12)}`,
        repeat: {
          id: `repeat-${candidateIndex + 1}-${repeat.ordinal}-${item.candidate.candidateSha.slice(0, 12)}`,
          candidateId: item.id,
          ...repeat,
          outcome: "completed",
        },
      }),
    )
  })
  const projectId = `rollback-probe-${current.candidate.candidateSha.slice(0, 16)}`
  const now = Date.now()
  storage.Database.use((database) =>
    database
      .insert(projectSql.CompanyProjectTable)
      .values({
        id: projectId,
        goal: "Verify isolated rollback preserves an in-flight Seed-and-Grow project",
        title: "Pre-Public rollback probe",
        status: "executing",
        output_dir: path.join(databaseDirectory, "probe-output"),
        execution_strategy: CompanyRollout.resolveNewProjectStrategy(),
        seed_mode: "direct_single",
        orchestration_state: "idle",
        orchestrator_version: 1,
        dispatch_paused: false,
        graph_revision: 0,
        created_at: now,
        updated_at: now,
      })
      .run(),
  )
  const projectRow = () =>
    storage.Database.use((database) =>
      database
        .select()
        .from(projectSql.CompanyProjectTable)
        .where(storage.eq(projectSql.CompanyProjectTable.id, projectId))
        .get(),
    )
  const snapshot = () => {
    const status = CompanyRollout.status()
    const project = projectRow()
    if (!project) fail("invalid", "Rollback probe project disappeared")
    return {
      rollout: {
        phase: status.state.phase,
        executionMode: status.executionMode,
        newProjectPolicy: status.newProjectPolicy,
      },
      project: {
        id: project.id,
        status: project.status,
        strategy: project.execution_strategy,
        businessStateSha256: CompanyRollout.projectBusinessStateSha256(project.id),
      },
    }
  }
  const databasePathSha256 = sha256(path.resolve(databasePath))
  const rollbackValues = []
  const activeBeforeKill = snapshot()
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
  const killAfter = snapshot()
  rollbackValues.push({
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-kill-${current.candidate.candidateSha.slice(0, 16)}`,
    inputSha256,
    candidateSha: current.candidate.candidateSha,
    localRepeat: current.evidence.repeats[0],
    target: "kill_switch",
    outcome: "completed",
    phaseAtAction: "dogfood_default",
    before: activeBeforeKill.rollout,
    after: killAfter.rollout,
    inFlightProject: {
      id: projectId,
      status: killAfter.project.status,
      strategyBefore: activeBeforeKill.project.strategy,
      strategyAfter: killAfter.project.strategy,
      businessStateSha256Before: activeBeforeKill.project.businessStateSha256,
      businessStateSha256After: killAfter.project.businessStateSha256,
    },
    resolvedNewProjectStrategy: CompanyRollout.resolveNewProjectStrategy(),
    resolvedExplicitFallbackStrategy: CompanyRollout.resolveNewProjectStrategy("legacy_full_plan"),
    isolation: {
      database: "fresh_local_sqlite",
      databasePathSha256,
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    observedAt: Date.now(),
  })
  const offBeforeFallback = snapshot()
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
  const fallbackAfter = snapshot()
  rollbackValues.push({
    schemaVersion: 1,
    kind: "seed-grow-isolated-rollback-evidence",
    id: `rollback-fallback-${current.candidate.candidateSha.slice(0, 16)}`,
    inputSha256,
    candidateSha: current.candidate.candidateSha,
    localRepeat: current.evidence.repeats[1],
    target: "legacy_fallback",
    outcome: "completed",
    phaseAtAction: "dogfood_default",
    before: offBeforeFallback.rollout,
    after: fallbackAfter.rollout,
    inFlightProject: {
      id: projectId,
      status: fallbackAfter.project.status,
      strategyBefore: offBeforeFallback.project.strategy,
      strategyAfter: fallbackAfter.project.strategy,
      businessStateSha256Before: offBeforeFallback.project.businessStateSha256,
      businessStateSha256After: fallbackAfter.project.businessStateSha256,
    },
    resolvedNewProjectStrategy: CompanyRollout.resolveNewProjectStrategy(),
    resolvedExplicitFallbackStrategy: CompanyRollout.resolveNewProjectStrategy("legacy_full_plan"),
    isolation: {
      database: "fresh_local_sqlite",
      databasePathSha256,
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    observedAt: Date.now(),
  })
  const rollbacks = validateRollbackPair(
    rollbackValues,
    current.candidate.candidateSha,
    current.evidence.repeats,
    inputSha256,
  )
  const rollbackBindings = [
    await writeJSON(outputDirectory, "rollback-kill-switch.json", rollbacks[0]),
    await writeJSON(outputDirectory, "rollback-legacy-fallback.json", rollbacks[1]),
  ] as const
  if (rollbackBindings[0].sha256 === rollbackBindings[1].sha256)
    fail("invalid", "Rollback artifacts have the same digest")
  rollbacks.forEach((rollback, index) => {
    process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = rollback.target === "kill_switch" ? "off" : "active"
    CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: `record-${rollback.id}`,
      rollback: {
        id: rollback.id,
        candidateId: candidateIds[1],
        target: rollback.target,
        phaseAtAction: rollback.phaseAtAction,
        executionModeAfter: rollback.after.executionMode,
        outcome: rollback.outcome,
        evidenceSha256: rollbackBindings[index]!.sha256,
        observedAt: rollback.observedAt,
      },
    })
  })
  storage.Database.use((database) =>
    database
      .update(projectSql.CompanyProjectTable)
      .set({ status: "completed", completed_at: Date.now(), updated_at: Date.now() })
      .where(storage.eq(projectSql.CompanyProjectTable.id, projectId))
      .run(),
  )
  const promotion = CompanyRollout.evaluatePrePublicPromotion({
    id: `promotion-${current.candidate.candidateSha.slice(0, 16)}`,
    candidateIds,
    metricContract: current.contract,
    metricContractSha256: current.contractSha256,
    metricReports: [previous.validated.reports.metric, current.reports.metric],
    shadowReports: [previous.validated.reports.shadow, current.reports.shadow],
    ancestry: {
      ...ancestry,
      targetRef: current.candidate.targetRef,
    },
  })
  if (promotion.status !== "pass") stageStatusError(promotion.status, "CompanyRollout promotion")
  const persistedPromotion = CompanyRollout.getPromotionDecision(promotion.id)
  if (!persistedPromotion || !same(promotion, persistedPromotion))
    fail("invalid", "Promotion decision did not survive persisted re-read")
  const transition = CompanyRollout.transition({
    idempotencyKey: `pre-public-transition-${current.candidate.candidateSha.slice(0, 16)}`,
    to: "pre_public_default",
    reason: "Two exact-SHA candidates passed all automatic Pre-Public gates",
    actorId: "seed-grow-pre-public-gate",
    promotionDecisionId: promotion.id,
  })
  const finalStatus = CompanyRollout.status()
  const evidence = CompanyRollout.evidence()
  const journal = CompanyRollout.listJournal()
  if (
    finalStatus.state.phase !== "pre_public_default" ||
    !evidence.promotionDecisions.some((decision) => same(decision, persistedPromotion)) ||
    !journal.items.some(
      (item) =>
        item.kind === "transition" &&
        item.resultRefId === transition.transition.id &&
        item.payloadSha256 === transition.journal.payloadSha256,
    )
  )
    fail("invalid", "Pre-Public transition did not survive persisted re-read")
  storage.Database.close()
  const database = await regularFile(databasePath, "Isolated promotion database")
  const result = {
    schemaVersion: 1,
    kind: "seed-grow-pre-public-promotion",
    inputSha256,
    previousBootstrap: request.previousBootstrap,
    candidateShas: [previous.artifact.candidate.candidateSha, current.candidate.candidateSha],
    candidates: {
      previous: {
        input: previous.artifact.candidate,
        evidence: previous.validated.evidence,
      },
      current: {
        input: current.candidate,
        evidence: current.evidence,
      },
    },
    ancestry,
    metricContract: {
      path: "docs/product-design/experience-refactor/metric-contract.v1.json",
      sourceSha256: current.governance.metricSha256,
      contractSha256: current.contractSha256,
    },
    reports: {
      previous: {
        metric: previous.artifact.metricReport,
        shadow: previous.artifact.shadowReport,
      },
      current: {
        metric: reportBindings.metric,
        shadow: reportBindings.shadow,
      },
    },
    rollbacks: rollbackBindings,
    promotion,
    persistedPromotion,
    transition,
    persistedState: finalStatus.state,
    persistedEvidenceSha256: CompanyRollout.valueSha256(evidence),
    persistedJournalSha256: CompanyRollout.valueSha256(journal),
    database: {
      pathSha256: databasePathSha256,
      sha256: database.sha256,
      byteLength: database.byteLength,
    },
    isolation: {
      productionDatabaseInherited: false,
      productionProcessUsed: false,
      networkPortsUsed: [],
    },
    status: "pass",
    createdAt: Date.now(),
  }
  return {
    ...result,
    promotionResult: await writeJSON(outputDirectory, "promotion-result.json", result),
  }
}

async function promote(request: z.infer<typeof PromoteRequest>, inputSha256: string, outputDirectory: string) {
  verifyCurrentCandidate(request.current)
  const previous = await revalidateBootstrap(request.previousBootstrap)
  if (previous.artifact.candidate.targetRef !== request.current.targetRef)
    fail("invalid", "Previous and current candidates use different target refs")
  const ancestry = verifyDirectParent(previous.artifact.candidate.candidateSha, request.current.candidateSha)
  const current = await validateCandidate(request.current)
  const reportBindings = await writeReports(outputDirectory, "current-", current.reports)
  if (current.status !== "pass") stageStatusError(current.status, "Current candidate reports")
  if (!same(previous.validated.contract, current.contract))
    fail("invalid", "Previous and current candidates use different metric contracts")
  return isolatedPromotion(request, inputSha256, outputDirectory, previous, current, reportBindings, ancestry)
}

function requestErrorStatus(error: z.ZodError) {
  return error.issues.some((issue) => issue.code === "invalid_type" && "input" in issue && issue.input === undefined)
    ? "blocked"
    : "invalid"
}

async function execute(requestPath: string) {
  if (!path.isAbsolute(requestPath)) fail("invalid", "Request path must be absolute")
  const input = await regularFile(requestPath, "Pre-Public gate request")
  const raw = await Promise.resolve()
    .then(() => JSON.parse(input.source) as unknown)
    .catch(() => fail("invalid", "Pre-Public gate request is not valid JSON"))
  const parsed = Request.safeParse(raw)
  if (!parsed.success)
    fail(requestErrorStatus(parsed.error), `Pre-Public gate request is malformed: ${z.prettifyError(parsed.error)}`)
  verifyCurrentCandidate(parsed.data.mode === "bootstrap" ? parsed.data.candidate : parsed.data.current)
  const outputDirectory = await emptyDirectory(parsed.data.outputDirectory, "Gate output directory")
  const result = await (
    parsed.data.mode === "bootstrap"
      ? bootstrap(parsed.data, input.sha256, outputDirectory)
      : promote(parsed.data, input.sha256, outputDirectory)
  ).catch((error) => ({
    schemaVersion: 1,
    kind: "seed-grow-pre-public-gate-decision",
    mode: parsed.data.mode,
    inputSha256: input.sha256,
    status: error instanceof PrePublicGateError ? error.status : ("invalid" as const),
    reasons: [redacted(error)],
  }))
  const decision = await writeJSON(outputDirectory, "decision.json", result)
  return { ...result, decision }
}

function redacted(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(root, "<repo>")
    .replaceAll(process.env.HOME ?? "\u0000", "<home>")
    .slice(0, 8_000)
}

if (import.meta.main) {
  const requestPath = Bun.argv[2]
  const result = requestPath
    ? await execute(requestPath).catch((error) => {
        const status = error instanceof PrePublicGateError ? error.status : ("invalid" as const)
        return {
          schemaVersion: 1,
          kind: "seed-grow-pre-public-gate-decision",
          status,
          reasons: [redacted(error)],
        }
      })
    : {
        schemaVersion: 1,
        kind: "seed-grow-pre-public-gate-decision",
        status: "blocked" as const,
        reasons: ["Usage: bun script/seed-grow-pre-public-gate.ts /absolute/request.json"],
      }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode =
    result.status === "pass" ? 0 : result.status === "failed" ? 1 : result.status === "blocked" ? 2 : 64
}
