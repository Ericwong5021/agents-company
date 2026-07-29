import z from "zod"

const Identifier = z.string().trim().min(1).max(240)
const ShortText = z.string().trim().min(1).max(240)
const LongText = z.string().trim().min(1).max(8_000)
const Timestamp = z.string().datetime()
const AuditableDecisionReason = ShortText.describe(
  "A short, auditable factual reason. Never chain-of-thought or private model reasoning.",
)

export const ExperienceSourceRef = z
  .object({
    kind: z.enum([
      "project",
      "project_event",
      "goal_brief",
      "legacy_charter",
      "work_item",
      "approval_gate",
      "artifact",
      "delivery",
      "conversation",
      "goal_request",
      "user",
      "work_attempt",
      "work_receipt",
      "graph_mutation",
      "project_assignment",
      "validation_gate",
    ]),
    id: Identifier,
    version: z.number().int().positive().optional(),
    eventType: ShortText.optional(),
  })
  .strict()
export type ExperienceSourceRef = z.infer<typeof ExperienceSourceRef>

export const GoalBriefSource = z.enum(["user_input", "system_suggestion", "user_confirmation"])
export type GoalBriefSource = z.infer<typeof GoalBriefSource>

export const GoalBriefDeliverable = z
  .object({
    id: Identifier,
    title: ShortText,
    description: LongText,
  })
  .strict()
export type GoalBriefDeliverable = z.infer<typeof GoalBriefDeliverable>

export const GoalBriefAcceptanceCriterion = z
  .object({
    id: Identifier,
    description: LongText,
    verification: LongText,
  })
  .strict()
export type GoalBriefAcceptanceCriterion = z.infer<typeof GoalBriefAcceptanceCriterion>

export const GoalBriefAssumption = z
  .object({
    id: Identifier,
    description: LongText,
    confirmed: z.boolean(),
  })
  .strict()
export type GoalBriefAssumption = z.infer<typeof GoalBriefAssumption>

export const GoalBriefOpenQuestion = z
  .object({
    id: Identifier,
    question: LongText,
    // GOAL-04：不同答案带来的影响（为什么这个问题重要）。
    impact: LongText,
    blocking: z.boolean(),
    // GOAL-04：用户不回答时系统将采用的默认假设，用于低风险可逆事项的自动决策与审计留痕。
    defaultAssumption: LongText.describe("若用户不回答，系统将采用的默认假设"),
  })
  .strict()
export type GoalBriefOpenQuestion = z.infer<typeof GoalBriefOpenQuestion>

export const GoalBriefPlanStep = z
  .object({
    id: Identifier,
    title: ShortText,
    outcome: LongText,
  })
  .strict()
export type GoalBriefPlanStep = z.infer<typeof GoalBriefPlanStep>

export const GoalBriefPlanSummary = z
  .object({
    summary: LongText,
    steps: z.array(GoalBriefPlanStep).min(1).max(100),
  })
  .strict()
export type GoalBriefPlanSummary = z.infer<typeof GoalBriefPlanSummary>

export const GoalBriefDraft = z
  .object({
    goal: LongText,
    deliverables: z.array(GoalBriefDeliverable).min(1).max(100),
    acceptanceCriteria: z.array(GoalBriefAcceptanceCriterion).min(1).max(200),
    constraints: z.array(LongText).max(100),
    nonGoals: z.array(LongText).max(100),
    assumptions: z.array(GoalBriefAssumption).max(100),
    openQuestions: z.array(GoalBriefOpenQuestion).max(100),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    recommendedPlan: GoalBriefPlanSummary,
    approvalMode: z.enum(["autonomous", "balanced", "strict"]),
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
  })
  .strict()
export type GoalBriefDraft = z.infer<typeof GoalBriefDraft>

export const GoalBrief = GoalBriefDraft.extend({
  id: Identifier,
  version: z.number().int().positive(),
  projectId: Identifier.optional(),
  sourceThreadId: Identifier.optional(),
  source: GoalBriefSource,
  createdAt: Timestamp,
}).strict()
export type GoalBrief = z.infer<typeof GoalBrief>

export const GoalBriefCreateRequest = z
  .object({
    projectId: Identifier.optional(),
    sourceThreadId: Identifier.optional(),
    source: GoalBriefSource,
    brief: GoalBriefDraft,
  })
  .strict()
export type GoalBriefCreateRequest = z.infer<typeof GoalBriefCreateRequest>

export const GoalBriefGenerateRequest = z
  .object({
    requestId: Identifier,
    goal: LongText,
    context: LongText.optional(),
    projectId: Identifier.optional(),
    sourceThreadId: Identifier.optional(),
  })
  .strict()
export type GoalBriefGenerateRequest = z.infer<typeof GoalBriefGenerateRequest>

export const GoalBriefAppendRequest = z
  .object({
    expectedVersion: z.number().int().positive(),
    source: GoalBriefSource,
    brief: GoalBriefDraft,
  })
  .strict()
export type GoalBriefAppendRequest = z.infer<typeof GoalBriefAppendRequest>

export const GoalBriefHistory = z
  .object({
    id: Identifier,
    versions: z.array(GoalBrief),
  })
  .strict()
export type GoalBriefHistory = z.infer<typeof GoalBriefHistory>

export const LegacyGoalBrief = z
  .object({
    id: Identifier,
    version: z.literal(1),
    projectId: Identifier,
    goal: LongText,
    deliverables: z.array(LongText),
    acceptanceCriteria: z.array(LongText),
    constraints: z.array(LongText),
    nonGoals: z.array(LongText),
    assumptions: z.array(LongText),
    openQuestions: z.array(LongText),
    riskLevel: z.null(),
    recommendedPlan: z.null(),
    approvalMode: z.enum(["autonomous", "balanced", "strict"]),
    sourceRefs: z.array(ExperienceSourceRef).min(1),
    source: z.literal("legacy_charter"),
    missingFields: z.array(z.enum(["riskLevel", "recommendedPlan"])).min(1),
    createdAt: Timestamp,
  })
  .strict()
export type LegacyGoalBrief = z.infer<typeof LegacyGoalBrief>

export const GoalBriefProjectView = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("goal_brief"),
      brief: GoalBrief,
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy_charter"),
      brief: LegacyGoalBrief,
    })
    .strict(),
])
export type GoalBriefProjectView = z.infer<typeof GoalBriefProjectView>

export const ExperienceIntent = z.enum(["message", "question", "goal", "intervention", "approval_response"])
export type ExperienceIntent = z.infer<typeof ExperienceIntent>

export const ExperienceIntentClassificationInput = z
  .object({
    schemaVersion: z.literal(1),
    requestId: Identifier,
    text: LongText,
    context: z
      .object({
        existingWorkId: Identifier.optional(),
        pendingDecisionId: Identifier.optional(),
        replyToId: Identifier.optional(),
      })
      .strict(),
    createdAt: Timestamp,
  })
  .strict()
export type ExperienceIntentClassificationInput = z.infer<typeof ExperienceIntentClassificationInput>

const IntentResultBase = {
  schemaVersion: z.literal(1),
  requestId: Identifier,
  decision: z.enum(["routed", "needs_confirmation"]),
  confidence: z.number().min(0).max(1),
  decisionReason: AuditableDecisionReason,
  source: z.enum(["rule", "model", "user_correction"]),
  classifiedAt: Timestamp,
}

export const ExperienceIntentConfirmationOption = z.enum([
  "execute_as_goal",
  "discuss_only",
  "answer_only",
  "append_to_work",
  "respond_to_approval",
])
export type ExperienceIntentConfirmationOption = z.infer<typeof ExperienceIntentConfirmationOption>

export const ExperienceGoalMode = z.enum(["direct", "briefed"])
export type ExperienceGoalMode = z.infer<typeof ExperienceGoalMode>

export const ExperienceWorkCreationPolicy = z.enum(["forbidden", "requires_explicit_start"])
export type ExperienceWorkCreationPolicy = z.infer<typeof ExperienceWorkCreationPolicy>

const RoutedIntentBase = {
  ...IntentResultBase,
  decision: z.literal("routed"),
}

export const ExperienceRoutedIntentClassificationResult = z.discriminatedUnion("intent", [
  z
    .object({
      ...RoutedIntentBase,
      intent: z.literal("message"),
      route: z.literal("conversation"),
      workCreationPolicy: z.literal("forbidden"),
    })
    .strict(),
  z
    .object({
      ...RoutedIntentBase,
      intent: z.literal("question"),
      route: z.literal("conversation"),
      workCreationPolicy: z.literal("forbidden"),
    })
    .strict(),
  z
    .object({
      ...RoutedIntentBase,
      intent: z.literal("goal"),
      route: z.literal("goal_brief"),
      goalMode: ExperienceGoalMode,
      workCreationPolicy: z.literal("requires_explicit_start"),
    })
    .strict(),
  z
    .object({
      ...RoutedIntentBase,
      intent: z.literal("intervention"),
      route: z.literal("existing_work"),
      targetWorkId: Identifier,
      workCreationPolicy: z.literal("forbidden"),
    })
    .strict(),
  z
    .object({
      ...RoutedIntentBase,
      intent: z.literal("approval_response"),
      route: z.literal("pending_decision"),
      targetDecisionId: Identifier,
      workCreationPolicy: z.literal("forbidden"),
    })
    .strict(),
])
export type ExperienceRoutedIntentClassificationResult = z.infer<typeof ExperienceRoutedIntentClassificationResult>

export const ExperienceNeedsConfirmationIntentClassificationResult = z
  .object({
    ...IntentResultBase,
    decision: z.literal("needs_confirmation"),
    proposedIntent: ExperienceIntent,
    confirmationOptions: z.array(ExperienceIntentConfirmationOption).min(1).max(5),
    workCreationPolicy: z.literal("forbidden"),
  })
  .strict()
export type ExperienceNeedsConfirmationIntentClassificationResult = z.infer<
  typeof ExperienceNeedsConfirmationIntentClassificationResult
>

export const ExperienceIntentClassificationResult = z.union([
  ExperienceRoutedIntentClassificationResult,
  ExperienceNeedsConfirmationIntentClassificationResult,
])
export type ExperienceIntentClassificationResult = z.infer<typeof ExperienceIntentClassificationResult>

export const ExperienceIntentCorrectionResult = z
  .object({
    schemaVersion: z.literal(1),
    correctionId: Identifier,
    requestId: Identifier,
    previousResultRef: Identifier,
    correctedBy: z.literal("user"),
    reason: LongText.optional(),
    correctedAt: Timestamp,
    result: ExperienceRoutedIntentClassificationResult,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result.requestId !== value.requestId)
      context.addIssue({
        code: "custom",
        path: ["result", "requestId"],
        message: "Correction requestId must match the corrected classification",
      })
    if (value.result.source !== "user_correction")
      context.addIssue({
        code: "custom",
        path: ["result", "source"],
        message: "Corrected classifications must use user_correction as their source",
      })
  })
export type ExperienceIntentCorrectionResult = z.infer<typeof ExperienceIntentCorrectionResult>

export const ExperienceUserStatus = z.enum([
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
])
export type ExperienceUserStatus = z.infer<typeof ExperienceUserStatus>

export const ExperienceUserStatusLabels = {
  draft: "Draft",
  needs_input: "Needs input",
  ready: "Ready",
  running: "Running",
  paused: "Paused",
  blocked: "Blocked",
  needs_approval: "Needs approval",
  reviewing: "Reviewing",
  revision: "Revision",
  delivered: "Delivered",
  accepted: "Accepted",
  failed: "Failed",
  cancelled: "Cancelled",
} as const satisfies Record<ExperienceUserStatus, string>

export const ExperienceActionType = z.enum([
  "continue_editing",
  "answer_question",
  "start_work",
  "adjust_brief",
  "view_progress",
  "pause_work",
  "resume_work",
  "stop_work",
  "resolve_blocker",
  "approve",
  "reject",
  "request_change",
  "view_evidence",
  "view_revision",
  "open_delivery",
  "accept_delivery",
  "retry",
  "open_diagnostics",
  "view_retained_results",
  "archive",
])
export type ExperienceActionType = z.infer<typeof ExperienceActionType>

export const ExperienceActionMutatesBusinessState = {
  continue_editing: false,
  answer_question: true,
  start_work: true,
  adjust_brief: true,
  view_progress: false,
  pause_work: true,
  resume_work: true,
  stop_work: true,
  resolve_blocker: true,
  approve: true,
  reject: true,
  request_change: true,
  view_evidence: false,
  view_revision: false,
  open_delivery: false,
  accept_delivery: true,
  retry: true,
  open_diagnostics: false,
  view_retained_results: false,
  archive: true,
} as const satisfies Record<ExperienceActionType, boolean>

export const ExperienceR0ImplementedMutationActions = [
  "adjust_brief",
  "pause_work",
  "resume_work",
  "stop_work",
  "resolve_blocker",
  "retry",
] as const satisfies readonly ExperienceActionType[]
const ExperienceR0ImplementedMutationActionSet = new Set<ExperienceActionType>(ExperienceR0ImplementedMutationActions)

const ExperienceWorkActionBase = {
  idempotencyKey: Identifier,
  expectedGraphRevision: z.number().int().nonnegative(),
}

export const ExperienceWorkActionRequest = z.union([
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("adjust_brief"),
      attentionId: Identifier.optional(),
      briefId: Identifier,
      expectedBriefVersion: z.number().int().positive(),
      expectedPlanVersion: z.number().int().positive(),
      source: GoalBriefSource,
      brief: GoalBriefDraft,
      changeReason: LongText,
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("pause_work"),
      reason: LongText.optional(),
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("resume_work"),
      reason: LongText.optional(),
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("stop_work"),
      reason: LongText.optional(),
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("retry"),
      workItemIds: z.array(Identifier).max(500).optional(),
      reason: LongText.optional(),
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("resolve_blocker"),
      attentionId: Identifier,
      resolution: LongText,
    })
    .strict(),
  z
    .object({
      ...ExperienceWorkActionBase,
      action: z.literal("resolve_blocker"),
      attentionId: Identifier.optional(),
      approvalGateId: Identifier,
      decision: z.enum(["approve", "reject"]),
      resolution: LongText,
    })
    .strict(),
])
export type ExperienceWorkActionRequest = z.infer<typeof ExperienceWorkActionRequest>

export const ExperienceWorkActionResult = z
  .object({
    actionId: Identifier,
    projectId: Identifier,
    action: z.enum(["adjust_brief", "pause_work", "resume_work", "stop_work", "retry", "resolve_blocker"]),
    status: z.enum(["applied", "rejected"]),
    replayed: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: LongText.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "applied" && !value.result)
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Applied actions require a persisted result",
      })
    if (value.status === "rejected" && !value.error)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Rejected actions require an error",
      })
  })
export type ExperienceWorkActionResult = z.infer<typeof ExperienceWorkActionResult>

export const ExperienceAllowedActionTypes = {
  draft: ["continue_editing", "adjust_brief"],
  needs_input: ["answer_question", "adjust_brief", "stop_work"],
  ready: ["start_work", "adjust_brief"],
  running: ["view_progress", "pause_work", "stop_work"],
  paused: ["resume_work", "adjust_brief", "stop_work"],
  blocked: ["resolve_blocker", "open_diagnostics", "stop_work"],
  needs_approval: ["approve", "reject", "request_change", "open_diagnostics"],
  reviewing: ["view_evidence", "view_progress"],
  revision: ["view_revision", "view_evidence", "stop_work"],
  delivered: ["open_delivery", "accept_delivery", "request_change", "view_evidence"],
  accepted: ["open_delivery", "view_evidence", "archive"],
  failed: ["retry", "open_diagnostics", "adjust_brief", "stop_work"],
  cancelled: ["view_retained_results", "archive"],
} as const satisfies Record<ExperienceUserStatus, readonly ExperienceActionType[]>

export const ExperienceNeedsUserAction = {
  draft: true,
  needs_input: true,
  ready: true,
  running: false,
  paused: true,
  blocked: true,
  needs_approval: true,
  reviewing: false,
  revision: false,
  delivered: true,
  accepted: false,
  failed: true,
  cancelled: false,
} as const satisfies Record<ExperienceUserStatus, boolean>

export const ExperienceActionDescriptor = z
  .discriminatedUnion("enabled", [
    z
      .object({
        id: ExperienceActionType,
        targetRef: ExperienceSourceRef.optional(),
        enabled: z.literal(true),
      })
      .strict(),
    z
      .object({
        id: ExperienceActionType,
        targetRef: ExperienceSourceRef.optional(),
        enabled: z.literal(false),
        disabledReason: LongText,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.enabled &&
      ExperienceActionMutatesBusinessState[value.id] &&
      !ExperienceR0ImplementedMutationActionSet.has(value.id)
    )
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "Mutation action has no implemented R0 handler",
      })
  })
export type ExperienceActionDescriptor = z.infer<typeof ExperienceActionDescriptor>

export const ExperienceKnownReason = z
  .object({
    availability: z.literal("known"),
    text: LongText,
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
  })
  .strict()
export type ExperienceKnownReason = z.infer<typeof ExperienceKnownReason>

export const ExperienceUnavailableReason = z
  .object({
    availability: z.literal("unavailable"),
    text: z.literal("当前原因不可用"),
    diagnosticIds: z.array(Identifier).min(1).max(500),
  })
  .strict()
export type ExperienceUnavailableReason = z.infer<typeof ExperienceUnavailableReason>

export const ExperienceReason = z.discriminatedUnion("availability", [
  ExperienceKnownReason,
  ExperienceUnavailableReason,
])
export type ExperienceReason = z.infer<typeof ExperienceReason>

export const ExperienceAgentRef = z
  .object({
    id: Identifier,
    name: ShortText.optional(),
  })
  .strict()
export type ExperienceAgentRef = z.infer<typeof ExperienceAgentRef>

export const ExperienceMilestoneSummary = z
  .object({
    id: Identifier,
    title: ShortText,
    completed: z.boolean(),
  })
  .strict()
export type ExperienceMilestoneSummary = z.infer<typeof ExperienceMilestoneSummary>

function refineStatusProjection(
  value: {
    userStatus: ExperienceUserStatus
    needsUserAction?: boolean
    nextAction: ExperienceActionDescriptor | null
    allowedActions: ExperienceActionDescriptor[]
  },
  context: z.RefinementCtx,
) {
  if (value.needsUserAction !== undefined && value.needsUserAction !== ExperienceNeedsUserAction[value.userStatus])
    context.addIssue({
      code: "custom",
      path: ["needsUserAction"],
      message: "needsUserAction must match the canonical user status",
    })
  const ids = value.allowedActions.map((item) => item.id)
  if (new Set(ids).size !== ids.length)
    context.addIssue({
      code: "custom",
      path: ["allowedActions"],
      message: "allowedActions must not contain duplicate IDs",
    })
  value.allowedActions.forEach((item, index) => {
    if (!ExperienceAllowedActionTypes[value.userStatus].some((id) => id === item.id))
      context.addIssue({
        code: "custom",
        path: ["allowedActions", index, "id"],
        message: "Action is not allowed for the canonical user status",
      })
  })
  if (
    value.nextAction &&
    (!value.nextAction.enabled ||
      !value.allowedActions.some((item) => item.id === value.nextAction?.id && item.enabled))
  )
    context.addIssue({
      code: "custom",
      path: ["nextAction"],
      message: "nextAction must be an enabled member of allowedActions",
    })
}

export const WorkSummary = z
  .object({
    workId: Identifier,
    title: ShortText,
    userStatus: ExperienceUserStatus,
    phase: ShortText,
    owner: ExperienceAgentRef.optional(),
    nextMilestone: ExperienceMilestoneSummary.optional(),
    needsUserAction: z.boolean(),
    reason: ExperienceReason,
    nextAction: ExperienceActionDescriptor.nullable(),
    updatedAt: Timestamp,
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
    allowedActions: z.array(ExperienceActionDescriptor).max(20),
  })
  .strict()
  .superRefine(refineStatusProjection)
export type WorkSummary = z.infer<typeof WorkSummary>

export const ProgressProjection = z
  .object({
    workId: Identifier,
    userStatus: ExperienceUserStatus,
    phase: ShortText,
    completedItems: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100).optional(),
    reason: ExperienceReason,
    nextAction: ExperienceActionDescriptor.nullable(),
    updatedAt: Timestamp,
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
    allowedActions: z.array(ExperienceActionDescriptor).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    refineStatusProjection(value, context)
    if (value.completedItems > value.totalItems)
      context.addIssue({
        code: "custom",
        path: ["completedItems"],
        message: "completedItems cannot exceed totalItems",
      })
    if (value.totalItems === 0 && value.percent !== undefined)
      context.addIssue({
        code: "custom",
        path: ["percent"],
        message: "percent must be omitted when totalItems is zero",
      })
    if (value.totalItems > 0 && value.percent !== Math.round((value.completedItems / value.totalItems) * 100))
      context.addIssue({
        code: "custom",
        path: ["percent"],
        message: "percent must match completedItems and totalItems",
      })
  })
export type ProgressProjection = z.infer<typeof ProgressProjection>

export const AttentionItem = z
  .object({
    id: Identifier,
    type: z.enum(["input", "approval", "blocked", "delivery", "failure"]),
    workId: Identifier,
    title: ShortText,
    reason: ExperienceReason,
    impact: LongText,
    recommendedAction: ExperienceActionDescriptor.nullable(),
    priority: z.enum(["normal", "high", "critical"]),
    updatedAt: Timestamp,
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
    allowedActions: z.array(ExperienceActionDescriptor).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.allowedActions.map((item) => item.id)
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "allowedActions must not contain duplicate IDs",
      })
    if (
      value.recommendedAction &&
      (!value.recommendedAction.enabled ||
        !value.allowedActions.some((item) => item.id === value.recommendedAction?.id && item.enabled))
    )
      context.addIssue({
        code: "custom",
        path: ["recommendedAction"],
        message: "recommendedAction must be an enabled member of allowedActions",
      })
  })
export type AttentionItem = z.infer<typeof AttentionItem>

export const ExperienceArtifactRef = z
  .object({
    id: Identifier,
    projectId: Identifier,
    kind: ShortText,
    title: ShortText,
    href: z
      .string()
      .max(1_000)
      .regex(/^\/experience\/projects\/[^/?#]+\/artifacts\/[^/?#]+$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.href !==
      `/experience/projects/${encodeURIComponent(value.projectId)}/artifacts/${encodeURIComponent(value.id)}`
    )
      context.addIssue({
        code: "custom",
        path: ["href"],
        message: "Artifact href must match its project and Artifact IDs",
      })
  })
export type ExperienceArtifactRef = z.infer<typeof ExperienceArtifactRef>

export const DeliveryArtifactRef = ExperienceArtifactRef
export type DeliveryArtifactRef = z.infer<typeof DeliveryArtifactRef>

export const ExperienceArtifactView = ExperienceArtifactRef.safeExtend({
  source: z.enum(["inline", "project_file"]),
  mediaType: ShortText,
  encoding: z.enum(["utf8", "base64"]),
  presentation: z.enum(["text", "media", "download"]),
  content: z.string().min(1).max(7_000_000),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  createdAt: Timestamp,
}).strict()
export type ExperienceArtifactView = z.infer<typeof ExperienceArtifactView>

export const ExperienceArtifactUnavailable = z
  .object({
    code: z.literal("artifact_unavailable"),
    message: LongText,
  })
  .strict()
export type ExperienceArtifactUnavailable = z.infer<typeof ExperienceArtifactUnavailable>

export const DeliverySummary = z
  .object({
    id: Identifier,
    workId: Identifier,
    version: z.number().int().positive(),
    acceptanceState: z.enum(["pending", "accepted", "revision_requested"]),
    artifacts: z.array(DeliveryArtifactRef).max(500),
    reason: ExperienceKnownReason,
    nextAction: ExperienceActionDescriptor.nullable(),
    updatedAt: Timestamp,
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
    allowedActions: z.array(ExperienceActionDescriptor).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.allowedActions.map((item) => item.id)
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "allowedActions must not contain duplicate IDs",
      })
    if (
      value.nextAction &&
      (!value.nextAction.enabled ||
        !value.allowedActions.some((item) => item.id === value.nextAction?.id && item.enabled))
    )
      context.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "nextAction must be an enabled member of allowedActions",
      })
    if (!value.artifacts.length)
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Delivery must contain at least one real artifact",
      })
  })
export type DeliverySummary = z.infer<typeof DeliverySummary>

export const WorkProjectionDiagnostic = z
  .object({
    id: Identifier,
    code: z.enum(["invalid_event", "unknown_event", "conflicting_duplicate", "invalid_timestamp", "missing_fact"]),
    message: LongText,
    eventId: Identifier.optional(),
    sourceRef: ExperienceSourceRef.optional(),
  })
  .strict()
export type WorkProjectionDiagnostic = z.infer<typeof WorkProjectionDiagnostic>

const WorkProjectionMetadata = {
  projectorVersion: z.number().int().positive(),
  sourceWatermark: z.string().regex(/^[a-f0-9]{64}$/),
}

const WorkProjectionValue = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...WorkProjectionMetadata,
      summary: WorkSummary,
      progress: ProgressProjection,
      attentionItems: z.array(AttentionItem).max(500),
      delivery: DeliverySummary.optional(),
      diagnostics: z.array(WorkProjectionDiagnostic).max(500),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...WorkProjectionMetadata,
      workId: Identifier,
      title: ShortText,
      updatedAt: Timestamp,
      reason: ExperienceUnavailableReason,
      diagnostics: z.array(WorkProjectionDiagnostic).min(1).max(500),
    })
    .strict(),
])
export const WorkProjection = WorkProjectionValue.superRefine((value, context) => {
  const diagnosticIDList = value.diagnostics.map((item) => item.id)
  const diagnosticIDs = new Set(diagnosticIDList)
  if (diagnosticIDs.size !== diagnosticIDList.length)
    context.addIssue({
      code: "custom",
      path: ["diagnostics"],
      message: "diagnostic IDs must be unique",
    })
  if (value.availability === "unavailable") {
    value.reason.diagnosticIds.forEach((id, index) => {
      if (!diagnosticIDs.has(id))
        context.addIssue({
          code: "custom",
          path: ["reason", "diagnosticIds", index],
          message: "Unavailable reason must reference a returned diagnostic",
        })
    })
    return
  }

  const pairs = [
    ["workId", value.summary.workId, value.progress.workId],
    ["userStatus", value.summary.userStatus, value.progress.userStatus],
    ["phase", value.summary.phase, value.progress.phase],
    ["updatedAt", value.summary.updatedAt, value.progress.updatedAt],
    ["reason", value.summary.reason, value.progress.reason],
    ["nextAction", value.summary.nextAction, value.progress.nextAction],
    ["sourceRefs", value.summary.sourceRefs, value.progress.sourceRefs],
    ["allowedActions", value.summary.allowedActions, value.progress.allowedActions],
  ] as const
  pairs.forEach(([field, summaryValue, progressValue]) => {
    if (JSON.stringify(summaryValue) !== JSON.stringify(progressValue))
      context.addIssue({
        code: "custom",
        path: ["progress", field],
        message: `${field} must match summary`,
      })
  })

  if (
    value.summary.reason.availability === "known" &&
    JSON.stringify(value.summary.reason.sourceRefs) !== JSON.stringify(value.summary.sourceRefs)
  )
    context.addIssue({
      code: "custom",
      path: ["summary", "reason", "sourceRefs"],
      message: "Known reason sourceRefs must match summary sourceRefs",
    })
  if (value.summary.reason.availability === "unavailable")
    value.summary.reason.diagnosticIds.forEach((id, index) => {
      if (!diagnosticIDs.has(id))
        context.addIssue({
          code: "custom",
          path: ["summary", "reason", "diagnosticIds", index],
          message: "Unavailable reason must reference a returned diagnostic",
        })
    })

  const attentionIDs = value.attentionItems.map((item) => item.id)
  if (new Set(attentionIDs).size !== attentionIDs.length)
    context.addIssue({
      code: "custom",
      path: ["attentionItems"],
      message: "Attention Item IDs must be unique",
    })
  const allowedIDs = ExperienceAllowedActionTypes[value.summary.userStatus]
  value.attentionItems.forEach((item, itemIndex) => {
    if (
      item.reason.availability === "known" &&
      JSON.stringify(item.reason.sourceRefs) !== JSON.stringify(item.sourceRefs)
    )
      context.addIssue({
        code: "custom",
        path: ["attentionItems", itemIndex, "reason", "sourceRefs"],
        message: "Known Attention reason sourceRefs must match the Attention sourceRefs",
      })
    if (item.reason.availability === "unavailable")
      item.reason.diagnosticIds.forEach((id, diagnosticIndex) => {
        if (!diagnosticIDs.has(id))
          context.addIssue({
            code: "custom",
            path: ["attentionItems", itemIndex, "reason", "diagnosticIds", diagnosticIndex],
            message: "Unavailable Attention reason must reference a returned diagnostic",
          })
      })
    item.allowedActions.forEach((descriptor, actionIndex) => {
      if (!allowedIDs.some((id) => id === descriptor.id))
        context.addIssue({
          code: "custom",
          path: ["attentionItems", itemIndex, "allowedActions", actionIndex, "id"],
          message: "Attention action is not allowed for the projected user status",
        })
    })
  })
  if (value.delivery) {
    if (value.delivery.workId !== value.summary.workId)
      context.addIssue({
        code: "custom",
        path: ["delivery", "workId"],
        message: "Delivery workId must match summary",
      })
    value.delivery.allowedActions.forEach((descriptor, index) => {
      if (!allowedIDs.some((id) => id === descriptor.id))
        context.addIssue({
          code: "custom",
          path: ["delivery", "allowedActions", index, "id"],
          message: "Delivery action is not allowed for the projected user status",
        })
    })
    if (JSON.stringify(value.delivery.reason.sourceRefs) !== JSON.stringify(value.delivery.sourceRefs))
      context.addIssue({
        code: "custom",
        path: ["delivery", "reason", "sourceRefs"],
        message: "Delivery reason sourceRefs must match Delivery sourceRefs",
      })
    const validAcceptanceState =
      (value.summary.userStatus === "delivered" && value.delivery.acceptanceState === "pending") ||
      (value.summary.userStatus === "accepted" && value.delivery.acceptanceState === "accepted") ||
      (value.summary.userStatus === "revision" && value.delivery.acceptanceState === "revision_requested")
    if (!validAcceptanceState)
      context.addIssue({
        code: "custom",
        path: ["delivery", "acceptanceState"],
        message: "Delivery acceptanceState must match the projected user status",
      })
  }
  if ((value.summary.userStatus === "delivered" || value.summary.userStatus === "accepted") && !value.delivery)
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "Delivered and accepted states require a real Delivery",
    })
})
export type WorkProjection = z.infer<typeof WorkProjection>

export const WorkProjectionList = z
  .object({
    items: z.array(WorkProjection),
  })
  .strict()
export type WorkProjectionList = z.infer<typeof WorkProjectionList>

const ReadProjectionMetadata = {
  projectorVersion: z.number().int().positive(),
  sourceWatermark: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
  updatedAt: Timestamp,
}

const ReadProjectionUnavailableReason = z
  .object({
    code: z.enum(["invalid_persisted_fact", "projection_overflow"]),
    message: LongText,
  })
  .strict()

export const AssignmentSummary = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...ReadProjectionMetadata,
      assignmentId: Identifier,
      projectId: Identifier,
      workItemId: Identifier,
      agent: ExperienceAgentRef,
      lifecycleAtSelection: z.enum(["candidate", "assigned", "employee", "archived"]),
      currentLifecycle: z.enum(["candidate", "assigned", "employee", "archived"]),
      status: z.enum(["assigned", "active", "released"]),
      version: z.number().int().positive(),
      temporaryRole: ShortText,
      responsibility: LongText,
      permissionMode: z.enum(["read_only", "workspace_write", "full_access"]),
      need: z
        .object({
          id: Identifier,
          key: ShortText,
          role: ShortText,
        })
        .strict(),
      selectionReason: LongText,
      sourceReceiptId: Identifier.optional(),
      supersedesAssignmentId: Identifier.optional(),
      assignedAt: Timestamp,
      startedAt: Timestamp.optional(),
      releasedAt: Timestamp.optional(),
      releaseReason: LongText.optional(),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...ReadProjectionMetadata,
      assignmentId: Identifier,
      projectId: Identifier,
      reason: ReadProjectionUnavailableReason,
    })
    .strict(),
])
export type AssignmentSummary = z.infer<typeof AssignmentSummary>

export const OrganizationProjection = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      activeAssignmentCount: z.number().int().nonnegative(),
      assignments: z.array(AssignmentSummary).max(499),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      reason: ReadProjectionUnavailableReason,
    })
    .strict(),
])
export type OrganizationProjection = z.infer<typeof OrganizationProjection>

const GraphOperationCounts = z
  .object({
    addedWorkItems: z.number().int().nonnegative(),
    addedDependencies: z.number().int().nonnegative(),
    removedDependencies: z.number().int().nonnegative(),
    supersededWorkItems: z.number().int().nonnegative(),
    addedValidationGates: z.number().int().nonnegative(),
    requestedCapabilities: z.number().int().nonnegative(),
    requestedUserDecisions: z.number().int().nonnegative(),
  })
  .strict()

const GraphChange = z
  .object({
    mutationId: Identifier,
    decision: z.enum([
      "accept",
      "retry",
      "expand",
      "rewire",
      "supersede",
      "request_capability",
      "request_attention",
      "quiesce",
    ]),
    status: z.enum(["proposed", "validated", "applied", "rejected", "superseded"]),
    rationale: LongText,
    expectedRevision: z.number().int().nonnegative(),
    appliedRevision: z.number().int().nonnegative().optional(),
    triggerReceiptId: Identifier,
    operationCounts: GraphOperationCounts,
    createdAt: Timestamp,
    appliedAt: Timestamp.optional(),
    sourceRefs: z.array(ExperienceSourceRef).min(2).max(500),
  })
  .strict()

export const GraphChangeSummary = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      revision: z.number().int().nonnegative(),
      changes: z.array(GraphChange).max(499),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      reason: ReadProjectionUnavailableReason,
    })
    .strict(),
])
export type GraphChangeSummary = z.infer<typeof GraphChangeSummary>

const DiscoveryAttempt = z
  .object({
    id: Identifier,
    ordinal: z.number().int().positive(),
    status: z.enum(["running", "completed", "failed", "stopped"]),
    failureKind: z
      .enum([
        "implementation",
        "environment",
        "missing_prerequisite",
        "dependency",
        "permission",
        "validator",
        "scope",
        "unknown",
      ])
      .optional(),
    safeSummary: LongText.optional(),
    startedAt: Timestamp,
    finishedAt: Timestamp.optional(),
  })
  .strict()

export const DiscoverySummary = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...ReadProjectionMetadata,
      receiptId: Identifier,
      projectId: Identifier,
      workItemId: Identifier,
      attempt: DiscoveryAttempt,
      outcome: z.enum(["completed", "blocked", "failed", "ask"]),
      processingStatus: z.enum(["pending", "processing", "processed", "rejected"]),
      summary: LongText,
      confirmedFacts: z.array(LongText).max(500),
      invalidatedAssumptions: z.array(LongText).max(500),
      unknowns: z.array(LongText).max(500),
      blockers: z.array(LongText).max(500),
      capabilityGaps: z.array(LongText).max(500),
      questions: z.array(LongText).max(500),
      processedMutationId: Identifier.optional(),
      createdAt: Timestamp,
      processedAt: Timestamp.optional(),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...ReadProjectionMetadata,
      receiptId: Identifier,
      projectId: Identifier,
      reason: ReadProjectionUnavailableReason,
    })
    .strict(),
])
export type DiscoverySummary = z.infer<typeof DiscoverySummary>

const ValidationCriterionSummary = z
  .object({
    id: Identifier,
    statement: LongText,
    anchor: z
      .object({
        kind: z.enum([
          "prerequisite",
          "unit_test",
          "integration_test",
          "device",
          "runtime",
          "artifact",
          "source",
          "policy",
        ]),
        reference: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    operator: z.enum(["exists", "equals", "exit_code", "digest"]),
    expected: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict()

const ValidationGateSummary = z
  .object({
    gateId: Identifier,
    workItemId: Identifier.optional(),
    kind: z.enum([
      "prerequisite",
      "unit_test",
      "integration_test",
      "device",
      "runtime",
      "artifact",
      "source",
      "policy",
    ]),
    status: z.enum(["pending", "running", "passed", "failed", "superseded"]),
    criteria: z.array(ValidationCriterionSummary).min(1).max(500),
    criteriaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    blockingWorkItemIds: z.array(Identifier).min(1).max(500),
    evidenceRefs: z.array(ExperienceSourceRef).max(500),
    evaluator: z.enum([
      "fact_match_v1",
      "command_exit_v1",
      "artifact_digest_v1",
      "source_reachability_v1",
      "runtime_state_v1",
      "policy_invariant_v1",
    ]),
    repairRound: z.number().int().nonnegative(),
    maxRepairRounds: z.number().int().positive(),
    failureSummary: LongText.optional(),
    supersedesGateId: Identifier.optional(),
    createdAt: Timestamp,
    evaluatedAt: Timestamp.optional(),
    sourceRefs: z.array(ExperienceSourceRef).min(1).max(500),
  })
  .strict()

export const ValidationSummary = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      blockingGateCount: z.number().int().nonnegative(),
      gates: z.array(ValidationGateSummary).max(499),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      ...ReadProjectionMetadata,
      projectId: Identifier,
      reason: ReadProjectionUnavailableReason,
    })
    .strict(),
])
export type ValidationSummary = z.infer<typeof ValidationSummary>

export const GoalBriefRecoveryAction = z.enum(["retry", "manual_edit"])
export type GoalBriefRecoveryAction = z.infer<typeof GoalBriefRecoveryAction>

export const GoalBriefStructuredFailure = z
  .object({
    code: z.literal("goal_brief_structured_output_failed"),
    message: LongText,
    attempts: z.number().int().min(1).max(3),
    recoveryActions: z.tuple([z.literal("retry"), z.literal("manual_edit")]),
  })
  .strict()
export type GoalBriefStructuredFailure = z.infer<typeof GoalBriefStructuredFailure>

export const ExperienceApiError = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("not_found"),
      message: LongText,
    })
    .strict(),
  z
    .object({
      code: z.literal("version_conflict"),
      message: LongText,
      currentVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      code: z.literal("request_conflict"),
      message: LongText,
    })
    .strict(),
  z
    .object({
      code: z.literal("request_in_progress"),
      message: LongText,
    })
    .strict(),
  ExperienceArtifactUnavailable,
  GoalBriefStructuredFailure,
])
export type ExperienceApiError = z.infer<typeof ExperienceApiError>
