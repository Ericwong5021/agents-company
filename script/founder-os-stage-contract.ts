import path from "node:path"
import {
  canonicalize,
  contractPath,
  contractRunnerPath,
  evidenceRunnerPath,
  evidenceSchemaPath,
  exactCommit,
  gateRunnerPath,
  loadContract,
  parseStage,
  root,
  sameValues,
  sha256,
  sourceAt,
  stageCommands,
  stageDefinition,
  stageIds,
  treeSha,
  validateContractSafety,
  type StageId,
} from "./founder-os-stage-core"

type Assertion = {
  id: string
  status: "pass" | "failed"
  detail: string
}

export type FounderOSStageContractReport = {
  schemaVersion: 1
  stage: StageId
  candidateSha: string
  candidateTreeSha: string
  contractBinding: { path: string; sha256: string }
  assertions: Assertion[]
  normalizedDigest: string
  status: "pass" | "failed"
}

function assertion(id: string, pass: boolean, detail: string): Assertion {
  return { id, status: pass ? "pass" : "failed", detail }
}

export function evaluateFounderOSStageContract(candidateSha: string, stage: StageId) {
  const contractSource = sourceAt(candidateSha, contractPath)
  const contract = validateContractSafety(loadContract(candidateSha))
  const definition = stageDefinition(contract, stage)
  const commandIds = contract.commandRegistry.map((command) => command.id)
  const commands = stageCommands(contract, stage)
  const governedSources = new Map(
    definition.governedPaths.map((file) => [file, sourceAt(candidateSha, file)]),
  )
  const assertions = [
    assertion("contract-identity", contract.schemaVersion === 1
      && contract.id === "agent-company-founder-os-stage-gate"
      && contract.version === "1.0.0", `${contract.id}@${contract.version}`),
    assertion("stage-set", sameValues(contract.stages.map((item) => item.id), [...stageIds])
      && new Set(contract.stages.map((item) => item.id)).size === stageIds.length, `${contract.stages.length} stages`),
    assertion("runner-bindings", contract.evidenceSchemaBinding.path === evidenceSchemaPath
      && contract.runnerBindings.contract === contractRunnerPath
      && contract.runnerBindings.evidence === evidenceRunnerPath
      && contract.runnerBindings.gate === gateRunnerPath, "All gate sources are bound"),
    assertion("exact-commit-policy", sameValues(contract.exactCommitGate.attempts, ["attempt-01", "attempt-02"])
      && contract.exactCommitGate.isolation === "detached_exact_commit_worktree"
      && contract.exactCommitGate.requireCleanTrackedFiles === true
      && contract.exactCommitGate.requireBaseAncestor === true
      && contract.exactCommitGate.requireSameNormalizedDigest === true,
    "Two clean detached exact-commit attempts are mandatory"),
    assertion("unavailable-ci-replacement", contract.githubActions.status === "unavailable"
      && contract.githubActions.blocking === false
      && contract.githubActions.replacement === "two_local_exact_sha_runs",
    "GitHub Actions is recorded as non-blocking with a local replacement"),
    assertion("weak-gate-policy", contract.advisories.humanAuthorization.blocking === false
      && contract.advisories.humanAuthorization.defaultStatus === "not_confirmed"
      && contract.advisories.realSamples.blocking === false
      && contract.advisories.realSamples.defaultStatus === "not_confirmed",
    "Human authorization and real samples are advisory"),
    assertion("task-set-nonempty-unique", definition.taskIds.length > 0
      && new Set(definition.taskIds).size === definition.taskIds.length
      && definition.taskIds.every((id) => /^FOS-[A-Z0-9]+-\d{3}$/.test(id)), `${definition.taskIds.length} tasks`),
    assertion("task-evidence-exact-set", sameValues(Object.keys(definition.taskEvidence), definition.taskIds),
      `${Object.keys(definition.taskEvidence).length}/${definition.taskIds.length} task mappings`),
    assertion("task-evidence-resolves", Object.values(definition.taskEvidence).every((ids) =>
      ids.length >= 3
      && ids.includes("founder-stage-production-contract")
      && ids.includes("control-plane-typecheck")
      && ids.includes("control-plane-test")
      && ids.every((id) => definition.requiredCommandIds.includes(id))),
    "Every task is mapped to production contract, package typecheck, and package test"),
    assertion("commands-known-unique", new Set(commandIds).size === commandIds.length
      && definition.requiredCommandIds.every((id) => commandIds.includes(id))
      && new Set(definition.requiredCommandIds).size === definition.requiredCommandIds.length,
    `${definition.requiredCommandIds.length} required commands`),
    assertion("package-dir-validation", commands.some((command) => command.kind === "typecheck"
      && command.cwd === "packages/control-plane"
      && sameValues(command.argv, ["bun", "typecheck"]))
      && commands.some((command) => command.kind === "test"
        && command.cwd === "packages/control-plane"
        && sameValues(command.argv, ["bun", "run", "test"]))
      && commands.every((command) => command.cwd !== "." || command.kind === "production_contract"),
    "Control Plane validation runs from its package directory"),
    assertion("governed-source-nonempty", governedSources.size >= 2
      && [...governedSources.values()].every((source) => source.trim().length >= 80),
    `${governedSources.size} non-empty governed production sources`),
    assertion("semantic-assertions-nonempty", definition.semanticAssertions.length >= 3
      && new Set(definition.semanticAssertions.map((item) => item.id)).size === definition.semanticAssertions.length,
    `${definition.semanticAssertions.length} semantic assertions`),
    ...definition.semanticAssertions.map((item) => {
      const source = governedSources.get(item.path)
      return assertion(
        `semantic:${item.id}`,
        Boolean(source)
          && item.includeAll.length > 0
          && item.includeAll.every((token) => source!.includes(token))
          && item.excludeAll.every((token) => !source!.includes(token)),
        `${item.path}: ${item.includeAll.length} required and ${item.excludeAll.length} forbidden tokens`,
      )
    }),
  ]
  const normalizedDigest = sha256(canonicalize({
    stage,
    candidateTreeSha: treeSha(candidateSha),
    assertions: assertions.map((item) => ({ id: item.id, status: item.status })),
  }))
  return {
    schemaVersion: 1,
    stage,
    candidateSha,
    candidateTreeSha: treeSha(candidateSha),
    contractBinding: { path: contractPath, sha256: sha256(contractSource) },
    assertions,
    normalizedDigest,
    status: assertions.every((item) => item.status === "pass") ? "pass" : "failed",
  } satisfies FounderOSStageContractReport
}

function parseArguments(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !["--stage", "--ref", "--out"].includes(key)) throw new Error(`Unknown argument: ${key ?? ""}`)
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if (!values.has("--stage") || !values.has("--ref") || !values.has("--out"))
    throw new Error("Required: --stage <id> --ref <full-sha> --out <report-path>")
  const candidateSha = exactCommit(values.get("--ref")!, "--ref")
  if (candidateSha !== exactCommit(Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
  }).stdout.toString().trim(), "HEAD")) throw new Error("Contract check must run at the exact candidate")
  return {
    stage: parseStage(values.get("--stage")),
    candidateSha,
    output: path.resolve(values.get("--out")!),
  }
}

if (import.meta.main) {
  await Promise.resolve()
    .then(() => parseArguments(Bun.argv.slice(2)))
    .then(async (options) => {
      const report = evaluateFounderOSStageContract(options.candidateSha, options.stage)
      await Bun.write(options.output, `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report))
      process.exitCode = report.status === "pass" ? 0 : 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 64
    })
}
