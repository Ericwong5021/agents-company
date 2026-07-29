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

export const GovernanceAssetType = z.enum([
  "constitution",
  "principle",
  "heuristic",
  "boundary",
  "taste_reference",
  "taste_anti_reference",
  "rubric",
  "decision_case",
])
export type GovernanceAssetType = z.infer<typeof GovernanceAssetType>

export const GovernanceAssetScope = z
  .object({
    kind: z.enum(["company", "domain", "project", "brand"]),
    ref: Identifier.optional(),
  })
  .strict()
  .refine((scope) => scope.kind === "company" ? scope.ref === undefined : scope.ref !== undefined, {
    message: "Only company scope omits ref",
  })
  .meta({ ref: "GovernanceAssetScope" })
export type GovernanceAssetScope = z.infer<typeof GovernanceAssetScope>

export const GovernanceAssetAuthority = z.enum([
  "human_explicit",
  "human_confirmed",
  "ai_proposed",
  "external_source",
])
export type GovernanceAssetAuthority = z.infer<typeof GovernanceAssetAuthority>

export const GovernanceAssetStatus = z.enum(["draft", "active", "deprecated"])
export type GovernanceAssetStatus = z.infer<typeof GovernanceAssetStatus>

export const GovernanceAssetSourceRef = z
  .object({
    kind: z.enum(["artifact", "decision", "outcome", "conversation", "external"]),
    id: Identifier,
  })
  .strict()
  .meta({ ref: "GovernanceAssetSourceRef" })
export type GovernanceAssetSourceRef = z.infer<typeof GovernanceAssetSourceRef>

export const GovernanceAsset = z
  .object({
    id: Identifier,
    companyId: Identifier,
    type: GovernanceAssetType,
    scope: GovernanceAssetScope,
    content: LongText,
    rationale: LongText,
    tags: z.array(ShortText).max(100),
    authority: GovernanceAssetAuthority,
    status: GovernanceAssetStatus,
    sourceRefs: z.array(GovernanceAssetSourceRef).max(100),
    supersedes: z.number().int().positive().optional(),
    version: z.number().int().positive(),
    createdBy: Identifier,
    approvedBy: Identifier.optional(),
    createdAt: z.number().int().nonnegative(),
    current: z.boolean(),
  })
  .strict()
  .meta({ ref: "GovernanceAsset" })
export type GovernanceAsset = z.infer<typeof GovernanceAsset>

export const GovernanceAssetDraftInput = z
  .object({
    companyId: Identifier,
    type: GovernanceAssetType,
    scope: GovernanceAssetScope,
    content: LongText,
    rationale: LongText,
    tags: z.array(ShortText).max(100).default([]),
    authority: z.enum(["ai_proposed", "external_source"]),
    sourceRefs: z.array(GovernanceAssetSourceRef).max(100).default([]),
    createdBy: Identifier,
  })
  .strict()
  .meta({ ref: "GovernanceAssetDraftInput" })
export type GovernanceAssetDraftInput = z.infer<typeof GovernanceAssetDraftInput>

export const GovernanceAssetRevisionInput = z
  .object({
    baseVersion: z.number().int().positive(),
    content: LongText,
    rationale: LongText,
    tags: z.array(ShortText).max(100),
    authority: GovernanceAssetAuthority,
    status: GovernanceAssetStatus,
    sourceRefs: z.array(GovernanceAssetSourceRef).max(100),
    actorKind: z.enum(["ai", "external", "human"]),
    createdBy: Identifier,
    confirmation: z
      .object({
        eventId: Identifier,
        confirmedBy: Identifier,
      })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ ref: "GovernanceAssetRevisionInput" })
export type GovernanceAssetRevisionInput = z.infer<typeof GovernanceAssetRevisionInput>

export const FounderSnapshotCompileInput = z
  .object({
    companyId: Identifier,
    profileSummary: z.string().trim().max(4_000),
    promptTemplateVersion: Identifier,
    modelConfigRef: Identifier,
    retrievalConfigRef: Identifier,
    permissionConfigRef: Identifier,
    compiledPromptHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: GovernanceAssetScope,
    createdBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderSnapshotCompileInput" })
export type FounderSnapshotCompileInput = z.infer<typeof FounderSnapshotCompileInput>

export const FounderTwinSnapshot = z
  .object({
    id: Identifier,
    companyId: Identifier,
    version: z.number().int().positive(),
    profileSummary: z.string().max(4_000),
    assetRefs: z.array(FounderAssetReference),
    promptTemplateVersion: Identifier,
    modelConfigRef: Identifier,
    retrievalConfigRef: Identifier,
    permissionConfigRef: Identifier,
    compiledPromptHash: z.string().regex(/^[a-f0-9]{64}$/),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    createdBy: Identifier,
    createdAt: z.number().int().nonnegative(),
    selected: z.boolean(),
  })
  .strict()
  .meta({ ref: "FounderTwinSnapshot" })
export type FounderTwinSnapshot = z.infer<typeof FounderTwinSnapshot>

export const FounderSnapshotSelectInput = z
  .object({
    companyId: Identifier,
    snapshotId: Identifier,
    reason: ShortText,
    selectedBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderSnapshotSelectInput" })
export type FounderSnapshotSelectInput = z.infer<typeof FounderSnapshotSelectInput>

export const FounderStudioProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    assets: z.array(GovernanceAsset),
    snapshots: z.array(FounderTwinSnapshot),
    selectedSnapshotId: Identifier.optional(),
    authorization: z
      .object({
        status: z.literal("not_confirmed"),
        blocking: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderStudioProjection" })
export type FounderStudioProjection = z.infer<typeof FounderStudioProjection>
export const DecisionScope = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("company"), companyId: Identifier }).strict(),
    z.object({ type: z.literal("project"), companyId: Identifier, projectId: Identifier }).strict(),
    z.object({ type: z.literal("pre_project"), companyId: Identifier, preProjectId: Identifier }).strict(),
  ])
  .meta({ ref: "DecisionScope" })
export type DecisionScope = z.infer<typeof DecisionScope>

export const DecisionMaker = z.enum(["human", "ai_founder", "board", "policy_engine", "unknown"])
export type DecisionMaker = z.infer<typeof DecisionMaker>

export const FounderOperatingMode = z.enum(["shadow", "advisor", "green_delegated", "yellow_delegated"])
export type FounderOperatingMode = z.infer<typeof FounderOperatingMode>

export const DecisionRiskLevel = z.enum(["low", "medium", "high", "critical"])
export type DecisionRiskLevel = z.infer<typeof DecisionRiskLevel>

export const DecisionStatus = z.enum([
  "unknown",
  "proposed",
  "awaiting_approval",
  "accepted",
  "executed",
  "overridden",
  "failed",
  "rolled_back",
])
export type DecisionStatus = z.infer<typeof DecisionStatus>

export const DecisionTransitionKind = z.enum([
  "created",
  "historical_imported",
  "submitted_for_approval",
  "accepted",
  "executed",
  "overridden",
  "failed",
  "rolled_back",
])
export type DecisionTransitionKind = z.infer<typeof DecisionTransitionKind>

export const FounderTwinSnapshotReference = z
  .object({
    id: Identifier,
    version: z.number().int().positive(),
  })
  .strict()
  .meta({ ref: "FounderTwinSnapshotReference" })
export type FounderTwinSnapshotReference = z.infer<typeof FounderTwinSnapshotReference>

export const DecisionSourceMapping = z
  .object({
    channelMessageId: Identifier.nullable(),
    boardThreadId: Identifier.nullable(),
    boardRunId: Identifier.nullable(),
    runtimeId: Identifier.nullable(),
    sourceCompleteness: z.enum(["complete", "partial"]),
  })
  .strict()
  .meta({ ref: "DecisionSourceMapping" })
export type DecisionSourceMapping = z.infer<typeof DecisionSourceMapping>

export const DecisionRecord = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    scope: DecisionScope,
    source: DecisionSourceMapping.nullable(),
    founderTwinSnapshot: FounderTwinSnapshotReference.nullable(),
    subject: LongText.nullable(),
    context: LongText.nullable(),
    options: z.array(LongText).max(100).nullable(),
    recommendation: LongText.nullable(),
    finalDecision: LongText.nullable(),
    decisionMaker: DecisionMaker,
    decisionMakerId: Identifier,
    authorityClass: FounderAuthorityClass.nullable(),
    operatingMode: FounderOperatingMode.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    reversible: z.boolean().nullable(),
    externalImpact: z.boolean().nullable(),
    riskLevel: DecisionRiskLevel.nullable(),
    evidenceRefs: z.array(FounderEvidenceReference).max(500).nullable(),
    principleRefs: z.array(FounderAssetReference).max(500).nullable(),
    decisionCaseRefs: z.array(FounderAssetReference).max(500).nullable(),
    currentStatus: DecisionStatus,
    overrideOf: Identifier.nullable(),
    outcomeRefIds: z.array(Identifier).max(500),
    transitionCount: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "DecisionRecord" })
export type DecisionRecord = z.infer<typeof DecisionRecord>

export const DecisionRecordAppendInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    scope: DecisionScope,
    founderTwinSnapshot: FounderTwinSnapshotReference.nullable(),
    subject: LongText,
    context: LongText,
    options: z.array(LongText).max(100),
    recommendation: LongText,
    finalDecision: LongText.nullable(),
    decisionMaker: z.enum(["human", "ai_founder", "board", "policy_engine"]),
    decisionMakerId: Identifier,
    authorityClass: FounderAuthorityClass,
    operatingMode: FounderOperatingMode.nullable(),
    confidence: z.number().min(0).max(1),
    reversible: z.boolean(),
    externalImpact: z.boolean(),
    riskLevel: DecisionRiskLevel,
    evidenceRefs: z.array(FounderEvidenceReference).max(500),
    principleRefs: z.array(FounderAssetReference).max(500),
    decisionCaseRefs: z.array(FounderAssetReference).max(500),
    initialStatus: z.enum(["proposed", "awaiting_approval", "accepted"]).default("proposed"),
    overrideOf: Identifier.nullable().default(null),
    decidedAt: z.number().int().nonnegative().nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decisionMaker === "ai_founder" && !value.founderTwinSnapshot)
      context.addIssue({
        code: "custom",
        message: "AI founder decisions require a Founder Twin snapshot reference.",
        path: ["founderTwinSnapshot"],
      })
    if (value.initialStatus === "accepted" && !value.finalDecision)
      context.addIssue({
        code: "custom",
        message: "Accepted decisions require a final decision.",
        path: ["finalDecision"],
      })
  })
  .meta({ ref: "DecisionRecordAppendInput" })
export type DecisionRecordAppendInput = z.infer<typeof DecisionRecordAppendInput>

export const DecisionTransitionAppendInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    toStatus: DecisionStatus.exclude(["unknown"]),
    kind: DecisionTransitionKind.exclude(["created", "historical_imported"]),
    reason: LongText,
    actorId: Identifier,
  })
  .strict()
  .meta({ ref: "DecisionTransitionAppendInput" })
export type DecisionTransitionAppendInput = z.infer<typeof DecisionTransitionAppendInput>

export const DecisionTransition = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    decisionId: Identifier,
    sequence: z.number().int().positive(),
    fromStatus: DecisionStatus.nullable(),
    toStatus: DecisionStatus,
    kind: DecisionTransitionKind,
    reason: LongText,
    actorId: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "DecisionTransition" })
export type DecisionTransition = z.infer<typeof DecisionTransition>

export const DelegationPolicy = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    actionType: z.string().trim().min(1).max(240),
    riskLevel: FounderAuthorityClass,
    reversible: z.boolean(),
    externalImpact: z.boolean(),
    budgetLimit: z.record(z.string(), z.unknown()).nullable(),
    requiresApproval: z.boolean(),
    allowedMode: z.enum(["advisor", "green_delegated", "yellow_delegated", "none"]),
    version: z.number().int().positive(),
    scope: DecisionScope,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "DelegationPolicy" })
export type DelegationPolicy = z.infer<typeof DelegationPolicy>
