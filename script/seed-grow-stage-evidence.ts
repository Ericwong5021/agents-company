import fs from "node:fs/promises"
import path from "node:path"
import { generateAutomaticEvidence } from "./experience-automatic-evidence"
import { canonicalize, sha256 } from "./experience-benchmark"
import { evaluateAndWriteSeedGrowStageGate } from "./seed-grow-stage-gate"
import {
  assertExactCandidate,
  loadCurrentSeedGrowGovernance,
  loadSeedGrowGovernance,
  normalizeAutomaticPackage,
  prepareRunDirectory,
  root,
  sourceBinding,
  stageCoverage,
  stageDefinition,
  stageIDs,
  stageRunnerPath,
  writeFileBinding,
  type FileBinding,
  type StageID,
} from "./seed-grow-stage-core"

type AttemptStatus = "pass" | "failed" | "blocked" | "invalid"

type AttemptRecord = {
  id: string
  relativeDirectory: string
  automaticRunnerBinding: FileBinding
  automaticPackage: FileBinding
  normalizedDigest: string
  status: AttemptStatus
}

class StageUnavailableError extends Error {}

async function runnerBindingValue(buildSha: string, attemptId: string) {
  return {
    schemaVersion: 1,
    id: "agent-company-seed-grow-final-candidate-runner-binding",
    buildSha,
    attemptId,
    scope: "all_implemented_stages",
    stageRunnerSha256: sha256(await Bun.file(path.join(root, stageRunnerPath)).text()),
  }
}

function bindingFor(base: string, relativePath: string, bytes: Uint8Array, mediaType: string) {
  return {
    relativePath: path.relative(base, path.join(base, relativePath)).split(path.sep).join("/"),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  } satisfies FileBinding
}

async function existingBinding(base: string, relativePath: string, mediaType: string) {
  const bytes = new Uint8Array(await Bun.file(path.join(base, relativePath)).arrayBuffer())
  return bindingFor(base, relativePath, bytes, mediaType)
}

function attemptStatus(status: string): AttemptStatus {
  if (status === "pass") return "pass"
  if (status === "fail") return "failed"
  if (status === "incomplete") return "blocked"
  return "invalid"
}

function redactedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replaceAll(root, "<repo>")
    .replaceAll(process.env.HOME ?? "\u0000", "<home>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer <redacted>")
    .slice(0, 8_000)
}

async function blockedAttempt(
  output: string,
  stage: StageID,
  buildSha: string,
  attemptId: string,
  reason: string,
  existingRunnerBinding?: FileBinding,
) {
  const relativeDirectory = `attempts/${attemptId}`
  const runnerBinding =
    existingRunnerBinding ??
    (await writeFileBinding(
      output,
      `${relativeDirectory}/runner-binding.json`,
      `${JSON.stringify(await runnerBindingValue(buildSha, attemptId), null, 2)}\n`,
      "application/json",
    ))
  const automaticPackage = await writeFileBinding(
    output,
    `${relativeDirectory}/automatic-evidence-error.json`,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "blocked",
        reason,
      },
      null,
      2,
    )}\n`,
    "application/json",
  )
  return {
    id: attemptId,
    relativeDirectory,
    automaticRunnerBinding: runnerBinding,
    automaticPackage,
    normalizedDigest: sha256(canonicalize({ buildSha, stage, status: "blocked", reason })),
    status: "blocked",
  } satisfies AttemptRecord
}

async function executeAttempt(
  output: string,
  stage: StageID,
  buildSha: string,
  attemptId: string,
  requiredCommandIDs: string[],
) {
  const relativeDirectory = `attempts/${attemptId}`
  const runnerBinding = await writeFileBinding(
    output,
    `${relativeDirectory}/runner-binding.json`,
    `${JSON.stringify(await runnerBindingValue(buildSha, attemptId), null, 2)}\n`,
    "application/json",
  )
  const generated = await generateAutomaticEvidence({
    buildSha,
    runnerPath: path.join(output, runnerBinding.relativePath),
    outputDirectory: path.join(output, relativeDirectory, "automatic"),
  }).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  if (!generated.ok) {
    return blockedAttempt(output, stage, buildSha, attemptId, redactedError(generated.error), runnerBinding)
  }
  const relativePackagePath = path.relative(output, generated.value.packagePath).split(path.sep).join("/")
  const packageValue: unknown = await Bun.file(generated.value.packagePath).json()
  return {
    id: attemptId,
    relativeDirectory,
    automaticRunnerBinding: runnerBinding,
    automaticPackage: await existingBinding(output, relativePackagePath, "application/json"),
    normalizedDigest: normalizeAutomaticPackage(packageValue, requiredCommandIDs),
    status: attemptStatus(generated.value.validation.status),
  } satisfies AttemptRecord
}

function overallStatus(attempts: AttemptRecord[]): AttemptStatus {
  if (attempts.some((attempt) => attempt.status === "invalid")) return "invalid"
  if (attempts.some((attempt) => attempt.status === "failed")) return "failed"
  if (attempts.some((attempt) => attempt.status === "blocked")) return "blocked"
  return new Set(attempts.map((attempt) => attempt.normalizedDigest)).size === 1 ? "pass" : "invalid"
}

async function writeStageRun(options: {
  output: string
  stage: StageID
  buildSha: string
  governance: Awaited<ReturnType<typeof loadSeedGrowGovernance>>
  createdAt: string
  finishedAt: string
  attempts: AttemptRecord[]
}) {
  const stage = stageDefinition(options.governance.contract, options.stage)
  assertExactCandidate(options.buildSha, stage)
  const ciEvidence = await writeFileBinding(
    options.output,
    "ci/availability.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        provider: "github_actions",
        status: "unavailable",
        blocking: false,
        replacement: "two_local_exact_sha_runs",
        fabricatedRunIdentity: false,
        localPlatform: `${process.platform}-${process.arch}`,
      },
      null,
      2,
    )}\n`,
    "application/json",
  )
  const status = overallStatus(options.attempts)
  const runnerSource = await Bun.file(path.join(root, stageRunnerPath)).text()
  const run = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    packageId: `SEED-GROW-${options.stage}-${options.buildSha.slice(0, 16)}-${path.basename(options.output)}`,
    stage: options.stage,
    capabilityPackage: stage.capabilityPackage,
    buildSha: options.buildSha,
    buildTreeSha: options.governance.buildTreeSha,
    contractBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
      options.governance.contractSource,
    ),
    schemaBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
      options.governance.schemaSource,
    ),
    runnerBinding: sourceBinding(stageRunnerPath, runnerSource),
    validationProfile: options.governance.contract.validationProfile,
    githubActions: {
      ...options.governance.contract.githubActions,
      evidence: ciEvidence,
    },
    createdAt: options.createdAt,
    finishedAt: options.finishedAt,
    attempts: options.attempts,
    coverage: stageCoverage(stage),
    overallStatus: status,
    advisory: ["github_actions_unavailable", `local_platform_only:${process.platform}-${process.arch}`],
  }
  const runPath = path.join(options.output, "run.json")
  await Bun.write(runPath, `${JSON.stringify(run, null, 2)}\n`)
  return {
    runPath,
    status,
    attempts: options.attempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      normalizedDigest: attempt.normalizedDigest,
    })),
  }
}

export async function generateSeedGrowStageEvidence(options: {
  buildSha: string
  stage: StageID
  outputDirectory: string
}) {
  const governance = await loadSeedGrowGovernance(options.buildSha)
  const stage = stageDefinition(governance.contract, options.stage)
  if (!governance.contract.implementedStages.includes(options.stage)) {
    throw new StageUnavailableError(`Seed-and-Grow stage ${options.stage} is not implemented yet.`)
  }
  assertExactCandidate(options.buildSha, stage)
  const output = await prepareRunDirectory(options.outputDirectory)
  const createdAt = new Date().toISOString()
  const first = await executeAttempt(output, options.stage, options.buildSha, "attempt-01", stage.requiredCommandIds)
  const second =
    first.status === "pass"
      ? await executeAttempt(output, options.stage, options.buildSha, "attempt-02", stage.requiredCommandIds)
      : await blockedAttempt(output, options.stage, options.buildSha, "attempt-02", "not_executed_after_attempt_01")
  const attempts = [first, second]
  return writeStageRun({
    output,
    stage: options.stage,
    buildSha: options.buildSha,
    governance,
    createdAt,
    finishedAt: new Date().toISOString(),
    attempts,
  })
}

async function copyAttempt(options: {
  source: string
  output: string
  stage: StageID
  buildSha: string
  requiredCommandIds: string[]
  attempt: AttemptRecord
}) {
  await fs.cp(
    path.join(options.source, options.attempt.relativeDirectory),
    path.join(options.output, options.attempt.relativeDirectory),
    {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    },
  )
  const packagePath =
    options.attempt.status === "blocked"
      ? `${options.attempt.relativeDirectory}/automatic-evidence-error.json`
      : `${options.attempt.relativeDirectory}/automatic/automatic-evidence-package.json`
  const packageValue: unknown = await Bun.file(path.join(options.output, packagePath)).json()
  return {
    id: options.attempt.id,
    relativeDirectory: options.attempt.relativeDirectory,
    automaticRunnerBinding: await existingBinding(
      options.output,
      `${options.attempt.relativeDirectory}/runner-binding.json`,
      "application/json",
    ),
    automaticPackage: await existingBinding(options.output, packagePath, "application/json"),
    normalizedDigest:
      options.attempt.status === "blocked"
        ? sha256(
            canonicalize({
              buildSha: options.buildSha,
              stage: options.stage,
              status: "blocked",
              reason:
                typeof packageValue === "object" && packageValue !== null && "reason" in packageValue
                  ? packageValue.reason
                  : "invalid_blocked_attempt",
            }),
          )
        : normalizeAutomaticPackage(packageValue, options.requiredCommandIds),
    status: options.attempt.status,
  } satisfies AttemptRecord
}

export async function generateSeedGrowAllStageEvidence(options: { buildSha: string; outputDirectory: string }) {
  const governance = await loadSeedGrowGovernance(options.buildSha)
  if (
    governance.contract.implementedStages.length !== stageIDs.length ||
    !stageIDs.every((stage) => governance.contract.implementedStages.includes(stage))
  ) {
    throw new StageUnavailableError("Seed-and-Grow final evidence requires every A0-B5 stage to be implemented.")
  }
  governance.contract.stages.forEach((stage) => assertExactCandidate(options.buildSha, stage))
  const output = await prepareRunDirectory(options.outputDirectory)
  const outputName = path.basename(output)
  if (outputName.length > 61) {
    throw new Error("Seed-and-Grow all-stage output name must leave room for the stage suffix.")
  }
  const createdAt = new Date().toISOString()
  const first = await executeAttempt(output, "A0", options.buildSha, "attempt-01", governance.automaticCommandIDs)
  const second =
    first.status === "pass"
      ? await executeAttempt(output, "A0", options.buildSha, "attempt-02", governance.automaticCommandIDs)
      : await blockedAttempt(output, "A0", options.buildSha, "attempt-02", "not_executed_after_attempt_01")
  const sourceAttempts = [first, second]
  const finishedAt = new Date().toISOString()
  const stages = []
  for (const stageId of stageIDs) {
    const stage = stageDefinition(governance.contract, stageId)
    const stageOutput = await prepareRunDirectory(
      path.join(path.dirname(output), `${outputName}-${stageId.toLowerCase()}`),
    )
    const attempts = await Promise.all(
      sourceAttempts.map((attempt) =>
        copyAttempt({
          source: output,
          output: stageOutput,
          stage: stageId,
          buildSha: options.buildSha,
          requiredCommandIds: stage.requiredCommandIds,
          attempt,
        }),
      ),
    )
    const run = await writeStageRun({
      output: stageOutput,
      stage: stageId,
      buildSha: options.buildSha,
      governance,
      createdAt,
      finishedAt,
      attempts,
    })
    const decision = await evaluateAndWriteSeedGrowStageGate({
      buildSha: options.buildSha,
      stage: stageId,
      evidenceDirectory: stageOutput,
      outputPath: path.join(stageOutput, "stage-decision.json"),
    })
    stages.push({
      stage: stageId,
      evidenceDirectory: path.basename(stageOutput),
      runSha256: sha256(await Bun.file(run.runPath).text()),
      decisionSha256: sha256(await Bun.file(path.join(stageOutput, "stage-decision.json")).text()),
      status: decision.status,
    })
  }
  const status: AttemptStatus = stages.some((stage) => stage.status === "invalid")
    ? "invalid"
    : stages.some((stage) => stage.status === "failed")
      ? "failed"
      : stages.some((stage) => stage.status === "blocked")
        ? "blocked"
        : "pass"
  const manifestPath = path.join(output, "final-run.json")
  await Bun.write(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "agent-company-seed-grow-final-candidate-evidence",
        buildSha: options.buildSha,
        buildTreeSha: governance.buildTreeSha,
        createdAt,
        finishedAt,
        automaticAttempts: sourceAttempts.map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          normalizedDigest: attempt.normalizedDigest,
        })),
        stages,
        status,
      },
      null,
      2,
    )}\n`,
  )
  const finalRun = await existingBinding(output, "final-run.json", "application/json")
  const finalDecisionPath = path.join(output, "final-decision.json")
  await Bun.write(
    finalDecisionPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "agent-company-seed-grow-final-decision",
        buildSha: options.buildSha,
        buildTreeSha: governance.buildTreeSha,
        finalRun,
        required: [...stageIDs],
        passed: stages.filter((stage) => stage.status === "pass").map((stage) => stage.stage),
        failed: stages.filter((stage) => stage.status === "failed").map((stage) => stage.stage),
        blocked: stages.filter((stage) => stage.status === "blocked").map((stage) => stage.stage),
        invalid: stages.filter((stage) => stage.status === "invalid").map((stage) => stage.stage),
        missing: stageIDs.filter((stage) => !stages.some((item) => item.stage === stage)),
        stages,
        decidedAt: finishedAt,
        status,
        advisory: ["github_actions_unavailable", `local_platform_only:${process.platform}-${process.arch}`],
      },
      null,
      2,
    )}\n`,
  )
  return { manifestPath, finalDecisionPath, status, stages }
}

export async function runSeedGrowEvidenceSelfTest() {
  const governance = await loadCurrentSeedGrowGovernance()
  const stage = stageDefinition(governance.contract, "A0")
  const implemented = governance.contract.stages.filter((item) =>
    governance.contract.implementedStages.includes(item.id),
  )
  if (
    governance.contract.stages.length !== stageIDs.length ||
    governance.contract.stages.flatMap((item) => item.taskIds).length !== 90 ||
    !implemented.every((item) =>
      item.requiredCommandIds.every((command) => governance.automaticCommandIDs.includes(command)),
    ) ||
    stageDefinition(governance.contract, "A1").requiredCommandIds.length !== 3 ||
    stageDefinition(governance.contract, "A2").requiredCommandIds.length !== 4 ||
    stageDefinition(governance.contract, "A3").requiredCommandIds.length !== 3 ||
    stageDefinition(governance.contract, "A4").requiredCommandIds.length !== 1 ||
    stageDefinition(governance.contract, "B0").requiredCommandIds.length !== 3 ||
    stageDefinition(governance.contract, "B1").requiredCommandIds.length !== 3 ||
    stageDefinition(governance.contract, "B2").requiredCommandIds.length !== 2 ||
    stageDefinition(governance.contract, "B3").requiredCommandIds.length !== 2 ||
    stageDefinition(governance.contract, "B4").requiredCommandIds.length !== 3 ||
    stageDefinition(governance.contract, "B5").requiredCommandIds.length !== 4 ||
    governance.contract.implementedStages.length !== stageIDs.length ||
    governance.contract.commandRegistry.plannedStageCommands.length !== 0 ||
    stage.repeats !== 2
  ) {
    throw new Error("Seed-and-Grow evidence runner self-test failed.")
  }
  return {
    result: "pass",
    stages: governance.contract.stages.length,
    tasks: governance.contract.stages.flatMap((item) => item.taskIds).length,
    a0Commands: stage.requiredCommandIds.length,
    a2Commands: stageDefinition(governance.contract, "A2").requiredCommandIds.length,
    a3Commands: stageDefinition(governance.contract, "A3").requiredCommandIds.length,
    a4Commands: stageDefinition(governance.contract, "A4").requiredCommandIds.length,
    b3Commands: stageDefinition(governance.contract, "B3").requiredCommandIds.length,
    b4Commands: stageDefinition(governance.contract, "B4").requiredCommandIds.length,
    b5Commands: stageDefinition(governance.contract, "B5").requiredCommandIds.length,
    automaticCommands: governance.automaticCommandIDs.length,
    implementedStages: governance.contract.implementedStages,
    repeats: stage.repeats,
  }
}

function parseArguments(args: string[]) {
  const allowed = new Set(["--ref", "--stage", "--out"])
  const values = new Map<string, string>()
  let all = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    if (key === "--all") {
      if (all) throw new Error("Duplicate argument: --all")
      all = true
      continue
    }
    const value = args[index + 1]
    if (!allowed.has(key) || !value || value.startsWith("--"))
      throw new Error("Required arguments: --ref <full-sha> (--stage <A0-B5> | --all) --out <empty-run-directory>")
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
    index += 1
  }
  if (!values.has("--ref") || !values.has("--out") || all === values.has("--stage")) {
    throw new Error("Required arguments: --ref <full-sha> (--stage <A0-B5> | --all) --out <empty-run-directory>")
  }
  if (all)
    return {
      mode: "all" as const,
      buildSha: values.get("--ref")!,
      outputDirectory: values.get("--out")!,
    }
  const stage = values.get("--stage")!
  if (!stageIDs.includes(stage as StageID)) throw new Error(`Invalid Seed-and-Grow stage: ${stage}`)
  return {
    mode: "stage" as const,
    buildSha: values.get("--ref")!,
    stage: stage as StageID,
    outputDirectory: values.get("--out")!,
  }
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === "--self-test") {
    console.log(JSON.stringify(await runSeedGrowEvidenceSelfTest(), null, 2))
  } else {
    const options = parseArguments(Bun.argv.slice(2))
    const execution =
      options.mode === "all" ? generateSeedGrowAllStageEvidence(options) : generateSeedGrowStageEvidence(options)
    await execution.then(
      (result) => {
        console.log(JSON.stringify(result, null, 2))
        process.exitCode =
          result.status === "pass" ? 0 : result.status === "failed" ? 1 : result.status === "blocked" ? 2 : 64
      },
      (error) => {
        console.error(redactedError(error))
        process.exitCode = error instanceof StageUnavailableError ? 2 : 64
      },
    )
  }
}
