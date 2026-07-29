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
