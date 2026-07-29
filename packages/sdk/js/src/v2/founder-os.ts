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
