export type FounderTwinMode = "off" | "shadow" | "advisor" | "green-delegated" | "yellow-delegated"

export type CompanyCommonsMode = "off" | "ingest-only" | "reading" | "belief-loop"

export type FounderOSModeSettings = {
  founderTwinMode: FounderTwinMode
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
  current: boolean
}
export type FounderTwinSnapshot = {
  id: string
  companyId: string
  version: number
  profileSummary: string
  assetRefs: FounderAssetReference[]
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
  authorization: { status: "not_confirmed"; blocking: false }
}

export type FounderStudioDraftInput = Omit<
  GovernanceAsset,
  "id" | "version" | "status" | "supersedes" | "approvedBy" | "createdAt" | "current"
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

export type DecisionScope =
  | { type: "company"; companyId: string }
  | { type: "project"; companyId: string; projectId: string }
  | { type: "pre_project"; companyId: string; preProjectId: string }

export type DecisionMaker = "human" | "ai_founder" | "board" | "policy_engine" | "unknown"

export type FounderOperatingMode = "shadow" | "advisor" | "green_delegated" | "yellow_delegated"

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

export type DecisionRecord = {
  schemaVersion: 1
  id: string
  scope: DecisionScope
  source: DecisionSourceMapping | null
  founderTwinSnapshot: FounderTwinSnapshotReference | null
  subject: string | null
  context: string | null
  options: string[] | null
  recommendation: string | null
  finalDecision: string | null
  decisionMaker: DecisionMaker
  decisionMakerId: string
  authorityClass: FounderAuthorityClass | null
  operatingMode: FounderOperatingMode | null
  confidence: number | null
  reversible: boolean | null
  externalImpact: boolean | null
  riskLevel: DecisionRiskLevel | null
  evidenceRefs: FounderEvidenceReference[] | null
  principleRefs: FounderAssetReference[] | null
  decisionCaseRefs: FounderAssetReference[] | null
  currentStatus: DecisionStatus
  overrideOf: string | null
  outcomeRefIds: string[]
  transitionCount: number
  createdAt: number
  decidedAt: number | null
  updatedAt: number
}

export type DecisionRecordAppendInput = {
  schemaVersion: 1
  idempotencyKey: string
  scope: DecisionScope
  founderTwinSnapshot: FounderTwinSnapshotReference | null
  subject: string
  context: string
  options: string[]
  recommendation: string
  finalDecision: string | null
  decisionMaker: Exclude<DecisionMaker, "unknown">
  decisionMakerId: string
  authorityClass: FounderAuthorityClass
  operatingMode: FounderOperatingMode | null
  confidence: number
  reversible: boolean
  externalImpact: boolean
  riskLevel: DecisionRiskLevel
  evidenceRefs: FounderEvidenceReference[]
  principleRefs: FounderAssetReference[]
  decisionCaseRefs: FounderAssetReference[]
  initialStatus?: "proposed" | "awaiting_approval" | "accepted"
  overrideOf?: string | null
  decidedAt?: number | null
}

export type DecisionTransitionAppendInput = {
  schemaVersion: 1
  idempotencyKey: string
  toStatus: Exclude<DecisionStatus, "unknown">
  kind: Exclude<DecisionTransitionKind, "created" | "historical_imported">
  reason: string
  actorId: string
}

export type DecisionTransition = {
  schemaVersion: 1
  id: string
  decisionId: string
  sequence: number
  fromStatus: DecisionStatus | null
  toStatus: DecisionStatus
  kind: DecisionTransitionKind
  reason: string
  actorId: string
  createdAt: number
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
  blockReasons: Array<FounderContextProjection["blockReasons"][number] | "model_unavailable" | "model_output_missing">
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
  blockReasons: Array<"holdout_empty" | "prediction_set_incomplete" | "training_holdout_leakage" | "snapshot_missing">
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
      model: { status: "available" | "unavailable"; configRef: string }
      output?: {
        recommendation: string
        alternatives: string[]
        authorityClass: FounderAuthorityClass
        confidence: number
        missingInformation: string[]
      }
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
      predictions: Array<{
        caseId: string
        authorityClass?: FounderAuthorityClass
        decision?: string
        preference?: "accept" | "reject" | "first" | "second"
        principleRefs: FounderAssetReference[]
        evidenceRefs: FounderShadowEvidenceRef[]
        decisionCaseRefs: FounderAssetReference[]
      }>
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
  assetId: string | null
  change: string
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
  principal: FounderAdvisorPrincipal
  status: "intent_recorded" | "blocked"
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
    converge(input: {
      companyId: string
      idempotencyKey: string
      source: { boardThreadId: string; boardRunId?: string; channelMessageId: string; shadowDecisionId: string }
      subject: string
      context: string
      driAgentId: string
      timeoutAt: number
      dissent: string[]
      requestedAction?: FounderRequestedAction
    }) {
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
