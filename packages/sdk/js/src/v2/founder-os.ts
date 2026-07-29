export type FounderTwinMode = "off" | "shadow" | "advisor" | "green-delegated" | "yellow-delegated"

export type CompanyCommonsMode = "off" | "ingest-only" | "reading" | "belief-loop"

export type FounderOSModeSettings = {
  founderTwinMode: FounderTwinMode
  companyCommonsMode: CompanyCommonsMode
}

export type FounderOSModeUpdateInput = {
  founderTwinMode: "off" | "shadow"
  companyCommonsMode: CompanyCommonsMode
}

export type FounderOSModeState = {
  schemaVersion: 1
  globalMaximum: FounderOSModeSettings
  company: FounderOSModeSettings
  effective: FounderOSModeSettings
}

export type FounderAuthorityClass = "green" | "yellow" | "red"

export type FounderAssetReference = {
  assetId: string
  version: number
}

export type FounderEvidenceReference = {
  kind: "source" | "artifact" | "decision" | "outcome" | "conversation" | "founder_asset"
  id: string
  version?: number
}

export type FounderProjectGoalProposal = {
  schemaVersion: 1
  type: "project.goal.propose"
  idempotencyKey: string
  payload: {
    goal: string
    projectId?: string
  }
}

export type FounderGovernanceReviewRequest = {
  schemaVersion: 1
  type: "governance.review.request"
  idempotencyKey: string
  payload: {
    subject: string
    question: string
  }
}

export type FounderStaffingChangeProposal = {
  schemaVersion: 1
  type: "organization.staffing.propose"
  idempotencyKey: string
  payload: {
    change: "recruit" | "release" | "role_change"
    role: string
    rationale: string
  }
}

export type FounderExternalCommunicationProposal = {
  schemaVersion: 1
  type: "external.communication.propose"
  idempotencyKey: string
  payload: {
    channel: string
    audience: string
    message: string
  }
}

export type FounderRequestedAction =
  | FounderProjectGoalProposal
  | FounderGovernanceReviewRequest
  | FounderStaffingChangeProposal
  | FounderExternalCommunicationProposal

export const FounderRequestedActionPolicy = {
  "project.goal.propose": {
    authorityClass: "yellow",
    rollbackCapability: "archive_proposal",
  },
  "governance.review.request": {
    authorityClass: "green",
    rollbackCapability: "withdraw_request",
  },
  "organization.staffing.propose": {
    authorityClass: "yellow",
    rollbackCapability: "requires_compensating_action",
  },
  "external.communication.propose": {
    authorityClass: "red",
    rollbackCapability: "none",
  },
} as const satisfies Record<
  FounderRequestedAction["type"],
  {
    authorityClass: FounderAuthorityClass
    rollbackCapability: "archive_proposal" | "withdraw_request" | "requires_compensating_action" | "none"
  }
>

export function classifyFounderRequestedAction(action: FounderRequestedAction) {
  return FounderRequestedActionPolicy[action.type]
}

export type DecisionIntent = {
  schemaVersion: 1
  decisionId: string
  recommendation: string
  alternatives: string[]
  authorityClass: FounderAuthorityClass
  confidence: number
  principlesApplied: FounderAssetReference[]
  evidenceRefs: FounderEvidenceReference[]
  dissent?: string[]
  missingInformation?: string[]
  requestedAction?: FounderRequestedAction
}

export type FounderCorrection = {
  schemaVersion: 1
  correctionId: string
  decisionId: string
  originalRecommendation: string
  humanDecision: string
  correctionReason: string
  proposedAssetUpdates: string[]
  createdAt: string
}

export type GovernanceAssetAuthority = "human_explicit" | "human_confirmed" | "ai_proposed" | "external_source"
export type GovernanceAssetStatus = "draft" | "active" | "deprecated"
export type GovernanceAssetScope = {
  kind: "company" | "domain" | "project" | "brand"
  ref?: string
}
export type GovernanceAsset = {
  id: string
  companyId: string
  type: "constitution" | "principle" | "heuristic" | "boundary" | "taste_reference" | "taste_anti_reference" | "rubric" | "decision_case"
  scope: GovernanceAssetScope
  content: string
  rationale: string
  tags: string[]
  authority: GovernanceAssetAuthority
  status: GovernanceAssetStatus
  sourceRefs: { kind: "artifact" | "decision" | "outcome" | "conversation" | "external"; id: string }[]
  supersedes?: number
  version: number
  createdBy: string
  approvedBy?: string
  createdAt: number
  approvedAt?: number
  current: boolean
}
export type FounderTwinSnapshot = {
  id: string
  companyId: string
  version: number
  profileSummary: string
  assetRefs: FounderAssetReference[]
  activePrincipleIds: string[]
  activeHeuristicIds: string[]
  decisionCaseIds: string[]
  tasteExampleIds: string[]
  rubricIds: string[]
  promptTemplateVersion: string
  modelConfigRef: string
  retrievalConfigRef: string
  permissionConfigRef: string
  compiledPromptHash: string
  checksum: string
  createdBy: string
  createdAt: number
  selected: boolean
}
export type FounderStudioProjection = {
  schemaVersion: 1
  companyId: string
  assets: GovernanceAsset[]
  snapshots: FounderTwinSnapshot[]
  selectedSnapshotId?: string
  calibrationQueue: FounderCalibrationItem[]
  authorization: { status: "not_confirmed"; blocking: false }
}

export type FounderStudioDraftInput = Omit<
  GovernanceAsset,
  "id" | "version" | "status" | "supersedes" | "approvedBy" | "approvedAt" | "createdAt" | "current"
> & {
  authority: "ai_proposed" | "external_source"
}

export type FounderStudioClientConfig = {
  baseUrl: string
  headers?: HeadersInit
  fetch?: typeof fetch
}

export function createFounderStudioClient(config: FounderStudioClientConfig) {
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(config.headers)), ...Object.fromEntries(new Headers(init?.headers)) },
    })
    if (!response.ok) throw new Error(`Founder Studio request failed with HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  return {
    projection(companyId: string, scope: GovernanceAssetScope = { kind: "company" }) {
      const query = new URLSearchParams({ company_id: companyId, scope_kind: scope.kind })
      if (scope.ref) query.set("scope_ref", scope.ref)
      return request<FounderStudioProjection>(`/company/founder-studio?${query}`)
    },
    createDraft(input: FounderStudioDraftInput) {
      return request<GovernanceAsset>("/company/founder-studio/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
    revise(assetId: string, input: {
      baseVersion: number
      content: string
      rationale: string
      tags: string[]
      authority: GovernanceAssetAuthority
      status: GovernanceAssetStatus
      sourceRefs: GovernanceAsset["sourceRefs"]
      actorKind: "ai" | "external" | "human"
      createdBy: string
      confirmation?: { eventId: string; confirmedBy: string }
    }) {
      return request<FounderStudioProjection>(`/company/founder-studio/assets/${encodeURIComponent(assetId)}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
    compileSnapshot(input: {
      companyId: string
      profileSummary: string
      promptTemplateVersion: string
      modelConfigRef: string
      retrievalConfigRef: string
      permissionConfigRef: string
      compiledPromptHash: string
      scope: GovernanceAssetScope
      createdBy: string
    }) {
      return request<FounderTwinSnapshot>("/company/founder-studio/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
    selectSnapshot(input: { companyId: string; snapshotId: string; reason: string; selectedBy: string }) {
      return request<FounderStudioProjection>("/company/founder-studio/snapshot-selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
  }
}

export function createFounderModesClient(config: FounderStudioClientConfig) {
  const request = async <T>(init?: RequestInit) => {
    const response = await (config.fetch ?? fetch)(new URL("/company/founder-os-modes", config.baseUrl), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(config.headers)), ...Object.fromEntries(new Headers(init?.headers)) },
    })
    if (!response.ok) throw new Error(`Founder OS modes request failed with HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  return {
    get() {
      return request<FounderOSModeState>()
    },
    update(input: FounderOSModeUpdateInput) {
      return request<FounderOSModeState>({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
  }
}

export type DecisionScope =
  | { type: "company"; companyId: string }
  | { type: "project"; companyId: string; projectId: string }
  | { type: "pre_project"; companyId: string; preProjectId: string }

export type DecisionMaker = "human" | "ai_founder" | "board" | "policy_engine" | "unknown"

export type DecisionRecordOrigin = "live" | "historical_import"

export type FounderOperatingMode = "shadow" | "advisor" | "green_delegated" | "yellow_delegated"

export type DecisionOperatingMode =
  | "off"
  | "shadow"
  | "advisor"
  | "green_delegated"
  | "yellow_delegated"
  | "not_applicable"
  | "unknown"

export type DecisionRiskLevel = "low" | "medium" | "high" | "critical"

export type DecisionStatus =
  | "unknown"
  | "proposed"
  | "awaiting_approval"
  | "accepted"
  | "executed"
  | "overridden"
  | "failed"
  | "rolled_back"

export type DecisionTransitionKind =
  | "created"
  | "historical_imported"
  | "submitted_for_approval"
  | "accepted"
  | "executed"
  | "overridden"
  | "failed"
  | "rolled_back"

export type FounderTwinSnapshotReference = {
  id: string
  version: number
}

export type DecisionSourceMapping = {
  channelMessageId: string | null
  boardThreadId: string | null
  boardRunId: string | null
  runtimeId: string | null
  sourceCompleteness: "complete" | "partial"
}

type DecisionRecordCommon = {
  schemaVersion: 1
  id: string
  scope: DecisionScope
  source: DecisionSourceMapping | null
  subject: string | null
  context: string | null
  options: string[] | null
  decisionMakerId: string
  evidenceRefs: FounderEvidenceReference[] | null
  principleRefs: FounderAssetReference[] | null
  decisionCaseRefs: FounderAssetReference[] | null
  overrideOf: string | null
  outcomeRefIds: string[]
  transitionCount: number
  createdAt: number
  updatedAt: number
}

type DecisionRecordStatus =
  | {
      currentStatus: "proposed" | "awaiting_approval"
      finalDecision: null
      decidedAt: null
    }
  | {
      currentStatus: "accepted" | "executed" | "overridden" | "failed" | "rolled_back"
      finalDecision: string
      decidedAt: number
    }

type DecisionRecordHistoricalStatus =
  | DecisionRecordStatus
  | {
      currentStatus: "unknown"
      finalDecision: null
      decidedAt: null
    }

export type DecisionRecord =
  DecisionRecordCommon
  & (
    | ({
        recordOrigin: Extract<DecisionRecordOrigin, "live">
        decisionMaker: "ai_founder"
        founderTwinSnapshot: FounderTwinSnapshotReference
        recommendation: string
        authorityClass: FounderAuthorityClass
        operatingMode: FounderOperatingMode
        confidence: number
        reversible: boolean
        externalImpact: boolean
        riskLevel: DecisionRiskLevel
      } & DecisionRecordStatus)
    | ({
        recordOrigin: Extract<DecisionRecordOrigin, "live">
        decisionMaker: "human" | "board" | "policy_engine"
        founderTwinSnapshot: FounderTwinSnapshotReference | null
        recommendation: string | null
        authorityClass: FounderAuthorityClass | null
        operatingMode: DecisionOperatingMode | null
        confidence: number | null
        reversible: boolean | null
        externalImpact: boolean | null
        riskLevel: DecisionRiskLevel | null
      } & DecisionRecordStatus)
    | ({
        recordOrigin: Extract<DecisionRecordOrigin, "historical_import">
        decisionMaker: DecisionMaker
        founderTwinSnapshot: FounderTwinSnapshotReference | null
        recommendation: string | null
        authorityClass: FounderAuthorityClass | null
        operatingMode: DecisionOperatingMode | null
        confidence: number | null
        reversible: boolean | null
        externalImpact: boolean | null
        riskLevel: DecisionRiskLevel | null
      } & DecisionRecordHistoricalStatus)
  )

type DecisionRecordAppendCommon = {
  schemaVersion: 1
  idempotencyKey: string
  scope: DecisionScope
  subject: string
  context: string
  options: string[]
  finalDecision: string | null
  decisionMakerId: string
  evidenceRefs: FounderEvidenceReference[]
  principleRefs: FounderAssetReference[]
  decisionCaseRefs: FounderAssetReference[]
  initialStatus?: "proposed" | "awaiting_approval" | "accepted"
  overrideOf?: string | null
  decidedAt?: number | null
}

export type DecisionRecordAppendInput =
  DecisionRecordAppendCommon
  & (
    | {
        decisionMaker: "ai_founder"
        founderTwinSnapshot: FounderTwinSnapshotReference
        recommendation: string
        authorityClass: FounderAuthorityClass
        operatingMode: FounderOperatingMode
        confidence: number
        reversible: boolean
        externalImpact: boolean
        riskLevel: DecisionRiskLevel
      }
    | {
        decisionMaker: "human" | "board" | "policy_engine"
        founderTwinSnapshot?: FounderTwinSnapshotReference | null
        recommendation?: string | null
        authorityClass?: FounderAuthorityClass | null
        operatingMode?: DecisionOperatingMode | null
        confidence?: number | null
        reversible?: boolean | null
        externalImpact?: boolean | null
        riskLevel?: DecisionRiskLevel | null
      }
  )

type DecisionTransitionInputCommon = {
  schemaVersion: 1
  idempotencyKey: string
  reason: string
  actorId: string
}

export type DecisionTransitionAppendInput =
  DecisionTransitionInputCommon
  & (
    | {
        toStatus: "awaiting_approval"
        kind: "submitted_for_approval"
        finalDecision?: null
        decidedAt?: null
      }
    | {
        toStatus: "accepted" | "executed" | "overridden" | "failed" | "rolled_back"
        kind: "accepted" | "executed" | "overridden" | "failed" | "rolled_back"
        finalDecision: string
        decidedAt?: number
      }
  )

type DecisionTransitionCommon = {
  schemaVersion: 1
  id: string
  decisionId: string
  sequence: number
  fromStatus: DecisionStatus | null
  reason: string
  actorId: string
  createdAt: number
}

export type DecisionTransition =
  DecisionTransitionCommon
  & (
    | {
        toStatus: "unknown" | "proposed" | "awaiting_approval"
        kind: "created" | "historical_imported" | "submitted_for_approval"
        finalDecision: null
        decidedAt: null
      }
    | {
        toStatus: "accepted" | "executed" | "overridden" | "failed" | "rolled_back"
        kind: "accepted" | "executed" | "overridden" | "failed" | "rolled_back"
        finalDecision: string
        decidedAt: number
      }
  )

export type DecisionDispatchStatus = "committed" | "claimed" | "completed" | "failed"

export type DecisionDispatchOutbox = {
  schemaVersion: 1
  id: string
  companyId: string
  decisionId: string
  transitionId: string | null
  consumer: string
  actionType: string
  payload: Record<string, unknown>
  idempotencyKey: string
  executionKey: string
  currentStatus: DecisionDispatchStatus
  eventCount: number
  consumerId: string | null
  leaseToken: string | null
  leaseExpiresAt: number | null
  executionReceipt: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type DecisionDispatchEvent = {
  schemaVersion: 1
  id: string
  outboxId: string
  sequence: number
  status: DecisionDispatchStatus
  consumerId: string | null
  leaseToken: string | null
  leaseExpiresAt: number | null
  executionReceipt: string | null
  error: string | null
  createdAt: number
}

export type DecisionDispatchAuthorizeInput = {
  schemaVersion: 1
  idempotencyKey: string
  consumer: string
  actionType: string
  payload: Record<string, unknown>
  reason: string
  actorId: string
}

export type DecisionDispatchClaimInput = {
  consumer: string
  consumerId: string
  leaseDurationMs: number
}

export type DecisionDispatchResolveInput = {
  consumerId: string
  leaseToken: string
  executionReceipt?: string
  error?: string
}

export type DelegationPolicy = {
  schemaVersion: 1
  id: string
  actionType: string
  riskLevel: FounderAuthorityClass
  reversible: boolean
  externalImpact: boolean
  budgetLimit: Record<string, unknown> | null
  requiresApproval: boolean
  allowedMode: "advisor" | "green_delegated" | "yellow_delegated" | "none"
  version: number
  scope: DecisionScope
  createdAt: number
}

export type FounderShadowEvidenceRef = {
  kind: "artifact" | "decision" | "outcome" | "conversation" | "fact"
  id: string
  version?: number
  validity: "verified" | "missing" | "forbidden"
}

export type FounderContextInput = {
  companyId: string
  scope: GovernanceAssetScope
  currentGoal: string
  discussion: string
  authorizationBoundary: string
  currentFacts: string[]
  evidenceRefs: FounderShadowEvidenceRef[]
  limits?: {
    principles: number
    decisionCases: number
    tasteExamples: number
    rubrics: number
  }
}

export type FounderContextProjection = {
  schemaVersion: 1
  status: "ready" | "blocked"
  companyId: string
  scope: GovernanceAssetScope
  currentGoal: string
  discussion: string
  authorizationBoundary: string
  currentFacts: string[]
  evidenceRefs: FounderShadowEvidenceRef[]
  snapshotId?: string
  snapshotChecksum?: string
  principles: GovernanceAsset[]
  decisionCases: GovernanceAsset[]
  tasteExamples: GovernanceAsset[]
  rubrics: GovernanceAsset[]
  missingInformation: string[]
  blockReasons: Array<
    | "snapshot_missing"
    | "snapshot_checksum_invalid"
    | "context_insufficient"
    | "asset_reference_missing"
    | "asset_scope_forbidden"
    | "evidence_reference_invalid"
  >
}

export type FounderShadowDecision = {
  id: string
  companyId: string
  status: "suggested" | "blocked"
  blockReasons: Array<
    FounderContextProjection["blockReasons"][number]
    | "model_unavailable"
    | "model_timeout"
    | "model_output_missing"
    | "model_output_invalid"
  >
  scope: GovernanceAssetScope
  snapshotId?: string
  snapshotChecksum?: string
  modelConfigRef: string
  recommendation?: string
  alternatives: string[]
  authorityClass?: FounderAuthorityClass
  confidence?: number
  principleRefs: FounderAssetReference[]
  decisionCaseRefs: FounderAssetReference[]
  tasteExampleRefs: FounderAssetReference[]
  rubricRefs: FounderAssetReference[]
  evidenceRefs: FounderShadowEvidenceRef[]
  missingInformation: string[]
  createsGate: false
  canSpeak: false
  canExecute: false
  createdBy: string
  createdAt: number
}

export type FounderShadowComparison = {
  id: string
  companyId: string
  shadowDecisionId: string
  actualDecision: string
  actualDecisionRef: FounderShadowEvidenceRef
  alignment: "match" | "partial" | "mismatch"
  rationale: string
  verificationStatus: "not_confirmed" | "human_confirmed"
  confirmedBy?: string
  confirmationEventId?: string
  comparedBy: string
  createdAt: number
}

export type FounderCalibrationItem = {
  id: string
  companyId: string
  kind: "ab" | "accept" | "reject"
  scope: GovernanceAssetScope
  prompt: string
  candidates: Array<{ artifactId: string; label: string }>
  status: "pending" | "responded"
  response?: "accept" | "reject" | "prefer_first" | "prefer_second"
  reason?: string
  confirmationEventId?: string
  confirmedBy?: string
  createdBy: string
  createdAt: number
}

export type FounderBenchmarkReport = {
  id: string
  companyId: string
  benchmarkType: "founder_decision" | "taste"
  datasetVersion: string
  snapshotId: string
  status: "pass" | "fail" | "blocked"
  blockReasons: Array<
    | "holdout_empty"
    | "prediction_set_incomplete"
    | "training_holdout_leakage"
    | "snapshot_missing"
    | "snapshot_checksum_invalid"
    | "model_unavailable"
    | "model_timeout"
    | "model_output_invalid"
  >
  metrics: {
    caseCount: number
    redRecall: number | null
    traceabilityRate: number | null
    agreementRate: number | null
  }
  authorization: { status: "not_confirmed"; blocking: false; confirmedSampleCount: number }
  createdBy: string
  createdAt: number
}

export type FounderBoardShadowProjection = {
  schemaVersion: 1
  companyId: string
  readOnly: true
  chatIntegrated: false
  createsGate: false
  decisions: FounderShadowDecision[]
  comparisons: FounderShadowComparison[]
  calibrationQueue: FounderCalibrationItem[]
  authorization: { status: "not_confirmed"; blocking: false }
}

export function createFounderShadowClient(config: FounderStudioClientConfig) {
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(config.headers)), ...Object.fromEntries(new Headers(init?.headers)) },
    })
    if (!response.ok) throw new Error(`Founder Shadow request failed with HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  const post = <T>(path: string, input: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  return {
    buildContext(input: FounderContextInput) {
      return post<FounderContextProjection>("/company/founder-shadow/context", input)
    },
    run(input: {
      context: FounderContextInput
      createdBy: string
    }) {
      return post<FounderShadowDecision>("/company/founder-shadow/runs", input)
    },
    compare(input: {
      companyId: string
      shadowDecisionId: string
      actualDecision: string
      actualDecisionRef: FounderShadowEvidenceRef
      alignment: "match" | "partial" | "mismatch"
      rationale: string
      comparedBy: string
      confirmation?: { eventId: string; confirmedBy: string }
    }) {
      return post<FounderShadowComparison>("/company/founder-shadow/comparisons", input)
    },
    audit(companyId: string) {
      return request<FounderBoardShadowProjection>(`/company/founder-shadow/audit?${new URLSearchParams({ company_id: companyId })}`)
    },
    importCase(input: {
      companyId: string
      kind: "decision_case" | "taste_reference" | "taste_anti_reference" | "rubric"
      scope: GovernanceAssetScope
      content: string
      rationale: string
      dimensions: string[]
      sourceRefs: GovernanceAsset["sourceRefs"]
      authority: "ai_proposed" | "external_source"
      createdBy: string
    }) {
      return post<GovernanceAsset>("/company/founder-studio/cases", input)
    },
    enqueueCalibration(input: {
      companyId: string
      kind: "ab" | "accept" | "reject"
      scope: GovernanceAssetScope
      prompt: string
      candidates: Array<{ artifactId: string; label: string }>
      createdBy: string
    }) {
      return post<FounderCalibrationItem>("/company/founder-studio/calibrations", input)
    },
    respondCalibration(input: {
      companyId: string
      requestId: string
      response: "accept" | "reject" | "prefer_first" | "prefer_second"
      reason: string
      actorKind: "human"
      confirmationEventId: string
      confirmedBy: string
    }) {
      return post<FounderCalibrationItem>("/company/founder-studio/calibration-responses", input)
    },
    validateRubric(input: {
      companyId: string
      rubric: FounderAssetReference
      scores: Array<{ dimension: string; score: number }>
    }) {
      return post<{
        status: "valid" | "blocked"
        rubric: FounderAssetReference
        rubricAuthority?: GovernanceAssetAuthority
        scores: Array<{ dimension: string; score: number }>
        aggregate?: number
        blockReasons: Array<"rubric_missing" | "rubric_inactive" | "dimension_mismatch">
      }>("/company/founder-studio/rubric-validations", input)
    },
    registerBenchmarkCase(input: {
      companyId: string
      benchmarkType: "founder_decision" | "taste"
      datasetVersion: string
      split: "training" | "holdout"
      sourceAsset: FounderAssetReference
      expected: { authorityClass?: FounderAuthorityClass; decision?: string; preference?: "accept" | "reject" | "first" | "second" }
      confirmationEventId: string
      confirmedBy: string
    }) {
      return post<{
        id: string
        companyId: string
        benchmarkType: "founder_decision" | "taste"
        datasetVersion: string
        split: "training" | "holdout"
        sourceAsset: FounderAssetReference
        expected: { authorityClass?: FounderAuthorityClass; decision?: string; preference?: "accept" | "reject" | "first" | "second" }
        confirmationEventId: string
        confirmedBy: string
        createdAt: number
      }>("/company/founder-benchmarks/cases", input)
    },
    runBenchmark(input: {
      companyId: string
      benchmarkType: "founder_decision" | "taste"
      datasetVersion: string
      snapshotId: string
      createdBy: string
    }) {
      return post<FounderBenchmarkReport>("/company/founder-benchmarks/runs", input)
    },
  }
}

export type FounderApprovalActorKind = "human" | "ai_founder" | "board" | "policy_engine"

export type DecisionAuthorityInput = {
  decisionId: string
  actionType: string
  proposedAuthorityClass: FounderAuthorityClass
  evidenceSufficient: boolean
  requestedMode: FounderTwinMode
  approvalPreset: "autonomous" | "balanced" | "strict"
}

export type DecisionAuthorityEvaluation = {
  schemaVersion: 1
  decisionId: string
  authorityClass: FounderAuthorityClass
  policyId: string | null
  requiresApproval: boolean
  allowed: boolean
  reasons: string[]
}

export type FounderApprovalGate = {
  id: string
  scope: DecisionScope
  decisionId: string
  kind: "founder_red"
  status: "pending" | "approved" | "rejected"
  title: string
  summary: string
  requestedBy: { kind: FounderApprovalActorKind; id: string }
  decisionNote: string | null
  requestedAt: number
  decidedAt: number | null
}

export type GovernanceRequest = {
  schemaVersion: 1
  idempotencyKey: string
  decisionId: string
  actionType: string
  proposedAuthorityClass: FounderAuthorityClass
  evidenceSufficient: boolean
  requestedBy: { kind: FounderApprovalActorKind; id: string }
}

export type GovernanceDecision = {
  schemaVersion: 1
  decision: DecisionRecord
  authority: DecisionAuthorityEvaluation
  gate: FounderApprovalGate | null
  dispatchAllowed: boolean
}

export type FounderAssetUpdateProposal = {
  target: {
    assetId: string | null
    type: GovernanceAsset["type"]
    scope: GovernanceAssetScope
  }
  baseRevision: {
    assetId: string
    version: number
  } | null
  typedDiff: {
    operation: "create" | "revise"
    content: string
    rationale: string
    tags: string[]
    sourceRefs: GovernanceAsset["sourceRefs"]
  }
  authority: "ai_proposed"
}

export type FounderCorrectionAppendInput = {
  schemaVersion: 1
  idempotencyKey: string
  decisionId: string
  kind: "override" | "correction"
  humanDecision: string
  reason: string
  proposedAssetUpdates: FounderAssetUpdateProposal[]
  actorKind?: "human"
  actorId: string
}

export type FounderCorrectionRecord = Omit<FounderCorrectionAppendInput, "idempotencyKey"> & {
  id: string
  originalDecision: string | null
  createdAt: number
}

export type DecisionCenterActionInput = {
  schemaVersion: 1
  idempotencyKey: string
  action: "accept" | "reject" | "rollback"
  reason: string
  actorId: string
}

export type DecisionCenterItem = {
  decision: DecisionRecord
  sourceLabel: DecisionMaker
  gate: FounderApprovalGate | null
  corrections: FounderCorrectionRecord[]
  outcomes: { id: string; result: "succeeded" | "failed" | "inconclusive"; summary: string; observedAt: number }[]
  yellowSummary: FounderYellowSummary | null
}

export type DecisionCenterProjection = {
  schemaVersion: 1
  companyId: string
  pending: DecisionCenterItem[]
  delegated: DecisionCenterItem[]
  executed: DecisionCenterItem[]
  overridden: DecisionCenterItem[]
  withOutcomes: DecisionCenterItem[]
}

export type FounderOSMetricContract = {
  schemaVersion: 1
  version: "founder-os-w2-v1"
  observationWindow: { days: 30; clock: "observed_at" }
  metrics: {
    id: string
    numerator: string
    denominator: string
    minimumSampleSize: number
    sourceKinds: string[]
    target: string
  }[]
  failClosedWhen: string[]
  humanSampleGate: { strength: "weak"; blockingDevelopment: false }
  selfEvaluationAcceptedAsTruth: false
}

export type FounderGreenReadiness = {
  schemaVersion: 1
  companyId: string
  status: "ready" | "blocked"
  b3: { status: "passed" | "missing"; evidenceRef: string | null }
  e0: { status: "passed" | "missing"; evidenceRef: string | null }
  w5Observation: { status: "passed" | "missing"; evidenceRef: string | null }
  takeoverFence: { status: "passed" | "missing"; evidenceRef: string | null }
  preferenceHoldout: {
    status: "passed" | "missing"
    reportRef: string | null
    agreementRate: number | null
  }
  metricContract: {
    status: "passed" | "missing"
    evidenceRef: string | null
    windowDays: number | null
    sampleContractMet: boolean
  }
  authorization: {
    status: "human_confirmed" | "missing"
    eventId: string | null
    confirmedBy: string | null
  }
  exactCommit: {
    status: "passed" | "missing"
    sha: string | null
    evidenceRef: string | null
  }
  failClosedReasons: string[]
  autoPromotionAllowed: false
  recordedAt: number | null
}

export type FounderGreenDelegationInput = {
  schemaVersion: 1
  companyId: string
  idempotencyKey: string
  decisionId: string
  projectId: string
  boardThreadId: string
  receiptId: string
  actionType: string
  requestedBy: { kind: "ai_founder"; id: "board-ceo" }
}

export type FounderGreenReadinessRecordInput = {
  schemaVersion: 1
  companyId: string
  idempotencyKey: string
  b3ArtifactId: string
  e0ArtifactId: string
  w5ObservationArtifactId: string
  takeoverFenceArtifactId: string
  preferenceBenchmarkReportId: string
  metricContractArtifactId: string
  authorizationEventId: string
  exactCommit: { sha: string; worktreeRunId: string }
  actor: { kind: "human"; id: string }
}

export type FounderGreenDelegationRun = {
  schemaVersion: 1
  id: string
  companyId: string
  idempotencyKey: string
  projectId: string
  boardThreadId: string
  receiptId: string
  actionType: string
  actionAllowlisted: boolean
  status: "blocked" | "authorized" | "outcome_pending" | "completed" | "failed"
  readiness: FounderGreenReadiness
  mode: FounderOSModeState
  authority: DecisionAuthorityEvaluation | null
  gate: FounderApprovalGate | null
  dispatch: {
    status: "paused" | "gated" | "idle" | "dispatched"
    workItemIds: string[]
  } | null
  chain: {
    decisionId: string
    ledgerDecisionId: string
    governanceRef: string | null
    graphDecisionId: string | null
    mutationId: string | null
    workItemIds: string[]
    receiptIds: string[]
    outcomeIds: string[]
    ledgerOutcomeLinked: boolean
  }
  outcomeStatus: "missing" | "succeeded" | "failed" | "inconclusive"
  completeChain: boolean
  failClosedReasons: string[]
  selfEvaluationAcceptedAsTruth: false
  createdAt: number
  updatedAt: number
}

export type FounderGreenDelegationProjection = {
  schemaVersion: 1
  companyId: string
  readiness: FounderGreenReadiness
  mode: FounderOSModeState
  allowlist: Array<"project.receipt.process">
  unknownActionsClassifiedAsRed: true
  activeFenceCount: number
  trends: {
    humanConfirmedShadowComparisons: number
    humanOverrides: number
    selfEvaluations: 0
  }
  runs: FounderGreenDelegationRun[]
  autoPromotionAllowed: false
}

export type FounderYellowGoalBriefDraft = {
  goal: string
  deliverables: { id: string; title: string; description: string }[]
  acceptanceCriteria: { id: string; description: string; verification: string }[]
  constraints: string[]
  nonGoals: string[]
  assumptions: { id: string; description: string; confirmed: boolean }[]
  openQuestions: {
    id: string
    question: string
    impact: string
    blocking: boolean
    defaultAssumption: string
  }[]
  riskLevel: "low" | "medium" | "high" | "critical"
  recommendedPlan: {
    summary: string
    steps: { id: string; title: string; outcome: string }[]
  }
  approvalMode: "autonomous" | "balanced" | "strict"
  sourceRefs: {
    kind:
      | "project"
      | "project_event"
      | "goal_brief"
      | "legacy_charter"
      | "work_item"
      | "approval_gate"
      | "artifact"
      | "delivery"
      | "conversation"
      | "goal_request"
      | "user"
      | "work_attempt"
      | "work_receipt"
      | "graph_mutation"
      | "project_assignment"
      | "validation_gate"
    id: string
    version?: number
    eventType?: string
  }[]
}

export type FounderYellowActionContract = {
  schemaVersion: 1
  actionType: "project.goal.propose"
  costLimit: { unit: "receipt"; maximum: 1 }
  reversible: true
  externalImpact: false
  rollbackHandlerId: "company-project-direction.restore_checkpoint"
  outcomeDeadlineMs: 3_600_000
}

export type FounderYellowReadiness = {
  schemaVersion: 1
  companyId: string
  status: "not_confirmed" | "confirmed"
  greenReadinessRef: string | null
  w6ObservationEvidenceRef: string | null
  e0EvidenceRef: string | null
  outcomeSignalRef: string | null
  authorizationEventRef: string | null
  confirmedBy: string | null
  failClosedReasons: string[]
  autoPromotionAllowed: false
  recordedAt: number | null
}

export type FounderYellowReadinessRecordInput = {
  schemaVersion: 1
  companyId: string
  idempotencyKey: string
  w6ObservationArtifactId: string
  e0ArtifactId: string
  outcomeSignalId: string
  authorizationEventId: string
  actor: { kind: "human"; id: string }
}

export type FounderYellowDelegationInput = {
  schemaVersion: 1
  companyId: string
  idempotencyKey: string
  decisionId: string
  projectId: string
  boardThreadId: string
  receiptId: string
  actionType: "project.goal.propose"
  estimatedCost: { unit: "receipt"; amount: number }
  direction: {
    briefId: string
    expectedBriefVersion: number
    expectedPlanVersion: number
    brief: FounderYellowGoalBriefDraft
  }
  requestedBy: { kind: "ai_founder"; id: "board-ceo" }
}

export type FounderYellowRollbackInput = {
  schemaVersion: 1
  idempotencyKey: string
  trigger: "failure_condition" | "human_decision"
  reason: string
  actor:
    | { kind: "human"; id: string }
    | { kind: "policy_engine"; id: "yellow-circuit-breaker" }
}

export type FounderYellowRollbackRecord = {
  id: string
  trigger: "failure_condition" | "human_decision"
  handlerId: string
  status: "requested" | "completed" | "failed"
  reason: string
  result: string | null
  actorKind: "human" | "policy_engine"
  actorId: string
  createdAt: number
}

export type FounderYellowSummary = {
  schemaVersion: 1
  runId: string
  status: "blocked" | "authorized" | "outcome_pending" | "completed" | "failed" | "rolled_back"
  actionType: "project.goal.propose"
  decisionId: string
  governanceRef: string | null
  mutationId: string | null
  workItemIds: string[]
  receiptIds: string[]
  outcomeIds: string[]
  cost: { unit: "receipt"; limit: number; actual: number }
  checkpointId: string | null
  rollbackHandlerId: string | null
  rollbacks: FounderYellowRollbackRecord[]
  overrideIds: string[]
  circuitBreakerOpen: boolean
  failClosedReasons: string[]
  createdAt: number
  updatedAt: number
}

export type FounderYellowDelegationProjection = {
  schemaVersion: 1
  companyId: string
  readiness: FounderYellowReadiness
  mode: FounderOSModeState
  effectiveDelegationMode: "advisor" | "green-delegated" | "yellow-delegated"
  contracts: FounderYellowActionContract[]
  redInvariants: Array<
    | "external.communication.propose"
    | "external.payment.propose"
    | "production.operation.propose"
    | "data.delete.propose"
    | "privacy.change.propose"
    | "security.change.propose"
    | "child_safety.change.propose"
  >
  circuitBreakerOpen: boolean
  outcomeConsumer: { baseline: "v1"; validatedOutcomeRequired: true }
  summaries: FounderYellowSummary[]
  autoPromotionAllowed: false
}

export function createFounderOSGovernanceClient(config: FounderStudioClientConfig) {
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(config.headers)), ...Object.fromEntries(new Headers(init?.headers)) },
    })
    if (!response.ok) throw new Error(`Founder OS governance request failed with HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    authority(input: DecisionAuthorityInput) {
      return request<DecisionAuthorityEvaluation>("/company/founder-os/authority/evaluate", json(input))
    },
    govern(input: GovernanceRequest) {
      return request<GovernanceDecision>("/company/founder-os/governance", json(input))
    },
    resolveGate(gateId: string, input: {
      decision: "approve" | "reject"
      note: string
      actor: { kind: FounderApprovalActorKind; id: string }
    }) {
      return request<GovernanceDecision>(
        `/company/founder-os/approval-gates/${encodeURIComponent(gateId)}/resolve`,
        json(input),
      )
    },
    correct(input: FounderCorrectionAppendInput) {
      return request<FounderCorrectionRecord>("/company/founder-os/corrections", json(input))
    },
    decisionCenter(companyId: string) {
      return request<DecisionCenterProjection>(
        `/company/founder-os/decision-center?${new URLSearchParams({ company_id: companyId })}`,
      )
    },
    action(decisionId: string, input: DecisionCenterActionInput) {
      return request<DecisionCenterProjection>(
        `/company/founder-os/decision-center/${encodeURIComponent(decisionId)}/actions`,
        json(input),
      )
    },
    metricContract() {
      return request<FounderOSMetricContract>("/company/founder-os/metrics/contract")
    },
    greenDelegations(companyId: string) {
      return request<FounderGreenDelegationProjection>(
        `/company/founder-os/green-delegations?${new URLSearchParams({ company_id: companyId })}`,
      )
    },
    delegateGreen(input: FounderGreenDelegationInput) {
      return request<FounderGreenDelegationRun>("/company/founder-os/green-delegations", json(input))
    },
    recordGreenReadiness(input: FounderGreenReadinessRecordInput) {
      return request<FounderGreenReadiness>("/company/founder-os/green-readiness", json(input))
    },
    yellowDelegations(companyId: string) {
      return request<FounderYellowDelegationProjection>(
        `/company/founder-os/yellow-delegations?${new URLSearchParams({ company_id: companyId })}`,
      )
    },
    delegateYellow(input: FounderYellowDelegationInput) {
      return request<FounderYellowSummary>("/company/founder-os/yellow-delegations", json(input))
    },
    recordYellowReadiness(input: FounderYellowReadinessRecordInput) {
      return request<FounderYellowReadiness>("/company/founder-os/yellow-readiness", json(input))
    },
    rollbackYellow(runId: string, input: FounderYellowRollbackInput) {
      return request<FounderYellowSummary>(
        `/company/founder-os/yellow-delegations/${encodeURIComponent(runId)}/rollback`,
        json(input),
      )
    },
  }
}

export type FounderAdvisorPrincipal = {
  principalId: "board-ceo"
  displayName: "AI 大东 · 创始人代理"
  principalKind: "agent"
  projectionKind: "founder_governance"
  humanAuthoritySource: "local_user"
  isAdditionalEmployee: false
}

export type FounderAdvisorReadiness = {
  schemaVersion: 1
  companyId: string
  status: "ready" | "not_confirmed" | "blocked"
  exactCommit: {
    status: "passed" | "missing"
    sha: string | null
    evidenceRef: string | null
  }
  benchmarkReportId: string | null
  metrics: {
    confirmedSampleCount: number
    redRecall: number | null
    traceabilityRate: number | null
    historicalAgreementRate: number | null
  }
  authorization: {
    status: "human_confirmed" | "missing"
    eventId: string | null
    confirmedBy: string | null
  }
  failClosedReasons: string[]
  autoPromotionAllowed: false
  recordedAt: number | null
}

export type FounderAdvisorReadinessRecordInput = {
  schemaVersion: 1
  companyId: string
  idempotencyKey: string
  benchmarkReportId: string
  exactCommit: { sha: string; worktreeRunId: string }
  authorizationEventId: string
  actor: { kind: "human"; id: string }
}

export type FounderAdvisorConvergence = {
  id: string
  companyId: string
  idempotencyKey: string
  source: {
    boardThreadId: string
    boardRunId?: string
    channelMessageId: string
    shadowDecisionId: string
  }
  currentRequestKey: string
  principal: FounderAdvisorPrincipal
  status: "intent_recorded" | "blocked" | "timed_out"
  events: Array<{
    id: string
    sequence: number
    status: "intent_recorded" | "blocked" | "timed_out"
    reason: string
    createdAt: number
  }>
  decisionIntent?: DecisionIntent
  ledgerDecisionId?: string
  authority: {
    status: "authorized" | "blocked" | "unavailable"
    reason: string
    governanceRef?: string
    reversible?: boolean
    externalImpact?: boolean
    riskLevel?: "low" | "medium" | "high" | "critical"
  }
  driAgentId: string
  timeoutAt: number
  dissent: string[]
  workItemCreated: false
  executionCreated: false
  createdAt: number
}

export type FounderAdvisorConvergenceInput = {
  companyId: string
  idempotencyKey: string
  source: {
    boardThreadId: string
    boardRunId?: string
    channelMessageId: string
    shadowDecisionId: string
  }
  subject: string
  context: string
  driAgentId: string
  timeoutAt: number
  dissent: string[]
  requestedAction?: FounderRequestedAction
}

export type FounderIntervention = {
  id: string
  companyId: string
  idempotencyKey: string
  kind: "takeover" | "pause" | "correct" | "reject" | "redefine_goal"
  boardThreadId: string
  projectId?: string
  decisionId?: string
  ledgerDecisionId: string
  reason: string
  newGoal?: string
  actorId: string
  fenceActive: boolean
  effects: Array<{
    id: string
    interventionId: string
    kind: "attention_opened" | "stop_requested" | "stop_completed" | "stop_failed"
    status: "recorded" | "failed"
    detail: string
    createdAt: number
  }>
  createdAt: number
}

export type FounderInterventionInput = {
  companyId: string
  idempotencyKey: string
  kind: "takeover" | "pause" | "correct" | "reject" | "redefine_goal"
  boardThreadId: string
  projectId?: string
  decisionId?: string
  reason: string
  newGoal?: string
  actorKind: "human"
  actorId: string
}

export type FounderBoardGovernanceProjection = {
  schemaVersion: 1
  companyId: string
  principal: FounderAdvisorPrincipal
  mode: FounderOSModeState
  advisorCanSpeak: boolean
  authorization: { status: "authorized" | "not_confirmed" | "unavailable"; canRaiseModeFromUI: false }
  convergences: FounderAdvisorConvergence[]
  interventions: FounderIntervention[]
  decisions: Array<{
    id: string
    subject: string | null
    recommendation: string | null
    finalDecision: string | null
    authorityClass: FounderAuthorityClass | null
    confidence: number | null
    principleRefs: FounderAssetReference[] | null
    decisionCaseRefs: FounderAssetReference[] | null
    evidenceRefs: FounderEvidenceReference[] | null
    currentStatus: string
    createdAt: number
  }>
  shadow: FounderBoardShadowProjection
  assets: GovernanceAsset[]
  readOnlyEvidence: true
}

export type FounderControlCenterProjection = {
  schemaVersion: 1
  companyId: string
  principal: FounderAdvisorPrincipal
  mode: FounderOSModeState
  authorization: { status: "authorized" | "not_confirmed" | "unavailable"; canRaiseModeFromUI: false }
  pending: { proposedDecisions: number; redDecisions: number; failedStops: number }
  trends: {
    shadowComparisons: number
    shadowOverrides: number
    confirmedCalibrations: number
    takeoverEvents: number
  }
  recentInterventions: FounderIntervention[]
  recentDecisions: FounderBoardGovernanceProjection["decisions"]
}

export function createFounderAdvisorClient(config: FounderStudioClientConfig) {
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(config.headers)), ...Object.fromEntries(new Headers(init?.headers)) },
    })
    if (!response.ok) throw new Error(`Founder Advisor request failed with HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  const post = <T>(path: string, input: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  return {
    board(companyId: string) {
      return request<FounderBoardGovernanceProjection>(`/company/board?${new URLSearchParams({ company_id: companyId })}`)
    },
    readiness(companyId: string) {
      return request<FounderAdvisorReadiness>(
        `/company/board/readiness?${new URLSearchParams({ company_id: companyId })}`,
      )
    },
    recordReadiness(input: FounderAdvisorReadinessRecordInput) {
      return post<FounderAdvisorReadiness>("/company/board/readiness", input)
    },
    converge(input: FounderAdvisorConvergenceInput) {
      return post<FounderAdvisorConvergence>("/company/board/convergences", input)
    },
    intervene(input: FounderInterventionInput) {
      return post<FounderIntervention>("/company/board/interventions", input)
    },
    controlCenter(companyId: string) {
      return request<FounderControlCenterProjection>(
        `/company/founder-control-center?${new URLSearchParams({ company_id: companyId })}`,
      )
    },
  }
}
