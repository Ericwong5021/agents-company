import path from "node:path"
import { generateAutomaticEvidence } from "./experience-automatic-evidence"
import { canonicalize, sha256 } from "./experience-benchmark"
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
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "agent-company-seed-grow-automatic-runner-binding",
          buildSha,
          stage,
          attemptId,
          stageRunnerSha256: sha256(await Bun.file(path.join(root, stageRunnerPath)).text()),
        },
        null,
        2,
      )}\n`,
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
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "agent-company-seed-grow-automatic-runner-binding",
        buildSha,
        stage,
        attemptId,
        stageRunnerSha256: sha256(
          await Bun.file(path.join(root, stageRunnerPath)).text(),
        ),
      },
      null,
      2,
    )}\n`,
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
    return blockedAttempt(
      output,
      stage,
      buildSha,
      attemptId,
      redactedError(generated.error),
      runnerBinding,
    )
  }
  const relativePackagePath = path
    .relative(output, generated.value.packagePath)
    .split(path.sep)
    .join("/")
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
  const ciEvidence = await writeFileBinding(
    output,
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
  const first = await executeAttempt(
    output,
    options.stage,
    options.buildSha,
    "attempt-01",
    stage.requiredCommandIds,
  )
  const second =
    first.status === "pass"
      ? await executeAttempt(
          output,
          options.stage,
          options.buildSha,
          "attempt-02",
          stage.requiredCommandIds,
        )
      : await blockedAttempt(
          output,
          options.stage,
          options.buildSha,
          "attempt-02",
          "not_executed_after_attempt_01",
        )
  const attempts = [first, second]
  const overallStatus: AttemptStatus = attempts.some((attempt) => attempt.status === "invalid")
    ? "invalid"
    : attempts.some((attempt) => attempt.status === "failed")
      ? "failed"
      : attempts.some((attempt) => attempt.status === "blocked")
        ? "blocked"
        : new Set(attempts.map((attempt) => attempt.normalizedDigest)).size === 1
          ? "pass"
          : "invalid"
  assertExactCandidate(options.buildSha, stage)
  const runnerSource = await Bun.file(path.join(root, stageRunnerPath)).text()
  const run = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    packageId: `SEED-GROW-${options.stage}-${options.buildSha.slice(0, 16)}-${path.basename(output)}`,
    stage: options.stage,
    capabilityPackage: stage.capabilityPackage,
    buildSha: options.buildSha,
    buildTreeSha: governance.buildTreeSha,
    contractBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-contract.v1.json",
      governance.contractSource,
    ),
    schemaBinding: sourceBinding(
      "docs/product-design/experience-refactor/seed-grow-stage-evidence.v1.json",
      governance.schemaSource,
    ),
    runnerBinding: sourceBinding(stageRunnerPath, runnerSource),
    validationProfile: governance.contract.validationProfile,
    githubActions: {
      ...governance.contract.githubActions,
      evidence: ciEvidence,
    },
    createdAt,
    finishedAt: new Date().toISOString(),
    attempts,
    coverage: stageCoverage(stage),
    overallStatus,
    advisory: [
      "github_actions_unavailable",
      `local_platform_only:${process.platform}-${process.arch}`,
    ],
  }
  const runPath = path.join(output, "run.json")
  await Bun.write(runPath, `${JSON.stringify(run, null, 2)}\n`)
  return {
    runPath,
    status: overallStatus,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      normalizedDigest: attempt.normalizedDigest,
    })),
  }
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
    stage.repeats !== 2
  ) {
    throw new Error("Seed-and-Grow evidence runner self-test failed.")
  }
  return {
    result: "pass",
    stages: governance.contract.stages.length,
    tasks: governance.contract.stages.flatMap((item) => item.taskIds).length,
    a0Commands: stage.requiredCommandIds.length,
    automaticCommands: governance.automaticCommandIDs.length,
    implementedStages: governance.contract.implementedStages,
    repeats: stage.repeats,
  }
}

function parseArguments(args: string[]) {
  const allowed = new Set(["--ref", "--stage", "--out"])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith("--") || !allowed.has(key) || !value || value.startsWith("--")) {
      throw new Error("Required arguments: --ref <full-sha> --stage <A0-B5> --out <empty-run-directory>")
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`)
    values.set(key, value)
  }
  if (args.length !== 6 || [...allowed].some((key) => !values.has(key))) {
    throw new Error("Required arguments: --ref <full-sha> --stage <A0-B5> --out <empty-run-directory>")
  }
  const stage = values.get("--stage")!
  if (!stageIDs.includes(stage as StageID)) throw new Error(`Invalid Seed-and-Grow stage: ${stage}`)
  return {
    buildSha: values.get("--ref")!,
    stage: stage as StageID,
    outputDirectory: values.get("--out")!,
  }
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === "--self-test") {
    console.log(JSON.stringify(await runSeedGrowEvidenceSelfTest(), null, 2))
  } else {
    await generateSeedGrowStageEvidence(parseArguments(Bun.argv.slice(2))).then(
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
