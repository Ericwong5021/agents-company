import z from "zod"
import { ProjectExecutionStrategy } from "./project-orchestration"
import { MetricContract, MetricEvaluationReport, MetricSourceRef } from "./seed-grow-metrics"
import { ShadowComparisonReport } from "./seed-grow-shadow"

const Identifier = z.string().trim().min(1).max(240)
const ShortText = z.string().trim().min(1).max(500)
const LongText = z.string().trim().min(1).max(8_000)
const Timestamp = z.number().int().nonnegative()
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/)
const phases = ["off", "shadow", "opt_in", "dogfood_default", "pre_public_default"] as const

export const RolloutPhase = z.enum(phases)
export type RolloutPhase = z.infer<typeof RolloutPhase>

export const SeedGrowExecutionMode = z.enum(["off", "shadow", "active"])
export type SeedGrowExecutionMode = z.infer<typeof SeedGrowExecutionMode>

export const RolloutState = z
  .object({
    id: z.literal("seed_and_grow"),
    phase: RolloutPhase,
    version: z.number().int().positive(),
    lastTransitionId: Identifier.optional(),
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedVersion = phases.indexOf(value.phase) + 1
    if (value.version !== expectedVersion)
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "rollout state version must match its monotonic phase",
      })
    if (value.phase === "off" && value.lastTransitionId)
      context.addIssue({
        code: "custom",
        path: ["lastTransitionId"],
        message: "off rollout state cannot reference a transition",
      })
    if (value.phase !== "off" && !value.lastTransitionId)
      context.addIssue({
        code: "custom",
        path: ["lastTransitionId"],
        message: "advanced rollout state must reference its transition",
      })
  })
export type RolloutState = z.infer<typeof RolloutState>

export const RolloutProjectPolicy = z
  .object({
    defaultStrategy: ProjectExecutionStrategy,
    seedOptInAllowed: z.boolean(),
    explicitLegacyFallbackAllowed: z.boolean(),
  })
  .strict()
export type RolloutProjectPolicy = z.infer<typeof RolloutProjectPolicy>

export const RolloutStatus = z
  .object({
    state: RolloutState,
    executionMode: SeedGrowExecutionMode,
    newProjectPolicy: RolloutProjectPolicy,
  })
  .strict()
export type RolloutStatus = z.infer<typeof RolloutStatus>

export const RolloutTransitionRequest = z
  .object({
    idempotencyKey: Identifier,
    to: RolloutPhase,
    reason: LongText,
    actorId: Identifier.optional(),
    promotionDecisionId: Identifier.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.to === "pre_public_default") !== Boolean(value.promotionDecisionId))
      context.addIssue({
        code: "custom",
        path: ["promotionDecisionId"],
        message: "only the pre-public transition requires a promotion decision",
      })
  })
export type RolloutTransitionRequest = z.infer<typeof RolloutTransitionRequest>

export const RolloutTransition = z
  .object({
    id: Identifier,
    from: RolloutPhase,
    to: RolloutPhase,
    version: z.number().int().positive(),
    reason: LongText,
    actorId: Identifier.optional(),
    promotionDecisionId: Identifier.optional(),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const index = phases.indexOf(value.to)
    if (index < 1 || value.from !== phases[index - 1])
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "rollout transitions must advance by exactly one phase",
      })
    if (value.version !== index + 1)
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "rollout transition version must match its destination phase",
      })
    if ((value.to === "pre_public_default") !== Boolean(value.promotionDecisionId))
      context.addIssue({
        code: "custom",
        path: ["promotionDecisionId"],
        message: "only the pre-public transition can bind a promotion decision",
      })
  })
export type RolloutTransition = z.infer<typeof RolloutTransition>

export const RolloutJournalActionKind = z.enum(["register_candidate", "record_local_repeat", "record_rollback"])
export type RolloutJournalActionKind = z.infer<typeof RolloutJournalActionKind>

export const RolloutTransitionJournalEntry = z
  .object({
    id: Identifier,
    kind: z.literal("transition"),
    idempotencyKey: Identifier,
    payloadSha256: Sha256,
    resultRefId: Identifier,
    createdAt: Timestamp,
  })
  .strict()
export type RolloutTransitionJournalEntry = z.infer<typeof RolloutTransitionJournalEntry>

export const RolloutActionJournalEntry = z
  .object({
    id: Identifier,
    kind: z.literal("action"),
    actionKind: RolloutJournalActionKind,
    idempotencyKey: Identifier,
    payloadSha256: Sha256,
    resultRefId: Identifier,
    createdAt: Timestamp,
  })
  .strict()
export type RolloutActionJournalEntry = z.infer<typeof RolloutActionJournalEntry>

export const RolloutJournalEntry = z.discriminatedUnion("kind", [
  RolloutTransitionJournalEntry,
  RolloutActionJournalEntry,
])
export type RolloutJournalEntry = z.infer<typeof RolloutJournalEntry>

export const RolloutJournal = z
  .object({
    items: z.array(RolloutJournalEntry).max(500),
  })
  .strict()
export type RolloutJournal = z.infer<typeof RolloutJournal>

export const RolloutTransitionResult = z
  .object({
    state: RolloutState,
    transition: RolloutTransition,
    journal: RolloutTransitionJournalEntry,
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.journal.resultRefId !== value.transition.id)
      context.addIssue({
        code: "custom",
        path: ["journal", "resultRefId"],
        message: "rollout transition journal must reference its transition",
      })
    if (
      value.state.phase !== value.transition.to ||
      value.state.version !== value.transition.version ||
      value.state.lastTransitionId !== value.transition.id
    )
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "rollout transition result state is inconsistent",
      })
    if (value.state.updatedAt !== value.transition.createdAt || value.journal.createdAt !== value.transition.createdAt)
      context.addIssue({
        code: "custom",
        path: ["state", "updatedAt"],
        message: "rollout transition timestamps are inconsistent",
      })
  })
export type RolloutTransitionResult = z.infer<typeof RolloutTransitionResult>

const CandidateRegistrationInput = z
  .object({
    id: Identifier,
    candidateSha: CommitSha,
    targetRef: ShortText,
  })
  .strict()

export const RolloutCandidateFact = CandidateRegistrationInput.extend({
  registeredAt: Timestamp,
}).strict()
export type RolloutCandidateFact = z.infer<typeof RolloutCandidateFact>

export const RolloutLocalRepeatOutcome = z.enum(["completed", "failed", "blocked", "invalid"])
export type RolloutLocalRepeatOutcome = z.infer<typeof RolloutLocalRepeatOutcome>

const LocalRepeatFactInput = z
  .object({
    id: Identifier,
    candidateId: Identifier,
    runId: Identifier,
    ordinal: z.union([z.literal(1), z.literal(2)]),
    outcome: RolloutLocalRepeatOutcome,
    environmentSha256: Sha256,
    evidenceSha256: Sha256,
    normalizedResultSha256: Sha256.optional(),
    startedAt: Timestamp,
    finishedAt: Timestamp,
  })
  .strict()

export const RolloutLocalRepeatFact = LocalRepeatFactInput.extend({
  recordedAt: Timestamp,
})
  .strict()
  .superRefine((value, context) => {
    if (value.finishedAt < value.startedAt)
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "finishedAt must be greater than or equal to startedAt",
      })
    if (value.outcome === "completed" && !value.normalizedResultSha256)
      context.addIssue({
        code: "custom",
        path: ["normalizedResultSha256"],
        message: "completed local repeats require a normalized result digest",
      })
  })
export type RolloutLocalRepeatFact = z.infer<typeof RolloutLocalRepeatFact>

export const RolloutRollbackTarget = z.enum(["kill_switch", "legacy_fallback"])
export type RolloutRollbackTarget = z.infer<typeof RolloutRollbackTarget>

export const RolloutRollbackOutcome = z.enum(["completed", "failed", "blocked", "invalid"])
export type RolloutRollbackOutcome = z.infer<typeof RolloutRollbackOutcome>

const RollbackFactInput = z
  .object({
    id: Identifier,
    candidateId: Identifier.optional(),
    projectId: Identifier.optional(),
    target: RolloutRollbackTarget,
    phaseAtAction: RolloutPhase,
    executionModeAfter: SeedGrowExecutionMode,
    outcome: RolloutRollbackOutcome,
    evidenceSha256: Sha256,
    observedAt: Timestamp,
  })
  .strict()

export const RolloutRollbackFact = RollbackFactInput.extend({
  recordedAt: Timestamp,
})
  .strict()
  .superRefine((value, context) => {
    if (value.target === "kill_switch" && value.executionModeAfter !== "off")
      context.addIssue({
        code: "custom",
        path: ["executionModeAfter"],
        message: "kill switch rollback facts must observe off execution mode",
      })
  })
export type RolloutRollbackFact = z.infer<typeof RolloutRollbackFact>

export const RolloutActionRequest = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("register_candidate"),
        idempotencyKey: Identifier,
        candidate: CandidateRegistrationInput,
      })
      .strict(),
    z
      .object({
        kind: z.literal("record_local_repeat"),
        idempotencyKey: Identifier,
        repeat: LocalRepeatFactInput,
      })
      .strict(),
    z
      .object({
        kind: z.literal("record_rollback"),
        idempotencyKey: Identifier,
        rollback: RollbackFactInput,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind === "record_local_repeat" && value.repeat.finishedAt < value.repeat.startedAt)
      context.addIssue({
        code: "custom",
        path: ["repeat", "finishedAt"],
        message: "finishedAt must be greater than or equal to startedAt",
      })
    if (
      value.kind === "record_local_repeat" &&
      value.repeat.outcome === "completed" &&
      !value.repeat.normalizedResultSha256
    )
      context.addIssue({
        code: "custom",
        path: ["repeat", "normalizedResultSha256"],
        message: "completed local repeats require a normalized result digest",
      })
    if (
      value.kind === "record_rollback" &&
      value.rollback.target === "kill_switch" &&
      value.rollback.executionModeAfter !== "off"
    )
      context.addIssue({
        code: "custom",
        path: ["rollback", "executionModeAfter"],
        message: "kill switch rollback facts must observe off execution mode",
      })
  })
export type RolloutActionRequest = z.infer<typeof RolloutActionRequest>

export const RolloutActionResult = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("register_candidate"),
        candidate: RolloutCandidateFact,
        journal: RolloutActionJournalEntry.extend({ actionKind: z.literal("register_candidate") }),
        replayed: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("record_local_repeat"),
        repeat: RolloutLocalRepeatFact,
        journal: RolloutActionJournalEntry.extend({ actionKind: z.literal("record_local_repeat") }),
        replayed: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("record_rollback"),
        rollback: RolloutRollbackFact,
        journal: RolloutActionJournalEntry.extend({ actionKind: z.literal("record_rollback") }),
        replayed: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const resultRefId =
      value.kind === "register_candidate"
        ? value.candidate.id
        : value.kind === "record_local_repeat"
          ? value.repeat.id
          : value.rollback.id
    const recordedAt =
      value.kind === "register_candidate"
        ? value.candidate.registeredAt
        : value.kind === "record_local_repeat"
          ? value.repeat.recordedAt
          : value.rollback.recordedAt
    if (value.journal.resultRefId !== resultRefId)
      context.addIssue({
        code: "custom",
        path: ["journal", "resultRefId"],
        message: "rollout action journal must reference its fact",
      })
    if (value.journal.createdAt !== recordedAt)
      context.addIssue({
        code: "custom",
        path: ["journal", "createdAt"],
        message: "rollout action timestamps are inconsistent",
      })
  })
export type RolloutActionResult = z.infer<typeof RolloutActionResult>

export const RolloutShadowEvaluationKind = z.enum(["seed_policy", "supervisor"])
export type RolloutShadowEvaluationKind = z.infer<typeof RolloutShadowEvaluationKind>

export const RolloutShadowEvaluation = z
  .object({
    id: Identifier,
    projectId: Identifier,
    sourceKey: Identifier,
    kind: RolloutShadowEvaluationKind,
    receiptId: Identifier.optional(),
    snapshotSha256: Sha256,
    inputSha256: Sha256,
    outputSha256: Sha256,
    businessStateBeforeSha256: Sha256,
    businessStateAfterSha256: Sha256,
    input: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()),
    status: z.enum(["evaluated", "validated", "rejected"]),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "supervisor") !== Boolean(value.receiptId))
      context.addIssue({
        code: "custom",
        path: ["receiptId"],
        message: "supervisor shadow evaluations require a receipt and seed policy evaluations cannot bind one",
      })
    if (value.businessStateBeforeSha256 !== value.businessStateAfterSha256)
      context.addIssue({
        code: "custom",
        path: ["businessStateAfterSha256"],
        message: "shadow evaluation cannot change business state",
      })
  })
export type RolloutShadowEvaluation = z.infer<typeof RolloutShadowEvaluation>

export const RolloutPromotionAncestry = z
  .object({
    previousCandidateSha: CommitSha,
    currentCandidateSha: CommitSha,
    parentSha: CommitSha,
    targetRef: ShortText,
    verified: z.boolean(),
    commandEvidenceSha256: Sha256,
  })
  .strict()
export type RolloutPromotionAncestry = z.infer<typeof RolloutPromotionAncestry>

export const RolloutPromotionEvaluationRequest = z
  .object({
    id: Identifier,
    candidateIds: z.tuple([Identifier, Identifier]),
    metricContract: MetricContract,
    metricContractSha256: Sha256,
    metricReports: z.tuple([MetricEvaluationReport, MetricEvaluationReport]),
    shadowReports: z.tuple([ShadowComparisonReport, ShadowComparisonReport]),
    ancestry: RolloutPromotionAncestry,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.candidateIds[0] === value.candidateIds[1])
      context.addIssue({ code: "custom", path: ["candidateIds"], message: "promotion candidates must be distinct" })
  })
export type RolloutPromotionEvaluationRequest = z.infer<typeof RolloutPromotionEvaluationRequest>

export const RolloutPromotionDerivedMetricResult = z
  .object({
    metricId: z.literal("consecutive_reproducible_candidate_count"),
    blocking: z.literal(true),
    status: z.enum(["pass", "failed", "blocked"]),
    value: z.number().int().min(0).max(2),
    numerator: z.number().int().min(0).max(2),
    denominator: z.literal(2),
    sampleSize: z.number().int().min(0).max(4),
    meetsThreshold: z.boolean(),
    threshold: z
      .object({
        gate: z.literal("R4"),
        operator: z.literal(">="),
        value: z.literal(2),
      })
      .strict(),
    reasons: z.array(z.string().trim().min(1).max(500)).max(100),
    sourceRefs: z.array(MetricSourceRef.extend({ kind: z.literal("gate_report") })).max(4),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.numerator !== value.value || value.sampleSize !== value.sourceRefs.length)
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "derived promotion metric counts must match their sources",
      })
    const passing =
      value.value === 2 &&
      value.meetsThreshold &&
      value.reasons.length === 0 &&
      value.sourceRefs.length === 4 &&
      new Set(value.sourceRefs.map((source) => source.id)).size === 4 &&
      new Set(value.sourceRefs.map((source) => source.runId)).size === 4 &&
      new Set(value.sourceRefs.map((source) => source.digest)).size === 4
    if ((value.status === "pass") !== passing)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "derived promotion metric status must match its trusted sources",
      })
    if (value.status !== "pass" && !value.reasons.length)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "non-passing derived promotion metrics require reasons",
      })
  })
export type RolloutPromotionDerivedMetricResult = z.infer<typeof RolloutPromotionDerivedMetricResult>

const RolloutPromotionDecisionCore = z
  .object({
    id: Identifier,
    targetPhase: z.literal("pre_public_default"),
    candidateIds: z.tuple([Identifier, Identifier]),
    candidateShas: z.tuple([CommitSha, CommitSha]),
    repeatIds: z.array(Identifier).max(4),
    rollbackIds: z.array(Identifier).max(2),
    metricContractSha256: Sha256,
    metricReportSha256s: z.tuple([Sha256, Sha256]),
    shadowReportSha256s: z.tuple([Sha256, Sha256]),
    ancestry: RolloutPromotionAncestry,
    inputSha256: Sha256,
    status: z.enum(["pass", "failed", "blocked"]),
    reasons: z.array(z.string().trim().min(1).max(500)).max(500),
    createdAt: Timestamp,
  })
  .strict()

function refinePromotionDecision(value: z.infer<typeof RolloutPromotionDecisionCore>, context: z.RefinementCtx) {
  if ((value.status === "pass") !== (value.reasons.length === 0))
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "passing promotion decisions cannot contain reasons and non-passing decisions require them",
    })
  if (value.status === "pass" && (value.repeatIds.length !== 4 || value.rollbackIds.length < 2))
    context.addIssue({
      code: "custom",
      path: ["repeatIds"],
      message: "passing promotion decisions require four repeats and both rollback targets",
    })
  if (
    value.ancestry.previousCandidateSha !== value.candidateShas[0] ||
    value.ancestry.currentCandidateSha !== value.candidateShas[1]
  )
    context.addIssue({
      code: "custom",
      path: ["ancestry"],
      message: "promotion ancestry must bind the evaluated candidates",
    })
}

export const RolloutLegacyPromotionDecision = RolloutPromotionDecisionCore.superRefine(refinePromotionDecision)
export type RolloutLegacyPromotionDecision = z.infer<typeof RolloutLegacyPromotionDecision>

export const RolloutPromotionDecision = RolloutPromotionDecisionCore.extend({
  derivedMetricResult: RolloutPromotionDerivedMetricResult,
})
  .strict()
  .superRefine((value, context) => {
    refinePromotionDecision(value, context)
    if (value.status === "pass" && value.derivedMetricResult.status !== "pass")
      context.addIssue({
        code: "custom",
        path: ["derivedMetricResult"],
        message: "passing promotion decisions require a passing trusted derived metric",
      })
    if (
      value.derivedMetricResult.sourceRefs.some(
        (source) => !value.repeatIds.includes(source.id) || !value.candidateShas.includes(source.candidateSha),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["derivedMetricResult", "sourceRefs"],
        message: "derived promotion metric sources must bind the decision repeats and candidates",
      })
  })
export type RolloutPromotionDecision = z.infer<typeof RolloutPromotionDecision>

export const RolloutEvidence = z
  .object({
    candidates: z.array(RolloutCandidateFact).max(500),
    localRepeats: z.array(RolloutLocalRepeatFact).max(500),
    rollbacks: z.array(RolloutRollbackFact).max(500),
    shadowEvaluations: z.array(RolloutShadowEvaluation).max(10_000),
    promotionDecisions: z.array(RolloutPromotionDecision).max(500),
  })
  .strict()
export type RolloutEvidence = z.infer<typeof RolloutEvidence>

export const RolloutApiError = z
  .object({
    code: z.enum([
      "idempotency_collision",
      "invalid_transition",
      "running_projects",
      "entity_conflict",
      "missing_candidate",
      "promotion_gate_required",
      "invalid_persisted_fact",
    ]),
    message: LongText,
  })
  .strict()
export type RolloutApiError = z.infer<typeof RolloutApiError>
