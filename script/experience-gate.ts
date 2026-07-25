import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"
import {
  generateAutomaticEvidence,
  validateAutomaticEvidencePackage,
  writeStructuralAutomaticEvidenceFixture,
  type AutomaticEvidenceGovernance,
} from "./experience-automatic-evidence"
import {
  canonicalize,
  deterministicHumanReviewSelection,
  normalizeExecutionRecord,
  normalizedEvidenceSummary,
  readBenchmarkContracts,
  sha256,
  validateArtifactFiles,
  validateExecutionRecord,
  verifyExactCommit,
  type BenchmarkContract,
  type ExecutionRecord,
  type RecordContract,
} from "./experience-benchmark"

const root = path.resolve(import.meta.dir, "..")
const protocolRelativePath = "docs/product-design/experience-refactor/human-research-protocol.v1.json"
const evidenceSchemaRelativePath = "docs/product-design/experience-refactor/human-evidence-package.v1.json"
const languageContractRelativePath = "docs/product-design/experience-refactor/language-contract.v1.json"
const benchmarkRelativePath = "docs/product-design/experience-refactor/benchmark-scenarios.v1.json"
const benchmarkRecordRelativePath = "docs/product-design/experience-refactor/benchmark-execution-record.v1.json"
const metricContractRelativePath = "docs/product-design/experience-refactor/metric-contract.v1.json"
const manifestRelativePath = "docs/product-design/experience-refactor/manifest.v1.json"
const governedExecutionPaths = [
  protocolRelativePath,
  evidenceSchemaRelativePath,
  languageContractRelativePath,
  benchmarkRelativePath,
  benchmarkRecordRelativePath,
  metricContractRelativePath,
  manifestRelativePath,
  "script/experience-gate.ts",
  "script/experience-benchmark.ts",
  "script/experience-automatic-evidence.ts",
]
const humanSignatureNamespace = "agent-company-r0-human-evidence"
const humanSignerIdentity = "agent-company-r0-release-owner"
const languageSignoffRoles = ["product", "design", "frontend", "backend"]
const languageSignoffAttestation =
  "I reviewed the identified language contract for the identified build and approve it for my named role."
const scenarioIDs = Array.from({ length: 12 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`)
const runIDs = ["run-01", "run-02"]
const selectedScenarioIDs = ["S05", "S02", "S01"]
const hr01PromptIDs = Array.from({ length: 12 }, (_, index) => `HR01-P${String(index + 1).padStart(2, "0")}`)
const hr01StateIDs = [
  "needs_input",
  "ready",
  "running",
  "paused",
  "blocked",
  "needs_approval",
  "reviewing",
  "revision",
  "delivered",
  "accepted",
  "failed",
  "cancelled",
]
const hr01Presentation =
  "Show the release-candidate state card with its state label hidden. Do not explain the state before the response."
const hr01ExactPrompt = "请用自己的话回答三个问题：现在发生了什么？为什么这件事重要？你下一步会怎么做？"
const hr02QuestionIDs = ["HR02-Q1", "HR02-Q2", "HR02-Q3"]
const hr03Surfaces = ["First-run", "Inbox", "Goal Brief", "Running", "Blocked", "Gate", "Delivery", "Team"]
const screenshotMinimum = { width: 1280, height: 720 }
const stimulusMinimum = { width: 600, height: 140 }
const attestation =
  "I reviewed the recorded raw responses or artifacts against this protocol and attest that the submitted decisions are accurate for the identified build."

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sameValues(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item))
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return sameValues(Object.keys(value), keys)
}

function validDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function validName(value: unknown) {
  return typeof value === "string" && value.trim().length >= 2
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
}

function validReleaseTrustAnchor(value: unknown) {
  if (!isRecord(value)) return false
  if (value.allowedSignersSha256 === null && value.trustAnchorStatus === "not_configured") return true
  return (
    typeof value.allowedSignersSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.allowedSignersSha256) &&
    value.trustAnchorStatus === "configured"
  )
}

async function readJson(file: string) {
  const source = await Bun.file(file).text()
  return {
    source,
    value: JSON.parse(source) as unknown,
    sha256: sha256(source),
  }
}

function readAtBuild(buildSha: string, file: string) {
  const result = Bun.spawnSync(["git", "show", `${buildSha}:${file}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `Missing ${file} at ${buildSha}.`)
  return result.stdout.toString()
}

async function readGovernedSources(buildSha?: string) {
  const entries = await Promise.all(
    governedExecutionPaths.map(async (relativePath) => {
      const currentSource = await Bun.file(path.join(root, relativePath)).text()
      if (!buildSha) return [relativePath, currentSource] as const
      const buildSource = readAtBuild(buildSha, relativePath)
      if (sha256(buildSource) !== sha256(currentSource)) {
        throw new Error(`Gate governance differs from exact build ${buildSha}: ${relativePath}`)
      }
      return [relativePath, buildSource] as const
    }),
  )
  return Object.fromEntries(entries)
}

function governedJson(sources: Record<string, string>, relativePath: string) {
  const source = sources[relativePath]
  if (source === undefined) throw new Error(`Missing governed source: ${relativePath}`)
  return {
    source,
    value: JSON.parse(source) as unknown,
    sha256: sha256(source),
  }
}

function confinedRelativePath(relativePath: unknown) {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]/).includes("..")
  )
}

async function resolveConfinedFile(base: string, relativePath: string) {
  const baseRealPath = await fs.realpath(base)
  const absolutePath = path.resolve(base, relativePath)
  if (!absolutePath.startsWith(`${path.resolve(base)}${path.sep}`)) return null
  const realPath = await fs.realpath(absolutePath).catch(() => null)
  if (!realPath || !realPath.startsWith(`${baseRealPath}${path.sep}`)) return null
  return realPath
}

function validateSignoff(value: unknown, label: string, errors: string[]) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["method", "signedBy", "role", "signedAt", "attestation"]) ||
    value.method !== "named_human_attestation" ||
    !validName(value.signedBy) ||
    !validName(value.role) ||
    !validDate(value.signedAt) ||
    value.attestation !== attestation
  ) {
    errors.push(`${label}: invalid named attestation`)
  }
}

async function loadGovernance(buildSha?: string) {
  const sources = await readGovernedSources(buildSha)
  const protocol = governedJson(sources, protocolRelativePath)
  const evidenceSchema = governedJson(sources, evidenceSchemaRelativePath)
  const languageContract = governedJson(sources, languageContractRelativePath)
  const metricContract = governedJson(sources, metricContractRelativePath)
  const manifest = governedJson(sources, manifestRelativePath)
  const { benchmark, recordContract } = await readBenchmarkContracts()
  if (
    !isRecord(protocol.value) ||
    protocol.value.schemaVersion !== 1 ||
    protocol.value.id !== "agent-company-r0-human-research" ||
    protocol.value.version !== "1.0.0" ||
    protocol.value.gate !== "R0" ||
    !isRecord(protocol.value.studies) ||
    !isRecord(protocol.value.signoff) ||
    protocol.value.signoff.requiredAttestation !== attestation ||
    !isRecord(protocol.value.releaseAuthorization) ||
    protocol.value.releaseAuthorization.method !== "openssh_detached_signature" ||
    protocol.value.releaseAuthorization.namespace !== humanSignatureNamespace ||
    protocol.value.releaseAuthorization.principal !== humanSignerIdentity ||
    protocol.value.releaseAuthorization.signedPayload !== "exact_human_evidence_package_bytes" ||
    protocol.value.releaseAuthorization.allowedSignersSource !== "external_release_owner_file" ||
    !validReleaseTrustAnchor(protocol.value.releaseAuthorization) ||
    protocol.value.releaseAuthorization.unsignedStatus !== "incomplete" ||
    !isRecord(evidenceSchema.value) ||
    evidenceSchema.value.schemaVersion !== 1 ||
    evidenceSchema.value.packageVersion !== "1.1.0" ||
    !isRecord(languageContract.value) ||
    languageContract.value.schemaVersion !== 1 ||
    !isRecord(metricContract.value) ||
    metricContract.value.schemaVersion !== 1 ||
    metricContract.value.id !== "agent-company-experience-metrics" ||
    !isRecord(manifest.value) ||
    manifest.value.schemaVersion !== 1 ||
    manifest.value.id !== "agent-company-experience-refactor-governance" ||
    !isRecord(manifest.value.humanResearchPolicy) ||
    !isRecord(manifest.value.humanResearchPolicy.releaseAuthorization) ||
    manifest.value.humanResearchPolicy.releaseAuthorization.method !== "openssh_detached_signature" ||
    manifest.value.humanResearchPolicy.releaseAuthorization.namespace !== humanSignatureNamespace ||
    manifest.value.humanResearchPolicy.releaseAuthorization.principal !== humanSignerIdentity ||
    manifest.value.humanResearchPolicy.releaseAuthorization.allowedSignersLocation !== "outside_repository" ||
    !validReleaseTrustAnchor(manifest.value.humanResearchPolicy.releaseAuthorization) ||
    manifest.value.humanResearchPolicy.releaseAuthorization.unsignedStatus !== "incomplete" ||
    manifest.value.humanResearchPolicy.releaseAuthorization.allowedSignersSha256 !==
      protocol.value.releaseAuthorization.allowedSignersSha256 ||
    manifest.value.humanResearchPolicy.releaseAuthorization.trustAnchorStatus !==
      protocol.value.releaseAuthorization.trustAnchorStatus
  ) {
    throw new Error("R0 gate governance is invalid.")
  }
  const hr01 = protocol.value.studies["HR-01"]
  const languageSignoff = protocol.value.studies["FND-02-LANGUAGE-SIGNOFF"]
  const hr02 = protocol.value.studies["HR-02"]
  const hr03 = protocol.value.studies["HR-03"]
  const spot = protocol.value.studies["FND-03-SPOT-CHECK"]
  if (
    !isRecord(languageSignoff) ||
    !sameValues(stringArray(languageSignoff.requiredRoles), languageSignoffRoles) ||
    languageSignoff.languageContractPath !== languageContractRelativePath ||
    languageSignoff.attestation !== languageSignoffAttestation ||
    !isRecord(hr01) ||
    hr01.moderatorScriptVersion !== "HR01-v1" ||
    hr01.minimumParticipants !== 3 ||
    hr01.presentation !== hr01Presentation ||
    hr01.exactPrompt !== hr01ExactPrompt ||
    !isRecord(hr01.scoring) ||
    hr01.scoring.threshold !== 0.9 ||
    hr01.scoring.requiredPromptsPerParticipant !== 12 ||
    !Array.isArray(hr01.prompts) ||
    !sameValues(
      hr01.prompts.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
      hr01PromptIDs,
    ) ||
    canonicalize(
      hr01.prompts.flatMap((item) =>
        isRecord(item) && typeof item.id === "string" && typeof item.stateId === "string"
          ? [{ promptId: item.id, stateId: item.stateId }]
          : [],
      ),
    ) !== canonicalize(hr01PromptIDs.map((promptId, index) => ({ promptId, stateId: hr01StateIDs[index] }))) ||
    !isRecord(hr02) ||
    hr02.moderatorScriptVersion !== "HR02-v1" ||
    hr02.requiredParticipants !== 5 ||
    !isRecord(hr02.exposure) ||
    hr02.exposure.durationSeconds !== 10 ||
    !Array.isArray(hr02.questions) ||
    !sameValues(
      hr02.questions.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
      hr02QuestionIDs,
    ) ||
    !isRecord(hr03) ||
    hr03.reviewScriptVersion !== "HR03-v1" ||
    !sameValues(stringArray(hr03.requiredSurfaces), hr03Surfaces) ||
    !isRecord(spot) ||
    spot.reviewScriptVersion !== "FND03-SPOT-v1" ||
    spot.selectionSeed !== 20260725 ||
    spot.selectionRate !== 0.2 ||
    spot.rounding !== "ceil" ||
    !sameValues(stringArray(spot.expectedSelectedScenarioIds), selectedScenarioIDs)
  ) {
    throw new Error("Human research protocol does not preserve the required R0 studies.")
  }
  return {
    protocol,
    evidenceSchema,
    languageContract,
    metricContract,
    manifest,
    releaseAuthorization: {
      allowedSignersSha256:
        typeof protocol.value.releaseAuthorization.allowedSignersSha256 === "string"
          ? protocol.value.releaseAuthorization.allowedSignersSha256
          : null,
    },
    benchmark,
    recordContract,
    digests: Object.fromEntries(
      Object.entries(sources).map(([relativePath, source]) => [relativePath, sha256(source)]),
    ),
  }
}

async function validateRunner(
  buildSha: string,
  runnerPath: string,
  benchmark: BenchmarkContract,
  recordContract: RecordContract,
) {
  const errors: string[] = []
  const runnerFile = path.resolve(runnerPath)
  const runner = await readJson(runnerFile).catch(() => null)
  if (!runner || !isRecord(runner.value)) {
    return {
      errors: ["runner: missing or invalid reproducibility record"],
      runnerFile,
      runnerSha256: null,
      recordDigests: new Map<string, string[]>(),
      automaticFailures: [] as string[],
    }
  }
  const contractScenarioIDs = benchmark.scenarios.map((scenario) => scenario.id)
  const contractRunIDs = Array.from({ length: 2 }, (_, index) => `run-${String(index + 1).padStart(2, "0")}`)
  const selection = deterministicHumanReviewSelection(benchmark.scenarios, recordContract)
  const expectedRunnerKeys = [
    "recordSchemaVersion",
    "buildSha",
    "gate",
    "repeats",
    "runnerSuccessMeaning",
    "ignoredForReproducibility",
    "selectedForHumanReview",
    "humanReviewSeed",
    "executionRecords",
    "scenarios",
    "reproducible",
    "scenarioDecisions",
    "r0ScenarioPass",
    "runnerDecision",
  ]
  if (
    !exactKeys(runner.value, expectedRunnerKeys) ||
    runner.value.recordSchemaVersion !== recordContract.schemaVersion ||
    runner.value.buildSha !== buildSha ||
    runner.value.gate !== "R0" ||
    runner.value.repeats !== 2 ||
    runner.value.runnerSuccessMeaning !== recordContract.governance.runnerSuccessMeaning ||
    canonicalize(runner.value.ignoredForReproducibility) !==
      canonicalize(recordContract.governance.reproducibilityIgnoredFields) ||
    runner.value.humanReviewSeed !== recordContract.governance.spotCheck.seed ||
    canonicalize(runner.value.selectedForHumanReview) !== canonicalize(selection.ids) ||
    canonicalize(selection.ids) !== canonicalize(selectedScenarioIDs) ||
    !sameValues(contractScenarioIDs, scenarioIDs)
  ) {
    errors.push("runner: build, contract, repeatability, or deterministic selection mismatch")
  }
  const inventory = Array.isArray(runner.value.executionRecords) ? runner.value.executionRecords : []
  if (inventory.length !== contractScenarioIDs.length * contractRunIDs.length)
    errors.push("runner: exactly two execution records per contracted scenario are required")
  const inventoryKeys = inventory.flatMap((item) =>
    isRecord(item) && typeof item.scenarioId === "string" && typeof item.runId === "string"
      ? [`${item.scenarioId}/${item.runId}`]
      : [],
  )
  const expectedInventoryKeys = contractScenarioIDs.flatMap((scenarioID) =>
    contractRunIDs.map((runID) => `${scenarioID}/${runID}`),
  )
  if (!sameValues(inventoryKeys, expectedInventoryKeys)) errors.push("runner: scenario/repeat inventory is incomplete")
  const validatedRecords = (
    await Promise.all(
      inventory.map(async (item) => {
        if (
          !isRecord(item) ||
          !exactKeys(item, ["scenarioId", "runId", "relativePath", "sha256"]) ||
          typeof item.scenarioId !== "string" ||
          typeof item.runId !== "string" ||
          !confinedRelativePath(item.relativePath) ||
          typeof item.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.sha256) ||
          item.relativePath !== path.join(item.scenarioId, item.runId, "execution-record.json")
        ) {
          errors.push("runner: malformed execution record inventory entry")
          return null
        }
        const scenarioID = item.scenarioId
        const runID = item.runId
        const label = `${scenarioID}/${runID}`
        const scenario = benchmark.scenarios.find((candidate) => candidate.id === scenarioID)
        if (!scenario || !contractRunIDs.includes(runID)) {
          errors.push(`${label}: scenario or run is outside the benchmark contract`)
          return null
        }
        const recordPath = await resolveConfinedFile(path.dirname(runnerFile), item.relativePath)
        if (!recordPath) {
          errors.push(`${label}: execution record escaped or is missing`)
          return null
        }
        const record = await readJson(recordPath).catch(() => null)
        if (!record || record.sha256 !== item.sha256 || !isRecord(record.value)) {
          errors.push(`${label}: execution record digest mismatch`)
          return null
        }
        const executionRecord = record.value as ExecutionRecord
        const contractErrors = await Promise.resolve()
          .then(() => validateExecutionRecord(executionRecord, scenario, benchmark, recordContract, buildSha))
          .catch(() => [`${label}: execution record has a malformed contract shape`])
        if (contractErrors.length) {
          errors.push(...contractErrors.map((error) => `${label}: ${error}`))
          return null
        }
        const artifactErrors = await validateArtifactFiles(executionRecord, path.dirname(recordPath)).catch(() => [
          `${label}: artifact validator rejected a malformed artifact`,
        ])
        if (artifactErrors.length) {
          errors.push(...artifactErrors.map((error) => `${label}: ${error}`))
          return null
        }
        const expectedSelected = selection.ids.includes(scenarioID)
        if (
          executionRecord.humanReview.selected !== expectedSelected ||
          executionRecord.humanReview.status !== (expectedSelected ? "human_pending" : "not_selected") ||
          executionRecord.humanReview.selectionSeed !== recordContract.governance.spotCheck.seed ||
          executionRecord.humanReview.selectionRank !== selection.rank.get(scenarioID)
        ) {
          errors.push(`${label}: deterministic human-review projection mismatch`)
          return null
        }
        return {
          scenarioId: scenarioID,
          runId: runID,
          record: executionRecord,
          recordSha256: record.sha256,
          normalizedDigest: sha256(canonicalize(normalizeExecutionRecord(executionRecord))),
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => Boolean(item))
  const recordsForScenario = (scenarioID: string) =>
    validatedRecords.filter((item) => item.scenarioId === scenarioID).sort((a, b) => a.runId.localeCompare(b.runId))
  const expectedReproducibility = contractScenarioIDs.map((scenarioID) => {
    const normalizedDigests = recordsForScenario(scenarioID).map((item) => item.normalizedDigest)
    return {
      scenarioId: scenarioID,
      normalizedDigests,
      match: normalizedDigests.length === 2 && normalizedDigests[0] === normalizedDigests[1],
    }
  })
  if (
    canonicalize(runner.value.scenarios) !== canonicalize(expectedReproducibility) ||
    expectedReproducibility.some((item) => !item.match)
  ) {
    errors.push("runner: normalized repeat digests were not recomputed from both execution records")
  }
  const expectedScenarioDecisions = contractScenarioIDs.map((scenarioID) => {
    const scenarioRecords = recordsForScenario(scenarioID).map((item) => item.record)
    return {
      scenarioId: scenarioID,
      decisions: scenarioRecords.map((record) => record.finalDecision),
      eligibleForR0:
        scenarioRecords.length === 2 && scenarioRecords.every((record) => record.eligibility.includedInGateDenominator),
    }
  })
  const eligibleRecords = validatedRecords
    .map((item) => item.record)
    .filter((record) => record.eligibility.includedInGateDenominator)
  const expectedReproducible =
    validatedRecords.length === expectedInventoryKeys.length && expectedReproducibility.every((item) => item.match)
  const expectedR0ScenarioPass =
    eligibleRecords.length > 0 && eligibleRecords.every((record) => record.finalDecision === "pass")
  if (
    canonicalize(runner.value.scenarioDecisions) !== canonicalize(expectedScenarioDecisions) ||
    runner.value.reproducible !== expectedReproducible ||
    runner.value.r0ScenarioPass !== expectedR0ScenarioPass ||
    runner.value.runnerDecision !== (expectedReproducible ? "complete" : "reproducibility_failed")
  ) {
    errors.push("runner: scenario decisions or aggregate summary do not match validated records")
  }
  const recordDigests = new Map(
    contractScenarioIDs.map((scenarioID) => [
      scenarioID,
      recordsForScenario(scenarioID).map((item) => item.recordSha256),
    ]),
  )
  const automaticFailures = validatedRecords
    .flatMap((item) =>
      item.record.criterionResults
        .filter(
          (criterion) =>
            criterion.gateEligibility.includedInGateDecision &&
            !criterion.humanEvidenceRequired &&
            ["fail", "not_evaluated"].includes(criterion.status),
        )
        .map(
          (criterion) =>
            `${item.scenarioId}/${item.runId}/${criterion.criterionId}:${criterion.status}${
              criterion.failureReason ? `:${criterion.failureReason}` : ""
            }`,
        ),
    )
    .sort()
  return {
    errors,
    runnerFile,
    runnerSha256: runner.sha256,
    recordDigests,
    automaticFailures,
  }
}

async function validateHR01StimulusSet(
  value: unknown,
  evidenceFile: string,
  buildSha: string,
  protocolSha256: string,
  errors: string[],
) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "buildSha",
      "manifestRelativePath",
      "manifestSha256",
      "stateLabelHidden",
      "presentedToAllParticipants",
    ]) ||
    value.buildSha !== buildSha ||
    !confinedRelativePath(value.manifestRelativePath) ||
    typeof value.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    value.stateLabelHidden !== true ||
    value.presentedToAllParticipants !== true
  ) {
    errors.push("HR-01: invalid release-candidate stimulus binding")
    return
  }
  const base = path.dirname(evidenceFile)
  const manifestPath = await resolveConfinedFile(base, value.manifestRelativePath)
  const manifest = manifestPath ? await readJson(manifestPath).catch(() => null) : null
  if (
    !manifest ||
    manifest.sha256 !== value.manifestSha256 ||
    !isRecord(manifest.value) ||
    !exactKeys(manifest.value, [
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
    manifest.value.schemaVersion !== 1 ||
    manifest.value.buildSha !== buildSha ||
    manifest.value.presentation !== hr01Presentation ||
    manifest.value.exactPrompt !== hr01ExactPrompt ||
    manifest.value.stateLabelHidden !== true ||
    manifest.value.relativePathBase !== "build-artifact-root" ||
    !isRecord(manifest.value.protocol) ||
    !exactKeys(manifest.value.protocol, ["id", "version", "sha256", "studyId", "moderatorScriptVersion"]) ||
    manifest.value.protocol.id !== "agent-company-r0-human-research" ||
    manifest.value.protocol.version !== "1.0.0" ||
    manifest.value.protocol.sha256 !== protocolSha256 ||
    manifest.value.protocol.studyId !== "HR-01" ||
    manifest.value.protocol.moderatorScriptVersion !== "HR01-v1" ||
    !isRecord(manifest.value.viewport) ||
    !exactKeys(manifest.value.viewport, ["width", "height"]) ||
    manifest.value.viewport.width !== 1440 ||
    manifest.value.viewport.height !== 1600 ||
    !Array.isArray(manifest.value.stimuli) ||
    manifest.value.stimuli.length !== 12
  ) {
    errors.push("HR-01: stimulus manifest is missing, mismatched, or structurally invalid")
    return
  }
  const expected = hr01PromptIDs.map((promptId, index) => ({ promptId, stateId: hr01StateIDs[index] }))
  const observed: Array<{ promptId: string; stateId: string }> = []
  const stimulusPaths: string[] = []
  const stimulusDigests: string[] = []
  for (const [index, stimulus] of manifest.value.stimuli.entries()) {
    if (
      !isRecord(stimulus) ||
      !exactKeys(stimulus, ["promptId", "stateId", "relativePath", "sha256"]) ||
      typeof stimulus.promptId !== "string" ||
      typeof stimulus.stateId !== "string" ||
      !confinedRelativePath(stimulus.relativePath) ||
      path.posix.basename(stimulus.relativePath.replaceAll("\\", "/")) !== `${stimulus.promptId}.png` ||
      typeof stimulus.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(stimulus.sha256)
    ) {
      errors.push(`HR-01 stimulus ${index + 1}: invalid identity, path, or digest`)
      continue
    }
    observed.push({ promptId: stimulus.promptId, stateId: stimulus.stateId })
    const stimulusPath = await resolveConfinedFile(base, stimulus.relativePath)
    const bytes = stimulusPath ? new Uint8Array(await Bun.file(stimulusPath).arrayBuffer()) : null
    const image = bytes
      ? await sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 })
          .toBuffer({ resolveWithObject: true })
          .catch(() => null)
      : null
    if (
      !stimulusPath ||
      !bytes ||
      sha256(bytes) !== stimulus.sha256 ||
      image?.info.format !== "png" ||
      image.info.width < stimulusMinimum.width ||
      image.info.height < stimulusMinimum.height
    ) {
      errors.push(`HR-01 ${stimulus.promptId}: stimulus is missing, escaped, invalid, too small, or digest-mismatched`)
      continue
    }
    stimulusPaths.push(stimulusPath)
    stimulusDigests.push(stimulus.sha256)
  }
  if (canonicalize(observed) !== canonicalize(expected)) errors.push("HR-01: prompt and state stimulus set mismatch")
  if (new Set(stimulusPaths).size !== 12) errors.push("HR-01: stimulus paths must be unique")
  if (new Set(stimulusDigests).size !== 12) errors.push("HR-01: stimulus contents must be unique")
}

async function validateHumanEvidence(
  value: unknown,
  evidenceFile: string,
  buildSha: string,
  runner: Awaited<ReturnType<typeof validateRunner>>,
  protocolSha256: string,
  languageContractSha256: string,
) {
  const errors: string[] = []
  const failures: string[] = []
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "packageVersion",
      "packageId",
      "buildSha",
      "protocolBinding",
      "runnerBinding",
      "createdAt",
      "studies",
      "packageSignoff",
    ])
  ) {
    return { errors: ["evidence package: top-level schema mismatch"], failures }
  }
  if (
    value.schemaVersion !== 1 ||
    value.packageVersion !== "1.1.0" ||
    typeof value.packageId !== "string" ||
    !/^R0-[a-z0-9-]{8,64}$/.test(value.packageId) ||
    value.buildSha !== buildSha ||
    !validDate(value.createdAt)
  ) {
    errors.push("evidence package: identity, build, or timestamp mismatch")
  }
  if (
    !isRecord(value.protocolBinding) ||
    !exactKeys(value.protocolBinding, ["id", "version", "sha256"]) ||
    value.protocolBinding.id !== "agent-company-r0-human-research" ||
    value.protocolBinding.version !== "1.0.0" ||
    value.protocolBinding.sha256 !== protocolSha256
  ) {
    errors.push("evidence package: protocol binding mismatch")
  }
  if (
    !isRecord(value.runnerBinding) ||
    !exactKeys(value.runnerBinding, ["relativePath", "sha256"]) ||
    typeof value.runnerBinding.relativePath !== "string" ||
    path.isAbsolute(value.runnerBinding.relativePath) ||
    value.runnerBinding.sha256 !== runner.runnerSha256 ||
    (await fs
      .realpath(path.resolve(path.dirname(evidenceFile), value.runnerBinding.relativePath))
      .catch(() => null)) !== (await fs.realpath(runner.runnerFile).catch(() => null))
  ) {
    errors.push("evidence package: runner artifact binding mismatch")
  }
  if (
    !isRecord(value.studies) ||
    !exactKeys(value.studies, ["FND-02-LANGUAGE-SIGNOFF", "HR-01", "HR-02", "HR-03", "FND-03-SPOT-CHECK"])
  ) {
    errors.push("evidence package: required study set mismatch")
    return { errors, failures }
  }
  const languageSignoff = value.studies["FND-02-LANGUAGE-SIGNOFF"]
  if (
    !isRecord(languageSignoff) ||
    !exactKeys(languageSignoff, ["buildSha", "languageContract", "approvals"]) ||
    languageSignoff.buildSha !== buildSha ||
    !isRecord(languageSignoff.languageContract) ||
    !exactKeys(languageSignoff.languageContract, ["path", "sha256"]) ||
    languageSignoff.languageContract.path !== languageContractRelativePath ||
    languageSignoff.languageContract.sha256 !== languageContractSha256 ||
    !Array.isArray(languageSignoff.approvals) ||
    languageSignoff.approvals.length !== 4
  ) {
    errors.push("FND-02 language contract: build, contract digest, or four-role approvals are missing")
  } else {
    const roles: string[] = []
    const names: string[] = []
    languageSignoff.approvals.forEach((approval, index) => {
      if (
        !isRecord(approval) ||
        !exactKeys(approval, ["role", "signedBy", "signedAt", "attestation"]) ||
        typeof approval.role !== "string" ||
        !languageSignoffRoles.includes(approval.role) ||
        !validName(approval.signedBy) ||
        !validDate(approval.signedAt) ||
        approval.attestation !== languageSignoffAttestation
      ) {
        errors.push(`FND-02 language contract approval ${index + 1}: invalid named role attestation`)
        return
      }
      roles.push(approval.role)
      names.push(String(approval.signedBy).trim())
    })
    if (!sameValues(roles, languageSignoffRoles)) errors.push("FND-02 language contract: required role set mismatch")
    if (new Set(names).size !== 4) errors.push("FND-02 language contract: approvers must be four distinct people")
  }
  const hr01 = value.studies["HR-01"]
  if (
    !isRecord(hr01) ||
    !exactKeys(hr01, ["moderatorScriptVersion", "stimulusSet", "participants", "calculation", "signoff"]) ||
    hr01.moderatorScriptVersion !== "HR01-v1" ||
    !Array.isArray(hr01.participants) ||
    hr01.participants.length < 3
  ) {
    errors.push("HR-01: missing participants or protocol version")
  } else {
    await validateHR01StimulusSet(hr01.stimulusSet, evidenceFile, buildSha, protocolSha256, errors)
    const participantIDs: string[] = []
    let correct = 0
    let total = 0
    hr01.participants.forEach((participant, participantIndex) => {
      if (
        !isRecord(participant) ||
        !exactKeys(participant, ["participantId", "eligibility", "responses"]) ||
        typeof participant.participantId !== "string" ||
        !/^P-[a-f0-9]{12}$/.test(participant.participantId) ||
        !isRecord(participant.eligibility) ||
        !exactKeys(participant.eligibility, ["targetUser", "documentationNaive", "notContributor", "consented"]) ||
        Object.values(participant.eligibility).some((item) => item !== true) ||
        !Array.isArray(participant.responses) ||
        participant.responses.length !== 12
      ) {
        errors.push(`HR-01 participant ${participantIndex + 1}: invalid anonymization or eligibility`)
        return
      }
      participantIDs.push(participant.participantId)
      const promptIDs: string[] = []
      participant.responses.forEach((response, responseIndex) => {
        if (
          !isRecord(response) ||
          !exactKeys(response, ["promptId", "rawExplanation", "rubricElements", "correct", "scoredBy"]) ||
          typeof response.promptId !== "string" ||
          !/^HR01-P(?:0[1-9]|1[0-2])$/.test(response.promptId) ||
          typeof response.rawExplanation !== "string" ||
          response.rawExplanation.length === 0 ||
          !validName(response.scoredBy) ||
          !isRecord(response.rubricElements) ||
          !exactKeys(response.rubricElements, ["currentSituation", "userImpact", "validNextStep"]) ||
          Object.values(response.rubricElements).some((item) => typeof item !== "boolean") ||
          typeof response.correct !== "boolean"
        ) {
          errors.push(`HR-01 participant ${participantIndex + 1} response ${responseIndex + 1}: invalid`)
          return
        }
        promptIDs.push(response.promptId)
        const recomputedCorrect = Object.values(response.rubricElements).every((item) => item === true)
        if (response.correct !== recomputedCorrect)
          errors.push(`HR-01 participant ${participantIndex + 1} response ${response.promptId}: forged score`)
        correct += recomputedCorrect ? 1 : 0
        total += 1
      })
      if (!sameValues(promptIDs, hr01PromptIDs))
        errors.push(`HR-01 participant ${participantIndex + 1}: prompt set mismatch`)
    })
    if (new Set(participantIDs).size !== participantIDs.length) errors.push("HR-01: participant IDs are not unique")
    const rate = total ? correct / total : 0
    if (
      !isRecord(hr01.calculation) ||
      !exactKeys(hr01.calculation, ["correct", "total", "rate"]) ||
      hr01.calculation.correct !== correct ||
      hr01.calculation.total !== total ||
      typeof hr01.calculation.rate !== "number" ||
      Math.abs(hr01.calculation.rate - rate) > 1e-12
    ) {
      errors.push("HR-01: calculation does not match raw response scoring")
    }
    if (total < 36 || rate < 0.9) failures.push(`HR-01: ${correct}/${total} is below 0.9`)
    validateSignoff(hr01.signoff, "HR-01", errors)
  }
  const hr02 = value.studies["HR-02"]
  if (
    !isRecord(hr02) ||
    !exactKeys(hr02, ["moderatorScriptVersion", "participants", "calculation", "signoff"]) ||
    hr02.moderatorScriptVersion !== "HR02-v1" ||
    !Array.isArray(hr02.participants) ||
    hr02.participants.length !== 5
  ) {
    errors.push("HR-02: exactly five participants are required")
  } else {
    const participantIDs: string[] = []
    let passingParticipants = 0
    hr02.participants.forEach((participant, participantIndex) => {
      if (
        !isRecord(participant) ||
        !exactKeys(participant, [
          "participantId",
          "eligibility",
          "exposureSeconds",
          "responses",
          "participantPassed",
        ]) ||
        typeof participant.participantId !== "string" ||
        !/^P-[a-f0-9]{12}$/.test(participant.participantId) ||
        !isRecord(participant.eligibility) ||
        !exactKeys(participant.eligibility, ["targetUser", "documentationNaive", "notContributor", "consented"]) ||
        Object.values(participant.eligibility).some((item) => item !== true) ||
        participant.exposureSeconds !== 10 ||
        !Array.isArray(participant.responses) ||
        participant.responses.length !== 3 ||
        typeof participant.participantPassed !== "boolean"
      ) {
        errors.push(`HR-02 participant ${participantIndex + 1}: invalid`)
        return
      }
      participantIDs.push(participant.participantId)
      const questionIDs: string[] = []
      const results = participant.responses.map((response, responseIndex) => {
        if (
          !isRecord(response) ||
          !exactKeys(response, ["questionId", "rawAnswer", "correct", "scoredBy"]) ||
          typeof response.questionId !== "string" ||
          !hr02QuestionIDs.includes(response.questionId) ||
          typeof response.rawAnswer !== "string" ||
          response.rawAnswer.length === 0 ||
          typeof response.correct !== "boolean" ||
          !validName(response.scoredBy)
        ) {
          errors.push(`HR-02 participant ${participantIndex + 1} response ${responseIndex + 1}: invalid`)
          return false
        }
        questionIDs.push(response.questionId)
        return response.correct
      })
      if (!sameValues(questionIDs, hr02QuestionIDs))
        errors.push(`HR-02 participant ${participantIndex + 1}: question set mismatch`)
      const recomputedPass = results.length === 3 && results.every(Boolean)
      if (participant.participantPassed !== recomputedPass)
        errors.push(`HR-02 participant ${participantIndex + 1}: forged participant result`)
      passingParticipants += recomputedPass ? 1 : 0
    })
    if (new Set(participantIDs).size !== participantIDs.length) errors.push("HR-02: participant IDs are not unique")
    if (
      !isRecord(hr02.calculation) ||
      !exactKeys(hr02.calculation, ["passingParticipants", "totalParticipants"]) ||
      hr02.calculation.passingParticipants !== passingParticipants ||
      hr02.calculation.totalParticipants !== 5
    ) {
      errors.push("HR-02: calculation does not match participant results")
    }
    if (passingParticipants < 4) failures.push(`HR-02: ${passingParticipants}/5 is below 4/5`)
    validateSignoff(hr02.signoff, "HR-02", errors)
  }
  const hr03 = value.studies["HR-03"]
  if (
    !isRecord(hr03) ||
    !exactKeys(hr03, ["reviewScriptVersion", "approverName", "approverRole", "approvals", "signoff"]) ||
    hr03.reviewScriptVersion !== "HR03-v1" ||
    !validName(hr03.approverName) ||
    !validName(hr03.approverRole) ||
    !Array.isArray(hr03.approvals) ||
    hr03.approvals.length !== 8
  ) {
    errors.push("HR-03: named approver or eight approvals are missing")
  } else {
    const surfaces: string[] = []
    const screenshotPaths: string[] = []
    const screenshotDigests: string[] = []
    for (const [index, approval] of hr03.approvals.entries()) {
      if (
        !isRecord(approval) ||
        !exactKeys(approval, ["surface", "buildSha", "relativePath", "sha256", "decision", "signedAt"]) ||
        typeof approval.surface !== "string" ||
        !hr03Surfaces.includes(approval.surface) ||
        approval.buildSha !== buildSha ||
        !confinedRelativePath(approval.relativePath) ||
        typeof approval.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(approval.sha256) ||
        !["accepted", "rejected"].includes(String(approval.decision)) ||
        !validDate(approval.signedAt)
      ) {
        errors.push(`HR-03 approval ${index + 1}: invalid build, path, digest, or decision`)
        continue
      }
      surfaces.push(approval.surface)
      const screenshotPath = await resolveConfinedFile(path.dirname(evidenceFile), String(approval.relativePath))
      const screenshot = screenshotPath ? new Uint8Array(await Bun.file(screenshotPath).arrayBuffer()) : null
      const image = screenshot
        ? await sharp(screenshot, { failOn: "error", limitInputPixels: 16_777_216 })
            .toBuffer({ resolveWithObject: true })
            .catch(() => null)
        : null
      if (
        !screenshotPath ||
        !screenshot ||
        sha256(screenshot) !== approval.sha256 ||
        image?.info.format !== "png" ||
        image.info.width < screenshotMinimum.width ||
        image.info.height < screenshotMinimum.height
      ) {
        errors.push(
          `HR-03 ${approval.surface}: screenshot is missing, escaped, invalid, too small, or digest-mismatched`,
        )
      } else {
        screenshotPaths.push(screenshotPath)
        screenshotDigests.push(approval.sha256)
      }
      if (approval.decision !== "accepted") failures.push(`HR-03 ${approval.surface}: rejected`)
    }
    if (!sameValues(surfaces, hr03Surfaces)) errors.push("HR-03: surface set mismatch")
    if (new Set(screenshotPaths).size !== 8) errors.push("HR-03: screenshot paths must be unique")
    if (new Set(screenshotDigests).size !== 8) errors.push("HR-03: screenshot contents must be unique")
    validateSignoff(hr03.signoff, "HR-03", errors)
    if (
      isRecord(hr03.signoff) &&
      (hr03.signoff.signedBy !== hr03.approverName || hr03.signoff.role !== hr03.approverRole)
    ) {
      errors.push("HR-03: approval identity and signoff identity differ")
    }
  }
  const spot = value.studies["FND-03-SPOT-CHECK"]
  if (
    !isRecord(spot) ||
    !exactKeys(spot, ["reviewScriptVersion", "selectionSeed", "selectedScenarioIds", "reviews", "signoff"]) ||
    spot.reviewScriptVersion !== "FND03-SPOT-v1" ||
    spot.selectionSeed !== 20260725 ||
    !sameValues(stringArray(spot.selectedScenarioIds), selectedScenarioIDs) ||
    !Array.isArray(spot.reviews) ||
    spot.reviews.length !== 3
  ) {
    errors.push("FND-03 spot check: deterministic 20% selection is missing")
  } else {
    const reviewedScenarios: string[] = []
    spot.reviews.forEach((review, index) => {
      if (
        !isRecord(review) ||
        !exactKeys(review, ["scenarioId", "executionRecordDigests", "reviewerAgrees", "notes"]) ||
        typeof review.scenarioId !== "string" ||
        !selectedScenarioIDs.includes(review.scenarioId) ||
        !Array.isArray(review.executionRecordDigests) ||
        review.executionRecordDigests.length !== 2 ||
        !review.executionRecordDigests.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) ||
        !sameValues(stringArray(review.executionRecordDigests), runner.recordDigests.get(review.scenarioId) ?? []) ||
        typeof review.reviewerAgrees !== "boolean" ||
        typeof review.notes !== "string" ||
        review.notes.length === 0
      ) {
        errors.push(`FND-03 spot check review ${index + 1}: invalid or forged record binding`)
        return
      }
      reviewedScenarios.push(review.scenarioId)
      if (!review.reviewerAgrees) failures.push(`FND-03 spot check ${review.scenarioId}: reviewer disagreed`)
    })
    if (!sameValues(reviewedScenarios, selectedScenarioIDs))
      errors.push("FND-03 spot check: reviewed scenario set mismatch")
    validateSignoff(spot.signoff, "FND-03 spot check", errors)
  }
  validateSignoff(value.packageSignoff, "evidence package", errors)
  return { errors, failures }
}

async function verifyHumanEvidenceAuthorization(
  evidenceSource: string,
  expectedAllowedSignersSha256: string | null,
  allowedSignersPath?: string,
  signaturePath?: string,
) {
  if (!expectedAllowedSignersSha256) {
    return {
      status: "incomplete" as const,
      missing: ["HUMAN-EVIDENCE-TRUST-ANCHOR"],
      errors: [] as string[],
      allowedSignersSha256: null,
      signatureSha256: null,
    }
  }
  if (!allowedSignersPath || !signaturePath) {
    return {
      status: "incomplete" as const,
      missing: ["HUMAN-EVIDENCE-TRUSTED-SIGNATURE"],
      errors: [] as string[],
      allowedSignersSha256: null,
      signatureSha256: null,
    }
  }
  const [allowedSignersFile, signatureFile, repositoryRealPath] = await Promise.all([
    fs.realpath(path.resolve(allowedSignersPath)).catch(() => null),
    fs.realpath(path.resolve(signaturePath)).catch(() => null),
    fs.realpath(root),
  ])
  if (!allowedSignersFile || !signatureFile) {
    return {
      status: "incomplete" as const,
      missing: ["HUMAN-EVIDENCE-TRUSTED-SIGNATURE"],
      errors: [] as string[],
      allowedSignersSha256: null,
      signatureSha256: null,
    }
  }
  const [allowedSignersSource, signatureSource] = await Promise.all([
    Bun.file(allowedSignersFile).text(),
    Bun.file(signatureFile).text(),
  ])
  if (sha256(allowedSignersSource) !== expectedAllowedSignersSha256) {
    return {
      status: "invalid" as const,
      missing: [] as string[],
      errors: ["human evidence signature: allowed_signers does not match the exact-build trust anchor"],
      allowedSignersSha256: sha256(allowedSignersSource),
      signatureSha256: sha256(signatureSource),
    }
  }
  if (allowedSignersFile === repositoryRealPath || allowedSignersFile.startsWith(`${repositoryRealPath}${path.sep}`)) {
    return {
      status: "invalid" as const,
      missing: [] as string[],
      errors: ["human evidence signature: allowed_signers must be supplied from outside the repository"],
      allowedSignersSha256: sha256(allowedSignersSource),
      signatureSha256: sha256(signatureSource),
    }
  }
  if (!Bun.which("ssh-keygen")) {
    return {
      status: "incomplete" as const,
      missing: ["OPENSSH-SIGNATURE-VERIFIER"],
      errors: [] as string[],
      allowedSignersSha256: sha256(allowedSignersSource),
      signatureSha256: sha256(signatureSource),
    }
  }
  const verification = Bun.spawn(
    [
      "ssh-keygen",
      "-Y",
      "verify",
      "-f",
      allowedSignersFile,
      "-I",
      humanSignerIdentity,
      "-n",
      humanSignatureNamespace,
      "-s",
      signatureFile,
    ],
    {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  verification.stdin.write(evidenceSource)
  verification.stdin.end()
  const [exitCode, stderr] = await Promise.all([verification.exited, new Response(verification.stderr).text()])
  return {
    status: exitCode === 0 ? ("pass" as const) : ("invalid" as const),
    missing: [] as string[],
    errors:
      exitCode === 0
        ? []
        : [`human evidence signature: OpenSSH verification failed${stderr.length ? ` (${stderr.trim()})` : ""}`],
    allowedSignersSha256: sha256(allowedSignersSource),
    signatureSha256: sha256(signatureSource),
  }
}

type GateOptions = {
  buildSha: string
  runnerPath: string
  automaticEvidencePath?: string
  executeAutomaticOutputDirectory?: string
  humanEvidencePath?: string
  humanAllowedSignersPath?: string
  humanSignaturePath?: string
}

async function evaluateR0GateWithDependencies(
  options: GateOptions,
  dependencies: {
    verifyCommit: (buildSha: string) => string
    governance?: Awaited<ReturnType<typeof loadGovernance>>
    automaticEvidenceGovernance?: AutomaticEvidenceGovernance
    automaticEvidenceExecuted?: boolean
    humanAllowedSignersSha256?: string | null
    languageContractSha256?: string
  },
) {
  if (!/^[a-f0-9]{40}$/.test(options.buildSha)) throw new Error("R0 gate requires a full lowercase build SHA.")
  dependencies.verifyCommit(options.buildSha)
  const governance = dependencies.governance ?? (await loadGovernance(options.buildSha))
  const runner = await validateRunner(
    options.buildSha,
    options.runnerPath,
    governance.benchmark,
    governance.recordContract,
  )
  const automaticEvidenceExecution = dependencies.automaticEvidenceExecuted ? "current_process" : "not_performed"
  if (runner.errors.length) {
    return {
      schemaVersion: 1,
      gate: "R0",
      buildSha: options.buildSha,
      status: "invalid",
      automaticEvidenceStatus: "invalid",
      automaticEvidenceExecution,
      humanEvidenceStatus: "not_evaluated",
      missing: [],
      failures: [],
      errors: runner.errors,
    }
  }
  const automaticEvidence = options.automaticEvidencePath
    ? await validateAutomaticEvidencePackage({
        packagePath: options.automaticEvidencePath,
        buildSha: options.buildSha,
        runnerSha256: runner.runnerSha256!,
        governance: dependencies.automaticEvidenceGovernance,
      })
    : {
        status: "incomplete" as const,
        packageSha256: null,
        missing: ["AUTOMATIC-EVIDENCE-PACKAGE"],
        failures: [],
        errors: [],
        coveredTaskIds: [],
        coveredCriterionIds: [],
      }
  const automaticPackageStatus =
    automaticEvidence.status === "invalid"
      ? "invalid"
      : runner.automaticFailures.length || automaticEvidence.status === "fail"
        ? "fail"
        : automaticEvidence.status === "incomplete"
          ? "incomplete"
          : "pass"
  const automaticEvidenceStatus =
    automaticPackageStatus === "pass" && automaticEvidenceExecution !== "current_process"
      ? "incomplete"
      : automaticPackageStatus
  const automaticMissing = [
    ...automaticEvidence.missing,
    ...(automaticPackageStatus === "pass" && automaticEvidenceExecution !== "current_process"
      ? ["AUTOMATIC-EVIDENCE-IN-PROCESS-EXECUTION"]
      : []),
  ]
  const automaticFailures = [...runner.automaticFailures, ...automaticEvidence.failures]
  if (automaticEvidenceStatus === "invalid") {
    return {
      schemaVersion: 1,
      gate: "R0",
      buildSha: options.buildSha,
      status: "invalid",
      automaticEvidenceStatus,
      automaticEvidencePackageStatus: automaticPackageStatus,
      automaticEvidenceExecution,
      humanEvidenceStatus: "not_evaluated",
      automaticEvidencePackageSha256: automaticEvidence.packageSha256,
      missing: automaticMissing,
      failures: automaticFailures,
      errors: automaticEvidence.errors,
    }
  }
  if (!options.humanEvidencePath) {
    return {
      schemaVersion: 1,
      gate: "R0",
      buildSha: options.buildSha,
      status: automaticEvidenceStatus === "fail" ? "fail" : "incomplete",
      automaticEvidenceStatus,
      automaticEvidencePackageStatus: automaticPackageStatus,
      automaticEvidenceExecution,
      humanEvidenceStatus: "incomplete",
      automaticEvidencePackageSha256: automaticEvidence.packageSha256,
      missing: [...automaticMissing, "FND-02-LANGUAGE-SIGNOFF", "HR-01", "HR-02", "HR-03", "FND-03-SPOT-CHECK"],
      failures: automaticFailures,
      errors: [],
    }
  }
  const evidenceFile = path.resolve(options.humanEvidencePath)
  const evidence = await readJson(evidenceFile).catch(() => null)
  if (!evidence) {
    return {
      schemaVersion: 1,
      gate: "R0",
      buildSha: options.buildSha,
      status: "invalid",
      automaticEvidenceStatus,
      automaticEvidencePackageStatus: automaticPackageStatus,
      automaticEvidenceExecution,
      humanEvidenceStatus: "invalid",
      automaticEvidencePackageSha256: automaticEvidence.packageSha256,
      missing: [],
      failures: automaticFailures,
      errors: ["evidence package: explicitly supplied file is missing or invalid JSON"],
    }
  }
  const validation = await validateHumanEvidence(
    evidence.value,
    evidenceFile,
    options.buildSha,
    runner,
    governance.protocol.sha256,
    dependencies.languageContractSha256 ?? governance.languageContract.sha256,
  )
  const authorization = await verifyHumanEvidenceAuthorization(
    evidence.source,
    dependencies.humanAllowedSignersSha256 ?? governance.releaseAuthorization.allowedSignersSha256,
    options.humanAllowedSignersPath,
    options.humanSignaturePath,
  )
  const humanEvidenceStatus =
    validation.errors.length || authorization.status === "invalid"
      ? "invalid"
      : validation.failures.length
        ? "fail"
        : authorization.status
  const status =
    humanEvidenceStatus === "invalid"
      ? "invalid"
      : automaticEvidenceStatus === "fail" || humanEvidenceStatus === "fail"
        ? "fail"
        : automaticEvidenceStatus === "incomplete" || humanEvidenceStatus === "incomplete"
          ? "incomplete"
          : "pass"
  return {
    schemaVersion: 1,
    gate: "R0",
    buildSha: options.buildSha,
    status,
    automaticEvidenceStatus,
    automaticEvidencePackageStatus: automaticPackageStatus,
    automaticEvidenceExecution,
    humanEvidenceStatus,
    protocol: {
      id: "agent-company-r0-human-research",
      version: "1.0.0",
      sha256: governance.protocol.sha256,
    },
    evidenceSchema: {
      packageVersion: "1.1.0",
      sha256: governance.evidenceSchema.sha256,
    },
    runnerArtifactSha256: runner.runnerSha256,
    automaticEvidencePackageSha256: automaticEvidence.packageSha256,
    humanEvidencePackageSha256: evidence.sha256,
    humanEvidenceAuthorization: {
      method: "openssh_detached_signature",
      namespace: humanSignatureNamespace,
      principal: humanSignerIdentity,
      allowedSignersSha256: authorization.allowedSignersSha256,
      signatureSha256: authorization.signatureSha256,
    },
    governance: {
      exactBuildSha: options.buildSha,
      files: governance.digests,
    },
    missing: [...automaticMissing, ...authorization.missing],
    failures: [...automaticFailures, ...validation.failures],
    errors: [...validation.errors, ...authorization.errors],
  }
}

export async function evaluateR0Gate(options: GateOptions) {
  if (options.automaticEvidencePath && options.executeAutomaticOutputDirectory) {
    throw new Error("--automatic-evidence and --execute-automatic are mutually exclusive.")
  }
  const generated = options.executeAutomaticOutputDirectory
    ? await generateAutomaticEvidence({
        buildSha: options.buildSha,
        runnerPath: options.runnerPath,
        outputDirectory: options.executeAutomaticOutputDirectory,
      })
    : null
  return evaluateR0GateWithDependencies(
    {
      ...options,
      automaticEvidencePath: generated?.packagePath ?? options.automaticEvidencePath,
    },
    {
      verifyCommit: verifyExactCommit,
      automaticEvidenceExecuted: Boolean(generated),
    },
  )
}

function structuralFixtureSignoff(signedBy = "Research Reviewer", role = "Product Researcher") {
  return {
    method: "named_human_attestation",
    signedBy,
    role,
    signedAt: "2026-07-25T08:00:00.000Z",
    attestation,
  }
}

function structuralFixtureEligibility() {
  return {
    targetUser: true,
    documentationNaive: true,
    notContributor: true,
    consented: true,
  }
}

async function writeStructuralRunnerFixture(directory: string, buildSha: string) {
  await fs.mkdir(directory, { recursive: true })
  const { benchmark, recordContract } = await readBenchmarkContracts()
  const selection = deterministicHumanReviewSelection(benchmark.scenarios, recordContract)
  const inventory: Array<{ scenarioId: string; runId: string; relativePath: string; sha256: string }> = []
  const records = new Map<string, ExecutionRecord[]>()
  const recordDigests = new Map<string, string[]>()
  for (const scenario of benchmark.scenarios) {
    const scenarioRecords: ExecutionRecord[] = []
    for (const runID of runIDs) {
      const runDirectory = path.join(directory, scenario.id, runID)
      await fs.mkdir(runDirectory, { recursive: true })
      const deferred = recordContract.governance.deferredScenarios[scenario.id]
      const selected = selection.ids.includes(scenario.id)
      const normalizedEvidence = {
        schemaVersion: 1,
        adapter: "playwright",
        scenarioId: scenario.id,
        buildSha,
        runId: runID,
        command: [
          "bun",
          "x",
          "playwright",
          "test",
          "--config",
          "playwright.config.ts",
          "--grep",
          `@scenario-${scenario.id.toLowerCase()}`,
          "--reporter=json",
          "--output",
          "<run-directory>/playwright",
        ],
        cwd: "packages/app",
        exitCode: 0,
        reportParsed: true,
        parseFailure: null,
        stderr: "",
        tests: scenario.acceptanceCriteria
          .filter(
            (criterion) =>
              !deferred && recordContract.governance.r0CriterionEligibility[criterion.id]?.includedInGateDecision,
          )
          .map((criterion) => ({
            title: `@scenario-${scenario.id.toLowerCase()} @criterion-${criterion.id.toLowerCase()} structural adapter`,
            projectName: "chromium",
            status: "passed",
            errors: [],
          })),
        isolation: {
          structuralFixture: true,
          identityAuthenticated: false,
        },
      }
      const evidenceSource = `${JSON.stringify(normalizedEvidence, null, 2)}\n`
      const evidenceDigest = sha256(evidenceSource)
      const auditID = `audit-${sha256(`${buildSha}:${scenario.id}:${scenario.seed}:${runID}`).slice(0, 32)}`
      const sideEffectAudit = {
        schemaVersion: 1,
        auditId: auditID,
        scenarioId: scenario.id,
        buildSha,
        runId: runID,
        network: {
          policy: "loopback-only",
          externalAttemptCount: 0,
          observedLoopbackRequestCount: 1,
          scenarios: [],
        },
        fakeControlPlane: {
          requestCount: 1,
          requests: [{ method: "GET", path: "/global/health", occurrences: 1 }],
        },
        isolatedRunTree: {
          capturedBeforeGovernanceArtifacts: true,
          writeEntryCount: 1,
          entries: [{ relativePath: "network-audit.raw.json", type: "file", size: 2 }],
        },
        productionCandidates: {
          snapshotCount: 1,
          changedCount: 0,
          changedPathHashes: [],
          contentsRead: false,
          before: [],
          after: [],
        },
        serverNetworkBoundary: {
          browserFullyObserved: true,
          serverEgressInstrumented: false,
          failClosedControls: [
            "browser_http_and_websocket_loopback_only",
            "external_provider_credentials_removed",
            "fake_control_plane_only",
            "server_proxy_environment_points_to_closed_loopback_port",
          ],
        },
      }
      const auditSource = `${JSON.stringify(sideEffectAudit, null, 2)}\n`
      if (!deferred) {
        await Promise.all([
          Bun.write(path.join(runDirectory, "evidence.json"), evidenceSource),
          Bun.write(path.join(runDirectory, "side-effect-audit.json"), auditSource),
        ])
      }
      const automaticResults = scenario.acceptanceCriteria.map((criterion) => {
        const contractedEligibility = recordContract.governance.r0CriterionEligibility[criterion.id]
        const eligibility = deferred
          ? {
              includedInGateDecision: false,
              deferredToGate: deferred.gate,
              reason: `The entire scenario is deferred to ${deferred.gate}.`,
            }
          : {
              includedInGateDecision: contractedEligibility?.includedInGateDecision ?? false,
              deferredToGate: contractedEligibility ? contractedEligibility.deferredToGate : "R1",
              reason: contractedEligibility?.includedInGateDecision
                ? "This criterion is part of the R0 decision."
                : `This criterion is explicitly deferred to ${contractedEligibility?.deferredToGate}.`,
            }
        return {
          criterionId: criterion.id,
          status: eligibility.includedInGateDecision ? ("pass" as const) : ("not_evaluated" as const),
          evidenceIds: eligibility.includedInGateDecision ? ["playwright-report"] : [],
          failureReason: eligibility.includedInGateDecision
            ? null
            : deferred
              ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
              : `deferred_to_${eligibility.deferredToGate}`,
          humanEvidenceRequired: false,
          gateEligibility: {
            gate: "R0" as const,
            ...eligibility,
          },
        }
      })
      const humanResults = scenario.humanEvidenceRequired.map((_, index) => ({
        criterionId: `${scenario.id}-H${index + 1}`,
        status: deferred ? ("not_evaluated" as const) : ("human_pending" as const),
        evidenceIds: deferred ? [] : ["human-policy"],
        failureReason: deferred
          ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
          : "signed_human_evidence_missing",
        humanEvidenceRequired: true,
        gateEligibility: {
          gate: "R0" as const,
          includedInGateDecision: !deferred,
          deferredToGate: deferred?.gate ?? null,
          reason: deferred
            ? `The entire scenario is deferred to ${deferred.gate}.`
            : "The scenario human criterion is an explicit R0 blocking requirement.",
        },
      }))
      const blockedByTasks = deferred
        ? deferred.blockedByTasks
        : [
            ...(humanResults.length
              ? (recordContract.governance.humanResearchBindings[scenario.id] ?? ["FND-03"])
              : []),
            ...(selected ? ["FND-03"] : []),
          ].filter((item, index, values) => values.indexOf(item) === index)
      const finalDecision = deferred
        ? ("blocked" as const)
        : humanResults.length || selected
          ? ("human_pending" as const)
          : ("pass" as const)
      const record = {
        recordSchemaVersion: recordContract.schemaVersion,
        scenarioId: scenario.id,
        scenarioVersion: benchmark.version,
        scenarioDigest: sha256(canonicalize(scenario)),
        buildSha,
        runId: runID,
        seed: scenario.seed,
        startedAt: "2026-07-25T08:00:00.000Z",
        finishedAt: "2026-07-25T08:00:01.000Z",
        stateTrace: [
          { sequence: 1, state: "scheduled" as const, evidenceIds: [] },
          {
            sequence: 2,
            state: deferred ? ("blocked" as const) : finalDecision === "pass" ? ("completed" as const) : finalDecision,
            evidenceIds: deferred ? [] : ["playwright-report"],
          },
        ],
        sideEffectLedger: deferred
          ? {
              mode: "deferred_no_execution" as const,
              auditArtifactId: null,
              auditSha256: null,
              network: {
                policy: "not_executed" as const,
                externalAttemptCount: 0,
                observedLoopbackRequestCount: 0,
              },
              fakeControlPlane: { requestCount: 0 },
              isolatedRunTree: { writeEntryCount: 0 },
              productionCandidates: { snapshotCount: 0, changedCount: 0, contentsRead: false as const },
              serverNetworkBoundary: {
                browserFullyObserved: false,
                serverEgressInstrumented: false as const,
                failClosedControls: [],
              },
            }
          : {
              mode: "measured_adapter" as const,
              auditArtifactId: "side-effect-audit",
              auditSha256: sha256(auditSource),
              network: {
                policy: "loopback-only" as const,
                externalAttemptCount: 0,
                observedLoopbackRequestCount: 1,
              },
              fakeControlPlane: { requestCount: 1 },
              isolatedRunTree: { writeEntryCount: 1 },
              productionCandidates: { snapshotCount: 1, changedCount: 0, contentsRead: false as const },
              serverNetworkBoundary: {
                browserFullyObserved: true,
                serverEgressInstrumented: false as const,
                failClosedControls: [
                  "browser_http_and_websocket_loopback_only",
                  "external_provider_credentials_removed",
                  "fake_control_plane_only",
                  "server_proxy_environment_points_to_closed_loopback_port",
                ],
              },
            },
        artifacts: deferred
          ? []
          : [
              {
                id: "normalized-evidence",
                relativePath: "evidence.json",
                sha256: evidenceDigest,
                mediaType: "application/json" as const,
                byteLength: new TextEncoder().encode(evidenceSource).byteLength,
                openCheck: { status: "pass" as const, checkedBy: "JSON.parse" as const },
              },
              {
                id: "side-effect-audit",
                relativePath: "side-effect-audit.json",
                sha256: sha256(auditSource),
                mediaType: "application/json" as const,
                byteLength: new TextEncoder().encode(auditSource).byteLength,
                openCheck: { status: "pass" as const, checkedBy: "JSON.parse" as const },
              },
            ],
        evidence: deferred
          ? []
          : [
              {
                id: "playwright-report",
                kind: "playwright" as const,
                source: `packages/app/e2e @scenario-${scenario.id.toLowerCase()}`,
                sha256: evidenceDigest,
                summary: normalizedEvidenceSummary(normalizedEvidence),
              },
              {
                id: "human-policy",
                kind: "human_policy" as const,
                source: "benchmark-scenarios.v1.json",
                sha256: evidenceDigest,
                summary: "Named human evidence remains a separate, non-automated release requirement.",
              },
              {
                id: "side-effect-audit-evidence",
                kind: "side_effect_audit" as const,
                source: "side-effect-audit.json",
                sha256: sha256(auditSource),
                summary: "Structural side-effect binding fixture.",
              },
            ],
        criterionResults: [...automaticResults, ...humanResults],
        humanReview: {
          selected,
          status: selected ? ("human_pending" as const) : ("not_selected" as const),
          selectionSeed: recordContract.governance.spotCheck.seed,
          selectionRank: selection.rank.get(scenario.id) ?? null,
        },
        finalDecision,
        failureReason:
          finalDecision === "pass"
            ? null
            : deferred
              ? `not_implemented_for_R0:${deferred.blockedByTasks.join(",")};gate=${deferred.gate}`
              : `human_evidence_pending:${blockedByTasks.join(",")}`,
        eligibility: {
          gate: "R0" as const,
          includedInGateDenominator: !deferred,
          reason: deferred ? `Deferred to ${deferred.gate}.` : "R0 executable adapter.",
        },
        blockedByTasks,
      } satisfies ExecutionRecord
      const recordSource = `${JSON.stringify(record, null, 2)}\n`
      const relativePath = path.join(scenario.id, runID, "execution-record.json")
      await Bun.write(path.join(directory, relativePath), recordSource)
      inventory.push({
        scenarioId: scenario.id,
        runId: runID,
        relativePath,
        sha256: sha256(recordSource),
      })
      recordDigests.set(scenario.id, [...(recordDigests.get(scenario.id) ?? []), sha256(recordSource)])
      scenarioRecords.push(record)
    }
    records.set(scenario.id, scenarioRecords)
  }
  const reproducibility = benchmark.scenarios.map((scenario) => {
    const normalizedDigests = (records.get(scenario.id) ?? []).map((record) =>
      sha256(canonicalize(normalizeExecutionRecord(record))),
    )
    return {
      scenarioId: scenario.id,
      normalizedDigests,
      match: normalizedDigests.length === 2 && normalizedDigests[0] === normalizedDigests[1],
    }
  })
  const eligibleRecords = [...records.values()].flat().filter((record) => record.eligibility.includedInGateDenominator)
  const runner = {
    recordSchemaVersion: recordContract.schemaVersion,
    buildSha,
    gate: "R0",
    repeats: 2,
    runnerSuccessMeaning: recordContract.governance.runnerSuccessMeaning,
    ignoredForReproducibility: recordContract.governance.reproducibilityIgnoredFields,
    selectedForHumanReview: selection.ids,
    humanReviewSeed: recordContract.governance.spotCheck.seed,
    executionRecords: inventory,
    scenarios: reproducibility,
    reproducible: reproducibility.every((item) => item.match),
    scenarioDecisions: benchmark.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      decisions: (records.get(scenario.id) ?? []).map((record) => record.finalDecision),
      eligibleForR0: (records.get(scenario.id) ?? []).every((record) => record.eligibility.includedInGateDenominator),
    })),
    r0ScenarioPass: eligibleRecords.length > 0 && eligibleRecords.every((record) => record.finalDecision === "pass"),
    runnerDecision: reproducibility.every((item) => item.match) ? "complete" : "reproducibility_failed",
  }
  const runnerPath = path.join(directory, "reproducibility-record.json")
  await Bun.write(runnerPath, `${JSON.stringify(runner, null, 2)}\n`)
  return {
    runnerPath,
    recordDigests,
  }
}

async function writeStructuralHumanEvidenceFixture(
  directory: string,
  buildSha: string,
  runnerPath: string,
  recordDigests: Map<string, string[]>,
  protocolSha256: string,
  languageContractSha256: string,
) {
  const screenshotDirectory = path.join(directory, "screenshots")
  await fs.mkdir(screenshotDirectory, { recursive: true })
  const approvals = await Promise.all(
    hr03Surfaces.map(async (surface, index) => {
      const relativePath = path.join("screenshots", `${surface.toLowerCase().replaceAll(" ", "-")}.png`)
      const png = await sharp({
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
        .toBuffer()
      await Bun.write(path.join(directory, relativePath), png)
      return {
        surface,
        buildSha,
        relativePath,
        sha256: sha256(png),
        decision: "accepted",
        signedAt: "2026-07-25T08:00:00.000Z",
      }
    }),
  )
  const stimulusDirectory = path.join(directory, "hr01-state-cards")
  await fs.mkdir(stimulusDirectory, { recursive: true })
  const stimuli = await Promise.all(
    hr01PromptIDs.map(async (promptId, index) => {
      const filename = `${promptId}.png`
      const relativePath = path.posix.join("hr01-state-cards", filename)
      const png = await sharp({
        create: {
          width: 800,
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
        .toBuffer()
      await Bun.write(path.join(directory, relativePath), png)
      return {
        promptId,
        stateId: hr01StateIDs[index],
        relativePath,
        sha256: sha256(png),
      }
    }),
  )
  const stimulusManifestRelativePath = path.posix.join("hr01-state-cards", "stimuli-manifest.json")
  const stimulusManifestSource = `${JSON.stringify(
    {
      schemaVersion: 1,
      buildSha,
      protocol: {
        id: "agent-company-r0-human-research",
        version: "1.0.0",
        sha256: protocolSha256,
        studyId: "HR-01",
        moderatorScriptVersion: "HR01-v1",
      },
      presentation: hr01Presentation,
      exactPrompt: hr01ExactPrompt,
      stateLabelHidden: true,
      relativePathBase: "build-artifact-root",
      viewport: { width: 1440, height: 1600 },
      stimuli,
    },
    null,
    2,
  )}\n`
  await Bun.write(path.join(directory, stimulusManifestRelativePath), stimulusManifestSource)
  const packageValue = {
    schemaVersion: 1,
    packageVersion: "1.1.0",
    packageId: "R0-structural-fixture",
    buildSha,
    protocolBinding: {
      id: "agent-company-r0-human-research",
      version: "1.0.0",
      sha256: protocolSha256,
    },
    runnerBinding: {
      relativePath: path.relative(directory, runnerPath),
      sha256: sha256(await Bun.file(runnerPath).text()),
    },
    createdAt: "2026-07-25T08:00:00.000Z",
    studies: {
      "FND-02-LANGUAGE-SIGNOFF": {
        buildSha,
        languageContract: {
          path: languageContractRelativePath,
          sha256: languageContractSha256,
        },
        approvals: languageSignoffRoles.map((role, index) => ({
          role,
          signedBy: `Language Approver ${index + 1}`,
          signedAt: "2026-07-25T08:00:00.000Z",
          attestation: languageSignoffAttestation,
        })),
      },
      "HR-01": {
        moderatorScriptVersion: "HR01-v1",
        stimulusSet: {
          buildSha,
          manifestRelativePath: stimulusManifestRelativePath,
          manifestSha256: sha256(stimulusManifestSource),
          stateLabelHidden: true,
          presentedToAllParticipants: true,
        },
        participants: Array.from({ length: 3 }, (_, participantIndex) => ({
          participantId: `P-${String(participantIndex + 1).padStart(12, "0")}`,
          eligibility: structuralFixtureEligibility(),
          responses: hr01PromptIDs.map((promptId) => ({
            promptId,
            rawExplanation: "structural self-test response",
            rubricElements: {
              currentSituation: true,
              userImpact: true,
              validNextStep: true,
            },
            correct: true,
            scoredBy: "Structural Fixture Scorer",
          })),
        })),
        calculation: {
          correct: 36,
          total: 36,
          rate: 1,
        },
        signoff: structuralFixtureSignoff(),
      },
      "HR-02": {
        moderatorScriptVersion: "HR02-v1",
        participants: Array.from({ length: 5 }, (_, participantIndex) => ({
          participantId: `P-${String(participantIndex + 101).padStart(12, "0")}`,
          eligibility: structuralFixtureEligibility(),
          exposureSeconds: 10,
          responses: hr02QuestionIDs.map((questionId) => ({
            questionId,
            rawAnswer: "structural self-test answer",
            correct: true,
            scoredBy: "Structural Fixture Scorer",
          })),
          participantPassed: true,
        })),
        calculation: {
          passingParticipants: 5,
          totalParticipants: 5,
        },
        signoff: structuralFixtureSignoff(),
      },
      "HR-03": {
        reviewScriptVersion: "HR03-v1",
        approverName: "Product Approver",
        approverRole: "Product Owner",
        approvals,
        signoff: structuralFixtureSignoff("Product Approver", "Product Owner"),
      },
      "FND-03-SPOT-CHECK": {
        reviewScriptVersion: "FND03-SPOT-v1",
        selectionSeed: 20260725,
        selectedScenarioIds: selectedScenarioIDs,
        reviews: selectedScenarioIDs.map((scenarioId) => ({
          scenarioId,
          executionRecordDigests: recordDigests.get(scenarioId) ?? [],
          reviewerAgrees: true,
          notes: "Structural evaluator fixture review; no human identity authentication was performed.",
        })),
        signoff: structuralFixtureSignoff("Spot Reviewer", "Independent Reviewer"),
      },
    },
    packageSignoff: structuralFixtureSignoff("Release Reviewer", "Release Approver"),
  }
  const evidencePath = path.join(directory, "human-evidence.json")
  await Bun.write(evidencePath, `${JSON.stringify(packageValue, null, 2)}\n`)
  return {
    evidencePath,
    packageValue,
  }
}

async function writeMutatedEvidence(
  directory: string,
  name: string,
  source: Record<string, unknown>,
  mutate: (value: Record<string, unknown>) => void,
) {
  const value = structuredClone(source)
  mutate(value)
  const file = path.join(directory, `${name}.json`)
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

async function writeMutatedRunnerFixture(
  directory: string,
  name: string,
  runnerPath: string,
  mutate: (value: Record<string, unknown>, fixtureDirectory: string) => void | Promise<void>,
) {
  const fixtureDirectory = path.join(directory, name)
  await fs.cp(path.dirname(runnerPath), fixtureDirectory, { recursive: true })
  const fixtureRunnerPath = path.join(fixtureDirectory, "reproducibility-record.json")
  const value = (await Bun.file(fixtureRunnerPath).json()) as Record<string, unknown>
  await mutate(value, fixtureDirectory)
  await Bun.write(fixtureRunnerPath, `${JSON.stringify(value, null, 2)}\n`)
  return fixtureRunnerPath
}

async function mutateFixtureExecutionRecord(
  runner: Record<string, unknown>,
  fixtureDirectory: string,
  scenarioID: string,
  runID: string,
  mutate: (value: Record<string, unknown>) => void,
) {
  const inventory = runner.executionRecords as Array<Record<string, unknown>>
  const item = inventory.find((candidate) => candidate.scenarioId === scenarioID && candidate.runId === runID)
  if (!item) throw new Error(`Missing fixture execution record ${scenarioID}/${runID}.`)
  const recordPath = path.join(fixtureDirectory, String(item.relativePath))
  const value = (await Bun.file(recordPath).json()) as Record<string, unknown>
  mutate(value)
  const source = `${JSON.stringify(value, null, 2)}\n`
  await Bun.write(recordPath, source)
  item.sha256 = sha256(source)
}

async function writeAutomaticFailureRunnerFixture(directory: string, runnerPath: string, synchronizeRecord: boolean) {
  return writeMutatedRunnerFixture(
    directory,
    synchronizeRecord ? "automatic-failure" : "evidence-record-mismatch",
    runnerPath,
    async (runner, fixtureDirectory) => {
      const inventory = runner.executionRecords as Array<Record<string, unknown>>
      const records: ExecutionRecord[] = []
      for (const runID of runIDs) {
        const item = inventory.find((candidate) => candidate.scenarioId === "S05" && candidate.runId === runID)
        if (!item) throw new Error(`Missing S05/${runID} fixture record.`)
        const recordPath = path.join(fixtureDirectory, String(item.relativePath))
        const record = (await Bun.file(recordPath).json()) as ExecutionRecord
        const evidencePath = path.join(path.dirname(recordPath), "evidence.json")
        const evidence = (await Bun.file(evidencePath).json()) as Record<string, unknown>
        evidence.exitCode = 1
        evidence.stderr = "structural fixture failure"
        const tests = evidence.tests as Array<Record<string, unknown>>
        tests[0]!.status = "failed"
        tests[0]!.errors = ["structural fixture failure"]
        const evidenceSource = `${JSON.stringify(evidence, null, 2)}\n`
        await Bun.write(evidencePath, evidenceSource)
        const evidenceDigest = sha256(evidenceSource)
        const evidenceBytes = new TextEncoder().encode(evidenceSource).byteLength
        const artifact = record.artifacts.find((candidate) => candidate.id === "normalized-evidence")
        if (!artifact) throw new Error("Missing normalized-evidence fixture artifact.")
        artifact.sha256 = evidenceDigest
        artifact.byteLength = evidenceBytes
        record.evidence
          .filter((candidate) => candidate.id === "playwright-report" || candidate.id === "human-policy")
          .forEach((candidate) => {
            candidate.sha256 = evidenceDigest
          })
        if (synchronizeRecord) {
          const playwrightEvidence = record.evidence.find((candidate) => candidate.id === "playwright-report")
          if (!playwrightEvidence) throw new Error("Missing Playwright evidence fixture.")
          playwrightEvidence.summary = normalizedEvidenceSummary(evidence)
          record.criterionResults
            .filter((criterion) => criterion.gateEligibility.includedInGateDecision && !criterion.humanEvidenceRequired)
            .forEach((criterion) => {
              criterion.status = "fail"
              criterion.failureReason = "playwright_test_failed:structural_fixture"
            })
          record.stateTrace.at(-1)!.state = "failed"
          record.finalDecision = "fail"
          record.failureReason = "criteria_failed:S05-C1,S05-C2,S05-C3"
          record.blockedByTasks = ["FND-03", "QA-02", "TRUST-01", "TRUST-02"]
        }
        const recordSource = `${JSON.stringify(record, null, 2)}\n`
        await Bun.write(recordPath, recordSource)
        item.sha256 = sha256(recordSource)
        records.push(record)
      }
      if (!synchronizeRecord) return
      const scenario = (runner.scenarios as Array<Record<string, unknown>>).find((item) => item.scenarioId === "S05")
      const decision = (runner.scenarioDecisions as Array<Record<string, unknown>>).find(
        (item) => item.scenarioId === "S05",
      )
      if (!scenario || !decision) throw new Error("Missing S05 runner summary.")
      const normalizedDigests = records.map((record) => sha256(canonicalize(normalizeExecutionRecord(record))))
      scenario.normalizedDigests = normalizedDigests
      scenario.match = normalizedDigests.length === 2 && normalizedDigests[0] === normalizedDigests[1]
      decision.decisions = ["fail", "fail"]
      runner.r0ScenarioPass = false
    },
  )
}

async function writeEphemeralHumanSignature(directory: string, evidencePath: string) {
  if (!Bun.which("ssh-keygen")) throw new Error("OpenSSH ssh-keygen is required for the R0 gate self-test.")
  const keyPath = path.join(directory, "ephemeral-release-owner")
  const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString().trim() || "Failed to generate test key.")
  const allowedSignersPath = path.join(directory, "external-allowed_signers")
  await Bun.write(allowedSignersPath, `${humanSignerIdentity} ${(await Bun.file(`${keyPath}.pub`).text()).trim()}\n`)
  const signed = Bun.spawnSync(
    ["ssh-keygen", "-Y", "sign", "-q", "-f", keyPath, "-n", humanSignatureNamespace, evidencePath],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (signed.exitCode !== 0) throw new Error(signed.stderr.toString().trim() || "Failed to sign test evidence.")
  return {
    allowedSignersPath,
    signaturePath: `${evidencePath}.sig`,
  }
}

export async function runGateSelfTest() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-r0-gate-"))
  const buildSha = "b".repeat(40)
  const languageContractSha256 = "d".repeat(64)
  const governance = await loadGovernance()
  const runner = await writeStructuralRunnerFixture(path.join(directory, "runner"), buildSha)
  const automaticEvidence = await writeStructuralAutomaticEvidenceFixture(
    path.join(directory, "automatic-evidence"),
    buildSha,
    "a".repeat(40),
    sha256(await Bun.file(runner.runnerPath).text()),
  )
  const evidence = await writeStructuralHumanEvidenceFixture(
    path.join(directory, "evidence"),
    buildSha,
    runner.runnerPath,
    runner.recordDigests,
    governance.protocol.sha256,
    languageContractSha256,
  )
  const ephemeralSignature = await writeEphemeralHumanSignature(directory, evidence.evidencePath)
  const ephemeralAllowedSignersSha256 = sha256(await Bun.file(ephemeralSignature.allowedSignersPath).text())
  const evaluateUnanchoredFixture = (options: GateOptions) =>
    evaluateR0GateWithDependencies(options, {
      verifyCommit: () => buildSha,
      governance,
      automaticEvidenceGovernance: automaticEvidence.governance,
      languageContractSha256,
    })
  const evaluateFixture = (options: GateOptions) =>
    evaluateR0GateWithDependencies(options, {
      verifyCommit: () => buildSha,
      governance,
      automaticEvidenceGovernance: automaticEvidence.governance,
      humanAllowedSignersSha256: ephemeralAllowedSignersSha256,
      languageContractSha256,
    })
  const evaluateExecutedAutomaticFixture = (options: GateOptions) =>
    evaluateR0GateWithDependencies(options, {
      verifyCommit: () => buildSha,
      governance,
      automaticEvidenceGovernance: automaticEvidence.governance,
      automaticEvidenceExecuted: true,
      humanAllowedSignersSha256: ephemeralAllowedSignersSha256,
      languageContractSha256,
    })
  const unanchoredStructuralEvidence = await evaluateUnanchoredFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    automaticEvidencePath: automaticEvidence.packagePath,
    humanEvidencePath: evidence.evidencePath,
    humanAllowedSignersPath: ephemeralSignature.allowedSignersPath,
    humanSignaturePath: ephemeralSignature.signaturePath,
  })
  const unsignedStructuralEvidence = await evaluateFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    automaticEvidencePath: automaticEvidence.packagePath,
    humanEvidencePath: evidence.evidencePath,
  })
  const unsignedWithExecutedAutomaticEvidence = await evaluateExecutedAutomaticFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    automaticEvidencePath: automaticEvidence.packagePath,
    humanEvidencePath: evidence.evidencePath,
  })
  const signedWithExecutedAutomaticEvidence = await evaluateExecutedAutomaticFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    automaticEvidencePath: automaticEvidence.packagePath,
    humanEvidencePath: evidence.evidencePath,
    humanAllowedSignersPath: ephemeralSignature.allowedSignersPath,
    humanSignaturePath: ephemeralSignature.signaturePath,
  })
  const verifiedEphemeralSignature = await verifyHumanEvidenceAuthorization(
    await Bun.file(evidence.evidencePath).text(),
    ephemeralAllowedSignersSha256,
    ephemeralSignature.allowedSignersPath,
    ephemeralSignature.signaturePath,
  )
  const rejectedTamperedPayload = await verifyHumanEvidenceAuthorization(
    `${await Bun.file(evidence.evidencePath).text()} `,
    ephemeralAllowedSignersSha256,
    ephemeralSignature.allowedSignersPath,
    ephemeralSignature.signaturePath,
  )
  const rejectedUnanchoredSignature = await verifyHumanEvidenceAuthorization(
    await Bun.file(evidence.evidencePath).text(),
    null,
    ephemeralSignature.allowedSignersPath,
    ephemeralSignature.signaturePath,
  )
  const rejectedWrongTrustAnchor = await verifyHumanEvidenceAuthorization(
    await Bun.file(evidence.evidencePath).text(),
    "f".repeat(64),
    ephemeralSignature.allowedSignersPath,
    ephemeralSignature.signaturePath,
  )
  const incomplete = await evaluateFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    automaticEvidencePath: automaticEvidence.packagePath,
  })
  const missingAutomaticEvidence = await evaluateFixture({
    buildSha,
    runnerPath: runner.runnerPath,
    humanEvidencePath: evidence.evidencePath,
  })
  const wrongBuild = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "wrong-build",
    evidence.packageValue,
    (value) => {
      value.buildSha = "c".repeat(40)
    },
  )
  const missingParticipant = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "missing-participant",
    evidence.packageValue,
    (value) => {
      const studies = value.studies as Record<string, Record<string, unknown>>
      ;(studies["HR-01"]!.participants as unknown[]).pop()
    },
  )
  const belowThreshold = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "below-threshold",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["HR-01"]!
      const responses = (study.participants as Array<Record<string, unknown>>)[0]!.responses as Array<
        Record<string, unknown>
      >
      responses.slice(0, 4).forEach((response) => {
        ;(response.rubricElements as Record<string, boolean>).currentSituation = false
        response.correct = false
      })
      study.calculation = { correct: 32, total: 36, rate: 32 / 36 }
    },
  )
  const wrongRunnerDigest = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "wrong-runner-digest",
    evidence.packageValue,
    (value) => {
      ;(value.runnerBinding as Record<string, unknown>).sha256 = "c".repeat(64)
    },
  )
  const duplicateParticipant = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "duplicate-participant",
    evidence.packageValue,
    (value) => {
      const participants = (value.studies as Record<string, Record<string, unknown>>)["HR-02"]!.participants as Array<
        Record<string, unknown>
      >
      participants[1]!.participantId = participants[0]!.participantId
    },
  )
  const nonStringPrompt = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "non-string-prompt",
    evidence.packageValue,
    (value) => {
      const participants = (value.studies as Record<string, Record<string, unknown>>)["HR-01"]!.participants as Array<
        Record<string, unknown>
      >
      ;(participants[0]!.responses as Array<Record<string, unknown>>)[0]!.promptId = 1
    },
  )
  const wrongStimulusDigest = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "wrong-stimulus-digest",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["HR-01"]!
      ;(study.stimulusSet as Record<string, unknown>).manifestSha256 = "c".repeat(64)
    },
  )
  const missingLanguageRole = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "missing-language-role",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["FND-02-LANGUAGE-SIGNOFF"]!
      ;(study.approvals as unknown[]).pop()
    },
  )
  const wrongLanguageDigest = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "wrong-language-digest",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["FND-02-LANGUAGE-SIGNOFF"]!
      ;(study.languageContract as Record<string, unknown>).sha256 = "c".repeat(64)
    },
  )
  const visibleStimulusLabel = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "visible-stimulus-label",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["HR-01"]!
      ;(study.stimulusSet as Record<string, unknown>).stateLabelHidden = false
    },
  )
  const missingSurface = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "missing-surface",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["HR-03"]!
      ;(study.approvals as unknown[]).pop()
    },
  )
  const invalidPng = Uint8Array.from([...Buffer.from("89504e470d0a1a0a", "hex"), 0])
  const invalidPngPath = path.join(path.dirname(evidence.evidencePath), "screenshots", "magic-only.png")
  await Bun.write(invalidPngPath, invalidPng)
  const magicOnlyScreenshot = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "magic-only-screenshot",
    evidence.packageValue,
    (value) => {
      const approvals = (value.studies as Record<string, Record<string, unknown>>)["HR-03"]!.approvals as Array<
        Record<string, unknown>
      >
      approvals[0]!.relativePath = path.relative(path.dirname(evidence.evidencePath), invalidPngPath)
      approvals[0]!.sha256 = sha256(invalidPng)
    },
  )
  const tinyPng = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  )
  const tinyPngPath = path.join(path.dirname(evidence.evidencePath), "screenshots", "tiny.png")
  await Bun.write(tinyPngPath, tinyPng)
  const tinyScreenshot = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "tiny-screenshot",
    evidence.packageValue,
    (value) => {
      const approvals = (value.studies as Record<string, Record<string, unknown>>)["HR-03"]!.approvals as Array<
        Record<string, unknown>
      >
      approvals[0]!.relativePath = path.relative(path.dirname(evidence.evidencePath), tinyPngPath)
      approvals[0]!.sha256 = sha256(tinyPng)
    },
  )
  const duplicateScreenshot = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "duplicate-screenshot",
    evidence.packageValue,
    (value) => {
      const approvals = (value.studies as Record<string, Record<string, unknown>>)["HR-03"]!.approvals as Array<
        Record<string, unknown>
      >
      approvals[1]!.relativePath = approvals[0]!.relativePath
      approvals[1]!.sha256 = approvals[0]!.sha256
    },
  )
  const wrongSpotDigest = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "wrong-spot-digest",
    evidence.packageValue,
    (value) => {
      const study = (value.studies as Record<string, Record<string, unknown>>)["FND-03-SPOT-CHECK"]!
      const reviews = study.reviews as Array<Record<string, unknown>>
      ;(reviews[0]!.executionRecordDigests as string[])[0] = "c".repeat(64)
    },
  )
  const forgedScore = await writeMutatedEvidence(
    path.dirname(evidence.evidencePath),
    "forged-score",
    evidence.packageValue,
    (value) => {
      const participants = (value.studies as Record<string, Record<string, unknown>>)["HR-01"]!.participants as Array<
        Record<string, unknown>
      >
      const response = (participants[0]!.responses as Array<Record<string, unknown>>)[0]!
      ;(response.rubricElements as Record<string, boolean>).currentSituation = false
    },
  )
  const mutatedResults = await Promise.all(
    [
      ["wrong_build_sha_rejected", wrongBuild, "invalid"],
      ["missing_participant_rejected", missingParticipant, "invalid"],
      ["below_threshold_rejected", belowThreshold, "fail"],
      ["wrong_runner_digest_rejected", wrongRunnerDigest, "invalid"],
      ["duplicate_participant_rejected", duplicateParticipant, "invalid"],
      ["non_string_pattern_bypass_rejected", nonStringPrompt, "invalid"],
      ["missing_language_role_rejected", missingLanguageRole, "invalid"],
      ["wrong_language_digest_rejected", wrongLanguageDigest, "invalid"],
      ["wrong_stimulus_digest_rejected", wrongStimulusDigest, "invalid"],
      ["visible_stimulus_label_rejected", visibleStimulusLabel, "invalid"],
      ["missing_surface_rejected", missingSurface, "invalid"],
      ["magic_only_screenshot_rejected", magicOnlyScreenshot, "invalid"],
      ["tiny_screenshot_rejected", tinyScreenshot, "invalid"],
      ["duplicate_screenshot_rejected", duplicateScreenshot, "invalid"],
      ["wrong_spot_digest_rejected", wrongSpotDigest, "invalid"],
      ["forged_score_rejected", forgedScore, "invalid"],
    ].map(async ([name, humanEvidencePath, expected]) => ({
      name,
      passed:
        (
          await evaluateFixture({
            buildSha,
            runnerPath: runner.runnerPath,
            automaticEvidencePath: automaticEvidence.packagePath,
            humanEvidencePath,
          })
        ).status === expected,
    })),
  )
  const [forgedScenarioDigest, forgedEvidenceID, forgedNormalizedDigest, forgedRunnerSummary, tamperedArtifact] =
    await Promise.all([
      writeMutatedRunnerFixture(directory, "forged-scenario-digest", runner.runnerPath, (value, fixtureDirectory) =>
        mutateFixtureExecutionRecord(value, fixtureDirectory, "S05", "run-01", (record) => {
          record.scenarioDigest = "c".repeat(64)
        }),
      ),
      writeMutatedRunnerFixture(directory, "forged-evidence-id", runner.runnerPath, (value, fixtureDirectory) =>
        mutateFixtureExecutionRecord(value, fixtureDirectory, "S05", "run-01", (record) => {
          const criterion = (record.criterionResults as Array<Record<string, unknown>>)[0]!
          criterion.evidenceIds = ["missing-evidence"]
        }),
      ),
      writeMutatedRunnerFixture(directory, "forged-normalized-digest", runner.runnerPath, (value) => {
        const summary = (value.scenarios as Array<Record<string, unknown>>).find((item) => item.scenarioId === "S05")!
        summary.normalizedDigests = ["c".repeat(64), "c".repeat(64)]
      }),
      writeMutatedRunnerFixture(directory, "forged-runner-summary", runner.runnerPath, (value) => {
        const summary = (value.scenarioDecisions as Array<Record<string, unknown>>).find(
          (item) => item.scenarioId === "S05",
        )!
        summary.decisions = ["pass", "pass"]
      }),
      writeMutatedRunnerFixture(directory, "tampered-artifact", runner.runnerPath, async (_, fixtureDirectory) => {
        await Bun.write(
          path.join(fixtureDirectory, "S05", "run-01", "evidence.json"),
          `${JSON.stringify({ tampered: true }, null, 2)}\n`,
        )
      }),
    ])
  const runnerMutationResults = await Promise.all(
    [
      ["forged_scenario_digest_rejected", forgedScenarioDigest],
      ["missing_evidence_id_rejected", forgedEvidenceID],
      ["forged_normalized_digest_rejected", forgedNormalizedDigest],
      ["forged_runner_summary_rejected", forgedRunnerSummary],
      ["tampered_artifact_rejected", tamperedArtifact],
    ].map(async ([name, runnerPath]) => ({
      name,
      passed:
        (
          await evaluateFixture({
            buildSha,
            runnerPath,
          })
        ).status === "invalid",
    })),
  )
  const [automaticFailureRunner, evidenceRecordMismatchRunner] = await Promise.all([
    writeAutomaticFailureRunnerFixture(directory, runner.runnerPath, true),
    writeAutomaticFailureRunnerFixture(directory, runner.runnerPath, false),
  ])
  const automaticFailure = await evaluateFixture({
    buildSha,
    runnerPath: automaticFailureRunner,
  })
  const evidenceRecordMismatch = await evaluateFixture({
    buildSha,
    runnerPath: evidenceRecordMismatchRunner,
  })
  const symlinkRunner = await writeMutatedRunnerFixture(
    directory,
    "symlinked-artifact",
    runner.runnerPath,
    async (_, fixtureDirectory) => {
      const external = path.join(directory, "external-evidence.json")
      const artifact = path.join(fixtureDirectory, "S05", "run-01", "evidence.json")
      await fs.copyFile(artifact, external)
      await fs.rm(artifact)
      await fs.symlink(external, artifact)
    },
  )
  const symlinkResult = await evaluateFixture({
    buildSha,
    runnerPath: symlinkRunner,
  })
  const forgedRunnerDirectory = path.join(directory, "forged-runner")
  await fs.cp(path.dirname(runner.runnerPath), forgedRunnerDirectory, { recursive: true })
  const forgedRunnerPath = path.join(forgedRunnerDirectory, "reproducibility-record.json")
  const forgedRunner = (await Bun.file(forgedRunnerPath).json()) as Record<string, unknown>
  const inventory = forgedRunner.executionRecords as Array<Record<string, unknown>>
  const s12Run01 = inventory.find((item) => item.scenarioId === "S12" && item.runId === "run-01")!
  const forgedRecordPath = path.join(forgedRunnerDirectory, String(s12Run01.relativePath))
  const forgedRecord = (await Bun.file(forgedRecordPath).json()) as Record<string, unknown>
  const forgedCriterion = (forgedRecord.criterionResults as Array<Record<string, unknown>>).find(
    (item) => item.criterionId === "S12-C3",
  )!
  forgedCriterion.status = "pass"
  const forgedRecordSource = `${JSON.stringify(forgedRecord, null, 2)}\n`
  await Bun.write(forgedRecordPath, forgedRecordSource)
  s12Run01.sha256 = sha256(forgedRecordSource)
  await Bun.write(forgedRunnerPath, `${JSON.stringify(forgedRunner, null, 2)}\n`)
  const forgedRunnerResult = await evaluateFixture({
    buildSha,
    runnerPath: forgedRunnerPath,
  })
  const nonexistentCommitRejected = await evaluateR0Gate({
    buildSha: "0".repeat(40),
    runnerPath: runner.runnerPath,
  }).then(
    () => false,
    () => true,
  )
  const offlineRequirePassRejected = await Promise.resolve()
    .then(() =>
      parseArguments([
        "--ref",
        buildSha,
        "--gate",
        "R0",
        "--runner-artifact",
        runner.runnerPath,
        "--automatic-evidence",
        automaticEvidence.packagePath,
        "--human-evidence",
        evidence.evidencePath,
        "--human-signature",
        ephemeralSignature.signaturePath,
        "--human-allowed-signers",
        ephemeralSignature.allowedSignersPath,
        "--out",
        path.join(directory, "decision.json"),
        "--require-pass",
      ]),
    )
    .then(
      () => false,
      () => true,
    )
  const assertions = [
    {
      name: "unanchored_signer_cannot_authorize_release",
      passed:
        unanchoredStructuralEvidence.status === "incomplete" &&
        unanchoredStructuralEvidence.humanEvidenceStatus === "incomplete" &&
        unanchoredStructuralEvidence.missing.includes("HUMAN-EVIDENCE-TRUST-ANCHOR"),
    },
    {
      name: "structurally_valid_unsigned_fixture_remains_incomplete",
      passed:
        unsignedStructuralEvidence.status === "incomplete" &&
        unsignedStructuralEvidence.humanEvidenceStatus === "incomplete" &&
        unsignedStructuralEvidence.missing.includes("HUMAN-EVIDENCE-TRUSTED-SIGNATURE") &&
        unsignedStructuralEvidence.errors.length === 0,
    },
    {
      name: "offline_automatic_package_cannot_authorize_release",
      passed:
        unsignedStructuralEvidence.automaticEvidencePackageStatus === "pass" &&
        unsignedStructuralEvidence.automaticEvidenceStatus === "incomplete" &&
        unsignedStructuralEvidence.missing.includes("AUTOMATIC-EVIDENCE-IN-PROCESS-EXECUTION"),
    },
    {
      name: "unsigned_human_evidence_cannot_pass_with_executed_automatic_evidence",
      passed:
        unsignedWithExecutedAutomaticEvidence.automaticEvidenceStatus === "pass" &&
        unsignedWithExecutedAutomaticEvidence.humanEvidenceStatus === "incomplete" &&
        unsignedWithExecutedAutomaticEvidence.status === "incomplete",
    },
    {
      name: "structurally_valid_signed_fixture_passes_with_explicit_test_trust_anchor",
      passed:
        signedWithExecutedAutomaticEvidence.status === "pass" &&
        signedWithExecutedAutomaticEvidence.automaticEvidenceStatus === "pass" &&
        signedWithExecutedAutomaticEvidence.humanEvidenceStatus === "pass" &&
        signedWithExecutedAutomaticEvidence.humanEvidenceAuthorization.allowedSignersSha256 ===
          ephemeralAllowedSignersSha256,
    },
    {
      name: "explicit_test_trust_anchor_verifies_exact_bytes",
      passed: verifiedEphemeralSignature.status === "pass",
    },
    {
      name: "ephemeral_openssh_signature_rejects_tampered_bytes",
      passed: rejectedTamperedPayload.status === "invalid",
    },
    {
      name: "unanchored_ephemeral_signature_remains_incomplete",
      passed:
        rejectedUnanchoredSignature.status === "incomplete" &&
        rejectedUnanchoredSignature.missing.includes("HUMAN-EVIDENCE-TRUST-ANCHOR"),
    },
    {
      name: "wrong_trust_anchor_rejects_ephemeral_signature",
      passed: rejectedWrongTrustAnchor.status === "invalid",
    },
    { name: "missing_human_evidence_is_incomplete", passed: incomplete.status === "incomplete" },
    {
      name: "missing_automatic_evidence_is_incomplete",
      passed:
        missingAutomaticEvidence.status === "incomplete" &&
        missingAutomaticEvidence.automaticEvidenceStatus === "incomplete",
    },
    ...mutatedResults,
    ...runnerMutationResults,
    {
      name: "automatic_failure_is_gate_failure",
      passed:
        automaticFailure.status === "fail" &&
        automaticFailure.automaticEvidenceStatus === "fail" &&
        automaticFailure.humanEvidenceStatus === "incomplete",
    },
    {
      name: "evidence_record_mismatch_rejected",
      passed: evidenceRecordMismatch.status === "invalid",
    },
    {
      name: "symlinked_artifact_rejected",
      passed: symlinkResult.status === "invalid",
    },
    { name: "forged_s12_c3_pass_rejected", passed: forgedRunnerResult.status === "invalid" },
    { name: "nonexistent_exact_commit_rejected", passed: nonexistentCommitRejected },
    { name: "offline_require_pass_rejected", passed: offlineRequirePassRejected },
  ]
  await fs.rm(directory, { recursive: true, force: true })
  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(
      `R0 gate evaluator self-test failed: ${JSON.stringify({ assertions, unsignedStructuralEvidence, incomplete })}`,
    )
  }
  return {
    result: "pass",
    structuralValidation: "pass",
    releaseAuthorizationBoundary: "verified_against_explicit_test_trust_anchor",
    reusableHumanPassPackageProduced: false,
    missingEvidenceStatus: "incomplete",
    negativeCases: assertions.filter(
      (assertion) =>
        !assertion.name.startsWith("structurally_") &&
        !assertion.name.startsWith("explicit_test_trust_anchor_verifies_"),
    ),
  }
}

function parseArguments(args: string[]) {
  const allowed = new Set([
    "--ref",
    "--gate",
    "--runner-artifact",
    "--automatic-evidence",
    "--execute-automatic",
    "--human-evidence",
    "--human-signature",
    "--human-allowed-signers",
    "--out",
    "--require-pass",
  ])
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!
    if (!item.startsWith("--")) continue
    if (!allowed.has(item)) throw new Error(`Unknown argument: ${item}`)
    if (flags.has(item)) throw new Error(`Duplicate argument: ${item}`)
    flags.add(item)
    if (item !== "--require-pass") {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${item}.`)
      values.set(item, value)
    }
  }
  const consumed = new Set(values.values())
  const stray = args.filter((item) => !item.startsWith("--") && !consumed.has(item))
  if (stray.length) throw new Error(`Unexpected positional argument: ${stray[0]}`)
  if (["--ref", "--gate", "--runner-artifact", "--out"].some((item) => !flags.has(item))) {
    throw new Error("Required arguments: --ref <sha> --gate R0 --runner-artifact <json> --out <json>")
  }
  if (values.get("--gate") !== "R0") throw new Error("This evaluator implements only R0.")
  if (flags.has("--automatic-evidence") && flags.has("--execute-automatic")) {
    throw new Error("--automatic-evidence and --execute-automatic are mutually exclusive.")
  }
  if (
    flags.has("--require-pass") &&
    ["--execute-automatic", "--human-evidence", "--human-signature", "--human-allowed-signers"].some(
      (item) => !flags.has(item),
    )
  ) {
    throw new Error(
      "--require-pass requires --execute-automatic, --human-evidence, --human-signature, and --human-allowed-signers.",
    )
  }
  return {
    buildSha: values.get("--ref") ?? "",
    runnerPath: values.get("--runner-artifact") ?? "",
    automaticEvidencePath: values.get("--automatic-evidence"),
    executeAutomaticOutputDirectory: values.get("--execute-automatic"),
    humanEvidencePath: values.get("--human-evidence"),
    humanSignaturePath: values.get("--human-signature"),
    humanAllowedSignersPath: values.get("--human-allowed-signers"),
    out: values.get("--out") ?? "",
    requirePass: flags.has("--require-pass"),
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    console.log(JSON.stringify(await runGateSelfTest(), null, 2))
  } else {
    const options = parseArguments(Bun.argv.slice(2))
    const result = await evaluateR0Gate(options)
    await Bun.write(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
    if (result.status === "invalid") process.exitCode = 1
    if (options.requirePass && result.status !== "pass") process.exitCode = 2
  }
}
