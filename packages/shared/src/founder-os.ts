import z from "zod"
import { GoalBriefDraft } from "./experience"

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
    reversible: true,
    externalImpact: false,
    riskLevel: "medium",
  },
  "governance.review.request": {
    authorityClass: "green",
    rollbackCapability: "withdraw_request",
    reversible: true,
    externalImpact: false,
    riskLevel: "low",
  },
  "organization.staffing.propose": {
    authorityClass: "yellow",
    rollbackCapability: "requires_compensating_action",
    reversible: false,
    externalImpact: false,
    riskLevel: "medium",
  },
  "external.communication.propose": {
    authorityClass: "red",
    rollbackCapability: "none",
    reversible: false,
    externalImpact: true,
    riskLevel: "high",
  },
} as const satisfies Record<
  FounderRequestedAction["type"],
  {
    authorityClass: FounderAuthorityClass
    rollbackCapability: "archive_proposal" | "withdraw_request" | "requires_compensating_action" | "none"
    reversible: boolean
    externalImpact: boolean
    riskLevel: DecisionRiskLevel
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
  "board_confirmed",
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
    approvedAt: z.number().int().nonnegative().optional(),
    current: z.boolean(),
  })
  .strict()
  .refine(
    (asset) =>
      asset.status !== "active"
      || (
        ["human_explicit", "human_confirmed", "board_confirmed"].includes(asset.authority)
        && asset.approvedBy !== undefined
        && asset.approvedAt !== undefined
      ),
    { message: "Active assets require human authority, approvedBy, and approvedAt" },
  )
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
    activePrincipleIds: z.array(Identifier),
    activeHeuristicIds: z.array(Identifier),
    decisionCaseIds: z.array(Identifier),
    tasteExampleIds: z.array(Identifier),
    rubricIds: z.array(Identifier),
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

export const FounderCalibrationItem = z
  .object({
    id: Identifier,
    companyId: Identifier,
    kind: z.enum(["ab", "accept", "reject"]),
    scope: GovernanceAssetScope,
    prompt: LongText,
    candidates: z.array(z.object({ artifactId: Identifier, label: ShortText }).strict()).min(1).max(2),
    status: z.enum(["pending", "responded"]),
    response: z.enum(["accept", "reject", "prefer_first", "prefer_second"]).optional(),
    reason: LongText.optional(),
    confirmationEventId: Identifier.optional(),
    confirmedBy: Identifier.optional(),
    createdBy: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderCalibrationItem" })
export type FounderCalibrationItem = z.infer<typeof FounderCalibrationItem>

export const FounderStudioProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    assets: z.array(GovernanceAsset),
    snapshots: z.array(FounderTwinSnapshot),
    selectedSnapshotId: Identifier.optional(),
    calibrationQueue: z.array(FounderCalibrationItem).default([]),
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

export const DecisionDispatchStatus = z.enum(["committed", "claimed", "completed", "failed"])
export type DecisionDispatchStatus = z.infer<typeof DecisionDispatchStatus>

export const DecisionDispatchOutbox = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    companyId: Identifier,
    decisionId: Identifier,
    transitionId: Identifier.nullable(),
    consumer: Identifier,
    actionType: Identifier,
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: Identifier,
    executionKey: Identifier,
    currentStatus: DecisionDispatchStatus,
    eventCount: z.number().int().positive(),
    consumerId: Identifier.nullable(),
    leaseToken: Identifier.nullable(),
    leaseExpiresAt: z.number().int().nonnegative().nullable(),
    executionReceipt: Identifier.nullable(),
    lastError: LongText.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "DecisionDispatchOutbox" })
export type DecisionDispatchOutbox = z.infer<typeof DecisionDispatchOutbox>

export const DecisionDispatchEvent = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    outboxId: Identifier,
    sequence: z.number().int().positive(),
    status: DecisionDispatchStatus,
    consumerId: Identifier.nullable(),
    leaseToken: Identifier.nullable(),
    leaseExpiresAt: z.number().int().nonnegative().nullable(),
    executionReceipt: Identifier.nullable(),
    error: LongText.nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "DecisionDispatchEvent" })
export type DecisionDispatchEvent = z.infer<typeof DecisionDispatchEvent>

export const DecisionDispatchAuthorizeInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    consumer: Identifier,
    actionType: Identifier,
    payload: z.record(z.string(), z.unknown()),
    reason: LongText,
    actorId: Identifier,
  })
  .strict()
  .meta({ ref: "DecisionDispatchAuthorizeInput" })
export type DecisionDispatchAuthorizeInput = z.infer<typeof DecisionDispatchAuthorizeInput>

export const DecisionDispatchClaimInput = z
  .object({
    consumer: Identifier,
    consumerId: Identifier,
    leaseDurationMs: z.number().int().min(1_000).max(300_000),
  })
  .strict()
  .meta({ ref: "DecisionDispatchClaimInput" })
export type DecisionDispatchClaimInput = z.infer<typeof DecisionDispatchClaimInput>

export const DecisionDispatchResolveInput = z
  .object({
    consumerId: Identifier,
    leaseToken: Identifier,
    executionReceipt: Identifier.optional(),
    error: LongText.optional(),
  })
  .strict()
  .meta({ ref: "DecisionDispatchResolveInput" })
export type DecisionDispatchResolveInput = z.infer<typeof DecisionDispatchResolveInput>

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

export const FounderShadowEvidenceRef = z
  .object({
    kind: z.enum(["artifact", "decision", "outcome", "conversation", "fact"]),
    id: Identifier,
    version: z.number().int().positive().optional(),
    validity: z.enum(["verified", "missing", "forbidden"]),
  })
  .strict()
  .meta({ ref: "FounderShadowEvidenceRef" })
export type FounderShadowEvidenceRef = z.infer<typeof FounderShadowEvidenceRef>

export const FounderContextBuildInput = z
  .object({
    companyId: Identifier,
    scope: GovernanceAssetScope,
    currentGoal: z.string().trim().min(1).max(4_000),
    discussion: z.string().trim().min(1).max(12_000),
    authorizationBoundary: z.string().trim().min(1).max(2_000),
    currentFacts: z.array(ShortText).max(30),
    evidenceRefs: z.array(FounderShadowEvidenceRef).max(30),
    limits: z
      .object({
        principles: z.number().int().min(1).max(12).default(8),
        decisionCases: z.number().int().min(1).max(10).default(6),
        tasteExamples: z.number().int().min(1).max(10).default(6),
        rubrics: z.number().int().min(1).max(6).default(3),
      })
      .strict()
      .default({ principles: 8, decisionCases: 6, tasteExamples: 6, rubrics: 3 }),
  })
  .strict()
  .meta({ ref: "FounderContextBuildInput" })
export type FounderContextBuildInput = z.infer<typeof FounderContextBuildInput>

export const FounderContextBlockReason = z.enum([
  "snapshot_missing",
  "snapshot_checksum_invalid",
  "context_insufficient",
  "asset_reference_missing",
  "asset_scope_forbidden",
  "evidence_reference_invalid",
])
export type FounderContextBlockReason = z.infer<typeof FounderContextBlockReason>

export const FounderContextProjection = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "blocked"]),
    companyId: Identifier,
    scope: GovernanceAssetScope,
    currentGoal: z.string().max(4_000),
    discussion: z.string().max(12_000),
    authorizationBoundary: z.string().max(2_000),
    currentFacts: z.array(ShortText).max(30),
    evidenceRefs: z.array(FounderShadowEvidenceRef).max(30),
    snapshotId: Identifier.optional(),
    snapshotChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    principles: z.array(GovernanceAsset).max(12),
    decisionCases: z.array(GovernanceAsset).max(10),
    tasteExamples: z.array(GovernanceAsset).max(10),
    rubrics: z.array(GovernanceAsset).max(6),
    missingInformation: z.array(ShortText).max(30),
    blockReasons: z.array(FounderContextBlockReason),
  })
  .strict()
  .meta({ ref: "FounderContextProjection" })
export type FounderContextProjection = z.infer<typeof FounderContextProjection>

export const FounderShadowModelOutput = z
  .object({
    recommendation: LongText,
    alternatives: z.array(LongText).max(20),
    authorityClass: FounderAuthorityClass,
    confidence: z.number().min(0).max(1),
    principleRefs: z.array(FounderAssetReference).min(1).max(12),
    decisionCaseRefs: z.array(FounderAssetReference).max(10),
    evidenceRefs: z.array(FounderShadowEvidenceRef).min(1).max(30),
    missingInformation: z.array(ShortText).max(30),
  })
  .strict()
  .meta({ ref: "FounderShadowModelOutput" })
export type FounderShadowModelOutput = z.infer<typeof FounderShadowModelOutput>

export const FounderShadowRunInput = z
  .object({
    context: FounderContextBuildInput,
    createdBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderShadowRunInput" })
export type FounderShadowRunInput = z.infer<typeof FounderShadowRunInput>

export const FounderShadowDecision = z
  .object({
    id: Identifier,
    companyId: Identifier,
    status: z.enum(["suggested", "blocked"]),
    blockReasons: z.array(z.union([
      FounderContextBlockReason,
      z.enum(["model_unavailable", "model_timeout", "model_output_missing", "model_output_invalid"]),
    ])),
    scope: GovernanceAssetScope,
    snapshotId: Identifier.optional(),
    snapshotChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    modelConfigRef: Identifier,
    recommendation: LongText.optional(),
    alternatives: z.array(LongText).max(20),
    authorityClass: FounderAuthorityClass.optional(),
    confidence: z.number().min(0).max(1).optional(),
    principleRefs: z.array(FounderAssetReference).max(12),
    decisionCaseRefs: z.array(FounderAssetReference).max(10),
    tasteExampleRefs: z.array(FounderAssetReference).max(10),
    rubricRefs: z.array(FounderAssetReference).max(6),
    evidenceRefs: z.array(FounderShadowEvidenceRef).max(30),
    missingInformation: z.array(ShortText).max(30),
    createsGate: z.literal(false),
    canSpeak: z.literal(false),
    canExecute: z.literal(false),
    createdBy: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderShadowDecision" })
export type FounderShadowDecision = z.infer<typeof FounderShadowDecision>

export const FounderShadowComparisonInput = z
  .object({
    companyId: Identifier,
    shadowDecisionId: Identifier,
    actualDecision: LongText,
    actualDecisionRef: FounderShadowEvidenceRef.refine((reference) =>
      reference.kind === "decision" && reference.validity === "verified"),
    alignment: z.enum(["match", "partial", "mismatch"]),
    rationale: LongText,
    comparedBy: Identifier,
    confirmation: z
      .object({
        eventId: Identifier,
        confirmedBy: Identifier,
      })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ ref: "FounderShadowComparisonInput" })
export type FounderShadowComparisonInput = z.infer<typeof FounderShadowComparisonInput>

export const FounderShadowComparison = z
  .object({
    id: Identifier,
    companyId: Identifier,
    shadowDecisionId: Identifier,
    actualDecision: LongText,
    actualDecisionRef: FounderShadowEvidenceRef,
    alignment: z.enum(["match", "partial", "mismatch"]),
    rationale: LongText,
    verificationStatus: z.enum(["not_confirmed", "human_confirmed"]),
    confirmedBy: Identifier.optional(),
    confirmationEventId: Identifier.optional(),
    comparedBy: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderShadowComparison" })
export type FounderShadowComparison = z.infer<typeof FounderShadowComparison>

export const FounderCaseImportInput = z
  .object({
    companyId: Identifier,
    kind: z.enum(["decision_case", "taste_reference", "taste_anti_reference", "rubric"]),
    scope: GovernanceAssetScope,
    content: LongText,
    rationale: LongText,
    dimensions: z.array(ShortText).min(1).max(30),
    sourceRefs: z.array(GovernanceAssetSourceRef).min(1).max(100),
    authority: z.enum(["ai_proposed", "external_source"]),
    createdBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderCaseImportInput" })
export type FounderCaseImportInput = z.infer<typeof FounderCaseImportInput>

export const FounderCalibrationRequestInput = z
  .object({
    companyId: Identifier,
    kind: z.enum(["ab", "accept", "reject"]),
    scope: GovernanceAssetScope,
    prompt: LongText,
    candidates: z
      .array(
        z
          .object({
            artifactId: Identifier,
            label: ShortText,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    createdBy: Identifier,
  })
  .strict()
  .refine((input) => input.kind !== "ab" || input.candidates.length === 2)
  .meta({ ref: "FounderCalibrationRequestInput" })
export type FounderCalibrationRequestInput = z.infer<typeof FounderCalibrationRequestInput>

export const FounderCalibrationResponseInput = z
  .object({
    companyId: Identifier,
    requestId: Identifier,
    response: z.enum(["accept", "reject", "prefer_first", "prefer_second"]),
    reason: LongText,
    actorKind: z.literal("human"),
    confirmationEventId: Identifier,
    confirmedBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderCalibrationResponseInput" })
export type FounderCalibrationResponseInput = z.infer<typeof FounderCalibrationResponseInput>

export const FounderRubricValidationInput = z
  .object({
    companyId: Identifier,
    rubric: FounderAssetReference,
    scores: z.array(z.object({ dimension: ShortText, score: z.number().min(0).max(1) }).strict()).min(1).max(30),
  })
  .strict()
  .meta({ ref: "FounderRubricValidationInput" })
export type FounderRubricValidationInput = z.infer<typeof FounderRubricValidationInput>

export const FounderRubricValidation = z
  .object({
    status: z.enum(["valid", "blocked"]),
    rubric: FounderAssetReference,
    rubricAuthority: GovernanceAssetAuthority.optional(),
    scores: z.array(z.object({ dimension: ShortText, score: z.number().min(0).max(1) }).strict()).max(30),
    aggregate: z.number().min(0).max(1).optional(),
    blockReasons: z.array(z.enum(["rubric_missing", "rubric_inactive", "dimension_mismatch"])),
  })
  .strict()
  .meta({ ref: "FounderRubricValidation" })
export type FounderRubricValidation = z.infer<typeof FounderRubricValidation>

export const FounderBenchmarkCaseInput = z
  .object({
    companyId: Identifier,
    benchmarkType: z.enum(["founder_decision", "taste"]),
    datasetVersion: Identifier,
    split: z.enum(["training", "holdout"]),
    sourceAsset: FounderAssetReference,
    expected: z
      .object({
        authorityClass: FounderAuthorityClass.optional(),
        decision: LongText.optional(),
        preference: z.enum(["accept", "reject", "first", "second"]).optional(),
      })
      .strict(),
    confirmationEventId: Identifier,
    confirmedBy: Identifier,
  })
  .strict()
  .refine((input) =>
    input.benchmarkType === "founder_decision"
      ? input.expected.authorityClass !== undefined && input.expected.decision !== undefined
      : input.expected.preference !== undefined)
  .meta({ ref: "FounderBenchmarkCaseInput" })
export type FounderBenchmarkCaseInput = z.infer<typeof FounderBenchmarkCaseInput>

export const FounderBenchmarkCase = z
  .object({
    id: Identifier,
    companyId: Identifier,
    benchmarkType: z.enum(["founder_decision", "taste"]),
    datasetVersion: Identifier,
    split: z.enum(["training", "holdout"]),
    sourceAsset: FounderAssetReference,
    expected: z
      .object({
        authorityClass: FounderAuthorityClass.optional(),
        decision: LongText.optional(),
        preference: z.enum(["accept", "reject", "first", "second"]).optional(),
      })
      .strict(),
    confirmationEventId: Identifier,
    confirmedBy: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderBenchmarkCase" })
export type FounderBenchmarkCase = z.infer<typeof FounderBenchmarkCase>

export const FounderBenchmarkPrediction = z
  .object({
    caseId: Identifier,
    authorityClass: FounderAuthorityClass.optional(),
    decision: LongText.optional(),
    preference: z.enum(["accept", "reject", "first", "second"]).optional(),
    principleRefs: z.array(FounderAssetReference).max(12),
    evidenceRefs: z.array(FounderShadowEvidenceRef).max(30),
    decisionCaseRefs: z.array(FounderAssetReference).max(10),
  })
  .strict()
  .meta({ ref: "FounderBenchmarkPrediction" })
export type FounderBenchmarkPrediction = z.infer<typeof FounderBenchmarkPrediction>

export const FounderBenchmarkRunInput = z
  .object({
    companyId: Identifier,
    benchmarkType: z.enum(["founder_decision", "taste"]),
    datasetVersion: Identifier,
    snapshotId: Identifier,
    createdBy: Identifier,
  })
  .strict()
  .meta({ ref: "FounderBenchmarkRunInput" })
export type FounderBenchmarkRunInput = z.infer<typeof FounderBenchmarkRunInput>

export const FounderBenchmarkReport = z
  .object({
    id: Identifier,
    companyId: Identifier,
    benchmarkType: z.enum(["founder_decision", "taste"]),
    datasetVersion: Identifier,
    snapshotId: Identifier,
    status: z.enum(["pass", "fail", "blocked"]),
    blockReasons: z.array(z.enum([
      "holdout_empty",
      "prediction_set_incomplete",
      "training_holdout_leakage",
      "snapshot_missing",
      "snapshot_checksum_invalid",
      "model_unavailable",
      "model_timeout",
      "model_output_invalid",
    ])),
    metrics: z
      .object({
        caseCount: z.number().int().nonnegative(),
        redRecall: z.number().min(0).max(1).nullable(),
        traceabilityRate: z.number().min(0).max(1).nullable(),
        agreementRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    authorization: z
      .object({
        status: z.literal("not_confirmed"),
        blocking: z.literal(false),
        confirmedSampleCount: z.number().int().nonnegative(),
      })
      .strict(),
    createdBy: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderBenchmarkReport" })
export type FounderBenchmarkReport = z.infer<typeof FounderBenchmarkReport>

export const FounderBoardShadowProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    readOnly: z.literal(true),
    chatIntegrated: z.literal(false),
    createsGate: z.literal(false),
    decisions: z.array(FounderShadowDecision),
    comparisons: z.array(FounderShadowComparison),
    calibrationQueue: z.array(FounderCalibrationItem),
    authorization: z
      .object({
        status: z.literal("not_confirmed"),
        blocking: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderBoardShadowProjection" })
export type FounderBoardShadowProjection = z.infer<typeof FounderBoardShadowProjection>

export const FounderApprovalActorKind = z.enum(["human", "ai_founder", "board", "policy_engine"])
export type FounderApprovalActorKind = z.infer<typeof FounderApprovalActorKind>

export const DecisionAuthorityInput = z
  .object({
    decisionId: Identifier,
    actionType: Identifier,
    proposedAuthorityClass: FounderAuthorityClass,
    evidenceSufficient: z.boolean(),
    requestedMode: FounderTwinMode,
    approvalPreset: z.enum(["autonomous", "balanced", "strict"]),
  })
  .strict()
  .meta({ ref: "DecisionAuthorityInput" })
export type DecisionAuthorityInput = z.infer<typeof DecisionAuthorityInput>

export const DecisionAuthorityEvaluation = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: Identifier,
    authorityClass: FounderAuthorityClass,
    policyId: Identifier.nullable(),
    requiresApproval: z.boolean(),
    allowed: z.boolean(),
    reasons: z.array(ShortText).min(1),
  })
  .strict()
  .meta({ ref: "DecisionAuthorityEvaluation" })
export type DecisionAuthorityEvaluation = z.infer<typeof DecisionAuthorityEvaluation>

export const GovernanceRequest = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    decisionId: Identifier,
    actionType: Identifier,
    proposedAuthorityClass: FounderAuthorityClass,
    evidenceSufficient: z.boolean(),
    requestedBy: z
      .object({
        kind: FounderApprovalActorKind,
        id: Identifier,
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "GovernanceRequest" })
export type GovernanceRequest = z.infer<typeof GovernanceRequest>

export const FounderApprovalGate = z
  .object({
    id: Identifier,
    scope: DecisionScope,
    decisionId: Identifier,
    kind: z.literal("founder_red"),
    status: z.enum(["pending", "approved", "rejected"]),
    title: LongText,
    summary: LongText,
    requestedBy: z
      .object({
        kind: FounderApprovalActorKind,
        id: Identifier,
      })
      .strict(),
    decisionNote: LongText.nullable(),
    requestedAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .meta({ ref: "FounderApprovalGate" })
export type FounderApprovalGate = z.infer<typeof FounderApprovalGate>

export const GovernanceDecision = z
  .object({
    schemaVersion: z.literal(1),
    decision: DecisionRecord,
    authority: DecisionAuthorityEvaluation,
    gate: FounderApprovalGate.nullable(),
    dispatchAllowed: z.boolean(),
  })
  .strict()
  .meta({ ref: "GovernanceDecision" })
export type GovernanceDecision = z.infer<typeof GovernanceDecision>

export const FounderCorrectionKind = z.enum(["override", "correction"])
export type FounderCorrectionKind = z.infer<typeof FounderCorrectionKind>

export const FounderAssetUpdateProposal = z
  .object({
    target: z
      .object({
        assetId: Identifier.nullable(),
        type: GovernanceAssetType,
        scope: GovernanceAssetScope,
      })
      .strict(),
    baseRevision: z
      .object({
        assetId: Identifier,
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    typedDiff: z
      .object({
        operation: z.enum(["create", "revise"]),
        content: LongText,
        rationale: LongText,
        tags: z.array(ShortText).max(100),
        sourceRefs: z.array(GovernanceAssetSourceRef).max(100),
      })
      .strict(),
    authority: z.literal("ai_proposed"),
  })
  .strict()
  .refine(
    (proposal) =>
      proposal.typedDiff.operation === "create"
        ? proposal.target.assetId === null && proposal.baseRevision === null
        : proposal.target.assetId !== null
          && proposal.baseRevision?.assetId === proposal.target.assetId,
    { message: "Asset proposal target, baseRevision, and operation do not agree" },
  )
  .meta({ ref: "FounderAssetUpdateProposal" })
export type FounderAssetUpdateProposal = z.infer<typeof FounderAssetUpdateProposal>

export const FounderCorrectionAppendInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    decisionId: Identifier,
    kind: FounderCorrectionKind,
    humanDecision: LongText,
    reason: LongText,
    proposedAssetUpdates: z.array(FounderAssetUpdateProposal).max(100),
    actorKind: z.literal("human").default("human"),
    actorId: Identifier,
  })
  .strict()
  .meta({ ref: "FounderCorrectionAppendInput" })
export type FounderCorrectionAppendInput = z.infer<typeof FounderCorrectionAppendInput>

export const FounderCorrectionRecord = FounderCorrectionAppendInput.omit({ idempotencyKey: true }).extend({
  id: Identifier,
  originalDecision: LongText.nullable(),
  createdAt: z.number().int().nonnegative(),
})
  .strict()
  .meta({ ref: "FounderCorrectionRecord" })
export type FounderCorrectionRecord = z.infer<typeof FounderCorrectionRecord>

export const DecisionCenterActionInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    action: z.enum(["accept", "reject", "rollback"]),
    reason: LongText,
    actorId: Identifier,
  })
  .strict()
  .meta({ ref: "DecisionCenterActionInput" })
export type DecisionCenterActionInput = z.infer<typeof DecisionCenterActionInput>

export const DecisionCenterItem = z
  .object({
    decision: DecisionRecord,
    sourceLabel: z.enum(["human", "ai_founder", "board", "policy_engine", "unknown"]),
    gate: FounderApprovalGate.nullable(),
    corrections: z.array(FounderCorrectionRecord),
    outcomes: z.array(
      z
        .object({
          id: Identifier,
          result: z.enum(["succeeded", "failed", "inconclusive"]),
          summary: LongText,
          observedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    yellowSummary: z.lazy(() => FounderYellowSummary).nullable(),
  })
  .strict()
  .meta({ ref: "DecisionCenterItem" })
export type DecisionCenterItem = z.infer<typeof DecisionCenterItem>

export const DecisionCenterProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    pending: z.array(DecisionCenterItem),
    delegated: z.array(DecisionCenterItem),
    executed: z.array(DecisionCenterItem),
    overridden: z.array(DecisionCenterItem),
    withOutcomes: z.array(DecisionCenterItem),
  })
  .strict()
  .meta({ ref: "DecisionCenterProjection" })
export type DecisionCenterProjection = z.infer<typeof DecisionCenterProjection>

export const FounderOSMetricContract = z
  .object({
    schemaVersion: z.literal(1),
    version: z.literal("founder-os-w2-v1"),
    observationWindow: z.object({ days: z.literal(30), clock: z.literal("observed_at") }).strict(),
    metrics: z.array(
      z
        .object({
          id: Identifier,
          numerator: ShortText,
          denominator: ShortText,
          minimumSampleSize: z.number().int().positive(),
          sourceKinds: z.array(Identifier).min(1),
          target: ShortText,
        })
        .strict(),
    ),
    failClosedWhen: z.array(ShortText).min(1),
    humanSampleGate: z.object({ strength: z.literal("weak"), blockingDevelopment: z.literal(false) }).strict(),
    selfEvaluationAcceptedAsTruth: z.literal(false),
  })
  .strict()
  .meta({ ref: "FounderOSMetricContract" })
export type FounderOSMetricContract = z.infer<typeof FounderOSMetricContract>

export const FounderAdvisorPrincipal = z
  .object({
    principalId: z.literal("board-ceo"),
    displayName: z.literal("AI 大东 · 创始人代理"),
    principalKind: z.literal("agent"),
    projectionKind: z.literal("founder_governance"),
    humanAuthoritySource: z.literal("local_user"),
    isAdditionalEmployee: z.literal(false),
  })
  .strict()
  .meta({ ref: "FounderAdvisorPrincipal" })
export type FounderAdvisorPrincipal = z.infer<typeof FounderAdvisorPrincipal>

export const FounderAdvisorReadiness = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    status: z.enum(["ready", "not_confirmed", "blocked"]),
    exactCommit: z
      .object({
        status: z.enum(["passed", "missing"]),
        sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
        evidenceRef: Identifier.nullable(),
      })
      .strict(),
    benchmarkReportId: Identifier.nullable(),
    metrics: z
      .object({
        confirmedSampleCount: z.number().int().nonnegative(),
        redRecall: z.number().min(0).max(1).nullable(),
        traceabilityRate: z.number().min(0).max(1).nullable(),
        historicalAgreementRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    authorization: z
      .object({
        status: z.enum(["human_confirmed", "missing"]),
        eventId: Identifier.nullable(),
        confirmedBy: Identifier.nullable(),
      })
      .strict(),
    failClosedReasons: z.array(ShortText).max(20),
    autoPromotionAllowed: z.literal(false),
    recordedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .meta({ ref: "FounderAdvisorReadiness" })
export type FounderAdvisorReadiness = z.infer<typeof FounderAdvisorReadiness>

export const FounderAdvisorReadinessRecordInput = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    idempotencyKey: Identifier,
    benchmarkReportId: Identifier,
    exactCommit: z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        worktreeRunId: Identifier,
      })
      .strict(),
    authorizationEventId: Identifier,
    actor: z.object({ kind: z.literal("human"), id: Identifier }).strict(),
  })
  .strict()
  .meta({ ref: "FounderAdvisorReadinessRecordInput" })
export type FounderAdvisorReadinessRecordInput = z.infer<typeof FounderAdvisorReadinessRecordInput>

export const FounderAdvisorSource = z
  .object({
    boardThreadId: Identifier,
    boardRunId: Identifier.optional(),
    channelMessageId: Identifier,
    shadowDecisionId: Identifier,
  })
  .strict()
  .meta({ ref: "FounderAdvisorSource" })
export type FounderAdvisorSource = z.infer<typeof FounderAdvisorSource>

export const FounderAdvisorConvergenceInput = z
  .object({
    companyId: Identifier,
    idempotencyKey: Identifier,
    source: FounderAdvisorSource,
    subject: LongText,
    context: LongText,
    driAgentId: Identifier,
    timeoutAt: z.number().int().nonnegative(),
    dissent: z.array(LongText).max(100),
    requestedAction: FounderRequestedAction.optional(),
  })
  .strict()
  .meta({ ref: "FounderAdvisorConvergenceInput" })
export type FounderAdvisorConvergenceInput = z.infer<typeof FounderAdvisorConvergenceInput>

export const FounderAdvisorAuthorityResult = z
  .object({
    status: z.enum(["authorized", "blocked", "unavailable"]),
    reason: ShortText,
    governanceRef: Identifier.optional(),
    reversible: z.boolean().optional(),
    externalImpact: z.boolean().optional(),
    riskLevel: DecisionRiskLevel.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "authorized"
      && (value.governanceRef === undefined
        || value.reversible === undefined
        || value.externalImpact === undefined
        || value.riskLevel === undefined)
    )
      context.addIssue({ code: "custom", message: "Authorized Advisor decisions require governance facts." })
  })
  .meta({ ref: "FounderAdvisorAuthorityResult" })
export type FounderAdvisorAuthorityResult = z.infer<typeof FounderAdvisorAuthorityResult>

export const FounderAdvisorConvergence = z
  .object({
    id: Identifier,
    companyId: Identifier,
    idempotencyKey: Identifier,
    source: FounderAdvisorSource,
    principal: FounderAdvisorPrincipal,
    status: z.enum(["intent_recorded", "blocked"]),
    decisionIntent: DecisionIntent.optional(),
    ledgerDecisionId: Identifier.optional(),
    authority: FounderAdvisorAuthorityResult,
    driAgentId: Identifier,
    timeoutAt: z.number().int().nonnegative(),
    dissent: z.array(LongText).max(100),
    workItemCreated: z.literal(false),
    executionCreated: z.literal(false),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderAdvisorConvergence" })
export type FounderAdvisorConvergence = z.infer<typeof FounderAdvisorConvergence>

export const FounderInterventionKind = z.enum(["takeover", "pause", "correct", "reject", "redefine_goal"])
export type FounderInterventionKind = z.infer<typeof FounderInterventionKind>

export const FounderInterventionInput = z
  .object({
    companyId: Identifier,
    idempotencyKey: Identifier,
    kind: FounderInterventionKind,
    boardThreadId: Identifier,
    projectId: Identifier.optional(),
    decisionId: Identifier.optional(),
    reason: LongText,
    newGoal: LongText.optional(),
    actorKind: z.literal("human"),
    actorId: Identifier,
  })
  .strict()
  .refine((input) => input.kind !== "redefine_goal" || input.newGoal !== undefined)
  .meta({ ref: "FounderInterventionInput" })
export type FounderInterventionInput = z.infer<typeof FounderInterventionInput>

export const FounderInterventionEffect = z
  .object({
    id: Identifier,
    interventionId: Identifier,
    kind: z.enum(["attention_opened", "stop_requested", "stop_completed", "stop_failed"]),
    status: z.enum(["recorded", "failed"]),
    detail: LongText,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderInterventionEffect" })
export type FounderInterventionEffect = z.infer<typeof FounderInterventionEffect>

export const FounderIntervention = z
  .object({
    id: Identifier,
    companyId: Identifier,
    idempotencyKey: Identifier,
    kind: FounderInterventionKind,
    boardThreadId: Identifier,
    projectId: Identifier.optional(),
    decisionId: Identifier.optional(),
    ledgerDecisionId: Identifier,
    reason: LongText,
    newGoal: LongText.optional(),
    actorId: Identifier,
    fenceActive: z.boolean(),
    effects: z.array(FounderInterventionEffect),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderIntervention" })
export type FounderIntervention = z.infer<typeof FounderIntervention>

export const FounderBoardGovernanceProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    principal: FounderAdvisorPrincipal,
    mode: FounderOSModeState,
    advisorCanSpeak: z.boolean(),
    authorization: z
      .object({
        status: z.enum(["authorized", "not_confirmed", "unavailable"]),
        canRaiseModeFromUI: z.literal(false),
      })
      .strict(),
    convergences: z.array(FounderAdvisorConvergence).max(100),
    interventions: z.array(FounderIntervention).max(100),
    decisions: z.array(DecisionRecord).max(100),
    shadow: FounderBoardShadowProjection,
    assets: z.array(GovernanceAsset).max(500),
    readOnlyEvidence: z.literal(true),
  })
  .strict()
  .meta({ ref: "FounderBoardGovernanceProjection" })
export type FounderBoardGovernanceProjection = z.infer<typeof FounderBoardGovernanceProjection>

export const FounderControlCenterProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    principal: FounderAdvisorPrincipal,
    mode: FounderOSModeState,
    authorization: z
      .object({
        status: z.enum(["authorized", "not_confirmed", "unavailable"]),
        canRaiseModeFromUI: z.literal(false),
      })
      .strict(),
    pending: z
      .object({
        proposedDecisions: z.number().int().nonnegative(),
        redDecisions: z.number().int().nonnegative(),
        failedStops: z.number().int().nonnegative(),
      })
      .strict(),
    trends: z
      .object({
        shadowComparisons: z.number().int().nonnegative(),
        shadowOverrides: z.number().int().nonnegative(),
        confirmedCalibrations: z.number().int().nonnegative(),
        takeoverEvents: z.number().int().nonnegative(),
      })
      .strict(),
    recentInterventions: z.array(FounderIntervention).max(20),
    recentDecisions: z.array(DecisionRecord).max(20),
  })
  .strict()
  .meta({ ref: "FounderControlCenterProjection" })
export type FounderControlCenterProjection = z.infer<typeof FounderControlCenterProjection>

export const FounderGreenDelegationAction = z.enum(["project.receipt.process"])
export type FounderGreenDelegationAction = z.infer<typeof FounderGreenDelegationAction>

export const FounderGreenReadiness = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    status: z.enum(["ready", "blocked"]),
    b3: z.object({ status: z.enum(["passed", "missing"]), evidenceRef: Identifier.nullable() }).strict(),
    e0: z.object({ status: z.enum(["passed", "missing"]), evidenceRef: Identifier.nullable() }).strict(),
    w5Observation: z.object({ status: z.enum(["passed", "missing"]), evidenceRef: Identifier.nullable() }).strict(),
    takeoverFence: z.object({ status: z.enum(["passed", "missing"]), evidenceRef: Identifier.nullable() }).strict(),
    preferenceHoldout: z
      .object({
        status: z.enum(["passed", "missing"]),
        reportRef: Identifier.nullable(),
        agreementRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    metricContract: z
      .object({
        status: z.enum(["passed", "missing"]),
        evidenceRef: Identifier.nullable(),
        windowDays: z.number().int().positive().nullable(),
        sampleContractMet: z.boolean(),
      })
      .strict(),
    authorization: z
      .object({
        status: z.enum(["human_confirmed", "missing"]),
        eventId: Identifier.nullable(),
        confirmedBy: Identifier.nullable(),
      })
      .strict(),
    exactCommit: z
      .object({
        status: z.enum(["passed", "missing"]),
        sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
        evidenceRef: Identifier.nullable(),
      })
      .strict(),
    failClosedReasons: z.array(ShortText).max(20),
    autoPromotionAllowed: z.literal(false),
    recordedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .meta({ ref: "FounderGreenReadiness" })
export type FounderGreenReadiness = z.infer<typeof FounderGreenReadiness>

export const FounderGreenReadinessRecordInput = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    idempotencyKey: Identifier,
    b3ArtifactId: Identifier,
    e0ArtifactId: Identifier,
    w5ObservationArtifactId: Identifier,
    takeoverFenceArtifactId: Identifier,
    preferenceBenchmarkReportId: Identifier,
    metricContractArtifactId: Identifier,
    authorizationEventId: Identifier,
    exactCommit: z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        worktreeRunId: Identifier,
      })
      .strict(),
    actor: z.object({ kind: z.literal("human"), id: Identifier }).strict(),
  })
  .strict()
  .meta({ ref: "FounderGreenReadinessRecordInput" })
export type FounderGreenReadinessRecordInput = z.infer<typeof FounderGreenReadinessRecordInput>

export const FounderGreenDelegationInput = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    idempotencyKey: Identifier,
    decisionId: Identifier,
    projectId: Identifier,
    boardThreadId: Identifier,
    receiptId: Identifier,
    actionType: Identifier,
    requestedBy: z
      .object({
        kind: z.literal("ai_founder"),
        id: z.literal("board-ceo"),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "FounderGreenDelegationInput" })
export type FounderGreenDelegationInput = z.infer<typeof FounderGreenDelegationInput>

export const FounderGreenDelegationChain = z
  .object({
    decisionId: Identifier,
    ledgerDecisionId: Identifier,
    governanceRef: Identifier.nullable(),
    graphDecisionId: Identifier.nullable(),
    mutationId: Identifier.nullable(),
    workItemIds: z.array(Identifier).max(500),
    receiptIds: z.array(Identifier).max(500),
    outcomeIds: z.array(Identifier).max(500),
    ledgerOutcomeLinked: z.boolean(),
  })
  .strict()
  .meta({ ref: "FounderGreenDelegationChain" })
export type FounderGreenDelegationChain = z.infer<typeof FounderGreenDelegationChain>

export const FounderGreenDelegationRun = z
  .object({
    schemaVersion: z.literal(1),
    id: Identifier,
    companyId: Identifier,
    idempotencyKey: Identifier,
    projectId: Identifier,
    boardThreadId: Identifier,
    receiptId: Identifier,
    actionType: Identifier,
    actionAllowlisted: z.boolean(),
    status: z.enum(["blocked", "authorized", "outcome_pending", "completed", "failed"]),
    readiness: FounderGreenReadiness,
    mode: FounderOSModeState,
    authority: DecisionAuthorityEvaluation.nullable(),
    gate: FounderApprovalGate.nullable(),
    dispatch: z
      .object({
        status: z.enum(["paused", "gated", "idle", "dispatched"]),
        workItemIds: z.array(Identifier).max(500),
      })
      .strict()
      .nullable(),
    chain: FounderGreenDelegationChain,
    outcomeStatus: z.enum(["missing", "succeeded", "failed", "inconclusive"]),
    completeChain: z.boolean(),
    failClosedReasons: z.array(ShortText).max(30),
    selfEvaluationAcceptedAsTruth: z.literal(false),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderGreenDelegationRun" })
export type FounderGreenDelegationRun = z.infer<typeof FounderGreenDelegationRun>

export const FounderGreenDelegationProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    readiness: FounderGreenReadiness,
    mode: FounderOSModeState,
    allowlist: z.array(FounderGreenDelegationAction),
    unknownActionsClassifiedAsRed: z.literal(true),
    activeFenceCount: z.number().int().nonnegative(),
    trends: z
      .object({
        humanConfirmedShadowComparisons: z.number().int().nonnegative(),
        humanOverrides: z.number().int().nonnegative(),
        selfEvaluations: z.literal(0),
      })
      .strict(),
    runs: z.array(FounderGreenDelegationRun).max(100),
    autoPromotionAllowed: z.literal(false),
  })
  .strict()
  .meta({ ref: "FounderGreenDelegationProjection" })
export type FounderGreenDelegationProjection = z.infer<typeof FounderGreenDelegationProjection>

export const FounderYellowDelegationAction = z.enum(["project.goal.propose"])
export type FounderYellowDelegationAction = z.infer<typeof FounderYellowDelegationAction>

export const FounderYellowActionContract = z
  .object({
    schemaVersion: z.literal(1),
    actionType: FounderYellowDelegationAction,
    costLimit: z.object({ unit: z.literal("receipt"), maximum: z.literal(1) }).strict(),
    reversible: z.literal(true),
    externalImpact: z.literal(false),
    rollbackHandlerId: z.literal("company-project-direction.restore_checkpoint"),
    outcomeDeadlineMs: z.literal(3_600_000),
  })
  .strict()
  .meta({ ref: "FounderYellowActionContract" })
export type FounderYellowActionContract = z.infer<typeof FounderYellowActionContract>

export const FounderYellowActionContracts = {
  "project.goal.propose": {
    schemaVersion: 1,
    actionType: "project.goal.propose",
    costLimit: { unit: "receipt", maximum: 1 },
    reversible: true,
    externalImpact: false,
    rollbackHandlerId: "company-project-direction.restore_checkpoint",
    outcomeDeadlineMs: 3_600_000,
  },
} as const satisfies Record<FounderYellowDelegationAction, FounderYellowActionContract>

export const FounderYellowReadiness = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    status: z.enum(["not_confirmed", "confirmed"]),
    greenReadinessRef: Identifier.nullable(),
    w6ObservationEvidenceRef: Identifier.nullable(),
    e0EvidenceRef: Identifier.nullable(),
    outcomeSignalRef: Identifier.nullable(),
    authorizationEventRef: Identifier.nullable(),
    confirmedBy: Identifier.nullable(),
    failClosedReasons: z.array(ShortText).max(20),
    autoPromotionAllowed: z.literal(false),
    recordedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .meta({ ref: "FounderYellowReadiness" })
export type FounderYellowReadiness = z.infer<typeof FounderYellowReadiness>

export const FounderYellowReadinessRecordInput = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    idempotencyKey: Identifier,
    w6ObservationArtifactId: Identifier,
    e0ArtifactId: Identifier,
    outcomeSignalId: Identifier,
    authorizationEventId: Identifier,
    actor: z.object({ kind: z.literal("human"), id: Identifier }).strict(),
  })
  .strict()
  .meta({ ref: "FounderYellowReadinessRecordInput" })
export type FounderYellowReadinessRecordInput = z.infer<typeof FounderYellowReadinessRecordInput>

export const FounderYellowDelegationInput = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    idempotencyKey: Identifier,
    decisionId: Identifier,
    projectId: Identifier,
    boardThreadId: Identifier,
    receiptId: Identifier,
    actionType: z.literal("project.goal.propose"),
    estimatedCost: z.object({ unit: z.literal("receipt"), amount: z.number().positive() }).strict(),
    direction: z.object({
      briefId: Identifier,
      expectedBriefVersion: z.number().int().positive(),
      expectedPlanVersion: z.number().int().positive(),
      brief: GoalBriefDraft,
    }).strict(),
    requestedBy: z.object({ kind: z.literal("ai_founder"), id: z.literal("board-ceo") }).strict(),
  })
  .strict()
  .meta({ ref: "FounderYellowDelegationInput" })
export type FounderYellowDelegationInput = z.infer<typeof FounderYellowDelegationInput>

export const FounderYellowRollbackInput = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: Identifier,
    trigger: z.enum(["failure_condition", "human_decision"]),
    reason: LongText,
    actor: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("human"), id: Identifier }).strict(),
      z.object({ kind: z.literal("policy_engine"), id: z.literal("yellow-circuit-breaker") }).strict(),
    ]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.trigger === "human_decision" && input.actor.kind !== "human")
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Human rollback decisions require a human actor",
      })
    if (input.trigger === "failure_condition" && input.actor.kind !== "policy_engine")
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Failure-condition rollback requires the circuit breaker actor",
      })
  })
  .meta({ ref: "FounderYellowRollbackInput" })
export type FounderYellowRollbackInput = z.infer<typeof FounderYellowRollbackInput>

export const FounderYellowRollbackRecord = z
  .object({
    id: Identifier,
    trigger: z.enum(["failure_condition", "human_decision"]),
    handlerId: Identifier,
    status: z.enum(["requested", "completed", "failed"]),
    reason: LongText,
    result: LongText.nullable(),
    actorKind: z.enum(["human", "policy_engine"]),
    actorId: Identifier,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderYellowRollbackRecord" })
export type FounderYellowRollbackRecord = z.infer<typeof FounderYellowRollbackRecord>

export const FounderYellowSummary = z
  .object({
    schemaVersion: z.literal(1),
    runId: Identifier,
    status: z.enum(["blocked", "authorized", "outcome_pending", "completed", "failed", "rolled_back"]),
    actionType: FounderYellowDelegationAction,
    decisionId: Identifier,
    governanceRef: Identifier.nullable(),
    mutationId: Identifier.nullable(),
    workItemIds: z.array(Identifier).max(500),
    receiptIds: z.array(Identifier).max(500),
    outcomeIds: z.array(Identifier).max(500),
    cost: z.object({ unit: z.literal("receipt"), limit: z.number().positive(), actual: z.number().nonnegative() }).strict(),
    checkpointId: Identifier.nullable(),
    rollbackHandlerId: Identifier.nullable(),
    rollbacks: z.array(FounderYellowRollbackRecord).max(100),
    overrideIds: z.array(Identifier).max(100),
    circuitBreakerOpen: z.boolean(),
    failClosedReasons: z.array(ShortText).max(30),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "FounderYellowSummary" })
export type FounderYellowSummary = z.infer<typeof FounderYellowSummary>

export const FounderYellowDelegationProjection = z
  .object({
    schemaVersion: z.literal(1),
    companyId: Identifier,
    readiness: FounderYellowReadiness,
    mode: FounderOSModeState,
    effectiveDelegationMode: z.enum(["advisor", "green-delegated", "yellow-delegated"]),
    contracts: z.array(FounderYellowActionContract),
    redInvariants: z.array(z.enum([
      "external.communication.propose",
      "external.payment.propose",
      "production.operation.propose",
      "data.delete.propose",
      "privacy.change.propose",
      "security.change.propose",
      "child_safety.change.propose",
    ])),
    circuitBreakerOpen: z.boolean(),
    outcomeConsumer: z
      .object({
        baseline: z.literal("v1"),
        validatedOutcomeRequired: z.literal(true),
      })
      .strict(),
    summaries: z.array(FounderYellowSummary).max(100),
    autoPromotionAllowed: z.literal(false),
  })
  .strict()
  .meta({ ref: "FounderYellowDelegationProjection" })
export type FounderYellowDelegationProjection = z.infer<typeof FounderYellowDelegationProjection>
