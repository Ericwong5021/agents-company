import path from "node:path"
import { requiredR0TaskIDs, runAutomaticEvidenceSelfTest } from "./experience-automatic-evidence"
import { runBenchmarkSelfTest } from "./experience-benchmark"
import { runGateSelfTest } from "./experience-gate"
import { runSelfTest, validatePRMetadata } from "./experience-pr-metadata"
import { runSeedGrowEvidenceSelfTest } from "./seed-grow-stage-evidence"
import { runSeedGrowStageSelfTest } from "./seed-grow-stage-gate"

const root = path.resolve(import.meta.dir, "..")
const requiredStates = [
  "draft",
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
const requiredIntents = ["message", "question", "goal", "intervention", "approval_response"]
const requiredMetrics = [
  "activation_success_rate",
  "goal_to_start_actions",
  "delivery_consumability_rate",
  "acceptance_determinability_rate",
  "unnecessary_interruption_rate",
  "recovery_success_rate",
  "sus_score",
]
const requiredTerms = [
  "Bidding",
  "projecting",
  "投影诊断",
  "raw status",
  "dependency ID",
  "Provider ID",
  "Source Protection",
]

async function readJson<T>(file: string) {
  return Bun.file(path.join(root, file)).json() as Promise<T>
}

function unique(values: string[]) {
  return new Set(values).size === values.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sameValues(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value))
}

function sameStructure(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function schemaPatternsAreStringTyped(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(schemaPatternsAreStringTyped)
  if (!isRecord(value)) return true
  if ("pattern" in value && value.type !== "string" && !sameStructure(value.type, ["string", "null"])) return false
  return Object.values(value).every(schemaPatternsAreStringTyped)
}

function containsTerm(source: string, term: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i").test(
    source,
  )
}

function digest(value: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

const errors: string[] = []
const check = (condition: boolean, message: string) => {
  if (!condition) errors.push(message)
}

const manifest = await readJson<{
  canonicalPlan: string
  canonicalArtifacts: Record<string, string>
  validationCommands: string[]
  r0PrerequisiteSlices: Array<{ id: string; sourceTask: string; requiredBy: string[] }>
  humanResearchPolicy: {
    automationMaySubstitute: boolean
    r0BlockingItems: string[]
    requiredEvidence: string[]
    releaseAuthorization: {
      method: string
      namespace: string
      principal: string
      allowedSignersLocation: string
      allowedSignersSha256: string | null
      trustAnchorStatus: string
      unsignedStatus: string
    }
  }
}>("docs/product-design/experience-refactor/manifest.v1.json")
const language = await readJson<{
  primaryNavigation: Array<{ id: string; label: string; route: string; description: string }>
  intentContract: Array<{ id: string; mayCreateWork: boolean }>
  intentRoutingContract: {
    schemaVersion: number
    classificationInput: {
      requiredFields: string[]
      schemaVersion: number
      contextRequiredFields: string[]
      contextOptionalFields: string[]
      additionalFields: boolean
      contextAdditionalFields: boolean
    }
    classificationResult: {
      commonRequiredFields: string[]
      decisionVariants: string[]
      routedRequiredFields: string[]
      confirmationRequiredFields: string[]
      confirmationOptions: string[]
      goalModes: string[]
      workCreationPolicies: string[]
      lowConfidenceDecision: string
      lowConfidenceWorkCreationPolicy: string
      decisionReasonRule: string
    }
    correctionResult: {
      requiredFields: string[]
      optionalFields: string[]
      correctedBy: string
      sameIntentCorrectionAllowed: boolean
      targetCorrectionAllowed: boolean
      previousResultReferenceRequired: boolean
      additionalFields: boolean
    }
  }
  projectionContract: {
    availabilityDiscriminator: string
    availabilityVariants: string[]
    unavailableIsUserStatus: boolean
    userStatusValue: string
    availableRequiredFields: string[]
    unavailableRequiredFields: string[]
    unavailableForbiddenFields: string[]
    reason: {
      availabilityDiscriminator: string
      availabilityVariants: string[]
      knownRequiredFields: string[]
      unavailableRequiredFields: string[]
      unavailableText: string
    }
    action: {
      idField: string
      labelOwner: string
      requiredFields: string[]
      optionalFields: string[]
      missingNextAction: null
      mutationWithoutValidHandler: string
      unavailableAllowedActionIds: string[]
    }
  }
  actions: Array<{ id: string; label: string; description: string }>
  states: Array<{
    id: string
    label: string
    description: string
    whyItMatters: string
    nextStep: string
    allowedActions: string[]
    eventMappings: Array<{
      source: string
      availability: string
      events?: string[]
      values?: string[]
      predicate?: string
    }>
  }>
  prohibitedTerms: Array<{ term: string; replacement: string; reason: string; allowedSurfaces: string[] }>
  fallbackRule: {
    unknownInternalState: string
    missingReason: string
    missingNextAction: string
  }
}>("docs/product-design/experience-refactor/language-contract.v1.json")
const benchmark = await readJson<{
  dataIsolation: { productionDemoDataAllowed: boolean; runDirectoryPattern: string }
  executionRecordRequiredFields: string[]
  scenarios: Array<{
    id: string
    seed: number
    runMode: string
    expectedOutputs: string[]
    allowedQuestions: string[]
    acceptanceCriteria: Array<{ id: string; statement: string; evidence: string }>
    failureConditions: string[]
    observedMetrics: string[]
    humanEvidenceRequired: string[]
  }>
  humanResearchItems: Array<{
    id: string
    status: string
    completionStatus: string
    automationSubstituteAllowed: boolean
    blocksReleaseGate: string
    cannotBeInferredFrom: string[]
  }>
}>("docs/product-design/experience-refactor/benchmark-scenarios.v1.json")
const benchmarkExecutionRecord = await readJson<{
  schemaVersion: number
  recordVersion: string
  additionalProperties: boolean
  required: string[]
  governance: {
    criterionStatuses: string[]
    finalDecisions: string[]
    r0ExecutableScenarios: string[]
    deferredScenarios: Record<string, { gate: string; blockedByTasks: string[] }>
    r0CriterionEligibility: Record<
      string,
      {
        includedInGateDecision: boolean
        deferredToGate: string | null
      }
    >
    spotCheck: { rate: number; rounding: string; seed: number; stratification: string; unsignedStatus: string }
    humanEvidenceCannotPassWithoutSignedEvidence: boolean
    reproducibilityIgnoredFields: string[]
  }
}>("docs/product-design/experience-refactor/benchmark-execution-record.v1.json")
const humanResearchProtocol = await readJson<{
  schemaVersion: number
  id: string
  version: string
  gate: string
  studies: {
    "HR-01": {
      moderatorScriptVersion: string
      minimumParticipants: number
      exactPrompt: string
      scoring: { threshold: number; requiredPromptsPerParticipant: number }
      prompts: Array<{ id: string; stateId: string; requiredConcepts: string[] }>
    }
    "FND-02-LANGUAGE-SIGNOFF": {
      requiredRoles: string[]
      languageContractPath: string
      attestation: string
    }
    "HR-02": {
      moderatorScriptVersion: string
      requiredParticipants: number
      exposure: { durationSeconds: number }
      questions: Array<{ id: string; text: string; requiredConcepts: string[] }>
      studyPassRule: { minimumPassingParticipants: number; outOfParticipants: number }
    }
    "HR-03": {
      reviewScriptVersion: string
      requiredSurfaces: string[]
    }
    "FND-03-SPOT-CHECK": {
      reviewScriptVersion: string
      selectionSeed: number
      selectionRate: number
      rounding: string
      expectedSelectedScenarioIds: string[]
    }
  }
  releaseAuthorization: {
    method: string
    namespace: string
    principal: string
    signedPayload: string
    allowedSignersSource: string
    allowedSignersSha256: string | null
    trustAnchorStatus: string
    unsignedStatus: string
  }
  signoff: { method: string; requiredAttestation: string }
}>("docs/product-design/experience-refactor/human-research-protocol.v1.json")
const humanEvidencePackage = await readJson<Record<string, unknown>>(
  "docs/product-design/experience-refactor/human-evidence-package.v1.json",
)
const automaticEvidenceRequirements = await readJson<{
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
  commands: Array<{
    id: string
    cwd: string
    argv: string[]
    reports: Array<{ path: string; validator: string }>
  }>
  tasks: Array<{
    id: string
    criteria: Array<{ id: string; evidenceRefs: string[] }>
  }>
}>("docs/product-design/experience-refactor/automatic-evidence-requirements.v1.json")
const automaticEvidencePackage = await readJson<Record<string, unknown>>(
  "docs/product-design/experience-refactor/automatic-evidence-package.v1.json",
)
const metrics = await readJson<{
  eventEnvelope: { requiredFields: Record<string, string>; duplicateKey: string }
  metrics: Array<{
    id: string
    formula: string
    collectionMode: string
    minimumEvidence: string[]
    target: { gate: string; operator: string; value: number }
    cannotBeInferredFrom?: string[]
  }>
  releaseGates: Array<{
    id: string
    currentStatus?: string
    requiredThresholds: Array<{ metricId: string }>
    requiredHumanEvidence?: Array<{
      id: string
      status: string
      automationSubstituteAllowed: boolean
      blocking: boolean
    }>
    requiredStructuralEvidence: string[]
  }>
  currentCollectionStatus: {
    automatedProductMetrics: string
    humanResearchMetrics: string
  }
}>("docs/product-design/experience-refactor/metric-contract.v1.json")
const baseline = await readJson<Record<string, unknown>>(
  "docs/product-design/experience-refactor/baselines/current-head.v1.json",
)
const plan = await Bun.file(path.join(root, manifest.canonicalPlan)).text()
const workflow = await Bun.file(path.join(root, ".github/workflows/experience-refactor-metadata.yml")).text()
const pullRequestTemplate = await Bun.file(path.join(root, ".github/pull_request_template.md")).text()
const metadataValidator = await Bun.file(path.join(root, "script/experience-pr-metadata.ts")).text()
const reachableUISurfaceFiles = (
  await Promise.all(
    [
      "packages/app/app/pages/**/*.{vue,ts}",
      "packages/app/app/layouts/**/*.{vue,ts}",
      "packages/app/public/**/*.{svg,html,json}",
    ].map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true }))),
  )
)
  .flat()
  .concat([
    "packages/app/app/app.vue",
    "packages/app/app/app.config.ts",
    "packages/app/app/components/BrandMark.vue",
    "packages/app/app/components/Logo.vue",
    "packages/app/app/components/UserMenu.vue",
    "packages/app/nuxt.config.ts",
    "packages/app/modules/agent-company/runtime/app/components/CompanyConnectionState.vue",
    "packages/app/modules/agent-company/runtime/app/pages/settings/company.vue",
  ])
  .filter((file, index, files) => files.indexOf(file) === index)
  .sort()
const reachableUISurfaces = reachableUISurfaceFiles.map((file) => ({
  file,
  surface: file.includes("/settings/")
    ? "settings_advanced"
    : file.endsWith("/CompanyConnectionState.vue")
      ? "diagnostics"
      : "normal_ui",
}))
const reachableUISources = await Promise.all(
  reachableUISurfaces.map(async (entry) => ({
    ...entry,
    source: await Bun.file(path.join(root, entry.file)).text(),
  })),
)
const shellE2E = await Bun.file(path.join(root, "packages/app/e2e/r0-shell.spec.ts")).text()

Object.values(manifest.canonicalArtifacts).forEach((file) => {
  check(Bun.file(path.join(root, file)).size > 0, `Canonical artifact is missing or empty: ${file}`)
})
check(
  reachableUISurfaceFiles.includes("packages/app/app/pages/library/artifacts/[projectID]/[artifactID].vue") &&
    reachableUISurfaceFiles.length >= 25,
  "User-visible language scanning must discover the complete App surface instead of a fixed file allowlist.",
)
check(
  sameValues(
    manifest.r0PrerequisiteSlices.map((slice) => slice.id),
    ["FND-04[R0-contract]", "GOAL-01[R0-contract]"],
  ),
  "R0 prerequisite slices are incomplete.",
)
check(manifest.humanResearchPolicy.requiredEvidence.length >= 6, "Human research evidence policy is incomplete.")
check(
  !manifest.humanResearchPolicy.automationMaySubstitute &&
    sameValues(manifest.humanResearchPolicy.r0BlockingItems, [
      "FND-02-LANGUAGE-SIGNOFF",
      "HR-01",
      "HR-02",
      "HR-03",
      "FND-03-SPOT-CHECK",
    ]) &&
    manifest.humanResearchPolicy.releaseAuthorization.method === "openssh_detached_signature" &&
    manifest.humanResearchPolicy.releaseAuthorization.namespace === "agent-company-r0-human-evidence" &&
    manifest.humanResearchPolicy.releaseAuthorization.principal === "agent-company-r0-release-owner" &&
    manifest.humanResearchPolicy.releaseAuthorization.allowedSignersLocation === "outside_repository" &&
    ((manifest.humanResearchPolicy.releaseAuthorization.allowedSignersSha256 === null &&
      manifest.humanResearchPolicy.releaseAuthorization.trustAnchorStatus === "not_configured") ||
      (typeof manifest.humanResearchPolicy.releaseAuthorization.allowedSignersSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(manifest.humanResearchPolicy.releaseAuthorization.allowedSignersSha256) &&
        manifest.humanResearchPolicy.releaseAuthorization.trustAnchorStatus === "configured")) &&
    manifest.humanResearchPolicy.releaseAuthorization.unsignedStatus === "incomplete",
  "R0 human evidence policy must forbid automation substitution for all five blocking items.",
)

const navigationIDs = language.primaryNavigation.map((item) => item.id)
check(
  sameValues(navigationIDs, ["inbox", "work", "team", "library", "settings"]),
  "Primary navigation must contain five canonical destinations.",
)
check(
  language.primaryNavigation.every((item) => item.route.startsWith("/") && Boolean(item.description)),
  "Every primary navigation destination needs a stable route and description.",
)
check(
  sameValues(
    language.intentContract.map((intent) => intent.id),
    requiredIntents,
  ),
  "Intent contract must contain exactly five canonical intents.",
)
check(
  language.intentContract
    .filter((intent) => intent.mayCreateWork)
    .map((intent) => intent.id)
    .join(",") === "goal",
  "Only Goal intent may create formal work.",
)
check(
  language.intentRoutingContract.schemaVersion === 1 &&
    language.intentRoutingContract.classificationInput.schemaVersion === 1 &&
    sameStructure(language.intentRoutingContract.classificationInput.requiredFields, [
      "schemaVersion",
      "requestId",
      "text",
      "context",
      "createdAt",
    ]) &&
    sameStructure(language.intentRoutingContract.classificationInput.contextRequiredFields, []) &&
    sameStructure(language.intentRoutingContract.classificationInput.contextOptionalFields, [
      "existingWorkId",
      "pendingDecisionId",
      "replyToId",
    ]) &&
    !language.intentRoutingContract.classificationInput.additionalFields &&
    !language.intentRoutingContract.classificationInput.contextAdditionalFields,
  "Intent classification input Schema is not frozen.",
)
check(
  sameStructure(language.intentRoutingContract.classificationResult.commonRequiredFields, [
    "schemaVersion",
    "requestId",
    "decision",
    "confidence",
    "decisionReason",
    "source",
    "classifiedAt",
  ]) &&
    sameStructure(language.intentRoutingContract.classificationResult.decisionVariants, [
      "routed",
      "needs_confirmation",
    ]) &&
    sameStructure(language.intentRoutingContract.classificationResult.routedRequiredFields, [
      "intent",
      "route",
      "workCreationPolicy",
    ]) &&
    sameStructure(language.intentRoutingContract.classificationResult.confirmationRequiredFields, [
      "proposedIntent",
      "confirmationOptions",
    ]) &&
    sameValues(language.intentRoutingContract.classificationResult.goalModes, ["direct", "briefed"]) &&
    sameValues(language.intentRoutingContract.classificationResult.workCreationPolicies, [
      "forbidden",
      "requires_explicit_start",
    ]) &&
    language.intentRoutingContract.classificationResult.lowConfidenceDecision === "needs_confirmation" &&
    language.intentRoutingContract.classificationResult.lowConfidenceWorkCreationPolicy === "forbidden" &&
    language.intentRoutingContract.classificationResult.decisionReasonRule.includes("never private model reasoning"),
  "Intent classification result Schema must support direct versus briefed goals and a non-creating confirmation fallback.",
)
check(
  sameValues(language.intentRoutingContract.classificationResult.confirmationOptions, [
    "execute_as_goal",
    "discuss_only",
    "answer_only",
    "append_to_work",
    "respond_to_approval",
  ]),
  "Intent confirmation options are incomplete.",
)
check(
  sameStructure(language.intentRoutingContract.correctionResult.requiredFields, [
    "schemaVersion",
    "correctionId",
    "requestId",
    "previousResultRef",
    "correctedBy",
    "correctedAt",
    "result",
  ]) &&
    sameStructure(language.intentRoutingContract.correctionResult.optionalFields, ["reason"]) &&
    language.intentRoutingContract.correctionResult.correctedBy === "user" &&
    language.intentRoutingContract.correctionResult.sameIntentCorrectionAllowed &&
    language.intentRoutingContract.correctionResult.targetCorrectionAllowed &&
    language.intentRoutingContract.correctionResult.previousResultReferenceRequired &&
    !language.intentRoutingContract.correctionResult.additionalFields,
  "Intent correction result Schema must preserve prior-result auditability and same-intent target corrections.",
)
const actionIDs = language.actions.map((action) => action.id)
check(unique(actionIDs), "Action identifiers must be unique.")
check(
  language.actions.every((action) => Boolean(action.label && action.description)),
  "Every action needs a label and description.",
)
const stateIDs = language.states.map((state) => state.id)
check(sameValues(stateIDs, requiredStates), "State contract must contain exactly the canonical user states.")
check(unique(language.states.map((state) => state.label)), "User state labels must be unique.")
check(
  language.states.every(
    (state) =>
      Boolean(state.description && state.whyItMatters && state.nextStep) &&
      state.allowedActions.length > 0 &&
      state.eventMappings.length > 0 &&
      state.allowedActions.every((action) => actionIDs.includes(action)) &&
      state.eventMappings.every(
        (mapping) =>
          ["current", "r0_contract", "future", "legacy_read_only"].includes(mapping.availability) &&
          Boolean(mapping.events?.length || mapping.values?.length),
      ),
  ),
  "Every state needs meaning, next step, valid actions, and event mappings.",
)
check(
  sameStructure(Object.fromEntries(language.states.map((state) => [state.id, state.eventMappings])), {
    draft: [
      {
        source: "company_project.status",
        values: ["intake"],
        predicate: "no valid Goal Brief or read-only legacy Charter view exists",
        availability: "current",
      },
    ],
    needs_input: [
      {
        source: "company_project.event",
        events: ["goal_brief.created", "goal_brief.versioned"],
        predicate: "data.blocking_question_count is greater than zero",
        availability: "current",
      },
    ],
    ready: [
      {
        source: "company_project.event",
        events: ["goal_brief.created", "goal_brief.versioned"],
        predicate: "data.blocking_question_count equals zero and the referenced Goal Brief version validates",
        availability: "current",
      },
      {
        source: "company_project.event",
        events: ["charter.saved"],
        predicate: "no Goal Brief exists and the read-only legacy Charter view validates",
        availability: "legacy_read_only",
      },
    ],
    running: [
      {
        source: "company_project.status",
        values: ["planning", "executing"],
        availability: "current",
      },
      {
        source: "company_project.event",
        events: ["project.status_changed"],
        predicate: "data.to is planning or executing",
        availability: "current",
      },
    ],
    paused: [
      {
        source: "work_control",
        events: ["work.paused"],
        availability: "r0_contract",
      },
    ],
    blocked: [
      {
        source: "company_project.status",
        values: ["blocked"],
        availability: "current",
      },
      {
        source: "company_project.event",
        events: ["work_item.blocked"],
        predicate: "the blocked item prevents all remaining critical-path work; otherwise emit only an Attention Item",
        availability: "current",
      },
    ],
    needs_approval: [
      {
        source: "company_project.status",
        values: ["awaiting_approval"],
        availability: "current",
      },
      {
        source: "company_project.event",
        events: ["gate.requested"],
        predicate: "gate status is pending",
        availability: "current",
      },
    ],
    reviewing: [
      {
        source: "company_project.status",
        values: ["reviewing"],
        availability: "current",
      },
    ],
    revision: [
      {
        source: "company_project.event",
        events: ["work_item.rework_requested", "work_item.rework_scheduled"],
        availability: "current",
      },
      {
        source: "company_project.status",
        values: ["rejected"],
        availability: "current",
      },
    ],
    delivered: [
      {
        source: "delivery",
        events: ["delivery.ready"],
        predicate:
          "data contains a stable delivery id and version, at least one real openable Artifact ref exists in both artifact.created facts and storage, and acceptance is pending",
        availability: "r0_contract",
      },
    ],
    accepted: [
      {
        source: "delivery",
        events: ["delivery.accepted"],
        availability: "r0_contract",
      },
    ],
    failed: [
      {
        source: "company_project.event",
        events: ["work_item.failed"],
        predicate: "no automatic retry remains",
        availability: "r0_contract",
      },
    ],
    cancelled: [
      {
        source: "work_control",
        events: ["work.cancelled"],
        availability: "r0_contract",
      },
    ],
  }),
  "User-state event mappings drifted from the replayable R0 contract.",
)
check(
  language.projectionContract.availabilityDiscriminator === "availability" &&
    sameStructure(language.projectionContract.availabilityVariants, ["available", "unavailable"]) &&
    !language.projectionContract.unavailableIsUserStatus &&
    language.projectionContract.userStatusValue === "state.id" &&
    sameStructure(language.projectionContract.availableRequiredFields, [
      "availability",
      "projectorVersion",
      "sourceWatermark",
      "summary",
      "progress",
      "attentionItems",
      "diagnostics",
    ]) &&
    sameStructure(language.projectionContract.unavailableRequiredFields, [
      "availability",
      "projectorVersion",
      "sourceWatermark",
      "workId",
      "title",
      "updatedAt",
      "reason",
      "diagnostics",
    ]) &&
    sameValues(language.projectionContract.unavailableForbiddenFields, [
      "userStatus",
      "progress",
      "delivery",
      "attentionItems",
    ]),
  "Work Projection must be an available/unavailable union without inventing an Unavailable lifecycle state.",
)
check(
  language.projectionContract.reason.availabilityDiscriminator === "availability" &&
    sameStructure(language.projectionContract.reason.availabilityVariants, ["known", "unavailable"]) &&
    sameStructure(language.projectionContract.reason.knownRequiredFields, ["availability", "text", "sourceRefs"]) &&
    sameStructure(language.projectionContract.reason.unavailableRequiredFields, [
      "availability",
      "text",
      "diagnosticIds",
    ]) &&
    language.projectionContract.reason.unavailableText === "当前原因不可用",
  "Projection reason must distinguish observed facts from unavailable reasons.",
)
check(
  language.projectionContract.action.idField === "id" &&
    language.projectionContract.action.labelOwner === "frontend_localization" &&
    sameStructure(language.projectionContract.action.requiredFields, ["id", "enabled"]) &&
    sameValues(language.projectionContract.action.optionalFields, ["targetRef", "disabledReason"]) &&
    language.projectionContract.action.missingNextAction === null &&
    language.projectionContract.action.mutationWithoutValidHandler === "disabled" &&
    sameStructure(language.projectionContract.action.unavailableAllowedActionIds, ["open_diagnostics"]),
  "Projection actions must use canonical IDs, nullable next actions, and disabled unsafe mutations.",
)
check(
  language.fallbackRule.unknownInternalState.includes("explicit unavailable state") &&
    language.fallbackRule.missingReason.includes("Do not fabricate a reason") &&
    language.fallbackRule.missingNextAction.includes("Disable mutation controls"),
  "Projection fallback rules no longer enforce truthful unavailable, reason, and action behavior.",
)
check(
  requiredTerms.every((term) => language.prohibitedTerms.some((entry) => entry.term === term)),
  "Required prohibited terms are missing.",
)
check(
  language.prohibitedTerms.every(
    (entry) => Boolean(entry.replacement && entry.reason) && entry.allowedSurfaces.length > 0,
  ),
  "Every prohibited term needs a replacement, reason, and explicit exemptions.",
)
const prohibitedUIHits = reachableUISources.flatMap((entry) =>
  language.prohibitedTerms.flatMap((term) =>
    containsTerm(entry.source, term.term) && !term.allowedSurfaces.includes(entry.surface)
      ? [`${entry.file}: ${term.term}`]
      : [],
  ),
)
check(
  prohibitedUIHits.length === 0,
  `Reachable UI or metadata uses prohibited product language without a surface exemption: ${prohibitedUIHits.join(", ")}`,
)
const legacyIdentityHits = reachableUISources.flatMap((entry) =>
  ["Eve", "Slack", "iMessage", "Linear"].flatMap((term) =>
    containsTerm(
      entry.file === "packages/app/nuxt.config.ts"
        ? entry.source
            .split("\n")
            .filter((line) => !line.includes("eve/nuxt") && !line.includes("/_eve_internal/"))
            .join("\n")
        : entry.source,
      term,
    )
      ? [`${entry.file}: ${term}`]
      : [],
  ),
)
check(
  legacyIdentityHits.length === 0,
  `Reachable UI or metadata still exposes template identity: ${legacyIdentityHits.join(", ")}`,
)
check(
  [
    '{ from: "/company", to: "/inbox" }',
    '{ from: "/company/board", to: "/work" }',
    '{ from: "/company/employees", to: "/team" }',
    '{ from: "/company/projects/legacy", to: "/work/legacy" }',
    '{ from: "/chat", to: "/work" }',
    '{ from: "/chat/legacy", to: "/work" }',
    '{ from: "/settings/profile", to: "/settings" }',
    '{ from: "/settings/integrations", to: "/settings" }',
    '{ from: "/settings/company", to: "/settings" }',
  ].every((route) => shellE2E.includes(route)) &&
    shellE2E.includes('test("@r0-shell redirects every legacy entry without a loop"') &&
    shellE2E.includes("await page.goto(route.from)") &&
    /await expect\(page\)\.toHaveURL\(\(?url\)? => url\.pathname === route\.to\)/.test(shellE2E),
  "Legacy route redirects are missing executable E2E coverage.",
)

const scenarioIDs = benchmark.scenarios.map((scenario) => scenario.id)
check(
  sameValues(
    scenarioIDs,
    Array.from({ length: 12 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
  ),
  "Benchmark must contain exactly S01 through S12.",
)
check(unique(benchmark.scenarios.map((scenario) => String(scenario.seed))), "Benchmark seeds must be unique.")
check(
  !benchmark.dataIsolation.productionDemoDataAllowed,
  "Benchmark data must remain isolated from production Demo data.",
)
check(benchmark.executionRecordRequiredFields.length >= 10, "Benchmark execution record is incomplete.")
check(
  benchmarkExecutionRecord.schemaVersion === 1 &&
    benchmarkExecutionRecord.recordVersion === "1.0.0" &&
    !benchmarkExecutionRecord.additionalProperties &&
    benchmark.executionRecordRequiredFields.every((field) => benchmarkExecutionRecord.required.includes(field)) &&
    ["eligibility", "blockedByTasks", "evidence", "sideEffectLedger"].every((field) =>
      benchmarkExecutionRecord.required.includes(field),
    ),
  "Versioned benchmark execution record schema is incomplete.",
)
check(
  sameValues(benchmarkExecutionRecord.governance.criterionStatuses, [
    "pass",
    "fail",
    "not_evaluated",
    "human_pending",
  ]) &&
    sameValues(benchmarkExecutionRecord.governance.finalDecisions, ["pass", "fail", "blocked", "human_pending"]) &&
    sameValues(benchmarkExecutionRecord.governance.r0ExecutableScenarios, ["S05", "S12"]) &&
    sameValues(Object.keys(benchmarkExecutionRecord.governance.deferredScenarios), [
      "S01",
      "S02",
      "S03",
      "S04",
      "S06",
      "S07",
      "S08",
      "S09",
      "S10",
      "S11",
    ]) &&
    Object.values(benchmarkExecutionRecord.governance.deferredScenarios).every(
      (item) => /^R[1-3]$/.test(item.gate) && item.blockedByTasks.length > 0,
    ) &&
    benchmarkExecutionRecord.governance.spotCheck.rate === 0.2 &&
    benchmarkExecutionRecord.governance.spotCheck.rounding === "ceil" &&
    benchmarkExecutionRecord.governance.spotCheck.stratification === "at_least_one_executable_automated_scenario" &&
    benchmarkExecutionRecord.governance.spotCheck.unsignedStatus === "human_pending" &&
    benchmarkExecutionRecord.governance.humanEvidenceCannotPassWithoutSignedEvidence &&
    benchmarkExecutionRecord.governance.reproducibilityIgnoredFields.length >= 4,
  "Benchmark execution governance permits fabricated, deferred, or non-reproducible evidence.",
)
check(
  sameStructure(benchmarkExecutionRecord.governance.r0CriterionEligibility, {
    "S05-C1": { includedInGateDecision: true, deferredToGate: null },
    "S05-C2": { includedInGateDecision: true, deferredToGate: null },
    "S05-C3": { includedInGateDecision: true, deferredToGate: null },
    "S12-C1": { includedInGateDecision: true, deferredToGate: null },
    "S12-C2": { includedInGateDecision: true, deferredToGate: null },
    "S12-C3": { includedInGateDecision: false, deferredToGate: "R1" },
  }),
  "S12-C1/C2 must be R0 criteria while S12-C3 remains explicitly deferred to R1.",
)
check(
  humanResearchProtocol.schemaVersion === 1 &&
    humanResearchProtocol.id === "agent-company-r0-human-research" &&
    humanResearchProtocol.version === "1.0.0" &&
    humanResearchProtocol.gate === "R0" &&
    sameValues(humanResearchProtocol.studies["FND-02-LANGUAGE-SIGNOFF"].requiredRoles, [
      "product",
      "design",
      "frontend",
      "backend",
    ]) &&
    humanResearchProtocol.studies["FND-02-LANGUAGE-SIGNOFF"].languageContractPath ===
      "docs/product-design/experience-refactor/language-contract.v1.json" &&
    Boolean(humanResearchProtocol.studies["FND-02-LANGUAGE-SIGNOFF"].attestation) &&
    humanResearchProtocol.studies["HR-01"].moderatorScriptVersion === "HR01-v1" &&
    humanResearchProtocol.studies["HR-01"].minimumParticipants === 3 &&
    humanResearchProtocol.studies["HR-01"].scoring.threshold === 0.9 &&
    humanResearchProtocol.studies["HR-01"].scoring.requiredPromptsPerParticipant === 12 &&
    sameValues(
      humanResearchProtocol.studies["HR-01"].prompts.map((item) => item.id),
      Array.from({ length: 12 }, (_, index) => `HR01-P${String(index + 1).padStart(2, "0")}`),
    ) &&
    humanResearchProtocol.studies["HR-01"].prompts.every((item) => item.requiredConcepts.length === 3) &&
    humanResearchProtocol.studies["HR-02"].moderatorScriptVersion === "HR02-v1" &&
    humanResearchProtocol.studies["HR-02"].requiredParticipants === 5 &&
    humanResearchProtocol.studies["HR-02"].exposure.durationSeconds === 10 &&
    sameValues(
      humanResearchProtocol.studies["HR-02"].questions.map((item) => item.id),
      ["HR02-Q1", "HR02-Q2", "HR02-Q3"],
    ) &&
    humanResearchProtocol.studies["HR-02"].studyPassRule.minimumPassingParticipants === 4 &&
    humanResearchProtocol.studies["HR-02"].studyPassRule.outOfParticipants === 5 &&
    humanResearchProtocol.studies["HR-03"].reviewScriptVersion === "HR03-v1" &&
    sameValues(humanResearchProtocol.studies["HR-03"].requiredSurfaces, [
      "First-run",
      "Inbox",
      "Goal Brief",
      "Running",
      "Blocked",
      "Gate",
      "Delivery",
      "Team",
    ]) &&
    humanResearchProtocol.studies["FND-03-SPOT-CHECK"].reviewScriptVersion === "FND03-SPOT-v1" &&
    humanResearchProtocol.studies["FND-03-SPOT-CHECK"].selectionSeed === 20260725 &&
    humanResearchProtocol.studies["FND-03-SPOT-CHECK"].selectionRate === 0.2 &&
    humanResearchProtocol.studies["FND-03-SPOT-CHECK"].rounding === "ceil" &&
    sameValues(humanResearchProtocol.studies["FND-03-SPOT-CHECK"].expectedSelectedScenarioIds, ["S05", "S02", "S01"]) &&
    humanResearchProtocol.releaseAuthorization.method === "openssh_detached_signature" &&
    humanResearchProtocol.releaseAuthorization.namespace === "agent-company-r0-human-evidence" &&
    humanResearchProtocol.releaseAuthorization.principal === "agent-company-r0-release-owner" &&
    humanResearchProtocol.releaseAuthorization.signedPayload === "exact_human_evidence_package_bytes" &&
    humanResearchProtocol.releaseAuthorization.allowedSignersSource === "external_release_owner_file" &&
    humanResearchProtocol.releaseAuthorization.allowedSignersSha256 ===
      manifest.humanResearchPolicy.releaseAuthorization.allowedSignersSha256 &&
    humanResearchProtocol.releaseAuthorization.trustAnchorStatus ===
      manifest.humanResearchPolicy.releaseAuthorization.trustAnchorStatus &&
    ((humanResearchProtocol.releaseAuthorization.allowedSignersSha256 === null &&
      humanResearchProtocol.releaseAuthorization.trustAnchorStatus === "not_configured") ||
      (typeof humanResearchProtocol.releaseAuthorization.allowedSignersSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(humanResearchProtocol.releaseAuthorization.allowedSignersSha256) &&
        humanResearchProtocol.releaseAuthorization.trustAnchorStatus === "configured")) &&
    humanResearchProtocol.releaseAuthorization.unsignedStatus === "incomplete" &&
    humanResearchProtocol.signoff.method === "named_human_attestation" &&
    Boolean(humanResearchProtocol.signoff.requiredAttestation),
  "Versioned language signoff, HR-01/02/03, or FND-03 spot-check protocol is incomplete.",
)
check(
  humanEvidencePackage.schemaVersion === 1 &&
    humanEvidencePackage.packageVersion === "1.2.0" &&
    humanEvidencePackage.additionalProperties === false &&
    schemaPatternsAreStringTyped(humanEvidencePackage),
  "Human evidence package schema is not strict or permits non-string pattern bypasses.",
)
check(
  sameStructure(
    manifest.canonicalArtifacts.humanResearchProtocol,
    "docs/product-design/experience-refactor/human-research-protocol.v1.json",
  ) &&
    sameStructure(
      manifest.canonicalArtifacts.humanEvidencePackage,
      "docs/product-design/experience-refactor/human-evidence-package.v1.json",
    ) &&
    sameStructure(
      manifest.canonicalArtifacts.automaticEvidenceRequirements,
      "docs/product-design/experience-refactor/automatic-evidence-requirements.v1.json",
    ) &&
    sameStructure(
      manifest.canonicalArtifacts.automaticEvidencePackage,
      "docs/product-design/experience-refactor/automatic-evidence-package.v1.json",
    ) &&
    manifest.canonicalArtifacts.r0GateEvaluator === "script/experience-gate.ts" &&
    manifest.validationCommands.includes("bun script/experience-automatic-evidence.ts --self-test") &&
    manifest.validationCommands.includes(
      "bun script/experience-automatic-evidence.ts --ref <full-sha> --runner-artifact .artifacts/experience-refactor/<full-sha>/reproducibility-record.json --out .artifacts/experience-refactor/<full-sha>/automatic-evidence",
    ) &&
    manifest.validationCommands.includes("(cd packages/app && bun run test:r0-candidates)") &&
    manifest.validationCommands.some(
      (command) =>
        command.startsWith("bun script/experience-gate.ts --ref") &&
        command.includes("--execute-automatic .artifacts/experience-refactor/<full-sha>/automatic-evidence-release") &&
        command.includes("--human-signature") &&
        command.includes("--human-allowed-signers") &&
        command.includes("--require-pass") &&
        !command.includes("--automatic-evidence "),
    ) &&
    manifest.validationCommands.includes("bun script/experience-gate.ts --self-test") &&
    sameValues(manifest.humanResearchPolicy.r0BlockingItems, [
      "FND-02-LANGUAGE-SIGNOFF",
      "HR-01",
      "HR-02",
      "HR-03",
      "FND-03-SPOT-CHECK",
    ]),
  "Manifest does not govern automatic evidence, human evidence, the evaluator, and blocking reviews.",
)
const automaticCommandIDs = automaticEvidenceRequirements.commands.map((command) => command.id)
const automaticCriterionRefs = automaticEvidenceRequirements.tasks.flatMap((task) =>
  task.criteria.flatMap((criterion) => criterion.evidenceRefs),
)
const humanEvidenceDefinitions = isRecord(humanEvidencePackage.$defs) ? humanEvidencePackage.$defs : {}
const hr01StimulusSetSchema = isRecord(humanEvidenceDefinitions.hr01StimulusSet)
  ? humanEvidenceDefinitions.hr01StimulusSet
  : {}
const hr02StimulusSetSchema = isRecord(humanEvidenceDefinitions.hr02StimulusSet)
  ? humanEvidenceDefinitions.hr02StimulusSet
  : {}
const hr03ScreenshotSetSchema = isRecord(humanEvidenceDefinitions.hr03ScreenshotSet)
  ? humanEvidenceDefinitions.hr03ScreenshotSet
  : {}
const hr01StimulusProperties = isRecord(hr01StimulusSetSchema.properties) ? hr01StimulusSetSchema.properties : {}
const hr02StimulusProperties = isRecord(hr02StimulusSetSchema.properties) ? hr02StimulusSetSchema.properties : {}
const hr03ScreenshotProperties = isRecord(hr03ScreenshotSetSchema.properties) ? hr03ScreenshotSetSchema.properties : {}
check(
  sameStructure(hr01StimulusProperties.manifestRelativePath, { type: "string", minLength: 1 }) &&
    sameStructure(hr02StimulusProperties.manifestRelativePath, {
      const: "human-review/screenshots-manifest.json",
    }) &&
    sameStructure(hr03ScreenshotProperties.manifestRelativePath, {
      const: "human-review/screenshots-manifest.json",
    }),
  "Human evidence schema does not preserve the distinct HR-01 stimulus and HR-02/03 screenshot manifest paths.",
)
check(
  automaticEvidenceRequirements.schemaVersion === 1 &&
    automaticEvidenceRequirements.id === "agent-company-r0-automatic-evidence-requirements" &&
    automaticEvidenceRequirements.version === "1.2.0" &&
    automaticEvidenceRequirements.gate === "R0" &&
    sameValues(automaticEvidenceRequirements.requiredTaskIds, [...requiredR0TaskIDs]) &&
    sameValues(
      automaticEvidenceRequirements.tasks.map((task) => task.id),
      [...requiredR0TaskIDs],
    ) &&
    automaticEvidenceRequirements.tasks.every(
      (task) =>
        task.criteria.length > 0 &&
        unique(task.criteria.map((criterion) => criterion.id)) &&
        task.criteria.every(
          (criterion) =>
            criterion.evidenceRefs.length > 0 &&
            criterion.evidenceRefs.every(
              (reference) =>
                reference === "runner" ||
                (reference.startsWith("command:") && automaticCommandIDs.includes(reference.slice("command:".length))),
            ),
        ),
    ) &&
    unique(automaticEvidenceRequirements.tasks.flatMap((task) => task.criteria.map((criterion) => criterion.id))) &&
    automaticEvidenceRequirements.isolation.mode === "detached_exact_commit_worktree" &&
    !automaticEvidenceRequirements.isolation.liveDatabaseAllowed &&
    sameValues(automaticEvidenceRequirements.isolation.requiredEnvironment, [
      "HOME",
      "USERPROFILE",
      "AGENTCOMPANY_HOME",
      "AGENT_COMPANY_WEBUI_DATA_DIR",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]),
  "Automatic evidence requirements do not exactly cover all R0 tasks, criteria, references, and isolation.",
)
check(
  [
    "governance-validation",
    "shared-typecheck",
    "control-plane-typecheck",
    "app-typecheck",
    "sdk-js-typecheck",
    "desktop-typecheck",
    "control-plane-r0-unit",
    "control-plane-r0-branches",
    "shared-unit",
    "sdk-js-unit",
    "sdk-js-build",
    "sdk-js-generated-diff",
    "app-unit",
    "app-r0-config-matrix",
    "app-r0-shell",
    "app-r0-candidates",
    "app-production",
    "desktop-e2e",
  ].every((command) => automaticCommandIDs.includes(command)) &&
    automaticCommandIDs.every((command) => automaticCriterionRefs.includes(`command:${command}`)) &&
    automaticEvidenceRequirements.tasks
      .find((task) => task.id === "FND-01")
      ?.criteria.some(
        (criterion) =>
          criterion.id === "FND-01-DEFAULT-AND-ENABLED-CONFIG" &&
          criterion.evidenceRefs.includes("command:app-r0-config-matrix"),
      ) === true &&
    sameValues(
      automaticEvidenceRequirements.tasks
        .find((task) => task.id === "SHELL-03")
        ?.criteria.map((criterion) => criterion.id) ?? [],
      [
        "SHELL-03-NO-DOM-OR-FLOATING-INJECTION",
        "SHELL-03-NO-DUPLICATE-OR-FLASHING-NAVIGATION",
        "SHELL-03-LEGACY-ROUTES-NO-LOOP",
        "SHELL-03-SINGLE-NAVIGATION-CONFIG",
      ],
    ),
  "Automatic evidence commands omit config, type, SDK, Desktop, candidate provenance, or SHELL-03 acceptance gates.",
)
const automaticEvidenceDefinitions = isRecord(automaticEvidencePackage.$defs) ? automaticEvidencePackage.$defs : {}
const automaticEvidenceProperties = isRecord(automaticEvidencePackage.properties)
  ? automaticEvidencePackage.properties
  : {}
const automaticHR01StimuliSchema = isRecord(automaticEvidenceDefinitions.releaseCandidateHR01Stimuli)
  ? automaticEvidenceDefinitions.releaseCandidateHR01Stimuli
  : {}
const automaticHR01StimulusSchema = isRecord(automaticEvidenceDefinitions.releaseCandidateHR01Stimulus)
  ? automaticEvidenceDefinitions.releaseCandidateHR01Stimulus
  : {}
const automaticHR01StimuliProperties = isRecord(automaticHR01StimuliSchema.properties)
  ? automaticHR01StimuliSchema.properties
  : {}
const automaticHR01StimulusProperties = isRecord(automaticHR01StimulusSchema.properties)
  ? automaticHR01StimulusSchema.properties
  : {}
check(
  automaticEvidencePackage.schemaVersion === 1 &&
    automaticEvidencePackage.packageVersion === "1.2.0" &&
    automaticEvidencePackage.additionalProperties === false &&
    Array.isArray(automaticEvidencePackage.required) &&
    automaticEvidencePackage.required.includes("releaseCandidateScreenshots") &&
    automaticEvidencePackage.required.includes("releaseCandidateHR01Stimuli") &&
    sameStructure(automaticEvidenceProperties.releaseCandidateHR01Stimuli, {
      anyOf: [{ type: "null" }, { $ref: "#/$defs/releaseCandidateHR01Stimuli" }],
    }) &&
    automaticHR01StimuliSchema.additionalProperties === false &&
    Array.isArray(automaticHR01StimuliSchema.required) &&
    sameValues(automaticHR01StimuliSchema.required, ["generatorCommandId", "buildSha", "manifest", "stimuli"]) &&
    sameStructure(automaticHR01StimuliProperties.generatorCommandId, { const: "app-r0-candidates" }) &&
    isRecord(automaticHR01StimuliProperties.stimuli) &&
    automaticHR01StimuliProperties.stimuli.minItems === 12 &&
    automaticHR01StimuliProperties.stimuli.maxItems === 12 &&
    sameStructure(automaticHR01StimuliProperties.stimuli.items, {
      $ref: "#/$defs/releaseCandidateHR01Stimulus",
    }) &&
    automaticHR01StimulusSchema.additionalProperties === false &&
    Array.isArray(automaticHR01StimulusSchema.required) &&
    sameValues(automaticHR01StimulusSchema.required, ["promptId", "stateId", "sourceRelativePath", "file"]) &&
    isRecord(automaticHR01StimulusProperties.promptId) &&
    sameValues(
      Array.isArray(automaticHR01StimulusProperties.promptId.enum)
        ? automaticHR01StimulusProperties.promptId.enum.filter((value): value is string => typeof value === "string")
        : [],
      Array.from({ length: 12 }, (_, index) => `HR01-P${String(index + 1).padStart(2, "0")}`),
    ) &&
    isRecord(automaticHR01StimulusProperties.stateId) &&
    sameValues(
      Array.isArray(automaticHR01StimulusProperties.stateId.enum)
        ? automaticHR01StimulusProperties.stateId.enum.filter((value): value is string => typeof value === "string")
        : [],
      [
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
      ],
    ) &&
    schemaPatternsAreStringTyped(automaticEvidencePackage),
  "Automatic evidence package schema is not strict or permits non-string pattern bypasses.",
)
const metricIDs = metrics.metrics.map((metric) => metric.id)
check(
  benchmark.scenarios.every(
    (scenario) =>
      ["automated", "hybrid", "human_observed"].includes(scenario.runMode) &&
      scenario.expectedOutputs.length > 0 &&
      scenario.acceptanceCriteria.length > 0 &&
      scenario.failureConditions.length > 0 &&
      scenario.observedMetrics.length > 0 &&
      scenario.observedMetrics.every((metric) => metricIDs.includes(metric)) &&
      scenario.acceptanceCriteria.every((criterion) =>
        Boolean(criterion.id && criterion.statement && criterion.evidence),
      ),
  ),
  "Every benchmark scenario needs deterministic inputs, evidence-bearing criteria, failures, and known metrics.",
)
check(
  sameValues(
    benchmark.humanResearchItems.map((item) => item.id),
    ["HR-01", "HR-02", "HR-03"],
  ) &&
    benchmark.humanResearchItems.every(
      (item) =>
        item.status === "not_scheduled" &&
        item.completionStatus === "incomplete" &&
        !item.automationSubstituteAllowed &&
        item.blocksReleaseGate === "R0" &&
        item.cannotBeInferredFrom.length > 0,
    ),
  "R0 human gates must remain explicitly incomplete, non-inferable, and impossible to replace with automation.",
)

check(
  requiredMetrics.every((metric) => metricIDs.includes(metric)),
  "Required product metrics are missing.",
)
check(unique(metricIDs), "Metric identifiers must be unique.")
check(
  metrics.metrics.every(
    (metric) =>
      Boolean(metric.formula) &&
      ["automated", "hybrid", "human_research"].includes(metric.collectionMode) &&
      metric.minimumEvidence.length > 0 &&
      /^R[0-4]$/.test(metric.target.gate),
  ),
  "Every metric needs a formula, collection mode, evidence, and release target.",
)
check(
  metrics.metrics
    .filter((metric) => metric.collectionMode === "human_research")
    .every((metric) => (metric.cannotBeInferredFrom?.length ?? 0) > 0),
  "Human metrics must state what cannot substitute for research.",
)
check(
  sameValues(
    metrics.releaseGates.map((gate) => gate.id),
    ["R0", "R1", "R2", "R3", "R4"],
  ),
  "Metric contract must define thresholds for R0 through R4.",
)
check(
  metrics.releaseGates.every(
    (gate) =>
      gate.requiredThresholds.length > 0 &&
      gate.requiredThresholds.every((threshold) => metricIDs.includes(threshold.metricId)) &&
      gate.requiredStructuralEvidence.length > 0,
  ),
  "Every release gate needs valid thresholds and structural evidence.",
)
const r0Gate = metrics.releaseGates.find((gate) => gate.id === "R0")
check(
  r0Gate?.currentStatus === "incomplete" &&
    sameValues(r0Gate.requiredHumanEvidence?.map((item) => item.id) ?? [], ["HR-01", "HR-02", "HR-03"]) &&
    r0Gate.requiredHumanEvidence?.every(
      (item) => item.status === "incomplete" && !item.automationSubstituteAllowed && item.blocking,
    ) === true,
  "R0 gate must be incomplete and blocked by the three non-automatable human approvals.",
)
check(
  metrics.currentCollectionStatus.automatedProductMetrics === "not_collectable" &&
    metrics.currentCollectionStatus.humanResearchMetrics === "not_scheduled",
  "Current unmeasured product and human metrics must not contain fabricated values.",
)

check(
  plan.includes("FND-04[R0-contract]") &&
    plan.includes("GOAL-01[R0-contract]") &&
    plan.includes(
      "| SHELL-02 | 建立原生 Agent Company App Shell 与一级导航 | 信息架构 | P0 | L | R0 | FND-04[R0-contract], SHELL-01 |",
    ) &&
    plan.includes(
      "| GOAL-02 | 建立结构化 Goal Brief / Charter Draft 数据契约 | 领域模型 | P0 | L | R0 | FND-02, GOAL-01[R0-contract] |",
    ),
  "Plan still contains reverse-phase R0 dependencies.",
)
check(
  workflow.includes("bun script/experience-pr-metadata.ts") &&
    ["packages/app/", "packages/control-plane/", "packages/shared/", "packages/desktop/"].every((value) =>
      metadataValidator.includes(value),
    ),
  "PR metadata workflow does not cover every required product package.",
)
check(
  ["Task ID:", "Release gate:", "Core-loop impact:", "Scope decision:", "### Acceptance evidence"].every((value) =>
    pullRequestTemplate.includes(value),
  ),
  "PR template is missing required experience metadata.",
)
check(
  validatePRMetadata(pullRequestTemplate, ["packages/app/example.ts"]).errors.length === 5,
  "An untouched PR template must fail every required metadata field.",
)

const baselineReplayCommand = "bun script/experience-baseline.ts --recorded-head"
const baselineRuns = Array.from({ length: 2 }, () =>
  Bun.spawnSync([process.execPath, "script/experience-baseline.ts", "--recorded-head"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  }),
)
const baselineRunEvidence = baselineRuns.map((run, index) => ({
  run: index + 1,
  exitCode: run.exitCode,
  stdoutBytes: run.stdout.byteLength,
  stdoutSha256: digest(run.stdout),
  stderr: run.stderr.toString().trim(),
}))
check(
  baselineRuns.every((run) => run.exitCode === 0),
  "Recorded baseline command did not exit zero twice.",
)
check(
  baselineRuns[0]?.stdout.toString() === baselineRuns[1]?.stdout.toString(),
  "Two recorded baseline command runs are not byte-identical.",
)
const currentBaseline = JSON.parse(baselineRuns[0]?.stdout.toString() ?? "{}") as Record<string, unknown>
check(
  JSON.stringify(currentBaseline) === JSON.stringify(baseline),
  "Current HEAD baseline does not match the reproducible collector output.",
)
const metadataSelfTest = runSelfTest()
const benchmarkRunnerSelfTest = await runBenchmarkSelfTest()
const automaticEvidenceSelfTest = await runAutomaticEvidenceSelfTest()
const gateEvaluatorSelfTest = await runGateSelfTest()
const seedGrowEvidenceSelfTest = await runSeedGrowEvidenceSelfTest()
const seedGrowStageSelfTest = await runSeedGrowStageSelfTest()

if (errors.length) {
  errors.forEach((error) => console.error(error))
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      result: "pass",
      languageContract: {
        navigationDestinations: navigationIDs.length,
        intents: language.intentContract.length,
        states: stateIDs.length,
        actions: actionIDs.length,
        prohibitedTerms: language.prohibitedTerms.length,
      },
      benchmark: {
        scenarios: scenarioIDs.length,
        digest: (baseline.scenarioContract as { sha256: string }).sha256,
        humanResearchPending: benchmark.humanResearchItems.length,
        executionRecordSchema: benchmarkExecutionRecord.recordVersion,
        runnerSelfTest: benchmarkRunnerSelfTest,
        gateEvaluatorSelfTest,
      },
      automaticEvidence: automaticEvidenceSelfTest,
      seedGrow: {
        evidenceRunnerSelfTest: seedGrowEvidenceSelfTest,
        stageGateSelfTest: seedGrowStageSelfTest,
      },
      metrics: {
        metrics: metricIDs.length,
        releaseGates: metrics.releaseGates.length,
        numericCurrentHeadClaims: 0,
      },
      baseline: {
        command: baselineReplayCommand,
        commitSha: baseline.commitSha,
        runs: baselineRunEvidence,
        byteIdentical: baselineRuns[0]?.stdout.toString() === baselineRuns[1]?.stdout.toString(),
        recordedIdentical: JSON.stringify(currentBaseline) === JSON.stringify(baseline),
      },
      prMetadata: metadataSelfTest,
    },
    null,
    2,
  ),
)
