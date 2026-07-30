import fs from "node:fs/promises"
import path from "node:path"

export const root = path.resolve(import.meta.dir, "..")
export const stageIds = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "E0", "K0", "K1", "K2"] as const
export type StageId = (typeof stageIds)[number]
export const contractPath = "docs/product-design/founder-os/stage-gate-contract.v1.json"
export const evidenceSchemaPath = "docs/product-design/founder-os/stage-evidence.v1.json"
export const contractRunnerPath = "script/founder-os-stage-contract.ts"
export const evidenceRunnerPath = "script/founder-os-stage-evidence.ts"
export const gateRunnerPath = "script/founder-os-stage-gate.ts"

export type CommandDefinition = {
  id: string
  cwd: string
  argv: string[]
  reportPath: string
  kind: "production_contract" | "typecheck" | "test"
}

export type SemanticAssertion = {
  id: string
  path: string
  includeAll: string[]
  excludeAll: string[]
}

export type StageDefinition = {
  id: StageId
  taskIds: string[]
  governedPaths: string[]
  requiredCommandIds: string[]
  taskEvidence: Record<string, string[]>
  semanticAssertions: SemanticAssertion[]
}

export type StageContract = {
  schemaVersion: number
  id: string
  version: string
  evidenceSchemaBinding: { path: string }
  runnerBindings: { contract: string; evidence: string; gate: string }
  exactCommitGate: {
    attempts: string[]
    isolation: string
    requireCleanTrackedFiles: boolean
    requireBaseAncestor: boolean
    requireSameNormalizedDigest: boolean
  }
  githubActions: { status: string; blocking: boolean; replacement: string }
  advisories: {
    humanAuthorization: { blocking: boolean; defaultStatus: string }
    realSamples: { blocking: boolean; defaultStatus: string }
  }
  commandRegistry: CommandDefinition[]
  stages: StageDefinition[]
}

export type FileBinding = {
  relativePath: string
  sha256: string
  byteLength: number
  mediaType: "application/json" | "text/plain"
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

export function sameValues(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value))
}

export function confinedRelativePath(value: unknown) {
  return (
    typeof value === "string"
    && value.length > 0
    && value !== "."
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..")
  )
}

export function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

export function runGit(args: string[], cwd = root, allowedExitCodes = [0]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!allowedExitCodes.includes(result.exitCode))
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

export function exactCommit(value: string, label: string) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a full lowercase commit SHA`)
  if (runGit(["rev-parse", `${value}^{commit}`]).stdout.trim() !== value)
    throw new Error(`${label} must identify the exact commit`)
  return value
}

export function sourceAt(ref: string, file: string) {
  return runGit(["show", `${ref}:${file}`]).stdout
}

export function sourceBinding(ref: string, file: string) {
  return { path: file, sha256: sha256(sourceAt(ref, file)) }
}

export function treeSha(ref: string) {
  return runGit(["rev-parse", `${ref}^{tree}`]).stdout.trim()
}

export function stageDefinition(contract: StageContract, stage: StageId) {
  const definition = contract.stages.find((item) => item.id === stage)
  if (!definition) throw new Error(`Stage ${stage} is not registered`)
  return definition
}

export function stageCommands(contract: StageContract, stage: StageId) {
  const definition = stageDefinition(contract, stage)
  return definition.requiredCommandIds.map((id) => {
    const command = contract.commandRegistry.find((item) => item.id === id)
    if (!command) throw new Error(`Unknown command ${id}`)
    return command
  })
}

export function expandCommand(command: CommandDefinition, stage: StageId, candidateSha: string, reportPath: string) {
  return command.argv.map((value) =>
    value
      .replaceAll("{stage}", stage)
      .replaceAll("{candidateSha}", candidateSha)
      .replaceAll("{reportPath}", reportPath),
  )
}

export function normalizeCommandOutput(value: string) {
  const normalized = value
    .replaceAll(root, "<ROOT>")
    .replace(/\/(?:private\/)?var\/folders\/[^\s:]+/g, "<TEMP>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<DURATION>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<TIMESTAMP>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<UUID>")
    .replace(/\b(port|pid)[=: ]+\d+\b/gi, "$1=<NUMBER>")
    .trim()
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.startsWith("bun test v")) return lines[0]
  if (!lines.some((line) => /^Ran \d+ tests? across \d+ files?/.test(line))) return normalized
  return lines
    .filter((line) =>
      /^\$ bun (?:run )?test\b/.test(line)
      || /^\s*\d+\s+(?:pass|fail|skip|todo)$/.test(line)
      || /^Ran \d+ tests? across \d+ files?/.test(line))
    .map((line) => line.replace(/\s+\[<DURATION>\]$/, ""))
    .join("\n")
}

export async function writeFileBinding(
  directory: string,
  relativePath: string,
  source: string,
  mediaType: FileBinding["mediaType"],
) {
  if (!confinedRelativePath(relativePath)) throw new Error(`Unsafe artifact path: ${relativePath}`)
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

export async function resolveBoundFile(directory: string, binding: FileBinding) {
  if (!confinedRelativePath(binding.relativePath)) throw new Error(`Unsafe artifact path: ${binding.relativePath}`)
  const base = await fs.realpath(directory)
  const file = await fs.realpath(path.join(base, binding.relativePath))
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error(`Artifact escaped package: ${binding.relativePath}`)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  if (binding.sha256 !== sha256(bytes) || binding.byteLength !== bytes.byteLength)
    throw new Error(`Artifact binding mismatch: ${binding.relativePath}`)
  return { file, bytes }
}

export function parseStage(value: string | undefined) {
  if (!stageIds.includes(value as StageId)) throw new Error(`--stage must be one of ${stageIds.join(", ")}`)
  return value as StageId
}

export function loadContract(ref: string) {
  return JSON.parse(sourceAt(ref, contractPath)) as StageContract
}

export function validateContractSafety(contract: StageContract) {
  if (!sameValues(contract.stages.map((stage) => stage.id), [...stageIds])
    || new Set(contract.stages.map((stage) => stage.id)).size !== stageIds.length)
    throw new Error("Founder OS stage contract has an invalid stage set")
  const allowedCommands: Record<string, CommandDefinition> = {
    "founder-stage-production-contract": {
      id: "founder-stage-production-contract",
      cwd: ".",
      argv: ["bun", contractRunnerPath, "--stage", "{stage}", "--ref", "{candidateSha}", "--out", "{reportPath}"],
      reportPath: "reports/{stage}-production-contract.json",
      kind: "production_contract",
    },
    "shared-typecheck": {
      id: "shared-typecheck",
      cwd: "packages/shared",
      argv: ["bun", "typecheck"],
      reportPath: "reports/shared-typecheck.json",
      kind: "typecheck",
    },
    "shared-test": {
      id: "shared-test",
      cwd: "packages/shared",
      argv: ["bun", "test"],
      reportPath: "reports/shared-test.json",
      kind: "test",
    },
    "control-plane-typecheck": {
      id: "control-plane-typecheck",
      cwd: "packages/control-plane",
      argv: ["bun", "typecheck"],
      reportPath: "reports/control-plane-typecheck.json",
      kind: "typecheck",
    },
    "control-plane-test": {
      id: "control-plane-test",
      cwd: "packages/control-plane",
      argv: ["bun", "run", "test"],
      reportPath: "reports/control-plane-test.json",
      kind: "test",
    },
    "sdk-typecheck": {
      id: "sdk-typecheck",
      cwd: "packages/sdk/js",
      argv: ["bun", "typecheck"],
      reportPath: "reports/sdk-typecheck.json",
      kind: "typecheck",
    },
    "app-typecheck": {
      id: "app-typecheck",
      cwd: "packages/app",
      argv: ["bun", "typecheck"],
      reportPath: "reports/app-typecheck.json",
      kind: "typecheck",
    },
    "app-unit-test": {
      id: "app-unit-test",
      cwd: "packages/app",
      argv: ["bun", "test:unit"],
      reportPath: "reports/app-unit-test.json",
      kind: "test",
    },
  }
  if (!sameValues(Object.keys(allowedCommands), contract.commandRegistry.map((command) => command.id)))
    throw new Error("Founder OS stage contract has an invalid command registry")
  contract.commandRegistry.forEach((command) => {
    if (canonicalize(command) !== canonicalize(allowedCommands[command.id]))
      throw new Error(`Founder OS stage command was modified: ${command.id}`)
    if (!command.id || !["production_contract", "typecheck", "test"].includes(command.kind))
      throw new Error("Founder OS stage contract has an invalid command")
    if (command.cwd !== "." && (!confinedRelativePath(command.cwd) || !command.cwd.startsWith("packages/")))
      throw new Error(`Unsafe command cwd: ${command.cwd}`)
    if (command.argv[0] !== "bun"
      || command.argv.some((value) => value.includes("\n") || value.includes("\0") || value.split(/[\\/]/).includes("..")))
      throw new Error(`Unsafe command argv: ${command.id}`)
    if (!confinedRelativePath(command.reportPath.replaceAll("{stage}", "w1")))
      throw new Error(`Unsafe command report path: ${command.reportPath}`)
  })
  contract.stages.forEach((stage) => {
    if (stage.governedPaths.some((file) => !confinedRelativePath(file))
      || stage.semanticAssertions.some((item) =>
        !confinedRelativePath(item.path) || !stage.governedPaths.includes(item.path)))
      throw new Error(`Unsafe governed source path in ${stage.id}`)
  })
  return contract
}
