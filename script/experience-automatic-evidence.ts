import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"
import { canonicalize, sha256, verifyExactCommit } from "./experience-benchmark"

const root = path.resolve(import.meta.dir, "..")
export const automaticEvidenceRequirementsRelativePath =
  "docs/product-design/experience-refactor/automatic-evidence-requirements.v1.json"
export const automaticEvidenceSchemaRelativePath =
  "docs/product-design/experience-refactor/automatic-evidence-package.v1.json"
export const requiredR0TaskIDs = [
  "FND-01",
  "FND-02",
  "FND-03",
  "FND-04[R0-contract]",
  "GOAL-01[R0-contract]",
  "SHELL-01",
  "SHELL-02",
  "SHELL-03",
  "TRUST-01",
  "TRUST-02",
  "GOAL-02",
  "WORK-05",
  "QA-02",
] as const
const requiredIsolationEnvironment = [
  "HOME",
  "USERPROFILE",
  "AGENTCOMPANY_HOME",
  "AGENT_COMPANY_WEBUI_DATA_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]
const inheritedEnvironmentAllowlist = new Set([
  "COLORTERM",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "SHELL",
  "SystemDrive",
  "SystemRoot",
  "TERM",
  "WINDIR",
])
const requirementEnvironmentAllowlist = new Set(["MODELS_DEV_API_JSON", "PLAYWRIGHT_JUNIT_OUTPUT"])
const releaseCandidateGeneratorCommandId = "app-r0-candidates"
const releaseCandidateManifestSourceRelativePath = "human-review/screenshots-manifest.json"
const releaseCandidateArchiveDirectory = "files/app-r0-candidates/release-candidate-screenshots"
const releaseCandidateSurfaces = ["First-run", "Inbox", "Goal Brief", "Running", "Blocked", "Gate", "Delivery", "Team"]
const releaseCandidateScreenshotMinimum = { width: 1280, height: 720 }
const releaseCandidateHR01ManifestSourceRelativePath = "human-review/hr01-state-cards/stimuli-manifest.json"
const releaseCandidateHR01ArchiveDirectory = "files/app-r0-candidates/release-candidate-hr01-stimuli"
const releaseCandidateHR01States = [
  ["HR01-P01", "needs_input"],
  ["HR01-P02", "ready"],
  ["HR01-P03", "running"],
  ["HR01-P04", "paused"],
  ["HR01-P05", "blocked"],
  ["HR01-P06", "needs_approval"],
  ["HR01-P07", "reviewing"],
  ["HR01-P08", "revision"],
  ["HR01-P09", "delivered"],
  ["HR01-P10", "accepted"],
  ["HR01-P11", "failed"],
  ["HR01-P12", "cancelled"],
] as const
const releaseCandidateHR01StimulusMinimum = { width: 600, height: 140 }
const releaseCandidateHR01Presentation =
  "Show the release-candidate state card with its state label hidden. Do not explain the state before the response."
const releaseCandidateHR01ExactPrompt = "请用自己的话回答三个问题：现在发生了什么？为什么这件事重要？你下一步会怎么做？"
const humanResearchProtocolRelativePath = "docs/product-design/experience-refactor/human-research-protocol.v1.json"
const packageKeys = [
  "schemaVersion",
  "packageVersion",
  "packageId",
  "gate",
  "buildSha",
  "buildTreeSha",
  "requirementsBinding",
  "schemaBinding",
  "runnerBinding",
  "provenance",
  "isolation",
  "createdAt",
  "commands",
  "coverage",
  "releaseCandidateScreenshots",
  "releaseCandidateHR01Stimuli",
  "overallStatus",
]
const commandKeys = [
  "id",
  "cwd",
  "argv",
  "environment",
  "startedAt",
  "finishedAt",
  "durationMs",
  "exitCode",
  "timedOut",
  "status",
  "stdout",
  "stderr",
  "stdoutSummary",
  "reports",
]

type RequirementReport = {
  path: string
  validator: "junit" | "r0_branch_coverage" | "artifact"
}

type RequirementCommand = {
  id: string
  cwd: string
  argv: string[]
  timeoutMs: number
  stdoutValidator: "none" | "json_pass"
  environment: Record<string, string>
  reports: RequirementReport[]
}

type RequirementCriterion = {
  id: string
  evidenceRefs: string[]
}

type RequirementTask = {
  id: string
  criteria: RequirementCriterion[]
}

export type AutomaticEvidenceRequirements = {
  schemaVersion: number
  id: string
  version: string
  gate: string
  requiredTaskIds: string[]
  isolation: {
    mode: string
    requiredEnvironment: string[]
    liveDatabaseAllowed: boolean
  }
  commands: RequirementCommand[]
  tasks: RequirementTask[]
}

type FileEvidence = {
  relativePath: string
  sha256: string
  byteLength: number
  mediaType: string
}

type ReportEvidence = {
  sourcePath: string
  validator: RequirementReport["validator"]
  file: FileEvidence
  summary: Record<string, unknown>
}

type CommandEvidence = {
  id: string
  cwd: string
  argv: string[]
  environment: Record<string, string>
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  status: "pass" | "fail"
  stdout: FileEvidence
  stderr: FileEvidence
  stdoutSummary: Record<string, unknown> | null
  reports: ReportEvidence[]
}

type ReleaseCandidateScreenshotEvidence = {
  surface: string
  sourceRelativePath: string
  file: FileEvidence
}

type ReleaseCandidateScreenshotsEvidence = {
  generatorCommandId: string
  buildSha: string
  manifest: FileEvidence
  screenshots: ReleaseCandidateScreenshotEvidence[]
}

type ReleaseCandidateHR01StimulusEvidence = {
  promptId: string
  stateId: string
  sourceRelativePath: string
  file: FileEvidence
}

type ReleaseCandidateHR01StimuliEvidence = {
  generatorCommandId: string
  buildSha: string
  manifest: FileEvidence
  stimuli: ReleaseCandidateHR01StimulusEvidence[]
}

export type TrustedReleaseCandidateScreenshots = {
  buildSha: string
  manifestSha256: string
  viewport: {
    width: number
    height: number
  }
  screenshots: Array<{
    surface: string
    relativePath: string
    sha256: string
  }>
}

export type TrustedReleaseCandidateHR01Stimuli = {
  buildSha: string
  manifestSha256: string
  viewport: {
    width: number
    height: number
  }
  stimuli: Array<{
    promptId: string
    stateId: string
    relativePath: string
    sha256: string
  }>
}

type AutomaticEvidencePackage = {
  schemaVersion: number
  packageVersion: string
  packageId: string
  gate: string
  buildSha: string
  buildTreeSha: string
  requirementsBinding: {
    path: string
    sha256: string
  }
  schemaBinding: {
    path: string
    sha256: string
  }
  runnerBinding: {
    buildSha: string
    sha256: string
  }
  provenance: {
    kind: "executed" | "structural_fixture"
    worktreeHead: string | null
  }
  isolation: {
    mode: string
    environment: string[]
    productionDataEnvironmentInherited: boolean
    hostPermissionIsolation: boolean
    networkIsolation: string
    playwright: {
      mode: string
      packageVersion: string
      browsersJsonSha256: string
      browserTreeSha256: string
    }
  }
  createdAt: string
  commands: CommandEvidence[]
  coverage: Array<{
    taskId: string
    criteria: Array<{
      criterionId: string
      evidenceRefs: string[]
    }>
  }>
  releaseCandidateScreenshots: ReleaseCandidateScreenshotsEvidence | null
  releaseCandidateHR01Stimuli: ReleaseCandidateHR01StimuliEvidence | null
  overallStatus: "pass" | "fail"
}

type PlaywrightRuntime = {
  directory: string
  isolationRoot: string
  packageVersion: string
  browsersJsonSha256: string
  browserTreeSha256: string
}

export type AutomaticEvidenceGovernance = {
  requirements: AutomaticEvidenceRequirements
  requirementsSource: string
  requirementsSha256: string
  schemaSource: string
  schemaSha256: string
  humanResearchProtocolSha256: string
  buildTreeSha: string
}

export type AutomaticEvidenceValidation = {
  status: "pass" | "fail" | "incomplete" | "invalid"
  packageSha256: string | null
  missing: string[]
  failures: string[]
  errors: string[]
  coveredTaskIds: string[]
  coveredCriterionIds: string[]
  trustedReleaseCandidateScreenshots: TrustedReleaseCandidateScreenshots | null
  trustedReleaseCandidateHR01Stimuli: TrustedReleaseCandidateHR01Stimuli | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sameValues(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item))
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  return sameValues(Object.keys(value), expected)
}

function validDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function confinedRelativePath(value: unknown) {
  return (
    typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..")
  )
}

function runGit(args: string[], cwd = root) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`)
  return result.stdout.toString()
}

async function resolveConfinedFile(base: string, relativePath: string) {
  const baseRealPath = await fs.realpath(base)
  const absolutePath = path.resolve(base, relativePath)
  if (!absolutePath.startsWith(`${path.resolve(base)}${path.sep}`)) return null
  const realPath = await fs.realpath(absolutePath).catch(() => null)
  if (!realPath || !realPath.startsWith(`${baseRealPath}${path.sep}`)) return null
  return realPath
}

function validateRequirements(value: unknown) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "id",
      "version",
      "gate",
      "requiredTaskIds",
      "isolation",
      "commands",
      "tasks",
    ]) ||
    value.schemaVersion !== 1 ||
    value.id !== "agent-company-r0-automatic-evidence-requirements" ||
    value.version !== "1.3.0" ||
    value.gate !== "R0" ||
    !Array.isArray(value.requiredTaskIds) ||
    !value.requiredTaskIds.every((item) => typeof item === "string") ||
    !sameValues(value.requiredTaskIds, [...requiredR0TaskIDs]) ||
    !isRecord(value.isolation) ||
    !exactKeys(value.isolation, ["mode", "requiredEnvironment", "liveDatabaseAllowed"]) ||
    value.isolation.mode !== "detached_exact_commit_worktree" ||
    !Array.isArray(value.isolation.requiredEnvironment) ||
    !value.isolation.requiredEnvironment.every((item) => typeof item === "string") ||
    !sameValues(value.isolation.requiredEnvironment, requiredIsolationEnvironment) ||
    value.isolation.liveDatabaseAllowed !== false ||
    !Array.isArray(value.commands) ||
    !Array.isArray(value.tasks)
  ) {
    throw new Error("Automatic evidence requirements are structurally invalid.")
  }
  const commandIDs: string[] = []
  value.commands.forEach((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["id", "cwd", "argv", "timeoutMs", "stdoutValidator", "environment", "reports"]) ||
      typeof item.id !== "string" ||
      !confinedRelativePath(item.cwd === "." ? "root" : item.cwd) ||
      !Array.isArray(item.argv) ||
      !item.argv.length ||
      !item.argv.every((argument) => typeof argument === "string") ||
      !["bun", "git"].includes(String(item.argv[0])) ||
      typeof item.timeoutMs !== "number" ||
      !Number.isInteger(item.timeoutMs) ||
      item.timeoutMs < 1000 ||
      !["none", "json_pass"].includes(String(item.stdoutValidator)) ||
      !isRecord(item.environment) ||
      !Object.values(item.environment).every((entry) => typeof entry === "string") ||
      !Object.keys(item.environment).every((key) => requirementEnvironmentAllowlist.has(key)) ||
      !Array.isArray(item.reports) ||
      !item.reports.every(
        (report) =>
          isRecord(report) &&
          exactKeys(report, ["path", "validator"]) &&
          confinedRelativePath(report.path) &&
          ["junit", "r0_branch_coverage", "artifact"].includes(String(report.validator)),
      )
    ) {
      throw new Error("Automatic evidence command requirements are invalid.")
    }
    commandIDs.push(item.id)
  })
  if (new Set(commandIDs).size !== commandIDs.length) throw new Error("Automatic evidence command IDs must be unique.")
  const taskIDs: string[] = []
  const criterionIDs: string[] = []
  const referencedCommands = new Set<string>()
  value.tasks.forEach((task) => {
    if (
      !isRecord(task) ||
      !exactKeys(task, ["id", "criteria"]) ||
      typeof task.id !== "string" ||
      !requiredR0TaskIDs.includes(task.id as (typeof requiredR0TaskIDs)[number]) ||
      !Array.isArray(task.criteria) ||
      !task.criteria.length
    ) {
      throw new Error("Automatic evidence task requirements are invalid.")
    }
    taskIDs.push(task.id)
    task.criteria.forEach((criterion) => {
      if (
        !isRecord(criterion) ||
        !exactKeys(criterion, ["id", "evidenceRefs"]) ||
        typeof criterion.id !== "string" ||
        !Array.isArray(criterion.evidenceRefs) ||
        !criterion.evidenceRefs.length ||
        !criterion.evidenceRefs.every(
          (reference) =>
            reference === "runner" ||
            (typeof reference === "string" &&
              reference.startsWith("command:") &&
              commandIDs.includes(reference.slice("command:".length))),
        )
      ) {
        throw new Error("Automatic evidence criterion requirements are invalid.")
      }
      criterionIDs.push(criterion.id)
      criterion.evidenceRefs
        .filter((reference): reference is string => typeof reference === "string" && reference.startsWith("command:"))
        .forEach((reference) => referencedCommands.add(reference.slice("command:".length)))
    })
  })
  if (
    !sameValues(taskIDs, [...requiredR0TaskIDs]) ||
    new Set(taskIDs).size !== taskIDs.length ||
    new Set(criterionIDs).size !== criterionIDs.length ||
    !sameValues([...referencedCommands], commandIDs)
  ) {
    throw new Error("Automatic evidence coverage must uniquely bind every R0 task, criterion, and command.")
  }
  return value as unknown as AutomaticEvidenceRequirements
}

async function currentGovernance(buildTreeSha: string) {
  const [requirementsSource, schemaSource, humanResearchProtocolSource] = await Promise.all([
    Bun.file(path.join(root, automaticEvidenceRequirementsRelativePath)).text(),
    Bun.file(path.join(root, automaticEvidenceSchemaRelativePath)).text(),
    Bun.file(path.join(root, humanResearchProtocolRelativePath)).text(),
  ])
  return {
    requirements: validateRequirements(JSON.parse(requirementsSource)),
    requirementsSource,
    requirementsSha256: sha256(requirementsSource),
    schemaSource,
    schemaSha256: sha256(schemaSource),
    humanResearchProtocolSha256: sha256(humanResearchProtocolSource),
    buildTreeSha,
  }
}

export async function loadAutomaticEvidenceGovernance(buildSha: string) {
  verifyExactCommit(buildSha)
  const requirementsSource = runGit(["show", `${buildSha}:${automaticEvidenceRequirementsRelativePath}`])
  const schemaSource = runGit(["show", `${buildSha}:${automaticEvidenceSchemaRelativePath}`])
  const humanResearchProtocolSource = runGit(["show", `${buildSha}:${humanResearchProtocolRelativePath}`])
  const current = await currentGovernance(runGit(["show", "-s", "--format=%T", buildSha]).trim())
  if (
    sha256(requirementsSource) !== current.requirementsSha256 ||
    sha256(schemaSource) !== current.schemaSha256 ||
    sha256(humanResearchProtocolSource) !== current.humanResearchProtocolSha256
  ) {
    throw new Error("Gate governance files differ from the exact build commit.")
  }
  return {
    ...current,
    requirements: validateRequirements(JSON.parse(requirementsSource)),
    requirementsSource,
    requirementsSha256: sha256(requirementsSource),
    schemaSource,
    schemaSha256: sha256(schemaSource),
    humanResearchProtocolSha256: sha256(humanResearchProtocolSource),
  }
}

function parseTrailingJson(source: string) {
  const starts = [...source.matchAll(/(?:^|\n)\s*\{/g)].map((match) => (match.index ?? 0) + match[0].lastIndexOf("{"))
  for (const start of starts.reverse()) {
    try {
      const value: unknown = JSON.parse(source.slice(start))
      if (isRecord(value)) return value
    } catch {
      continue
    }
  }
  return null
}

function stdoutSummary(
  validator: RequirementCommand["stdoutValidator"],
  source: string,
  commandId?: string,
  buildSha?: string,
) {
  if (validator === "none") return { valid: true, summary: null }
  const value = parseTrailingJson(source)
  const field = value?.result === "pass" ? "result" : value?.status === "pass" ? "status" : null
  const candidateShaMatches =
    commandId !== "seed-grow-real-surfaces" || (typeof buildSha === "string" && value?.candidateSha === buildSha)
  return {
    valid: Boolean(field) && candidateShaMatches,
    summary: field
      ? {
          kind: "json_pass",
          field,
          value: "pass",
          ...(commandId === "seed-grow-real-surfaces" ? { candidateShaMatches } : {}),
        }
      : { kind: "json_pass", field: null, value: null },
  }
}

function numberAttribute(source: string, attribute: string) {
  const value = source.match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1]
  return value === undefined ? 0 : Number(value)
}

function reportMediaType(report: RequirementReport) {
  if (report.validator === "junit") return "application/xml"
  if (report.validator === "r0_branch_coverage" || report.path.endsWith(".json")) return "application/json"
  if (report.path.endsWith(".png")) return "image/png"
  return "application/octet-stream"
}

async function reportSummary(
  validator: RequirementReport["validator"],
  bytes: Uint8Array,
  sourcePath: string,
) {
  const source = new TextDecoder().decode(bytes)
  if (validator === "junit") {
    const rootTag = source.match(/<testsuites\b[^>]*>/)?.[0]
    const summary = rootTag
      ? {
          validator,
          tests: numberAttribute(rootTag, "tests"),
          failures: numberAttribute(rootTag, "failures"),
          errors: numberAttribute(rootTag, "errors"),
          skipped: numberAttribute(rootTag, "skipped"),
        }
      : { validator, tests: 0, failures: 0, errors: 0, skipped: 0 }
    return {
      valid: Boolean(rootTag) && summary.tests > 0 && summary.failures === 0 && summary.errors === 0,
      summary,
    }
  }
  if (validator === "artifact") {
    if (sourcePath.endsWith(".png")) {
      const image = await sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 })
        .toBuffer({ resolveWithObject: true })
        .catch(() => null)
      const summary = {
        validator,
        kind: "png",
        width: image?.info.width ?? null,
        height: image?.info.height ?? null,
      }
      return {
        valid:
          image?.info.format === "png" &&
          typeof image.info.width === "number" &&
          image.info.width >= 390 &&
          typeof image.info.height === "number" &&
          image.info.height >= 720,
        summary,
      }
    }
    const value = await Promise.resolve()
      .then(() => JSON.parse(source) as unknown)
      .catch(() => null)
    return {
      valid: isRecord(value),
      summary: {
        validator,
        kind: "json",
      },
    }
  }
  try {
    const value: unknown = JSON.parse(source)
    if (!isRecord(value) || typeof value.threshold !== "number" || !Array.isArray(value.results)) {
      return { valid: false, summary: { validator, targets: 0, threshold: null, minimumPercent: null } }
    }
    const percentages = value.results.flatMap((item) =>
      isRecord(item) && typeof item.percent === "number" ? [item.percent] : [],
    )
    const summary = {
      validator,
      targets: percentages.length,
      threshold: value.threshold,
      minimumPercent: percentages.length ? Math.min(...percentages) : null,
    }
    return {
      valid:
        percentages.length >= 7 &&
        percentages.length === value.results.length &&
        percentages.every((percent) => percent >= value.threshold),
      summary,
    }
  } catch {
    return { valid: false, summary: { validator, targets: 0, threshold: null, minimumPercent: null } }
  }
}

async function validateFileEvidence(
  base: string,
  value: unknown,
  expectedMediaType: string,
  label: string,
  errors: string[],
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["relativePath", "sha256", "byteLength", "mediaType"]) ||
    !confinedRelativePath(value.relativePath) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.byteLength !== "number" ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.mediaType !== expectedMediaType
  ) {
    errors.push(`${label}: invalid file binding`)
    return null
  }
  const file = await resolveConfinedFile(base, value.relativePath)
  const stat = await fs.lstat(path.resolve(base, value.relativePath)).catch(() => null)
  const bytes = file ? new Uint8Array(await Bun.file(file).arrayBuffer()) : null
  if (
    !file ||
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !bytes ||
    bytes.byteLength !== value.byteLength ||
    sha256(bytes) !== value.sha256
  ) {
    errors.push(`${label}: missing, escaped, or digest-mismatched file`)
    return null
  }
  return {
    file,
    bytes,
    source: new TextDecoder().decode(bytes),
  }
}

type ReleaseCandidateManifest = {
  schemaVersion: number
  buildSha: string
  relativePathBase: string
  viewport: {
    width: number
    height: number
  }
  screenshots: Array<{
    surface: string
    relativePath: string
    sha256: string
  }>
}

async function parseReleaseCandidateManifest(source: string, buildSha: string) {
  const value = await Promise.resolve()
    .then(() => JSON.parse(source) as unknown)
    .catch(() => null)
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "buildSha", "relativePathBase", "viewport", "screenshots"]) ||
    value.schemaVersion !== 1 ||
    value.buildSha !== buildSha ||
    value.relativePathBase !== "build-artifact-root" ||
    !isRecord(value.viewport) ||
    !exactKeys(value.viewport, ["width", "height"]) ||
    value.viewport.width !== 1440 ||
    value.viewport.height !== 1600 ||
    !Array.isArray(value.screenshots) ||
    value.screenshots.length !== releaseCandidateSurfaces.length
  ) {
    throw new Error("Release-candidate screenshot manifest is structurally invalid.")
  }
  value.screenshots.forEach((screenshot, index) => {
    const surface = releaseCandidateSurfaces[index]!
    if (
      !isRecord(screenshot) ||
      !exactKeys(screenshot, ["surface", "relativePath", "sha256"]) ||
      screenshot.surface !== surface ||
      screenshot.relativePath !== `human-review/screenshots/${surface.toLowerCase().replaceAll(" ", "-")}.png` ||
      typeof screenshot.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(screenshot.sha256)
    ) {
      throw new Error(`Release-candidate screenshot manifest entry ${index + 1} is invalid.`)
    }
  })
  return value as unknown as ReleaseCandidateManifest
}

async function inspectReleaseCandidatePng(bytes: Uint8Array, label: string) {
  const image = await sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => null)
  if (
    image?.info.format !== "png" ||
    image.info.width < releaseCandidateScreenshotMinimum.width ||
    image.info.height < releaseCandidateScreenshotMinimum.height
  ) {
    throw new Error(`${label} is not a valid release-candidate PNG.`)
  }
}

async function collectReleaseCandidateScreenshots(worktree: string, outputDirectory: string, buildSha: string) {
  const sourceBase = path.join(worktree, ".artifacts/experience-refactor", buildSha)
  const manifestPath = await resolveConfinedFile(sourceBase, releaseCandidateManifestSourceRelativePath)
  const manifestStat = await fs
    .lstat(path.resolve(sourceBase, releaseCandidateManifestSourceRelativePath))
    .catch(() => null)
  if (!manifestPath || !manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Release-candidate screenshot manifest is missing, escaped, or not a regular file.")
  }
  const manifestBytes = new Uint8Array(await Bun.file(manifestPath).arrayBuffer())
  const manifest = await parseReleaseCandidateManifest(new TextDecoder().decode(manifestBytes), buildSha)
  const screenshots = await Promise.all(
    manifest.screenshots.map(async (screenshot) => {
      const sourcePath = await resolveConfinedFile(sourceBase, screenshot.relativePath)
      const sourceStat = await fs.lstat(path.resolve(sourceBase, screenshot.relativePath)).catch(() => null)
      if (!sourcePath || !sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(
          `${screenshot.surface} release-candidate screenshot is missing, escaped, or not a regular file.`,
        )
      }
      const bytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
      if (sha256(bytes) !== screenshot.sha256) {
        throw new Error(`${screenshot.surface} release-candidate screenshot digest does not match its manifest.`)
      }
      await inspectReleaseCandidatePng(bytes, `${screenshot.surface} release-candidate screenshot`)
      return {
        surface: screenshot.surface,
        sourceRelativePath: screenshot.relativePath,
        bytes,
      }
    }),
  )
  if (
    new Set(screenshots.map((screenshot) => screenshot.sourceRelativePath)).size !== releaseCandidateSurfaces.length
  ) {
    throw new Error("Release-candidate screenshot source paths must be unique.")
  }
  if (new Set(screenshots.map((screenshot) => sha256(screenshot.bytes))).size !== releaseCandidateSurfaces.length) {
    throw new Error("Release-candidate screenshot contents must be unique.")
  }
  const archivedScreenshots = await Promise.all(
    screenshots.map(async (screenshot) => ({
      surface: screenshot.surface,
      sourceRelativePath: screenshot.sourceRelativePath,
      file: await writeEvidenceFile(
        outputDirectory,
        path.posix.join(
          releaseCandidateArchiveDirectory,
          "screenshots",
          path.posix.basename(screenshot.sourceRelativePath),
        ),
        screenshot.bytes,
        "image/png",
      ),
    })),
  )
  return {
    generatorCommandId: releaseCandidateGeneratorCommandId,
    buildSha,
    manifest: await writeEvidenceFile(
      outputDirectory,
      path.posix.join(releaseCandidateArchiveDirectory, "screenshots-manifest.json"),
      manifestBytes,
      "application/json",
    ),
    screenshots: archivedScreenshots,
  } satisfies ReleaseCandidateScreenshotsEvidence
}

async function validateReleaseCandidateScreenshotsEvidence(
  base: string,
  value: unknown,
  buildSha: string,
  errors: string[],
) {
  const errorCount = errors.length
  if (
    !isRecord(value) ||
    !exactKeys(value, ["generatorCommandId", "buildSha", "manifest", "screenshots"]) ||
    value.generatorCommandId !== releaseCandidateGeneratorCommandId ||
    value.buildSha !== buildSha ||
    !Array.isArray(value.screenshots) ||
    value.screenshots.length !== releaseCandidateSurfaces.length
  ) {
    errors.push("automatic evidence release-candidate screenshots: invalid top-level binding")
    return null
  }
  const manifestFile = await validateFileEvidence(
    base,
    value.manifest,
    "application/json",
    "release-candidate screenshot manifest",
    errors,
  )
  if (
    !isRecord(value.manifest) ||
    value.manifest.relativePath !== path.posix.join(releaseCandidateArchiveDirectory, "screenshots-manifest.json")
  ) {
    errors.push("automatic evidence release-candidate screenshots: unexpected manifest archive path")
  }
  const manifest = manifestFile
    ? await parseReleaseCandidateManifest(manifestFile.source, buildSha).catch(() => null)
    : null
  if (!manifest) errors.push("automatic evidence release-candidate screenshots: invalid manifest content")
  const screenshots: TrustedReleaseCandidateScreenshots["screenshots"] = []
  for (const [index, evidence] of value.screenshots.entries()) {
    const manifestScreenshot = manifest?.screenshots[index]
    const expectedSurface = releaseCandidateSurfaces[index]!
    if (
      !isRecord(evidence) ||
      !exactKeys(evidence, ["surface", "sourceRelativePath", "file"]) ||
      evidence.surface !== expectedSurface ||
      evidence.sourceRelativePath !== manifestScreenshot?.relativePath
    ) {
      errors.push(`automatic evidence release-candidate screenshot ${index + 1}: invalid identity or source path`)
      continue
    }
    const file = await validateFileEvidence(
      base,
      evidence.file,
      "image/png",
      `${expectedSurface} release-candidate screenshot`,
      errors,
    )
    if (
      !isRecord(evidence.file) ||
      evidence.file.relativePath !==
        path.posix.join(
          releaseCandidateArchiveDirectory,
          "screenshots",
          `${expectedSurface.toLowerCase().replaceAll(" ", "-")}.png`,
        ) ||
      evidence.file.sha256 !== manifestScreenshot?.sha256
    ) {
      errors.push(`automatic evidence ${expectedSurface}: screenshot archive path or manifest digest mismatch`)
    }
    if (file) {
      const validImage = await inspectReleaseCandidatePng(
        file.bytes,
        `${expectedSurface} release-candidate screenshot`,
      ).then(
        () => true,
        () => false,
      )
      if (!validImage) errors.push(`automatic evidence ${expectedSurface}: invalid release-candidate PNG`)
    }
    screenshots.push({
      surface: expectedSurface,
      relativePath: String(evidence.sourceRelativePath),
      sha256: isRecord(evidence.file) ? String(evidence.file.sha256) : "",
    })
  }
  if (
    new Set(
      value.screenshots.flatMap((evidence) =>
        isRecord(evidence) && typeof evidence.sourceRelativePath === "string" ? [evidence.sourceRelativePath] : [],
      ),
    ).size !== releaseCandidateSurfaces.length
  ) {
    errors.push("automatic evidence release-candidate screenshot source paths must be unique")
  }
  if (
    new Set(
      value.screenshots.flatMap((evidence) =>
        isRecord(evidence) && isRecord(evidence.file) && typeof evidence.file.relativePath === "string"
          ? [evidence.file.relativePath]
          : [],
      ),
    ).size !== releaseCandidateSurfaces.length
  ) {
    errors.push("automatic evidence release-candidate screenshot archive paths must be unique")
  }
  if (
    new Set(
      value.screenshots.flatMap((evidence) =>
        isRecord(evidence) && isRecord(evidence.file) && typeof evidence.file.sha256 === "string"
          ? [evidence.file.sha256]
          : [],
      ),
    ).size !== releaseCandidateSurfaces.length
  ) {
    errors.push("automatic evidence release-candidate screenshot contents must be unique")
  }
  if (errors.length !== errorCount || !manifest || !manifestFile) return null
  return {
    buildSha,
    manifestSha256: isRecord(value.manifest) ? String(value.manifest.sha256) : "",
    viewport: manifest.viewport,
    screenshots,
  } satisfies TrustedReleaseCandidateScreenshots
}

type ReleaseCandidateHR01Manifest = {
  schemaVersion: number
  buildSha: string
  protocol: {
    id: string
    version: string
    sha256: string
    studyId: string
    moderatorScriptVersion: string
  }
  presentation: string
  exactPrompt: string
  stateLabelHidden: boolean
  relativePathBase: string
  viewport: {
    width: number
    height: number
  }
  stimuli: Array<{
    promptId: string
    stateId: string
    relativePath: string
    sha256: string
  }>
}

async function parseReleaseCandidateHR01Manifest(source: string, buildSha: string, protocolSha256: string) {
  const value = await Promise.resolve()
    .then(() => JSON.parse(source) as unknown)
    .catch(() => null)
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "buildSha",
      "protocol",
      "presentation",
      "exactPrompt",
      "stateLabelHidden",
      "relativePathBase",
      "viewport",
      "stimuli",
    ]) ||
    value.schemaVersion !== 1 ||
    value.buildSha !== buildSha ||
    !isRecord(value.protocol) ||
    !exactKeys(value.protocol, ["id", "version", "sha256", "studyId", "moderatorScriptVersion"]) ||
    value.protocol.id !== "agent-company-r0-human-research" ||
    value.protocol.version !== "1.0.0" ||
    value.protocol.sha256 !== protocolSha256 ||
    value.protocol.studyId !== "HR-01" ||
    value.protocol.moderatorScriptVersion !== "HR01-v1" ||
    value.presentation !== releaseCandidateHR01Presentation ||
    value.exactPrompt !== releaseCandidateHR01ExactPrompt ||
    value.stateLabelHidden !== true ||
    value.relativePathBase !== "build-artifact-root" ||
    !isRecord(value.viewport) ||
    !exactKeys(value.viewport, ["width", "height"]) ||
    value.viewport.width !== 1440 ||
    value.viewport.height !== 1600 ||
    !Array.isArray(value.stimuli) ||
    value.stimuli.length !== releaseCandidateHR01States.length
  ) {
    throw new Error("Release-candidate HR-01 stimulus manifest is structurally invalid.")
  }
  value.stimuli.forEach((stimulus, index) => {
    const [promptId, stateId] = releaseCandidateHR01States[index]!
    if (
      !isRecord(stimulus) ||
      !exactKeys(stimulus, ["promptId", "stateId", "relativePath", "sha256"]) ||
      stimulus.promptId !== promptId ||
      stimulus.stateId !== stateId ||
      stimulus.relativePath !== `human-review/hr01-state-cards/${promptId}.png` ||
      typeof stimulus.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(stimulus.sha256)
    ) {
      throw new Error(`Release-candidate HR-01 stimulus manifest entry ${index + 1} is invalid.`)
    }
  })
  return value as unknown as ReleaseCandidateHR01Manifest
}

async function inspectReleaseCandidateHR01Png(bytes: Uint8Array, label: string) {
  const image = await sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => null)
  if (
    image?.info.format !== "png" ||
    image.info.width < releaseCandidateHR01StimulusMinimum.width ||
    image.info.height < releaseCandidateHR01StimulusMinimum.height
  ) {
    throw new Error(`${label} is not a valid release-candidate HR-01 PNG.`)
  }
}

async function collectReleaseCandidateHR01Stimuli(
  worktree: string,
  outputDirectory: string,
  buildSha: string,
  protocolSha256: string,
) {
  const sourceBase = path.join(worktree, ".artifacts/experience-refactor", buildSha)
  const manifestPath = await resolveConfinedFile(sourceBase, releaseCandidateHR01ManifestSourceRelativePath)
  const manifestStat = await fs
    .lstat(path.resolve(sourceBase, releaseCandidateHR01ManifestSourceRelativePath))
    .catch(() => null)
  if (!manifestPath || !manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Release-candidate HR-01 stimulus manifest is missing, escaped, or not a regular file.")
  }
  const manifestBytes = new Uint8Array(await Bun.file(manifestPath).arrayBuffer())
  const manifest = await parseReleaseCandidateHR01Manifest(
    new TextDecoder().decode(manifestBytes),
    buildSha,
    protocolSha256,
  )
  const stimuli = await Promise.all(
    manifest.stimuli.map(async (stimulus) => {
      const sourcePath = await resolveConfinedFile(sourceBase, stimulus.relativePath)
      const sourceStat = await fs.lstat(path.resolve(sourceBase, stimulus.relativePath)).catch(() => null)
      if (!sourcePath || !sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(
          `${stimulus.promptId} release-candidate HR-01 stimulus is missing, escaped, or not a regular file.`,
        )
      }
      const bytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
      if (sha256(bytes) !== stimulus.sha256) {
        throw new Error(`${stimulus.promptId} release-candidate HR-01 stimulus digest does not match its manifest.`)
      }
      await inspectReleaseCandidateHR01Png(bytes, `${stimulus.promptId} release-candidate HR-01 stimulus`)
      return {
        promptId: stimulus.promptId,
        stateId: stimulus.stateId,
        sourceRelativePath: stimulus.relativePath,
        bytes,
      }
    }),
  )
  if (new Set(stimuli.map((stimulus) => stimulus.sourceRelativePath)).size !== releaseCandidateHR01States.length) {
    throw new Error("Release-candidate HR-01 stimulus source paths must be unique.")
  }
  if (new Set(stimuli.map((stimulus) => sha256(stimulus.bytes))).size !== releaseCandidateHR01States.length) {
    throw new Error("Release-candidate HR-01 stimulus contents must be unique.")
  }
  return {
    generatorCommandId: releaseCandidateGeneratorCommandId,
    buildSha,
    manifest: await writeEvidenceFile(
      outputDirectory,
      path.posix.join(releaseCandidateHR01ArchiveDirectory, "stimuli-manifest.json"),
      manifestBytes,
      "application/json",
    ),
    stimuli: await Promise.all(
      stimuli.map(async (stimulus) => ({
        promptId: stimulus.promptId,
        stateId: stimulus.stateId,
        sourceRelativePath: stimulus.sourceRelativePath,
        file: await writeEvidenceFile(
          outputDirectory,
          path.posix.join(
            releaseCandidateHR01ArchiveDirectory,
            "hr01-state-cards",
            path.posix.basename(stimulus.sourceRelativePath),
          ),
          stimulus.bytes,
          "image/png",
        ),
      })),
    ),
  } satisfies ReleaseCandidateHR01StimuliEvidence
}

async function validateReleaseCandidateHR01StimuliEvidence(
  base: string,
  value: unknown,
  buildSha: string,
  protocolSha256: string,
  errors: string[],
) {
  const errorCount = errors.length
  if (
    !isRecord(value) ||
    !exactKeys(value, ["generatorCommandId", "buildSha", "manifest", "stimuli"]) ||
    value.generatorCommandId !== releaseCandidateGeneratorCommandId ||
    value.buildSha !== buildSha ||
    !Array.isArray(value.stimuli) ||
    value.stimuli.length !== releaseCandidateHR01States.length
  ) {
    errors.push("automatic evidence release-candidate HR-01 stimuli: invalid top-level binding")
    return null
  }
  const manifestFile = await validateFileEvidence(
    base,
    value.manifest,
    "application/json",
    "release-candidate HR-01 stimulus manifest",
    errors,
  )
  if (
    !isRecord(value.manifest) ||
    value.manifest.relativePath !== path.posix.join(releaseCandidateHR01ArchiveDirectory, "stimuli-manifest.json")
  ) {
    errors.push("automatic evidence release-candidate HR-01 stimuli: unexpected manifest archive path")
  }
  const manifest = manifestFile
    ? await parseReleaseCandidateHR01Manifest(manifestFile.source, buildSha, protocolSha256).catch(() => null)
    : null
  if (!manifest) errors.push("automatic evidence release-candidate HR-01 stimuli: invalid manifest content")
  const stimuli: TrustedReleaseCandidateHR01Stimuli["stimuli"] = []
  for (const [index, evidence] of value.stimuli.entries()) {
    const manifestStimulus = manifest?.stimuli[index]
    const [expectedPromptId, expectedStateId] = releaseCandidateHR01States[index]!
    if (
      !isRecord(evidence) ||
      !exactKeys(evidence, ["promptId", "stateId", "sourceRelativePath", "file"]) ||
      evidence.promptId !== expectedPromptId ||
      evidence.stateId !== expectedStateId ||
      evidence.sourceRelativePath !== manifestStimulus?.relativePath
    ) {
      errors.push(`automatic evidence release-candidate HR-01 stimulus ${index + 1}: invalid identity or source path`)
      continue
    }
    const file = await validateFileEvidence(
      base,
      evidence.file,
      "image/png",
      `${expectedPromptId} release-candidate HR-01 stimulus`,
      errors,
    )
    if (
      !isRecord(evidence.file) ||
      evidence.file.relativePath !==
        path.posix.join(releaseCandidateHR01ArchiveDirectory, "hr01-state-cards", `${expectedPromptId}.png`) ||
      evidence.file.sha256 !== manifestStimulus?.sha256
    ) {
      errors.push(`automatic evidence ${expectedPromptId}: HR-01 archive path or manifest digest mismatch`)
    }
    if (file) {
      const validImage = await inspectReleaseCandidateHR01Png(
        file.bytes,
        `${expectedPromptId} release-candidate HR-01 stimulus`,
      ).then(
        () => true,
        () => false,
      )
      if (!validImage) errors.push(`automatic evidence ${expectedPromptId}: invalid release-candidate HR-01 PNG`)
    }
    stimuli.push({
      promptId: expectedPromptId,
      stateId: expectedStateId,
      relativePath: String(evidence.sourceRelativePath),
      sha256: isRecord(evidence.file) ? String(evidence.file.sha256) : "",
    })
  }
  if (
    new Set(
      value.stimuli.flatMap((evidence) =>
        isRecord(evidence) && typeof evidence.sourceRelativePath === "string" ? [evidence.sourceRelativePath] : [],
      ),
    ).size !== releaseCandidateHR01States.length
  ) {
    errors.push("automatic evidence release-candidate HR-01 stimulus source paths must be unique")
  }
  if (
    new Set(
      value.stimuli.flatMap((evidence) =>
        isRecord(evidence) && isRecord(evidence.file) && typeof evidence.file.relativePath === "string"
          ? [evidence.file.relativePath]
          : [],
      ),
    ).size !== releaseCandidateHR01States.length
  ) {
    errors.push("automatic evidence release-candidate HR-01 stimulus archive paths must be unique")
  }
  if (
    new Set(
      value.stimuli.flatMap((evidence) =>
        isRecord(evidence) && isRecord(evidence.file) && typeof evidence.file.sha256 === "string"
          ? [evidence.file.sha256]
          : [],
      ),
    ).size !== releaseCandidateHR01States.length
  ) {
    errors.push("automatic evidence release-candidate HR-01 stimulus contents must be unique")
  }
  if (errors.length !== errorCount || !manifest || !manifestFile) return null
  return {
    buildSha,
    manifestSha256: isRecord(value.manifest) ? String(value.manifest.sha256) : "",
    viewport: manifest.viewport,
    stimuli,
  } satisfies TrustedReleaseCandidateHR01Stimuli
}

function expectedCoverage(requirements: AutomaticEvidenceRequirements) {
  return requirements.tasks.map((task) => ({
    taskId: task.id,
    criteria: task.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidenceRefs: criterion.evidenceRefs,
    })),
  }))
}

export async function validateAutomaticEvidencePackage(options: {
  packagePath: string
  buildSha: string
  runnerSha256: string
  governance?: AutomaticEvidenceGovernance
  packageSource?: string
  allowStructuralFixture?: boolean
}): Promise<AutomaticEvidenceValidation> {
  const errors: string[] = []
  const failures: string[] = []
  const missing: string[] = []
  const file = path.resolve(options.packagePath)
  const source =
    options.packageSource ??
    (await Bun.file(file)
      .text()
      .catch(() => null))
  if (!source) {
    return {
      status: "incomplete",
      packageSha256: null,
      missing: ["AUTOMATIC-EVIDENCE-PACKAGE"],
      failures,
      errors,
      coveredTaskIds: [],
      coveredCriterionIds: [],
      trustedReleaseCandidateScreenshots: null,
      trustedReleaseCandidateHR01Stimuli: null,
    }
  }
  const parsed = await Promise.resolve()
    .then(() => JSON.parse(source) as unknown)
    .catch(() => null)
  if (!isRecord(parsed) || !exactKeys(parsed, packageKeys)) {
    return {
      status: "invalid",
      packageSha256: sha256(source),
      missing,
      failures,
      errors: ["automatic evidence package: invalid JSON or top-level shape"],
      coveredTaskIds: [],
      coveredCriterionIds: [],
      trustedReleaseCandidateScreenshots: null,
      trustedReleaseCandidateHR01Stimuli: null,
    }
  }
  const governance = options.governance ?? (await loadAutomaticEvidenceGovernance(options.buildSha))
  if (
    parsed.schemaVersion !== 1 ||
    parsed.packageVersion !== "1.3.0" ||
    typeof parsed.packageId !== "string" ||
    !/^R0-AUTO-[a-f0-9]{12,40}$/.test(parsed.packageId) ||
    parsed.gate !== "R0" ||
    parsed.buildSha !== options.buildSha ||
    parsed.buildTreeSha !== governance.buildTreeSha ||
    !validDate(parsed.createdAt)
  ) {
    errors.push("automatic evidence package: build, version, identity, or timestamp mismatch")
  }
  for (const [label, binding, expectedPath, expectedDigest] of [
    [
      "requirements",
      parsed.requirementsBinding,
      automaticEvidenceRequirementsRelativePath,
      governance.requirementsSha256,
    ],
    ["schema", parsed.schemaBinding, automaticEvidenceSchemaRelativePath, governance.schemaSha256],
  ] as const) {
    if (
      !isRecord(binding) ||
      !exactKeys(binding, ["path", "sha256"]) ||
      binding.path !== expectedPath ||
      binding.sha256 !== expectedDigest
    ) {
      errors.push(`automatic evidence package: ${label} binding mismatch`)
    }
  }
  if (
    !isRecord(parsed.runnerBinding) ||
    !exactKeys(parsed.runnerBinding, ["buildSha", "sha256"]) ||
    parsed.runnerBinding.buildSha !== options.buildSha ||
    parsed.runnerBinding.sha256 !== options.runnerSha256
  ) {
    errors.push("automatic evidence package: runner binding mismatch")
  }
  if (
    !isRecord(parsed.provenance) ||
    !exactKeys(parsed.provenance, ["kind", "worktreeHead"]) ||
    !["executed", "structural_fixture"].includes(String(parsed.provenance.kind)) ||
    (parsed.provenance.kind === "executed" && parsed.provenance.worktreeHead !== options.buildSha) ||
    (parsed.provenance.kind === "structural_fixture" && parsed.provenance.worktreeHead !== null)
  ) {
    errors.push("automatic evidence package: execution provenance mismatch")
  } else if (parsed.provenance.kind === "structural_fixture" && !options.allowStructuralFixture) {
    errors.push("automatic evidence package: structural fixture is not production evidence")
  }
  if (
    !isRecord(parsed.isolation) ||
    !exactKeys(parsed.isolation, [
      "mode",
      "environment",
      "productionDataEnvironmentInherited",
      "hostPermissionIsolation",
      "networkIsolation",
      "playwright",
    ]) ||
    parsed.isolation.mode !== governance.requirements.isolation.mode ||
    !Array.isArray(parsed.isolation.environment) ||
    !parsed.isolation.environment.every((item) => typeof item === "string") ||
    !sameValues(parsed.isolation.environment, governance.requirements.isolation.requiredEnvironment) ||
    parsed.isolation.productionDataEnvironmentInherited !== false ||
    parsed.isolation.hostPermissionIsolation !== false ||
    parsed.isolation.networkIsolation !== "proxy_environment_only" ||
    !isRecord(parsed.isolation.playwright) ||
    !exactKeys(parsed.isolation.playwright, ["mode", "packageVersion", "browsersJsonSha256", "browserTreeSha256"]) ||
    parsed.isolation.playwright.mode !== "fresh_isolated_install" ||
    typeof parsed.isolation.playwright.packageVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.isolation.playwright.packageVersion) ||
    typeof parsed.isolation.playwright.browsersJsonSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.isolation.playwright.browsersJsonSha256) ||
    typeof parsed.isolation.playwright.browserTreeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.isolation.playwright.browserTreeSha256)
  ) {
    errors.push("automatic evidence package: isolation contract mismatch")
  }
  const trustedReleaseCandidateScreenshots =
    parsed.releaseCandidateScreenshots === null
      ? null
      : await validateReleaseCandidateScreenshotsEvidence(
          path.dirname(file),
          parsed.releaseCandidateScreenshots,
          options.buildSha,
          errors,
        )
  const trustedReleaseCandidateHR01Stimuli =
    parsed.releaseCandidateHR01Stimuli === null
      ? null
      : await validateReleaseCandidateHR01StimuliEvidence(
          path.dirname(file),
          parsed.releaseCandidateHR01Stimuli,
          options.buildSha,
          governance.humanResearchProtocolSha256,
          errors,
        )
  const commands = Array.isArray(parsed.commands) ? parsed.commands : []
  const commandIDs = commands.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
  const expectedCommandIDs = governance.requirements.commands.map((command) => command.id)
  expectedCommandIDs.filter((id) => !commandIDs.includes(id)).forEach((id) => missing.push(`command:${id}`))
  commandIDs
    .filter((id) => !expectedCommandIDs.includes(id))
    .forEach((id) => errors.push(`automatic evidence package: unexpected command ${id}`))
  if (new Set(commandIDs).size !== commandIDs.length) errors.push("automatic evidence package: duplicate command IDs")
  const recomputedStatuses = new Map<string, "pass" | "fail">()
  for (const requirement of governance.requirements.commands) {
    const value = commands.find((item) => isRecord(item) && item.id === requirement.id)
    if (!isRecord(value)) continue
    if (
      !exactKeys(value, commandKeys) ||
      value.cwd !== requirement.cwd ||
      canonicalize(value.argv) !== canonicalize(requirement.argv) ||
      canonicalize(value.environment) !== canonicalize(requirement.environment) ||
      !validDate(value.startedAt) ||
      !validDate(value.finishedAt) ||
      typeof value.durationMs !== "number" ||
      !Number.isInteger(value.durationMs) ||
      value.durationMs < 0 ||
      !["number", "object"].includes(typeof value.exitCode) ||
      !(typeof value.exitCode === "number" || value.exitCode === null) ||
      typeof value.timedOut !== "boolean" ||
      !["pass", "fail"].includes(String(value.status)) ||
      !Array.isArray(value.reports)
    ) {
      errors.push(`automatic evidence ${requirement.id}: malformed command record`)
      continue
    }
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      errors.push(`automatic evidence ${requirement.id}: invalid command interval`)
    }
    const stdout = await validateFileEvidence(
      path.dirname(file),
      value.stdout,
      "text/plain",
      `${requirement.id} stdout`,
      errors,
    )
    const stderr = await validateFileEvidence(
      path.dirname(file),
      value.stderr,
      "text/plain",
      `${requirement.id} stderr`,
      errors,
    )
    const stdoutResult = stdoutSummary(
      requirement.stdoutValidator,
      stdout?.source ?? "",
      requirement.id,
      options.buildSha,
    )
    if (canonicalize(value.stdoutSummary) !== canonicalize(stdoutResult.summary)) {
      errors.push(`automatic evidence ${requirement.id}: stdout summary mismatch`)
    }
    const reports = value.reports
    const sourcePaths = reports.flatMap((report) =>
      isRecord(report) && typeof report.sourcePath === "string" ? [report.sourcePath] : [],
    )
    const expectedReportPaths = requirement.reports.map((report) => report.path)
    sourcePaths
      .filter((reportPath) => !expectedReportPaths.includes(reportPath))
      .forEach((reportPath) => errors.push(`automatic evidence ${requirement.id}: unexpected report ${reportPath}`))
    if (new Set(sourcePaths).size !== sourcePaths.length) {
      errors.push(`automatic evidence ${requirement.id}: duplicate report paths`)
    }
    let reportsPass = true
    for (const requiredReport of requirement.reports) {
      const report = reports.find((item) => isRecord(item) && item.sourcePath === requiredReport.path)
      if (!isRecord(report)) {
        failures.push(`${requirement.id}: missing report ${requiredReport.path}`)
        reportsPass = false
        continue
      }
      if (
        !exactKeys(report, ["sourcePath", "validator", "file", "summary"]) ||
        report.validator !== requiredReport.validator
      ) {
        errors.push(`${requirement.id}: invalid report record ${requiredReport.path}`)
        reportsPass = false
        continue
      }
      const reportFile = await validateFileEvidence(
        path.dirname(file),
        report.file,
        reportMediaType(requiredReport),
        `${requirement.id} report ${requiredReport.path}`,
        errors,
      )
      const result = await reportSummary(
        requiredReport.validator,
        reportFile?.bytes ?? new Uint8Array(),
        requiredReport.path,
      )
      if (canonicalize(report.summary) !== canonicalize(result.summary)) {
        errors.push(`${requirement.id}: report summary mismatch ${requiredReport.path}`)
      }
      if (!result.valid) {
        failures.push(`${requirement.id}: report failed ${requiredReport.path}`)
        reportsPass = false
      }
    }
    const pass =
      value.exitCode === 0 &&
      value.timedOut === false &&
      Boolean(stdout) &&
      Boolean(stderr) &&
      stdoutResult.valid &&
      reportsPass &&
      (requirement.id !== releaseCandidateGeneratorCommandId ||
        (Boolean(trustedReleaseCandidateScreenshots) && Boolean(trustedReleaseCandidateHR01Stimuli)))
    const status = pass ? "pass" : "fail"
    recomputedStatuses.set(requirement.id, status)
    if (value.status !== status) errors.push(`automatic evidence ${requirement.id}: forged command status`)
    if (!pass && !failures.some((failure) => failure.startsWith(`${requirement.id}:`))) {
      failures.push(
        `${requirement.id}: exit=${String(value.exitCode)} timeout=${String(value.timedOut)} stdout=${String(
          stdoutResult.valid,
        )}`,
      )
    }
  }
  const releaseCandidateGeneratorStatus = recomputedStatuses.get(releaseCandidateGeneratorCommandId)
  if (parsed.releaseCandidateScreenshots !== null && releaseCandidateGeneratorStatus !== "pass") {
    errors.push("automatic evidence release-candidate screenshots: generator command did not pass")
  }
  if (parsed.releaseCandidateHR01Stimuli !== null && releaseCandidateGeneratorStatus !== "pass") {
    errors.push("automatic evidence release-candidate HR-01 stimuli: generator command did not pass")
  }
  const coverage = Array.isArray(parsed.coverage) ? parsed.coverage : []
  const taskIDs = coverage.flatMap((task) => (isRecord(task) && typeof task.taskId === "string" ? [task.taskId] : []))
  requiredR0TaskIDs.filter((taskId) => !taskIDs.includes(taskId)).forEach((taskId) => missing.push(`task:${taskId}`))
  taskIDs
    .filter((taskId) => !requiredR0TaskIDs.includes(taskId as (typeof requiredR0TaskIDs)[number]))
    .forEach((taskId) => errors.push(`automatic evidence package: unexpected task ${taskId}`))
  if (new Set(taskIDs).size !== taskIDs.length) errors.push("automatic evidence package: duplicate task coverage")
  const coveredCriterionIDs: string[] = []
  for (const task of governance.requirements.tasks) {
    const actual = coverage.find((item) => isRecord(item) && item.taskId === task.id)
    if (!isRecord(actual)) continue
    if (!exactKeys(actual, ["taskId", "criteria"]) || !Array.isArray(actual.criteria)) {
      errors.push(`automatic evidence ${task.id}: malformed task coverage`)
      continue
    }
    const criterionIDs = actual.criteria.flatMap((criterion) =>
      isRecord(criterion) && typeof criterion.criterionId === "string" ? [criterion.criterionId] : [],
    )
    task.criteria
      .filter((criterion) => !criterionIDs.includes(criterion.id))
      .forEach((criterion) => missing.push(`criterion:${criterion.id}`))
    criterionIDs
      .filter((criterionID) => !task.criteria.some((criterion) => criterion.id === criterionID))
      .forEach((criterionID) => errors.push(`automatic evidence ${task.id}: unexpected criterion ${criterionID}`))
    if (new Set(criterionIDs).size !== criterionIDs.length) {
      errors.push(`automatic evidence ${task.id}: duplicate criteria`)
    }
    for (const criterion of task.criteria) {
      const actualCriterion = actual.criteria.find((item) => isRecord(item) && item.criterionId === criterion.id)
      if (!isRecord(actualCriterion)) continue
      coveredCriterionIDs.push(criterion.id)
      if (
        !exactKeys(actualCriterion, ["criterionId", "evidenceRefs"]) ||
        !Array.isArray(actualCriterion.evidenceRefs) ||
        !actualCriterion.evidenceRefs.every((item) => typeof item === "string") ||
        canonicalize(actualCriterion.evidenceRefs) !== canonicalize(criterion.evidenceRefs)
      ) {
        errors.push(`automatic evidence ${criterion.id}: evidence reference mismatch`)
      }
    }
  }
  const expectedStatus = [...recomputedStatuses.values()].every((status) => status === "pass") ? "pass" : "fail"
  if (parsed.overallStatus !== expectedStatus) errors.push("automatic evidence package: forged overall status")
  const status = errors.length ? "invalid" : missing.length ? "incomplete" : failures.length ? "fail" : "pass"
  return {
    status,
    packageSha256: sha256(source),
    missing: [...new Set(missing)].sort(),
    failures: [...new Set(failures)].sort(),
    errors: [...new Set(errors)].sort(),
    coveredTaskIds: taskIDs.sort(),
    coveredCriterionIds: coveredCriterionIDs.sort(),
    trustedReleaseCandidateScreenshots,
    trustedReleaseCandidateHR01Stimuli,
  }
}

async function writeEvidenceFile(base: string, relativePath: string, value: string | Uint8Array, mediaType: string) {
  const file = path.join(base, relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, value)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  return {
    relativePath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  }
}

async function capture(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function executableCommand(argv: string[]) {
  return argv[0] === "bun" ? [process.execPath, "--no-orphans", ...argv.slice(1)] : argv
}

function environmentFromAllowlist(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => inheritedEnvironmentAllowlist.has(entry[0]) && entry[1] !== undefined,
    ),
  )
}

function commandIsolationDirectories(isolationRoot: string) {
  return Object.fromEntries(
    [
      ["HOME", "home"],
      ["USERPROFILE", "home"],
      ["AGENTCOMPANY_HOME", "agentcompany-home"],
      ["AGENT_COMPANY_WEBUI_DATA_DIR", "webui-data"],
      ["XDG_DATA_HOME", "xdg-data"],
      ["XDG_CONFIG_HOME", "xdg-config"],
      ["XDG_CACHE_HOME", "xdg-cache"],
      ["XDG_STATE_HOME", "xdg-state"],
      ["XDG_RUNTIME_DIR", "xdg-runtime"],
      ["TMPDIR", "temp"],
      ["TMP", "temp"],
      ["TEMP", "temp"],
      ["APPDATA", "app-data"],
      ["LOCALAPPDATA", "local-app-data"],
    ].map(([key, value]) => [key, path.join(isolationRoot, value)]),
  )
}

function commandEnvironment(
  inherited: NodeJS.ProcessEnv,
  directories: Record<string, string>,
  requirement: RequirementCommand,
  playwrightBrowsersPath: string,
) {
  return {
    ...environmentFromAllowlist(inherited),
    ...directories,
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_PURE: "1",
    NUXT_TELEMETRY_DISABLED: "1",
    CI: "1",
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    TZ: "UTC",
    USER: "agent-company-r0-evidence",
    LOGNAME: "agent-company-r0-evidence",
    ...requirement.environment,
  }
}

async function cleanIgnoredRuntimePaths(worktree: string) {
  await Promise.all(
    [
      ".artifacts",
      "packages/app/.artifacts",
      "packages/app/.r0-config-matrix-data",
      "packages/app/.nuxt-r0-config-matrix",
      "packages/control-plane/.artifacts",
      "packages/shared/.artifacts",
      "packages/sdk/js/.artifacts",
      "packages/desktop/.artifacts",
    ].map((relativePath) => fs.rm(path.join(worktree, relativePath), { recursive: true, force: true })),
  )
}

async function runCommand(
  worktree: string,
  outputDirectory: string,
  isolationRoot: string,
  requirement: RequirementCommand,
  playwrightBrowsersPath: string,
  buildSha: string,
  humanResearchProtocolSha256: string,
) {
  const commandIsolation = path.join(isolationRoot, requirement.id)
  const directories = commandIsolationDirectories(commandIsolation)
  await Promise.all(
    [...new Set(Object.values(directories))].map((directory) => fs.mkdir(directory, { recursive: true })),
  )
  await cleanIgnoredRuntimePaths(worktree)
  await Promise.all(
    requirement.reports.map(async (report) => {
      const reportPath = path.join(worktree, requirement.cwd, report.path)
      await fs.mkdir(path.dirname(reportPath), { recursive: true })
      await fs.rm(reportPath, { force: true })
    }),
  )
  const environment = commandEnvironment(process.env, directories, requirement, playwrightBrowsersPath)
  const started = Date.now()
  const child = Bun.spawn({
    cmd: executableCommand(requirement.argv),
    cwd: path.join(worktree, requirement.cwd),
    env: environment,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const signalTree = (signal: "SIGTERM" | "SIGKILL") => {
    if (process.platform === "win32") {
      if (child.exitCode === null) {
        Bun.spawn(["taskkill", "/pid", child.pid.toString(), "/t", "/f"], {
          stdout: "ignore",
          stderr: "ignore",
        })
      }
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
    }
  }
  let timedOut = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    signalTree("SIGTERM")
    forceTimer = setTimeout(() => {
      signalTree("SIGKILL")
    }, 10_000)
  }, requirement.timeoutMs)
  const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
    child.exited,
    capture(child.stdout),
    capture(child.stderr),
  ])
  clearTimeout(timer)
  if (forceTimer) clearTimeout(forceTimer)
  const releaseCandidateResult =
    requirement.id === releaseCandidateGeneratorCommandId && exitCode === 0 && !timedOut
      ? await Promise.allSettled([
          collectReleaseCandidateScreenshots(worktree, outputDirectory, buildSha),
          collectReleaseCandidateHR01Stimuli(worktree, outputDirectory, buildSha, humanResearchProtocolSha256),
        ]).then(([screenshots, hr01Stimuli]) => {
          const error = [screenshots, hr01Stimuli]
            .flatMap((result) =>
              result.status === "rejected"
                ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
                : [],
            )
            .join("; ")
          return {
            screenshots: screenshots.status === "fulfilled" && !error ? screenshots.value : null,
            hr01Stimuli: hr01Stimuli.status === "fulfilled" && !error ? hr01Stimuli.value : null,
            error: error || null,
          }
        })
      : { screenshots: null, hr01Stimuli: null, error: null }
  const collectionFailureBytes = releaseCandidateResult.error
    ? new TextEncoder().encode(
        `${stderrBytes.byteLength && !new TextDecoder().decode(stderrBytes).endsWith("\n") ? "\n" : ""}Automatic evidence collector: ${releaseCandidateResult.error}\n`,
      )
    : new Uint8Array()
  const archivedStderrBytes = new Uint8Array(stderrBytes.byteLength + collectionFailureBytes.byteLength)
  archivedStderrBytes.set(stderrBytes)
  archivedStderrBytes.set(collectionFailureBytes, stderrBytes.byteLength)
  const finished = Date.now()
  const commandDirectory = path.posix.join("files", requirement.id)
  const stdout = await writeEvidenceFile(
    outputDirectory,
    path.posix.join(commandDirectory, "stdout.log"),
    stdoutBytes,
    "text/plain",
  )
  const stderr = await writeEvidenceFile(
    outputDirectory,
    path.posix.join(commandDirectory, "stderr.log"),
    archivedStderrBytes,
    "text/plain",
  )
  const stdoutResult = stdoutSummary(
    requirement.stdoutValidator,
    new TextDecoder().decode(stdoutBytes),
    requirement.id,
    buildSha,
  )
  const reports: ReportEvidence[] = []
  let reportsPass = true
  for (const report of requirement.reports) {
    const sourceFile = path.join(worktree, requirement.cwd, report.path)
    const source = await Bun.file(sourceFile)
      .arrayBuffer()
      .then((value) => new Uint8Array(value))
      .catch(() => null)
    if (source === null) {
      reportsPass = false
      continue
    }
    const result = await reportSummary(report.validator, source, report.path)
    reportsPass = reportsPass && result.valid
    reports.push({
      sourcePath: report.path,
      validator: report.validator,
      file: await writeEvidenceFile(
        outputDirectory,
        path.posix.join(commandDirectory, "reports", path.basename(report.path)),
        source,
        reportMediaType(report),
      ),
      summary: result.summary,
    })
  }
  const status =
    exitCode === 0 &&
    !timedOut &&
    stdoutResult.valid &&
    reports.length === requirement.reports.length &&
    reportsPass &&
    (requirement.id !== releaseCandidateGeneratorCommandId ||
      (Boolean(releaseCandidateResult.screenshots) && Boolean(releaseCandidateResult.hr01Stimuli)))
      ? "pass"
      : "fail"
  await cleanIgnoredRuntimePaths(worktree)
  return {
    command: {
      id: requirement.id,
      cwd: requirement.cwd,
      argv: requirement.argv,
      environment: requirement.environment,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      exitCode,
      timedOut,
      status,
      stdout,
      stderr,
      stdoutSummary: stdoutResult.summary,
      reports,
    } satisfies CommandEvidence,
    releaseCandidateScreenshots: releaseCandidateResult.screenshots,
    releaseCandidateHR01Stimuli: releaseCandidateResult.hr01Stimuli,
  }
}

function pathIsInside(base: string, candidate: string) {
  const relative = path.relative(base, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function dependencyInstallationDirectories(isolationRoot: string) {
  return Object.fromEntries(
    [
      ["HOME", "home"],
      ["USERPROFILE", "home"],
      ["AGENTCOMPANY_HOME", "agentcompany-home"],
      ["AGENT_COMPANY_WEBUI_DATA_DIR", "webui-data"],
      ["XDG_DATA_HOME", "xdg-data"],
      ["XDG_CONFIG_HOME", "xdg-config"],
      ["XDG_CACHE_HOME", "xdg-cache"],
      ["XDG_STATE_HOME", "xdg-state"],
      ["XDG_RUNTIME_DIR", "xdg-runtime"],
      ["TMPDIR", "temp"],
      ["TMP", "temp"],
      ["TEMP", "temp"],
      ["APPDATA", "app-data"],
      ["LOCALAPPDATA", "local-app-data"],
      ["BUN_INSTALL_CACHE_DIR", "bun-cache"],
      ["BUN_INSTALL_GLOBAL_DIR", "bun-global"],
      ["BUN_INSTALL_BIN", "bun-bin"],
    ].map(([key, value]) => [key, path.join(isolationRoot, value)]),
  )
}

function dependencyInstallationEnvironment(inherited: NodeJS.ProcessEnv, directories: Record<string, string>) {
  return {
    ...environmentFromAllowlist(inherited),
    ...directories,
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
    AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
    AGENTCOMPANY_PURE: "1",
    CI: "1",
    HUSKY: "0",
    NUXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    USER: "agent-company-r0-evidence",
    LOGNAME: "agent-company-r0-evidence",
  }
}

function dependencyInstallCommand(cacheDirectory: string, frozen: boolean) {
  return [
    process.execPath,
    "install",
    ...(frozen ? ["--frozen-lockfile"] : ["--lockfile-only"]),
    "--cache-dir",
    cacheDirectory,
    "--backend",
    "copyfile",
    "--no-progress",
    "--no-summary",
  ]
}

async function runDependencyInstall(worktree: string, isolationRoot: string, frozen: boolean) {
  const directories = dependencyInstallationDirectories(isolationRoot)
  await Promise.all(
    [...new Set(Object.values(directories))].map((directory) => fs.mkdir(directory, { recursive: true })),
  )
  const [isolationRealPath, cacheRealPath, cacheStat, cacheEntries] = await Promise.all([
    fs.realpath(isolationRoot),
    fs.realpath(directories.BUN_INSTALL_CACHE_DIR!),
    fs.lstat(directories.BUN_INSTALL_CACHE_DIR!),
    fs.readdir(directories.BUN_INSTALL_CACHE_DIR!),
  ])
  if (
    cacheStat.isSymbolicLink() ||
    !cacheStat.isDirectory() ||
    !pathIsInside(isolationRealPath, cacheRealPath) ||
    cacheEntries.length
  ) {
    throw new Error("Fresh dependency installation requires an empty isolated Bun cache.")
  }
  const child = Bun.spawn({
    cmd: dependencyInstallCommand(directories.BUN_INSTALL_CACHE_DIR!, frozen),
    cwd: worktree,
    env: dependencyInstallationEnvironment(process.env, directories),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)])
  return {
    exitCode,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    directories,
  }
}

async function workspaceNodeModulesPaths(worktree: string) {
  const manifest: unknown = await Bun.file(path.join(worktree, "package.json")).json()
  const patterns = Array.isArray(isRecord(manifest) ? manifest.workspaces : undefined)
    ? manifest.workspaces
    : isRecord(manifest) && isRecord(manifest.workspaces) && Array.isArray(manifest.workspaces.packages)
      ? manifest.workspaces.packages
      : []
  if (!patterns.length || !patterns.every((item) => typeof item === "string")) {
    throw new Error("Exact-build workspace manifest does not define workspace packages.")
  }
  const packageFiles: string[] = []
  for (const pattern of patterns) {
    for await (const packageFile of new Bun.Glob(
      `${pattern.replace(/\\+$/g, "").replace(/\/+$/g, "")}/package.json`,
    ).scan({
      cwd: worktree,
      onlyFiles: true,
    })) {
      packageFiles.push(packageFile)
    }
  }
  return [
    "node_modules",
    ...[...new Set(packageFiles)].map((packageFile) => path.join(path.dirname(packageFile), "node_modules")),
  ]
}

async function assertWorkspaceLinks(worktree: string, relativePaths: string[]) {
  const worktreeRealPath = await fs.realpath(worktree)
  const workspaceLinks = (
    await Promise.all(
      relativePaths.flatMap((relativePath) =>
        ["@agents-company", "@mimo-ai"].map(async (scope) => {
          const scopeDirectory = path.join(worktree, relativePath, scope)
          const entries = await fs.readdir(scopeDirectory, { withFileTypes: true }).catch(() => [])
          return Promise.all(
            entries.map(async (entry) => {
              const link = path.join(scopeDirectory, entry.name)
              const stat = await fs.lstat(link)
              if (!stat.isSymbolicLink()) {
                throw new Error(`Workspace dependency is not linked from the exact-build worktree: ${link}`)
              }
              const resolved = await fs.realpath(link)
              return {
                relativePath: path.relative(worktree, link),
                resolved,
              }
            }),
          )
        }),
      ),
    )
  ).flat(2)
  if (!workspaceLinks.length) throw new Error("Fresh dependency installation contains no workspace links.")
  workspaceLinks.forEach((link) => {
    if (!pathIsInside(worktreeRealPath, link.resolved)) {
      throw new Error(`Workspace dependency escaped the exact-build worktree: ${link.relativePath} -> ${link.resolved}`)
    }
  })
  return workspaceLinks
}

async function assertInstalledDependencies(worktree: string, relativePaths: string[]) {
  const worktreeRealPath = await fs.realpath(worktree)
  const installedNodeModules = (
    await Promise.all(
      relativePaths.map(async (relativePath) => {
        const directory = path.join(worktree, relativePath)
        const stat = await fs.lstat(directory).catch(() => null)
        if (!stat) return null
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            `Installed node_modules must be a real directory in the exact-build worktree: ${relativePath}`,
          )
        }
        const resolved = await fs.realpath(directory)
        if (!pathIsInside(worktreeRealPath, resolved)) {
          throw new Error(`Installed node_modules escaped the exact-build worktree: ${relativePath} -> ${resolved}`)
        }
        return relativePath
      }),
    )
  ).filter((relativePath): relativePath is string => relativePath !== null)
  if (!installedNodeModules.includes("node_modules")) {
    throw new Error("Fresh dependency installation did not create root node_modules.")
  }
  const store = path.join(worktree, "node_modules/.bun")
  const storeStat = await fs.lstat(store).catch(() => null)
  if (storeStat) {
    if (!storeStat.isDirectory() || storeStat.isSymbolicLink()) {
      throw new Error("Installed Bun dependency store must be a real directory in the exact-build worktree.")
    }
    const resolved = await fs.realpath(store)
    if (!pathIsInside(worktreeRealPath, resolved)) {
      throw new Error(`Installed Bun dependency store escaped the exact-build worktree: ${resolved}`)
    }
  }
  return {
    nodeModules: installedNodeModules,
    workspaceLinks: await assertWorkspaceLinks(worktree, installedNodeModules),
  }
}

async function installDependencies(worktree: string, isolationRoot: string) {
  const lockPath = path.join(worktree, "bun.lock")
  const lockSha256 = sha256(new Uint8Array(await Bun.file(lockPath).arrayBuffer()))
  await fs.rm(path.join(worktree, "node_modules"), { recursive: true, force: true })
  const result = await runDependencyInstall(worktree, isolationRoot, true)
  if (result.exitCode !== 0) {
    throw new Error(
      `Fresh exact-build bun install failed: ${(result.stderr || result.stdout).trim().slice(-8_000) || "unknown error"}`,
    )
  }
  if (sha256(new Uint8Array(await Bun.file(lockPath).arrayBuffer())) !== lockSha256) {
    throw new Error("Fresh exact-build bun install changed bun.lock.")
  }
  const installed = await assertInstalledDependencies(worktree, await workspaceNodeModulesPaths(worktree))
  return {
    lockSha256,
    cacheDirectory: result.directories.BUN_INSTALL_CACHE_DIR!,
    ...installed,
  }
}

async function fileSha256(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of createReadStream(file)) hasher.update(chunk)
  return hasher.digest("hex")
}

async function inspectPlaywrightBrowsers(directory: string, isolationRoot: string) {
  const [directoryStat, directoryRealPath, isolationRealPath] = await Promise.all([
    fs.lstat(directory),
    fs.realpath(directory),
    fs.realpath(isolationRoot),
  ])
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !pathIsInside(isolationRealPath, directoryRealPath)
  ) {
    throw new Error("Playwright browsers must be a real directory inside the evidence isolation root.")
  }
  const records: Array<Record<string, string | number>> = []
  let executableFiles = 0
  let installationMarkers = 0
  const visit = async (current: string) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolutePath = path.join(current, entry.name)
      const relativePath = path.relative(directoryRealPath, absolutePath).split(path.sep).join("/")
      const stat = await fs.lstat(absolutePath)
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(absolutePath).catch(() => null)
        if (!resolved || !pathIsInside(directoryRealPath, resolved)) {
          throw new Error(`Playwright browser symlink escaped the evidence isolation root: ${relativePath}`)
        }
        records.push({
          path: relativePath,
          type: "symlink",
          target: await fs.readlink(absolutePath),
        })
        continue
      }
      if (stat.isDirectory()) {
        records.push({ path: relativePath, type: "directory", mode: stat.mode & 0o777 })
        await visit(absolutePath)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Playwright browser cache contains an unsupported entry: ${relativePath}`)
      }
      const mode = stat.mode & 0o777
      executableFiles +=
        process.platform === "win32" ? Number(relativePath.endsWith(".exe")) : Number(Boolean(mode & 0o111))
      installationMarkers += Number(entry.name === "INSTALLATION_COMPLETE")
      records.push({
        path: relativePath,
        type: "file",
        mode,
        byteLength: stat.size,
        sha256: await fileSha256(absolutePath),
      })
    }
  }
  await visit(directoryRealPath)
  if (!records.length || !executableFiles || !installationMarkers) {
    throw new Error("Fresh Playwright browser installation is empty or incomplete.")
  }
  return {
    browserTreeSha256: sha256(canonicalize(records)),
    files: records.filter((record) => record.type === "file").length,
  }
}

async function resolvePlaywrightInstallation(worktree: string) {
  const [rootManifest, appManifest, desktopManifest] = (await Promise.all(
    ["package.json", "packages/app/package.json", "packages/desktop/package.json"].map((relativePath) =>
      Bun.file(path.join(worktree, relativePath)).json(),
    ),
  )) as unknown[]
  if (!rootManifest || !appManifest || !desktopManifest) {
    throw new Error("Exact-build Playwright package manifests are missing.")
  }
  const rootCatalog =
    isRecord(rootManifest) && isRecord(rootManifest.workspaces) && isRecord(rootManifest.workspaces.catalog)
      ? rootManifest.workspaces.catalog
      : {}
  const declaredVersions = [appManifest, desktopManifest].map((manifest) => {
    const specifier =
      isRecord(manifest) && isRecord(manifest.devDependencies)
        ? manifest.devDependencies["@playwright/test"]
        : undefined
    return specifier === "catalog:" ? rootCatalog["@playwright/test"] : specifier
  })
  if (
    declaredVersions.some(
      (version) => typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    ) ||
    new Set(declaredVersions).size !== 1
  ) {
    throw new Error("App and desktop must resolve one exact Playwright version from the exact-build manifests.")
  }
  const worktreeRealPath = await fs.realpath(worktree)
  const playwrightTestDirectory = await fs.realpath(path.join(worktree, "packages/app/node_modules/@playwright/test"))
  const playwrightDirectory = await fs.realpath(path.join(playwrightTestDirectory, "../../playwright"))
  const playwrightCoreDirectory = await fs.realpath(path.join(playwrightDirectory, "../playwright-core"))
  if (
    [playwrightTestDirectory, playwrightDirectory, playwrightCoreDirectory].some(
      (directory) => !pathIsInside(worktreeRealPath, directory),
    )
  ) {
    throw new Error("Playwright packages escaped the exact-build worktree.")
  }
  const packageManifests = (await Promise.all(
    [playwrightTestDirectory, playwrightDirectory, playwrightCoreDirectory].map((directory) =>
      Bun.file(path.join(directory, "package.json")).json(),
    ),
  )) as unknown[]
  if (
    packageManifests.some(
      (manifest, index) =>
        !isRecord(manifest) ||
        manifest.name !== ["@playwright/test", "playwright", "playwright-core"][index] ||
        manifest.version !== declaredVersions[0],
    )
  ) {
    throw new Error("Installed Playwright package versions do not match the exact-build manifest.")
  }
  const cliPath = path.join(playwrightTestDirectory, "cli.js")
  const browsersJsonPath = path.join(playwrightCoreDirectory, "browsers.json")
  const [cliStat, cliRealPath, browsersJsonStat, browsersJsonRealPath] = await Promise.all([
    fs.lstat(cliPath),
    fs.realpath(cliPath),
    fs.lstat(browsersJsonPath),
    fs.realpath(browsersJsonPath),
  ])
  if (
    !cliStat.isFile() ||
    cliStat.isSymbolicLink() ||
    cliStat.nlink !== 1 ||
    !browsersJsonStat.isFile() ||
    browsersJsonStat.isSymbolicLink() ||
    browsersJsonStat.nlink !== 1 ||
    !pathIsInside(worktreeRealPath, cliRealPath) ||
    !pathIsInside(worktreeRealPath, browsersJsonRealPath)
  ) {
    throw new Error("Playwright CLI or browser manifest escaped the exact-build worktree.")
  }
  const browsersJsonSource = await Bun.file(browsersJsonPath).text()
  const browsersJson: unknown = JSON.parse(browsersJsonSource)
  if (
    !isRecord(browsersJson) ||
    !Array.isArray(browsersJson.browsers) ||
    !["chromium", "chromium-headless-shell"].every((name) =>
      browsersJson.browsers.some(
        (browser) =>
          isRecord(browser) &&
          browser.name === name &&
          typeof browser.revision === "string" &&
          browser.installByDefault === true,
      ),
    )
  ) {
    throw new Error("Exact-build Playwright browser manifest does not bind Chromium.")
  }
  return {
    packageVersion: declaredVersions[0] as string,
    browsersJsonSha256: sha256(browsersJsonSource),
    cliPath: cliRealPath,
  }
}

async function installPlaywrightBrowsers(worktree: string, isolationRoot: string) {
  const installation = await resolvePlaywrightInstallation(worktree)
  const directory = path.join(isolationRoot, "playwright-browsers")
  const directories = dependencyInstallationDirectories(path.join(isolationRoot, "environment"))
  await Promise.all([
    fs.mkdir(directory, { recursive: true }),
    ...[...new Set(Object.values(directories))].map((value) => fs.mkdir(value, { recursive: true })),
  ])
  const [directoryStat, directoryRealPath, isolationRealPath, entries] = await Promise.all([
    fs.lstat(directory),
    fs.realpath(directory),
    fs.realpath(isolationRoot),
    fs.readdir(directory),
  ])
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !pathIsInside(isolationRealPath, directoryRealPath) ||
    entries.length
  ) {
    throw new Error("Playwright installation requires an empty browser directory inside the evidence isolation root.")
  }
  const child = Bun.spawn({
    cmd: [process.execPath, installation.cliPath, "install", "chromium"],
    cwd: path.join(worktree, "packages/app"),
    env: {
      ...dependencyInstallationEnvironment(process.env, directories),
      PLAYWRIGHT_BROWSERS_PATH: directory,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)])
  if (exitCode !== 0) {
    throw new Error(
      `Fresh isolated Playwright browser install failed: ${new TextDecoder()
        .decode(stderr.byteLength ? stderr : stdout)
        .trim()
        .slice(-8_000)}`,
    )
  }
  await fs.rm(path.join(directory, ".links"), { recursive: true, force: true })
  return {
    directory,
    isolationRoot,
    packageVersion: installation.packageVersion,
    browsersJsonSha256: installation.browsersJsonSha256,
    ...(await inspectPlaywrightBrowsers(directory, isolationRoot)),
  } satisfies PlaywrightRuntime & { files: number }
}

async function assertPlaywrightBrowsersUnchanged(runtime: PlaywrightRuntime) {
  if (
    (await inspectPlaywrightBrowsers(runtime.directory, runtime.isolationRoot)).browserTreeSha256 !==
    runtime.browserTreeSha256
  ) {
    throw new Error("Playwright browser installation changed during automatic evidence execution.")
  }
}

export async function generateAutomaticEvidence(options: {
  buildSha: string
  runnerPath: string
  outputDirectory: string
}) {
  const buildSha = verifyExactCommit(options.buildSha)
  const outputDirectory = path.resolve(options.outputDirectory)
  const existing = await fs.readdir(outputDirectory).catch(() => [])
  if (existing.length) throw new Error("Automatic evidence output directory must be absent or empty.")
  await fs.mkdir(outputDirectory, { recursive: true })
  const governance = await loadAutomaticEvidenceGovernance(buildSha)
  const runnerSource = await Bun.file(path.resolve(options.runnerPath)).text()
  const runner: unknown = JSON.parse(runnerSource)
  if (!isRecord(runner) || runner.buildSha !== buildSha) {
    throw new Error("Automatic evidence runner binding does not match the exact build SHA.")
  }
  const temporaryRoot = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ac-r0-"))
  const worktree = path.join(temporaryRoot, "worktree")
  const isolationRoot = path.join(temporaryRoot, "isolation")
  runGit(["worktree", "add", "--detach", worktree, buildSha])
  try {
    await installDependencies(worktree, path.join(isolationRoot, "dependency-install"))
    const playwright = await installPlaywrightBrowsers(worktree, path.join(isolationRoot, "playwright"))
    await assertPlaywrightBrowsersUnchanged(playwright)
    const commandResults: Awaited<ReturnType<typeof runCommand>>[] = []
    for (const command of governance.requirements.commands) {
      commandResults.push(
        await runCommand(
          worktree,
          outputDirectory,
          isolationRoot,
          command,
          playwright.directory,
          buildSha,
          governance.humanResearchProtocolSha256,
        ),
      )
    }
    const commands = commandResults.map((result) => result.command)
    const releaseCandidateScreenshots =
      commandResults.find((result) => result.command.id === releaseCandidateGeneratorCommandId)
        ?.releaseCandidateScreenshots ?? null
    const releaseCandidateHR01Stimuli =
      commandResults.find((result) => result.command.id === releaseCandidateGeneratorCommandId)
        ?.releaseCandidateHR01Stimuli ?? null
    await assertPlaywrightBrowsersUnchanged(playwright)
    await cleanIgnoredRuntimePaths(worktree)
    const finalHead = runGit(["rev-parse", "HEAD^{commit}"], worktree).trim()
    if (finalHead !== buildSha) {
      throw new Error(`Automatic evidence worktree HEAD changed from ${buildSha} to ${finalHead}.`)
    }
    const worktreeStatus = runGit(["status", "--porcelain", "--untracked-files=all"], worktree).trim()
    if (worktreeStatus) throw new Error(`Automatic evidence exact-commit worktree became dirty:\n${worktreeStatus}`)
    const packageValue: AutomaticEvidencePackage = {
      schemaVersion: 1,
      packageVersion: "1.3.0",
      packageId: `R0-AUTO-${buildSha.slice(0, 16)}`,
      gate: "R0",
      buildSha,
      buildTreeSha: governance.buildTreeSha,
      requirementsBinding: {
        path: automaticEvidenceRequirementsRelativePath,
        sha256: governance.requirementsSha256,
      },
      schemaBinding: {
        path: automaticEvidenceSchemaRelativePath,
        sha256: governance.schemaSha256,
      },
      runnerBinding: {
        buildSha,
        sha256: sha256(runnerSource),
      },
      provenance: {
        kind: "executed",
        worktreeHead: finalHead,
      },
      isolation: {
        mode: "detached_exact_commit_worktree",
        environment: governance.requirements.isolation.requiredEnvironment,
        productionDataEnvironmentInherited: false,
        hostPermissionIsolation: false,
        networkIsolation: "proxy_environment_only",
        playwright: {
          mode: "fresh_isolated_install",
          packageVersion: playwright.packageVersion,
          browsersJsonSha256: playwright.browsersJsonSha256,
          browserTreeSha256: playwright.browserTreeSha256,
        },
      },
      createdAt: new Date().toISOString(),
      commands,
      coverage: expectedCoverage(governance.requirements),
      releaseCandidateScreenshots,
      releaseCandidateHR01Stimuli,
      overallStatus: commands.every((command) => command.status === "pass") ? "pass" : "fail",
    }
    const packagePath = path.join(outputDirectory, "automatic-evidence-package.json")
    await Bun.write(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`)
    const validation = await validateAutomaticEvidencePackage({
      packagePath,
      buildSha,
      runnerSha256: sha256(runnerSource),
      governance,
    })
    if (validation.status === "invalid" || validation.status === "incomplete") {
      throw new Error(`Generated automatic evidence is ${validation.status}: ${JSON.stringify(validation)}`)
    }
    return {
      packagePath,
      validation,
    }
  } finally {
    runGit(["worktree", "remove", "--force", worktree])
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function writeStructuralAutomaticEvidenceFixture(
  directory: string,
  buildSha: string,
  buildTreeSha: string,
  runnerSha256: string,
) {
  await fs.mkdir(directory, { recursive: true })
  const governance = await currentGovernance(buildTreeSha)
  const commands: CommandEvidence[] = []
  for (const command of governance.requirements.commands) {
    const commandDirectory = path.posix.join("files", command.id)
    const stdoutSource =
      command.stdoutValidator === "json_pass"
        ? `${JSON.stringify({
            result: "pass",
            status: "pass",
            ...(command.id === "seed-grow-real-surfaces" ? { candidateSha: buildSha } : {}),
          })}\n`
        : ""
    const stdout = await writeEvidenceFile(
      directory,
      path.posix.join(commandDirectory, "stdout.log"),
      stdoutSource,
      "text/plain",
    )
    const stderr = await writeEvidenceFile(directory, path.posix.join(commandDirectory, "stderr.log"), "", "text/plain")
    const reports: ReportEvidence[] = []
    for (const report of command.reports) {
      const source: string | Uint8Array =
        report.validator === "junit"
          ? '<testsuites tests="1" failures="0" errors="0" skipped="0"></testsuites>\n'
          : report.validator === "r0_branch_coverage"
            ? `${JSON.stringify({
                threshold: 90,
                results: Array.from({ length: 7 }, (_, index) => ({
                  file: `fixture-${index + 1}.ts`,
                  percent: 100,
                })),
              })}\n`
            : report.path.endsWith(".png")
              ? await sharp({
                  create: {
                    width: 1440,
                    height: 900,
                    channels: 4,
                    background: { r: 24, g: 36, b: 48, alpha: 1 },
                  },
                })
                  .png()
                  .toBuffer()
              : `${JSON.stringify({ result: "pass" })}\n`
      const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source
      const result = await reportSummary(report.validator, bytes, report.path)
      reports.push({
        sourcePath: report.path,
        validator: report.validator,
        file: await writeEvidenceFile(
          directory,
          path.posix.join(commandDirectory, "reports", path.basename(report.path)),
          bytes,
          reportMediaType(report),
        ),
        summary: result.summary,
      })
    }
    commands.push({
      id: command.id,
      cwd: command.cwd,
      argv: command.argv,
      environment: command.environment,
      startedAt: "2026-07-25T08:00:00.000Z",
      finishedAt: "2026-07-25T08:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      timedOut: false,
      status: "pass",
      stdout,
      stderr,
      stdoutSummary: stdoutSummary(command.stdoutValidator, stdoutSource, command.id, buildSha).summary,
      reports,
    })
  }
  const releaseCandidateScreenshotFiles = await Promise.all(
    releaseCandidateSurfaces.map(async (surface, index) => {
      const sourceRelativePath = `human-review/screenshots/${surface.toLowerCase().replaceAll(" ", "-")}.png`
      return {
        surface,
        sourceRelativePath,
        file: await writeEvidenceFile(
          directory,
          path.posix.join(releaseCandidateArchiveDirectory, "screenshots", path.posix.basename(sourceRelativePath)),
          await sharp({
            create: {
              width: 1440,
              height: 900,
              channels: 4,
              background: {
                r: 24 + index * 20,
                g: 36 + index * 12,
                b: 48 + index * 8,
                alpha: 1,
              },
            },
          })
            .png()
            .toBuffer(),
          "image/png",
        ),
      }
    }),
  )
  const releaseCandidateScreenshots: ReleaseCandidateScreenshotsEvidence = {
    generatorCommandId: releaseCandidateGeneratorCommandId,
    buildSha,
    manifest: await writeEvidenceFile(
      directory,
      path.posix.join(releaseCandidateArchiveDirectory, "screenshots-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          buildSha,
          relativePathBase: "build-artifact-root",
          viewport: { width: 1440, height: 1600 },
          screenshots: releaseCandidateScreenshotFiles.map((screenshot) => ({
            surface: screenshot.surface,
            relativePath: screenshot.sourceRelativePath,
            sha256: screenshot.file.sha256,
          })),
        },
        null,
        2,
      )}\n`,
      "application/json",
    ),
    screenshots: releaseCandidateScreenshotFiles,
  }
  const releaseCandidateHR01StimulusFiles = await Promise.all(
    releaseCandidateHR01States.map(async ([promptId, stateId], index) => {
      const sourceRelativePath = `human-review/hr01-state-cards/${promptId}.png`
      return {
        promptId,
        stateId,
        sourceRelativePath,
        file: await writeEvidenceFile(
          directory,
          path.posix.join(
            releaseCandidateHR01ArchiveDirectory,
            "hr01-state-cards",
            path.posix.basename(sourceRelativePath),
          ),
          await sharp({
            create: {
              width: 605,
              height: 180,
              channels: 4,
              background: {
                r: 32 + index * 11,
                g: 44 + index * 9,
                b: 56 + index * 7,
                alpha: 1,
              },
            },
          })
            .png()
            .toBuffer(),
          "image/png",
        ),
      }
    }),
  )
  const releaseCandidateHR01Stimuli: ReleaseCandidateHR01StimuliEvidence = {
    generatorCommandId: releaseCandidateGeneratorCommandId,
    buildSha,
    manifest: await writeEvidenceFile(
      directory,
      path.posix.join(releaseCandidateHR01ArchiveDirectory, "stimuli-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          buildSha,
          protocol: {
            id: "agent-company-r0-human-research",
            version: "1.0.0",
            sha256: governance.humanResearchProtocolSha256,
            studyId: "HR-01",
            moderatorScriptVersion: "HR01-v1",
          },
          presentation: releaseCandidateHR01Presentation,
          exactPrompt: releaseCandidateHR01ExactPrompt,
          stateLabelHidden: true,
          relativePathBase: "build-artifact-root",
          viewport: { width: 1440, height: 1600 },
          stimuli: releaseCandidateHR01StimulusFiles.map((stimulus) => ({
            promptId: stimulus.promptId,
            stateId: stimulus.stateId,
            relativePath: stimulus.sourceRelativePath,
            sha256: stimulus.file.sha256,
          })),
        },
        null,
        2,
      )}\n`,
      "application/json",
    ),
    stimuli: releaseCandidateHR01StimulusFiles,
  }
  const packageValue: AutomaticEvidencePackage = {
    schemaVersion: 1,
    packageVersion: "1.3.0",
    packageId: `R0-AUTO-${buildSha.slice(0, 16)}`,
    gate: "R0",
    buildSha,
    buildTreeSha,
    requirementsBinding: {
      path: automaticEvidenceRequirementsRelativePath,
      sha256: governance.requirementsSha256,
    },
    schemaBinding: {
      path: automaticEvidenceSchemaRelativePath,
      sha256: governance.schemaSha256,
    },
    runnerBinding: {
      buildSha,
      sha256: runnerSha256,
    },
    provenance: {
      kind: "structural_fixture",
      worktreeHead: null,
    },
    isolation: {
      mode: "detached_exact_commit_worktree",
      environment: governance.requirements.isolation.requiredEnvironment,
      productionDataEnvironmentInherited: false,
      hostPermissionIsolation: false,
      networkIsolation: "proxy_environment_only",
      playwright: {
        mode: "fresh_isolated_install",
        packageVersion: "1.59.1",
        browsersJsonSha256: "d".repeat(64),
        browserTreeSha256: "e".repeat(64),
      },
    },
    createdAt: "2026-07-25T08:00:00.000Z",
    commands,
    coverage: expectedCoverage(governance.requirements),
    releaseCandidateScreenshots,
    releaseCandidateHR01Stimuli,
    overallStatus: "pass",
  }
  const packagePath = path.join(directory, "automatic-evidence-package.json")
  await Bun.write(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`)
  return {
    packagePath,
    packageValue,
    governance,
  }
}

async function writeMutatedPackage(
  directory: string,
  name: string,
  source: AutomaticEvidencePackage,
  mutate: (value: AutomaticEvidencePackage) => void,
) {
  const value = structuredClone(source)
  mutate(value)
  const file = path.join(directory, `${name}.json`)
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

async function dependencyIsolationSelfTest(directory: string) {
  const worktree = path.join(directory, "dependency-worktree")
  const mismatchedWorktree = path.join(directory, "dependency-worktree-lock-mismatch")
  const externalNodeModules = path.join(directory, "external-node-modules")
  const rootManifest = {
    name: "dependency-isolation-fixture",
    private: true,
    workspaces: { packages: ["packages/*"] },
    dependencies: {
      "@agents-company/consumer": "workspace:*",
      "@agents-company/shared": "workspace:*",
      "@mimo-ai/compat": "workspace:*",
    },
  }
  await Promise.all(
    [
      path.join(worktree, "packages/shared"),
      path.join(worktree, "packages/consumer"),
      path.join(worktree, "packages/compat"),
      path.join(worktree, "fixtures/local"),
      path.join(externalNodeModules, ".bun"),
    ].map((target) => fs.mkdir(target, { recursive: true })),
  )
  await Promise.all([
    Bun.write(path.join(worktree, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`),
    Bun.write(
      path.join(worktree, "packages/shared/package.json"),
      `${JSON.stringify({ name: "@agents-company/shared", version: "1.0.0" }, null, 2)}\n`,
    ),
    Bun.write(
      path.join(worktree, "packages/consumer/package.json"),
      `${JSON.stringify(
        {
          name: "@agents-company/consumer",
          version: "1.0.0",
          dependencies: { "@agents-company/shared": "workspace:*" },
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      path.join(worktree, "packages/compat/package.json"),
      `${JSON.stringify(
        {
          name: "@mimo-ai/compat",
          version: "1.0.0",
          dependencies: { "@agents-company/shared": "workspace:*" },
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      path.join(worktree, "fixtures/local/package.json"),
      `${JSON.stringify({ name: "fixture-local", version: "1.0.0" }, null, 2)}\n`,
    ),
    Bun.write(path.join(externalNodeModules, "external-store-content"), "must-not-be-reused\n"),
  ])
  const lockGeneration = await runDependencyInstall(worktree, path.join(directory, "lock-generation"), false)
  if (lockGeneration.exitCode !== 0) {
    throw new Error(`Dependency isolation fixture lock generation failed: ${lockGeneration.stderr}`)
  }
  await fs.rm(path.join(worktree, "node_modules"), { recursive: true, force: true })
  await fs.cp(worktree, mismatchedWorktree, { recursive: true })
  await Bun.write(
    path.join(mismatchedWorktree, "package.json"),
    `${JSON.stringify(
      {
        ...rootManifest,
        dependencies: {
          ...rootManifest.dependencies,
          "fixture-local": "file:./fixtures/local",
        },
      },
      null,
      2,
    )}\n`,
  )
  await fs.symlink(
    externalNodeModules,
    path.join(worktree, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const installed = await installDependencies(worktree, path.join(directory, "fresh-install"))
  const mismatchedLockSha256 = sha256(
    new Uint8Array(await Bun.file(path.join(mismatchedWorktree, "bun.lock")).arrayBuffer()),
  )
  const mismatchedInstall = await runDependencyInstall(
    mismatchedWorktree,
    path.join(directory, "mismatched-install"),
    true,
  )
  const lockMismatchRejected =
    mismatchedInstall.exitCode !== 0 &&
    /lockfile.*frozen|frozen.*lockfile/i.test(`${mismatchedInstall.stdout}\n${mismatchedInstall.stderr}`) &&
    sha256(new Uint8Array(await Bun.file(path.join(mismatchedWorktree, "bun.lock")).arrayBuffer())) ===
      mismatchedLockSha256
  const externalStoreContentNotReused =
    (await Bun.file(path.join(externalNodeModules, "external-store-content")).exists()) &&
    !(await Bun.file(path.join(worktree, "node_modules/external-store-content")).exists()) &&
    !(await fs.lstat(path.join(worktree, "node_modules"))).isSymbolicLink() &&
    (await fs.realpath(path.join(worktree, "node_modules"))) !== (await fs.realpath(externalNodeModules))
  const nodeModulesPaths = await workspaceNodeModulesPaths(worktree)
  const store = path.join(worktree, "node_modules/.bun")
  await fs.rm(store, { recursive: true, force: true })
  await fs.symlink(path.join(externalNodeModules, ".bun"), store, process.platform === "win32" ? "junction" : "dir")
  const externalStoreRejected = await assertInstalledDependencies(worktree, nodeModulesPaths).then(
    () => false,
    () => true,
  )
  await fs.rm(store, { recursive: true, force: true })
  await fs.mkdir(store, { recursive: true })
  const workspaceLink = installed.workspaceLinks[0]!
  const escapedWorkspace = path.join(directory, "escaped-workspace")
  await fs.mkdir(escapedWorkspace, { recursive: true })
  await fs.rm(path.join(worktree, workspaceLink.relativePath), { recursive: true, force: true })
  await fs.symlink(
    escapedWorkspace,
    path.join(worktree, workspaceLink.relativePath),
    process.platform === "win32" ? "junction" : "dir",
  )
  const workspaceEscapeRejected = await assertInstalledDependencies(worktree, nodeModulesPaths).then(
    () => false,
    () => true,
  )
  const requirement = {
    id: "environment-self-test",
    cwd: ".",
    argv: ["bun", "--version"],
    timeoutMs: 1000,
    stdoutValidator: "none",
    environment: {
      PLAYWRIGHT_JUNIT_OUTPUT: ".artifacts/junit.xml",
    },
    reports: [],
  } satisfies RequirementCommand
  const commandDirectories = commandIsolationDirectories(path.join(directory, "environment-command"))
  const environment = commandEnvironment(
    {
      PATH: "/safe/bin",
      AGENTCOMPANY_DB: "/live/database.db",
      AGENTCOMPANY_CONFIG: "/live/config.json",
      AGENTCOMPANY_CONFIG_CONTENT: "{}",
      AGENTCOMPANY_CONFIG_DIR: "/live/config",
      AGENT_COMPANY_CONTROL_PLANE_URL: "http://127.0.0.1:9999",
      AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION: "secret",
      BETTER_AUTH_SECRET: "secret",
      BETTER_AUTH_URL: "http://127.0.0.1:9998",
      HOST: "0.0.0.0",
      INTERNAL_API_SECRET: "secret",
      OPENROUTER_API_KEY: "secret",
      PLAYWRIGHT_APP_SERVER_COMMAND: "malicious-command",
      PLAYWRIGHT_BASE_URL: "http://127.0.0.1:9997",
      PLAYWRIGHT_BROWSERS_PATH: "/host/mutable-playwright-cache",
      PLAYWRIGHT_DESKTOP_SERVER_PORT: "9996",
      PORT: "9995",
    },
    commandDirectories,
    requirement,
    "/safe/playwright-browsers",
  )
  const forbiddenEnvironment = [
    "AGENTCOMPANY_DB",
    "AGENTCOMPANY_CONFIG",
    "AGENTCOMPANY_CONFIG_CONTENT",
    "AGENTCOMPANY_CONFIG_DIR",
    "AGENT_COMPANY_CONTROL_PLANE_URL",
    "AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "HOST",
    "INTERNAL_API_SECRET",
    "OPENROUTER_API_KEY",
    "PLAYWRIGHT_APP_SERVER_COMMAND",
    "PLAYWRIGHT_BASE_URL",
    "PLAYWRIGHT_DESKTOP_SERVER_PORT",
    "PORT",
  ]
  const worktreeRealPath = await fs.realpath(worktree)
  const installDirectories = dependencyInstallationDirectories(path.join(directory, "environment-install"))
  const installEnvironment = dependencyInstallationEnvironment(
    {
      PATH: "/safe/bin",
      AGENTCOMPANY_DB: "/live/database.db",
      AGENTCOMPANY_CONFIG: "/live/config.json",
      BUN_INSTALL_CACHE_DIR: "/external/cache",
      HTTP_PROXY: "http://external-proxy",
      PLAYWRIGHT_BROWSERS_PATH: "/host/mutable-playwright-cache",
    },
    installDirectories,
  )
  return {
    freshInstallation:
      (await fs.lstat(path.join(worktree, "node_modules"))).isDirectory() &&
      !(await fs.lstat(path.join(worktree, "node_modules"))).isSymbolicLink() &&
      installed.lockSha256 === sha256(new Uint8Array(await Bun.file(path.join(worktree, "bun.lock")).arrayBuffer())),
    isolatedFreshCache:
      pathIsInside(await fs.realpath(directory), await fs.realpath(installed.cacheDirectory)) &&
      dependencyInstallCommand(installed.cacheDirectory, true).includes("--frozen-lockfile") &&
      dependencyInstallCommand(installed.cacheDirectory, true).includes("copyfile"),
    externalStoreContentNotReused,
    externalStoreRejected,
    workspaceLinksInsideWorktree: installed.workspaceLinks.every((link) =>
      pathIsInside(worktreeRealPath, link.resolved),
    ),
    workspaceEscapeRejected,
    lockMismatchRejected,
    installEnvironmentSanitized:
      installEnvironment.AGENTCOMPANY_DB === undefined &&
      installEnvironment.AGENTCOMPANY_CONFIG === undefined &&
      installEnvironment.HTTP_PROXY === undefined &&
      installEnvironment.PLAYWRIGHT_BROWSERS_PATH === undefined &&
      installEnvironment.BUN_INSTALL_CACHE_DIR === installDirectories.BUN_INSTALL_CACHE_DIR,
    environmentSanitized:
      forbiddenEnvironment.every((key) => environment[key] === undefined) &&
      environment.HOME === commandDirectories.HOME &&
      environment.AGENT_COMPANY_WEBUI_DATA_DIR === commandDirectories.AGENT_COMPANY_WEBUI_DATA_DIR &&
      pathIsInside(directory, commandDirectories.AGENT_COMPANY_WEBUI_DATA_DIR) &&
      !pathIsInside(worktree, commandDirectories.AGENT_COMPANY_WEBUI_DATA_DIR) &&
      environment.PATH === "/safe/bin" &&
      environment.PLAYWRIGHT_BROWSERS_PATH === "/safe/playwright-browsers" &&
      environment.PLAYWRIGHT_JUNIT_OUTPUT === ".artifacts/junit.xml",
  }
}

async function playwrightIsolationSelfTest(directory: string) {
  const isolationRoot = path.join(directory, "playwright-isolation")
  const browserDirectory = path.join(isolationRoot, "playwright-browsers")
  const revisionDirectory = path.join(browserDirectory, "chromium-1")
  const externalDirectory = path.join(directory, "external-playwright-cache")
  const executable = path.join(revisionDirectory, process.platform === "win32" ? "browser.exe" : "browser")
  await Promise.all([
    fs.mkdir(revisionDirectory, { recursive: true }),
    fs.mkdir(externalDirectory, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(executable, "exact-browser-binary\n"),
    Bun.write(path.join(revisionDirectory, "INSTALLATION_COMPLETE"), ""),
  ])
  if (process.platform !== "win32") await fs.chmod(executable, 0o755)
  const inspected = await inspectPlaywrightBrowsers(browserDirectory, isolationRoot)
  const runtime = {
    directory: browserDirectory,
    isolationRoot,
    packageVersion: "1.0.0",
    browsersJsonSha256: "f".repeat(64),
    browserTreeSha256: inspected.browserTreeSha256,
  }
  await Bun.write(executable, "tampered-browser-binary\n")
  if (process.platform !== "win32") await fs.chmod(executable, 0o755)
  const tamperRejected = await assertPlaywrightBrowsersUnchanged(runtime).then(
    () => false,
    () => true,
  )
  await fs.symlink(
    externalDirectory,
    path.join(revisionDirectory, "external-cache"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const escapeRejected = await inspectPlaywrightBrowsers(browserDirectory, isolationRoot).then(
    () => false,
    () => true,
  )
  return {
    digestProduced: /^[a-f0-9]{64}$/.test(inspected.browserTreeSha256),
    tamperRejected,
    escapeRejected,
  }
}

export async function runAutomaticEvidenceSelfTest() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-r0-automatic-evidence-self-test-"))
  const buildSha = "a".repeat(40)
  const runnerSha256 = "b".repeat(64)
  const fixture = await writeStructuralAutomaticEvidenceFixture(directory, buildSha, "c".repeat(40), runnerSha256)
  const validate = (packagePath: string) =>
    validateAutomaticEvidencePackage({
      packagePath,
      buildSha,
      runnerSha256,
      governance: fixture.governance,
      allowStructuralFixture: true,
    })
  const valid = await validate(fixture.packagePath)
  const structuralFixtureRejected = await validateAutomaticEvidencePackage({
    packagePath: fixture.packagePath,
    buildSha,
    runnerSha256,
    governance: fixture.governance,
  })
  const unsafeRequirements = structuredClone(fixture.governance.requirements)
  unsafeRequirements.commands[0]!.environment = { AGENTCOMPANY_DB: "/live/database.db" }
  const unsafeRequirementEnvironmentRejected = await Promise.resolve()
    .then(() => validateRequirements(unsafeRequirements))
    .then(
      () => false,
      () => true,
    )
  const missingCommand = await writeMutatedPackage(directory, "missing-command", fixture.packageValue, (value) => {
    value.commands.pop()
  })
  const failedCommand = await writeMutatedPackage(directory, "failed-command", fixture.packageValue, (value) => {
    value.commands[0]!.exitCode = 1
    value.commands[0]!.status = "fail"
    value.overallStatus = "fail"
  })
  const failedCandidateCommand = await writeMutatedPackage(
    directory,
    "failed-candidate-command",
    fixture.packageValue,
    (value) => {
      const command = value.commands.find((item) => item.id === releaseCandidateGeneratorCommandId)!
      command.exitCode = 1
      command.status = "fail"
      value.releaseCandidateScreenshots = null
      value.releaseCandidateHR01Stimuli = null
      value.overallStatus = "fail"
    },
  )
  const missingTask = await writeMutatedPackage(directory, "missing-task", fixture.packageValue, (value) => {
    value.coverage.pop()
  })
  const wrongBuild = await writeMutatedPackage(directory, "wrong-build", fixture.packageValue, (value) => {
    value.buildSha = "d".repeat(40)
  })
  const invalidBrowserBinding = await writeMutatedPackage(
    directory,
    "invalid-browser-binding",
    fixture.packageValue,
    (value) => {
      value.isolation.playwright.browserTreeSha256 = "not-a-digest"
    },
  )
  const tamperedLogPath = path.join(directory, fixture.packageValue.commands[0]!.stdout.relativePath)
  const originalLog = await Bun.file(tamperedLogPath).text()
  await Bun.write(tamperedLogPath, `${originalLog}tampered\n`)
  const tamperedLog = await validate(fixture.packagePath)
  await Bun.write(tamperedLogPath, originalLog)
  const tamperedCandidatePath = path.join(
    directory,
    fixture.packageValue.releaseCandidateScreenshots!.screenshots[0]!.file.relativePath,
  )
  const originalCandidate = new Uint8Array(await Bun.file(tamperedCandidatePath).arrayBuffer())
  await Bun.write(tamperedCandidatePath, "tampered candidate PNG\n")
  const tamperedCandidate = await validate(fixture.packagePath)
  await Bun.write(tamperedCandidatePath, originalCandidate)
  const tamperedHR01StimulusPath = path.join(
    directory,
    fixture.packageValue.releaseCandidateHR01Stimuli!.stimuli[0]!.file.relativePath,
  )
  const originalHR01Stimulus = new Uint8Array(await Bun.file(tamperedHR01StimulusPath).arrayBuffer())
  await Bun.write(tamperedHR01StimulusPath, "tampered HR-01 stimulus PNG\n")
  const tamperedHR01Stimulus = await validate(fixture.packagePath)
  await Bun.write(tamperedHR01StimulusPath, originalHR01Stimulus)
  const dependencyIsolation = await dependencyIsolationSelfTest(directory)
  const playwrightIsolation = await playwrightIsolationSelfTest(directory)
  const assertions = [
    {
      name: "structural_fixture_is_rejected_as_production_evidence",
      passed: structuralFixtureRejected.status === "invalid",
    },
    {
      name: "valid_complete_package_passes",
      passed:
        valid.status === "pass" &&
        valid.trustedReleaseCandidateScreenshots?.buildSha === buildSha &&
        valid.trustedReleaseCandidateScreenshots.screenshots.length === releaseCandidateSurfaces.length &&
        valid.trustedReleaseCandidateHR01Stimuli?.buildSha === buildSha &&
        valid.trustedReleaseCandidateHR01Stimuli.stimuli.length === releaseCandidateHR01States.length,
    },
    {
      name: "git_command_is_not_rewritten_as_bun",
      passed:
        canonicalize(executableCommand(["git", "diff", "--exit-code"])) ===
        canonicalize(["git", "diff", "--exit-code"]),
    },
    { name: "missing_command_is_incomplete", passed: (await validate(missingCommand)).status === "incomplete" },
    { name: "failed_command_fails", passed: (await validate(failedCommand)).status === "fail" },
    {
      name: "failed_candidate_command_allows_null_candidate_bundle",
      passed: (await validate(failedCandidateCommand)).status === "fail",
    },
    { name: "missing_task_is_incomplete", passed: (await validate(missingTask)).status === "incomplete" },
    { name: "wrong_build_is_invalid", passed: (await validate(wrongBuild)).status === "invalid" },
    { name: "tampered_log_is_invalid", passed: tamperedLog.status === "invalid" },
    { name: "tampered_release_candidate_png_is_invalid", passed: tamperedCandidate.status === "invalid" },
    {
      name: "tampered_release_candidate_hr01_png_is_invalid",
      passed: tamperedHR01Stimulus.status === "invalid",
    },
    {
      name: "invalid_playwright_browser_binding_is_rejected",
      passed: (await validate(invalidBrowserBinding)).status === "invalid",
    },
    {
      name: "fresh_dependency_install_is_exact_build_and_isolated",
      passed:
        dependencyIsolation.freshInstallation &&
        dependencyIsolation.isolatedFreshCache &&
        dependencyIsolation.externalStoreContentNotReused &&
        dependencyIsolation.externalStoreRejected &&
        dependencyIsolation.workspaceLinksInsideWorktree &&
        dependencyIsolation.workspaceEscapeRejected &&
        dependencyIsolation.lockMismatchRejected &&
        dependencyIsolation.installEnvironmentSanitized,
    },
    { name: "command_environment_is_allowlisted", passed: dependencyIsolation.environmentSanitized },
    { name: "unsafe_requirement_environment_is_rejected", passed: unsafeRequirementEnvironmentRejected },
    {
      name: "playwright_browser_cache_is_fresh_hashed_and_confined",
      passed:
        playwrightIsolation.digestProduced && playwrightIsolation.tamperRejected && playwrightIsolation.escapeRejected,
    },
  ]
  await fs.rm(directory, { recursive: true, force: true })
  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(`Automatic evidence self-test failed: ${JSON.stringify(assertions)}`)
  }
  return {
    result: "pass",
    tasks: requiredR0TaskIDs.length,
    commands: fixture.governance.requirements.commands.length,
    criteria: fixture.governance.requirements.tasks.flatMap((task) => task.criteria).length,
    negativeCases: assertions.slice(2),
  }
}

function parseArguments(args: string[]) {
  const allowed = new Set(["--ref", "--runner-artifact", "--out"])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!
    if (!item.startsWith("--")) continue
    if (!allowed.has(item)) throw new Error(`Unknown argument: ${item}`)
    if (values.has(item)) throw new Error(`Duplicate argument: ${item}`)
    values.set(item, args[index + 1] ?? "")
  }
  const consumed = new Set(values.values())
  const stray = args.filter((item) => !item.startsWith("--") && !consumed.has(item))
  if (stray.length) throw new Error(`Unexpected positional argument: ${stray[0]}`)
  if ([...allowed].some((item) => !values.get(item))) {
    throw new Error("Required arguments: --ref <full-sha> --runner-artifact <json> --out <empty-directory>")
  }
  return {
    buildSha: values.get("--ref")!,
    runnerPath: values.get("--runner-artifact")!,
    outputDirectory: values.get("--out")!,
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    console.log(JSON.stringify(await runAutomaticEvidenceSelfTest(), null, 2))
  } else {
    const result = await generateAutomaticEvidence(parseArguments(Bun.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (result.validation.status !== "pass") process.exitCode = 1
  }
}
