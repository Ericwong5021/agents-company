import { DecisionIntent } from "@agents-company/shared/founder-os"
import z from "zod"

const Identifier = z.string().trim().min(1).max(500)
const LongText = z.string().trim().min(1).max(24_000)

export const BeliefStatus = z.enum([
  "candidate",
  "contested",
  "experiment_pending",
  "validated",
  "adopted",
  "rejected",
  "deprecated",
])
export type BeliefStatus = z.infer<typeof BeliefStatus>

export const BeliefInterpretationPosition = z.enum(["supporting", "counter", "context"])
export type BeliefInterpretationPosition = z.infer<typeof BeliefInterpretationPosition>

export const BeliefInterpretationRef = z.object({
  interpretation_id: Identifier,
  position: BeliefInterpretationPosition,
}).strict()
export type BeliefInterpretationRef = z.infer<typeof BeliefInterpretationRef>

export const BeliefEvidence = z.object({
  id: Identifier,
  belief_id: Identifier,
  position: z.enum(["supporting", "counter"]),
  source_kind: z.enum(["interpretation", "outcome_signal", "artifact", "decision", "external"]),
  source_ref: Identifier,
  summary: LongText,
  created_by: Identifier,
  created_at: z.number().int().nonnegative(),
}).strict()
export type BeliefEvidence = z.infer<typeof BeliefEvidence>

export const Belief = z.object({
  id: Identifier,
  company_id: Identifier,
  source_id: Identifier,
  statement: LongText,
  scope: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  applicable_scopes: z.array(z.string().trim().min(1).max(500)).max(100),
  inapplicable_scopes: z.array(z.string().trim().min(1).max(500)).max(100),
  confidence: z.number().min(0).max(1),
  status: BeliefStatus,
  action_implications: z.array(LongText).max(100),
  interpretation_refs: z.array(BeliefInterpretationRef).min(2).max(100),
  evidence: z.array(BeliefEvidence).max(1_000),
  experiment_ids: z.array(Identifier).max(500),
  created_by: Identifier,
  approved_by: Identifier.nullable(),
  board_decision_id: Identifier.nullable(),
  review_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  approved_at: z.number().int().nonnegative().nullable(),
  updated_at: z.number().int().nonnegative(),
}).strict()
export type Belief = z.infer<typeof Belief>

export const BeliefCandidateInput = z.object({
  company_id: Identifier,
  source_id: Identifier,
  statement: LongText,
  scope: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  applicable_scopes: z.array(z.string().trim().min(1).max(500)).max(100),
  inapplicable_scopes: z.array(z.string().trim().min(1).max(500)).max(100),
  confidence: z.number().min(0).max(1),
  action_implications: z.array(LongText).max(100),
  interpretation_refs: z.array(BeliefInterpretationRef).min(2).max(100),
  created_by: Identifier,
  review_at: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if (!value.interpretation_refs.some((item) => item.position === "supporting"))
    context.addIssue({ code: "custom", path: ["interpretation_refs"], message: "Candidate Belief requires supporting Interpretation" })
  if (!value.interpretation_refs.some((item) => item.position === "counter"))
    context.addIssue({ code: "custom", path: ["interpretation_refs"], message: "Candidate Belief requires counter Interpretation" })
  if (new Set(value.interpretation_refs.map((item) => item.interpretation_id)).size !== value.interpretation_refs.length)
    context.addIssue({ code: "custom", path: ["interpretation_refs"], message: "Interpretation references must be unique" })
})
export type BeliefCandidateInput = z.infer<typeof BeliefCandidateInput>

export const BeliefEvidenceAppendInput = z.object({
  position: z.enum(["supporting", "counter"]),
  source_kind: z.enum(["interpretation", "outcome_signal", "artifact", "decision", "external"]),
  source_ref: Identifier,
  summary: LongText,
  created_by: Identifier,
}).strict()
export type BeliefEvidenceAppendInput = z.infer<typeof BeliefEvidenceAppendInput>

export const BeliefComparison = z.object({
  source_id: Identifier,
  interpretation_refs: z.array(BeliefInterpretationRef).min(2),
  supporting_count: z.number().int().nonnegative(),
  counter_count: z.number().int().nonnegative(),
  context_count: z.number().int().nonnegative(),
  candidate_only: z.literal(true),
  adoption_requires_board_decision: z.literal(true),
  automatic_verdict: z.literal(null),
}).strict()
export type BeliefComparison = z.infer<typeof BeliefComparison>

export const BeliefAdoptionInput = z.object({
  board_decision_id: Identifier,
  approved_by: Identifier,
}).strict()
export type BeliefAdoptionInput = z.infer<typeof BeliefAdoptionInput>

export const ExperimentStatus = z.enum(["proposed", "authorized", "running", "completed", "evaluated", "rejected", "stopped"])
export const ExperimentVerdict = z.enum(["pending", "supported", "refuted", "inconclusive"])

export const Experiment = z.object({
  id: Identifier,
  company_id: Identifier,
  belief_id: Identifier,
  project_id: Identifier,
  decision_id: Identifier,
  decision_intent: DecisionIntent,
  hypothesis: LongText,
  success_criteria: z.array(LongText).min(1).max(100),
  failure_criteria: z.array(LongText).min(1).max(100),
  rollback_plan: LongText,
  status: ExperimentStatus,
  verdict: ExperimentVerdict,
  authority_class: z.enum(["green", "yellow", "red"]),
  approval_gate_id: Identifier.nullable(),
  outcome_signal_ids: z.array(Identifier).max(500),
  proposed_by: Identifier,
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  completed_at: z.number().int().nonnegative().nullable(),
  evaluated_at: z.number().int().nonnegative().nullable(),
}).strict()
export type Experiment = z.infer<typeof Experiment>

export const ExperimentProposalInput = z.object({
  company_id: Identifier,
  belief_id: Identifier,
  project_id: Identifier,
  decision_intent: DecisionIntent,
  hypothesis: LongText,
  success_criteria: z.array(LongText).min(1).max(100),
  failure_criteria: z.array(LongText).min(1).max(100),
  rollback_plan: LongText,
  proposed_by: Identifier,
  idempotency_key: Identifier,
}).strict()
export type ExperimentProposalInput = z.infer<typeof ExperimentProposalInput>

export const ExperimentActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh_authority"), actor_id: Identifier, idempotency_key: Identifier }).strict(),
  z.object({ action: z.literal("start"), actor_id: Identifier }).strict(),
  z.object({ action: z.literal("complete"), actor_id: Identifier }).strict(),
  z.object({ action: z.literal("stop"), actor_id: Identifier }).strict(),
  z.object({ action: z.literal("attach_outcome"), outcome_signal_id: Identifier, actor_id: Identifier }).strict(),
])
export type ExperimentActionInput = z.infer<typeof ExperimentActionInput>

export const LearningPatchTargetType = z.enum([
  "governance_asset",
  "delegation_policy",
  "skill",
  "benchmark",
  "agent_interest",
  "workflow",
])
export type LearningPatchTargetType = z.infer<typeof LearningPatchTargetType>

export const LearningPatchStatus = z.enum(["proposed", "approved", "canary", "active", "rejected", "rolled_back"])

export const PatchBenchmark = z.object({
  id: Identifier,
  patch_id: Identifier,
  version: z.number().int().positive(),
  holdout_manifest: z.record(z.string(), z.unknown()),
  holdout_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  frozen_at: z.number().int().nonnegative(),
  author_id: Identifier,
  subject_id: Identifier.nullable(),
  reviewer_id: Identifier,
  reviewer_principal_id: Identifier.nullable(),
  report_author_id: Identifier.nullable(),
  result: z.enum(["passed", "failed", "not_confirmed"]),
  evidence_refs: z.array(Identifier).max(500),
  real_sample_count: z.number().int().nonnegative(),
  reviewed_at: z.number().int().nonnegative(),
}).strict()
export type PatchBenchmark = z.infer<typeof PatchBenchmark>

export const PatchCanary = z.object({
  id: Identifier,
  patch_id: Identifier,
  previous_version_ref: Identifier,
  candidate_version_ref: Identifier,
  status: z.enum(["running", "passed", "failed", "rolled_back", "not_confirmed"]),
  metric_evidence_refs: z.array(Identifier).max(500),
  started_at: z.number().int().nonnegative(),
  finished_at: z.number().int().nonnegative().nullable(),
}).strict()
export type PatchCanary = z.infer<typeof PatchCanary>

export const LearningPatch = z.object({
  id: Identifier,
  company_id: Identifier,
  source_decision_id: Identifier,
  source_experiment_id: Identifier,
  source_outcome_id: Identifier,
  target_type: LearningPatchTargetType,
  target_id: Identifier,
  proposed_diff: z.record(z.string(), z.unknown()),
  evidence: z.array(Identifier).min(1).max(500),
  expected_impact: LongText,
  benchmark_plan: LongText,
  rollback_plan: LongText,
  status: LearningPatchStatus,
  authority_class: z.enum(["yellow", "red"]),
  approval_gate_id: Identifier.nullable(),
  created_by: Identifier,
  approved_by: Identifier.nullable(),
  benchmarks: z.array(PatchBenchmark),
  canaries: z.array(PatchCanary),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
}).strict()
export type LearningPatch = z.infer<typeof LearningPatch>

export const ActiveLearningTarget = z.object({
  id: Identifier,
  patch_id: Identifier,
  company_id: Identifier,
  target_type: LearningPatchTargetType,
  target_id: Identifier,
  version: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  previous_version_ref: Identifier.nullable(),
  target_version_ref: Identifier.nullable(),
  status: z.literal("active"),
  created_at: z.number().int().nonnegative(),
}).strict()
export type ActiveLearningTarget = z.infer<typeof ActiveLearningTarget>

export const LearningPatchProposalInput = z.object({
  company_id: Identifier,
  source_decision_id: Identifier,
  source_experiment_id: Identifier,
  source_outcome_id: Identifier,
  target_type: LearningPatchTargetType,
  target_id: Identifier,
  proposed_diff: z.record(z.string(), z.unknown()),
  evidence: z.array(Identifier).min(1).max(500),
  expected_impact: LongText,
  benchmark_plan: LongText,
  rollback_plan: LongText,
  created_by: Identifier,
}).strict()
export type LearningPatchProposalInput = z.infer<typeof LearningPatchProposalInput>

export const LearningPatchActionInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    decision_id: Identifier,
    actor_kind: z.enum(["agent", "human", "system"]),
    actor_id: Identifier,
    idempotency_key: Identifier,
  }).strict(),
  z.object({ action: z.literal("reject"), actor_id: Identifier }).strict(),
  z.object({
    action: z.literal("record_benchmark"),
    holdout_manifest: z.record(z.string(), z.unknown()),
    author_id: Identifier,
    subject_id: Identifier.optional(),
    reviewer_id: Identifier,
    report_author_id: Identifier,
    result: z.enum(["passed", "failed", "not_confirmed"]),
    evidence_refs: z.array(Identifier).max(500),
    real_sample_count: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    action: z.literal("start_canary"),
    previous_version_ref: Identifier,
    candidate_version_ref: Identifier,
    skill_snapshot_id: Identifier.optional(),
    actor_id: Identifier,
  }).strict(),
  z.object({
    action: z.literal("finish_canary"),
    canary_id: Identifier,
    result: z.enum(["passed", "failed", "not_confirmed"]),
    metric_evidence_refs: z.array(Identifier).max(500),
    actor_id: Identifier,
  }).strict(),
  z.object({ action: z.literal("activate"), actor_id: Identifier }).strict(),
  z.object({
    action: z.literal("record_planning_read"),
    project_id: Identifier,
    work_receipt_id: Identifier,
    target_version_id: Identifier,
    actor_id: Identifier,
  }).strict(),
  z.object({ action: z.literal("rollback"), actor_id: Identifier, reason: LongText }).strict(),
])
export type LearningPatchActionInput = z.infer<typeof LearningPatchActionInput>

export const LearningEvidencePackage = z.object({
  schema_version: z.literal(1),
  company_id: Identifier,
  weak_gate: z.enum(["confirmed", "not_confirmed"]),
  generated_at: z.number().int().nonnegative(),
  fixture_success_allowed: z.literal(false),
  requirements: z.array(z.object({
    id: Identifier,
    status: z.enum(["present", "missing", "not_confirmed"]),
    evidence_refs: z.array(Identifier),
  }).strict()),
  complete_real_chain: z.boolean(),
}).strict()
export type LearningEvidencePackage = z.infer<typeof LearningEvidencePackage>
