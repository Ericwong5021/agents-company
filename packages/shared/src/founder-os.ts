import z from "zod"

const Identifier = z.string().trim().min(1).max(240)
const ShortText = z.string().trim().min(1).max(1_000)
const LongText = z.string().trim().min(1).max(20_000)

export const FounderTwinMode = z.enum(["off", "shadow", "advisor", "green-delegated", "yellow-delegated"])
export type FounderTwinMode = z.infer<typeof FounderTwinMode>

export const CompanyCommonsMode = z.enum(["off", "ingest-only", "reading", "belief-loop"])
export type CompanyCommonsMode = z.infer<typeof CompanyCommonsMode>

export const FounderOSModeSettings = z
  .object({
    founderTwinMode: FounderTwinMode,
    companyCommonsMode: CompanyCommonsMode,
  })
  .strict()
  .meta({ ref: "FounderOSModeSettings" })
export type FounderOSModeSettings = z.infer<typeof FounderOSModeSettings>

export const FounderOSModeState = z
  .object({
    schemaVersion: z.literal(1),
    globalMaximum: FounderOSModeSettings,
    company: FounderOSModeSettings,
    effective: FounderOSModeSettings,
  })
  .strict()
  .meta({ ref: "FounderOSModeState" })
export type FounderOSModeState = z.infer<typeof FounderOSModeState>

export const FounderAuthorityClass = z.enum(["green", "yellow", "red"])
export type FounderAuthorityClass = z.infer<typeof FounderAuthorityClass>

export const FounderAssetReference = z
  .object({
    assetId: Identifier,
    version: z.number().int().positive(),
  })
  .strict()
  .meta({ ref: "FounderAssetReference" })
export type FounderAssetReference = z.infer<typeof FounderAssetReference>

export const FounderEvidenceReference = z
  .object({
    kind: z.enum(["source", "artifact", "decision", "outcome", "conversation", "founder_asset"]),
    id: Identifier,
    version: z.number().int().positive().optional(),
  })
  .strict()
  .meta({ ref: "FounderEvidenceReference" })
export type FounderEvidenceReference = z.infer<typeof FounderEvidenceReference>

const RequestedActionBase = {
  schemaVersion: z.literal(1),
  idempotencyKey: Identifier,
}

export const FounderProjectGoalProposal = z
  .object({
    ...RequestedActionBase,
    type: z.literal("project.goal.propose"),
    payload: z
      .object({
        goal: LongText,
        projectId: Identifier.optional(),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderProjectGoalProposal" })
export type FounderProjectGoalProposal = z.infer<typeof FounderProjectGoalProposal>

export const FounderGovernanceReviewRequest = z
  .object({
    ...RequestedActionBase,
    type: z.literal("governance.review.request"),
    payload: z
      .object({
        subject: ShortText,
        question: LongText,
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderGovernanceReviewRequest" })
export type FounderGovernanceReviewRequest = z.infer<typeof FounderGovernanceReviewRequest>

export const FounderStaffingChangeProposal = z
  .object({
    ...RequestedActionBase,
    type: z.literal("organization.staffing.propose"),
    payload: z
      .object({
        change: z.enum(["recruit", "release", "role_change"]),
        role: ShortText,
        rationale: LongText,
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderStaffingChangeProposal" })
export type FounderStaffingChangeProposal = z.infer<typeof FounderStaffingChangeProposal>

export const FounderExternalCommunicationProposal = z
  .object({
    ...RequestedActionBase,
    type: z.literal("external.communication.propose"),
    payload: z
      .object({
        channel: ShortText,
        audience: ShortText,
        message: LongText,
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderExternalCommunicationProposal" })
export type FounderExternalCommunicationProposal = z.infer<typeof FounderExternalCommunicationProposal>

export const FounderRequestedAction = z
  .discriminatedUnion("type", [
    FounderProjectGoalProposal,
    FounderGovernanceReviewRequest,
    FounderStaffingChangeProposal,
    FounderExternalCommunicationProposal,
  ])
  .meta({ ref: "FounderRequestedAction" })
export type FounderRequestedAction = z.infer<typeof FounderRequestedAction>

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

export const DecisionIntent = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: Identifier,
    recommendation: LongText,
    alternatives: z.array(LongText).max(100),
    authorityClass: FounderAuthorityClass,
    confidence: z.number().min(0).max(1),
    principlesApplied: z.array(FounderAssetReference).max(500),
    evidenceRefs: z.array(FounderEvidenceReference).max(500),
    dissent: z.array(LongText).max(100).optional(),
    missingInformation: z.array(LongText).max(100).optional(),
    requestedAction: FounderRequestedAction.optional(),
  })
  .strict()
  .meta({ ref: "DecisionIntent" })
export type DecisionIntent = z.infer<typeof DecisionIntent>

export const FounderCorrection = z
  .object({
    schemaVersion: z.literal(1),
    correctionId: Identifier,
    decisionId: Identifier,
    originalRecommendation: LongText,
    humanDecision: LongText,
    correctionReason: LongText,
    proposedAssetUpdates: z.array(LongText).max(100),
    createdAt: z.string().datetime(),
  })
  .strict()
  .meta({ ref: "FounderCorrection" })
export type FounderCorrection = z.infer<typeof FounderCorrection>
