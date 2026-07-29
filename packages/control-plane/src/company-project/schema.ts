import z from "zod"
import { NamedError } from "@agents-company/shared/util/error"

export const ProjectStatus = z.enum([
  "intake",
  "planning",
  "executing",
  "reviewing",
  "awaiting_approval",
  "completed",
  "rejected",
  "blocked",
])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const WorkItemStatus = z.enum([
  "pending",
  "running",
  "blocked",
  "failed",
  "completed",
  "superseded",
  "cancelled",
])
export type WorkItemStatus = z.infer<typeof WorkItemStatus>

export const DeliveryPolicy = z
  .object({
    source_approval_preset: z.string().min(1),
    allow_workspace_write: z.boolean(),
    require_high_risk_approval: z.boolean(),
    require_human_merge: z.boolean(),
    require_clean_worktree: z.boolean(),
    require_main_branch_verification: z.boolean(),
  })
  .strict()
export type DeliveryPolicy = z.infer<typeof DeliveryPolicy>

export const GateKind = z.enum(["risk_approval", "merge_approval"])
export type GateKind = z.infer<typeof GateKind>

export const GateStatus = z.enum(["pending", "approved", "rejected"])
export type GateStatus = z.infer<typeof GateStatus>

export const PlanPhase = z.enum(["planning", "execution", "replan"])
export type PlanPhase = z.infer<typeof PlanPhase>

export const Project = z.object({
  id: z.string(),
  company_id: z.string().optional(),
  root_need_id: z.string().optional(),
  source_thread_id: z.string().optional(),
  decision_request_id: z.string().uuid().optional(),
  goal: z.string(),
  title: z.string(),
  status: ProjectStatus,
  owner_agent_id: z.string().optional(),
  coordinator_session_id: z.string().optional(),
  provider_id: z.string().optional(),
  model_id: z.string().optional(),
  active_run_id: z.string().optional(),
  output_dir: z.string(),
  active_plan_version: z.number().int().optional(),
  graph_revision: z.number().int().nonnegative(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().optional(),
})
export type Project = z.infer<typeof Project>

export const CharterRisk = z
  .object({
    description: z.string().trim().min(1),
    mitigation: z.string().trim().min(1),
  })
  .strict()
export type CharterRisk = z.infer<typeof CharterRisk>

export const CharterResource = z
  .object({
    kind: z.enum(["file", "application", "web", "data", "repository", "other"]),
    scope: z.string().trim().min(1),
    disposition: z.string().trim().min(1),
  })
  .strict()
export type CharterResource = z.infer<typeof CharterResource>

export const BoardProjectCharter = z
  .object({
    title: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1),
    deliverables: z.array(z.string().trim().min(1)).min(1),
    acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
    scope: z.array(z.string().trim().min(1)).min(1),
    non_goals: z.array(z.string().trim().min(1)).min(1),
    constraints: z.array(z.string().trim().min(1)).min(1),
    resources: z.array(CharterResource).min(1),
    risks: z.array(CharterRisk),
    dri_agent_id: z.string().trim().min(1),
    milestones: z.array(z.string().trim().min(1)).min(1),
    open_decisions: z.array(z.string().trim().min(1)).max(0),
  })
  .strict()
export type BoardProjectCharter = z.infer<typeof BoardProjectCharter>

export const BoardProjectDecisionNotReady = NamedError.create(
  "BoardProjectDecisionNotReady",
  z
    .object({
      thread_id: z.string().min(1),
      reason: z.enum(["not_board_thread", "run_not_completed", "dri_not_board_member", "open_decisions"]),
    })
    .strict(),
)

export const BoardProjectDecisionConflict = NamedError.create(
  "BoardProjectDecisionConflict",
  z.object({ thread_id: z.string().min(1), request_id: z.string().uuid() }).strict(),
)

export const ProjectCharter = BoardProjectCharter.extend({
  project_id: z.string(),
  success_criteria: z.array(z.string()),
  policy: DeliveryPolicy,
  created_at: z.number(),
  updated_at: z.number(),
})
export type ProjectCharter = z.infer<typeof ProjectCharter>

export const Plan = z.object({
  id: z.string(),
  project_id: z.string(),
  version: z.number().int(),
  phase: PlanPhase,
  status: z.enum(["active", "superseded", "completed"]),
  summary: z.string(),
  assumptions: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  change_reason: z.string().optional(),
  created_at: z.number(),
})
export type Plan = z.infer<typeof Plan>

export const WorkItem = z.object({
  id: z.string(),
  project_id: z.string(),
  plan_id: z.string(),
  source_task_key: z.string().optional(),
  parent_id: z.string().optional(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["planner", "worker", "reviewer"]),
  work_type: z.enum(["coding", "decision", "research", "writing", "design", "analysis"]),
  role: z.string(),
  capability_packs: z.array(z.string()),
  decision_scope: z.array(z.string()),
  resource_scope: z.array(z.string()),
  inputs: z.array(z.string()),
  expected_outputs: z.array(z.string()),
  validators: z.array(z.string()),
  disposition: z.string(),
  depends_on: z.array(z.string()),
  model_group: z.enum(["ultra", "standard", "lite"]),
  risk_level: z.enum(["low", "medium", "high"]),
  review_status: z.enum(["pending", "running", "accepted", "rejected", "not_required"]),
  status: WorkItemStatus,
  purpose: z.enum(["discovery", "first_slice", "delivery", "verification", "recovery", "closeout"]),
  origin_kind: z.enum(["legacy", "seed", "receipt", "graph_mutation", "user"]),
  origin_ref_id: z.string().optional(),
  graph_revision_created: z.number().int().nonnegative(),
  validation_mode: z.enum(["self_check", "machine", "independent_review", "review_and_user_gate"]),
  superseded_by_id: z.string().optional(),
  owner_agent_id: z.string().optional(),
  workflow_run_id: z.string().optional(),
  acceptance_criteria: z.array(z.string()),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  error: z.string().optional(),
  started_at: z.number().optional(),
  completed_at: z.number().optional(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type WorkItem = z.infer<typeof WorkItem>

export const WorktreeRunStatus = z.enum([
  "preparing",
  "ready",
  "running",
  "verifying",
  "awaiting_merge_approval",
  "approved",
  "review_rejected",
  "merged",
  "failed",
  "cancelled",
  "recovery_needed",
])
export type WorktreeRunStatus = z.infer<typeof WorktreeRunStatus>

export const WorktreeRun = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string().optional(),
  agent_run_id: z.string().optional(),
  status: WorktreeRunStatus,
  repository_path: z.string(),
  directory: z.string(),
  branch: z.string(),
  base_commit: z.string(),
  head_commit: z.string().optional(),
  verification_commands: z.array(z.string()),
  verification: z.record(z.string(), z.unknown()),
  review: z.record(z.string(), z.unknown()),
  merge_gate_id: z.string().optional(),
  error: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  merged_at: z.number().optional(),
})
export type WorktreeRun = z.infer<typeof WorktreeRun>

export const Artifact = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string().optional(),
  kind: z.string(),
  title: z.string(),
  path: z.string().optional(),
  content: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()),
  created_by_agent_id: z.string().optional(),
  created_at: z.number(),
})
export type Artifact = z.infer<typeof Artifact>

export const WorkAttemptStatus = z.enum(["running", "completed", "failed", "stopped"])
export type WorkAttemptStatus = z.infer<typeof WorkAttemptStatus>

export const WorkAttemptFailureKind = z.enum([
  "implementation",
  "environment",
  "missing_prerequisite",
  "dependency",
  "permission",
  "validator",
  "scope",
  "unknown",
])
export type WorkAttemptFailureKind = z.infer<typeof WorkAttemptFailureKind>

export const WorkAttempt = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  agent_run_id: z.string().optional(),
  ordinal: z.number().int().positive(),
  status: WorkAttemptStatus,
  failure_kind: WorkAttemptFailureKind.optional(),
  safe_summary: z.string().optional(),
  started_at: z.number(),
  finished_at: z.number().optional(),
})
export type WorkAttempt = z.infer<typeof WorkAttempt>

export const WorkReceiptOutcome = z.enum(["completed", "blocked", "failed", "ask"])
export type WorkReceiptOutcome = z.infer<typeof WorkReceiptOutcome>

export const WorkReceiptProcessingStatus = z.enum(["pending", "processing", "processed", "rejected"])
export type WorkReceiptProcessingStatus = z.infer<typeof WorkReceiptProcessingStatus>

export const WorkReceiptEvidenceRef = z
  .object({
    kind: z.enum(["agent_run", "artifact", "project_event"]),
    id: z.string().trim().min(1),
  })
  .strict()
export type WorkReceiptEvidenceRef = z.infer<typeof WorkReceiptEvidenceRef>

export const WorkReceiptSubmission = z
  .object({
    idempotency_key: z.string().trim().min(1).max(500),
    outcome: WorkReceiptOutcome,
    summary: z.string().trim().min(1).max(8_000),
    artifact_ids: z.array(z.string().trim().min(1)).max(500),
    evidence_refs: z.array(WorkReceiptEvidenceRef).max(1_000),
    confirmed_facts: z.array(z.string().trim().min(1)).max(500),
    invalidated_assumptions: z.array(z.string().trim().min(1)).max(500),
    unknowns: z.array(z.string().trim().min(1)).max(500),
    blockers: z.array(z.string().trim().min(1)).max(500),
    capability_gaps: z.array(z.string().trim().min(1)).max(500),
    task_proposals: z.array(z.record(z.string(), z.unknown())).max(500),
    dependency_proposals: z.array(z.record(z.string(), z.unknown())).max(500),
    questions: z.array(z.string().trim().min(1)).max(500),
  })
  .strict()
export type WorkReceiptSubmission = z.infer<typeof WorkReceiptSubmission>

export const WorkReceipt = WorkReceiptSubmission.extend({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  attempt_id: z.string(),
  processing_status: WorkReceiptProcessingStatus,
  processed_mutation_id: z.string().optional(),
  created_at: z.number(),
  processed_at: z.number().optional(),
})
export type WorkReceipt = z.infer<typeof WorkReceipt>

export const GraphMutationDecision = z.enum([
  "accept",
  "retry",
  "expand",
  "rewire",
  "supersede",
  "request_capability",
  "request_attention",
  "quiesce",
])
export type GraphMutationDecision = z.infer<typeof GraphMutationDecision>

export const GraphMutationStatus = z.enum(["proposed", "validated", "applied", "rejected", "superseded"])
export type GraphMutationStatus = z.infer<typeof GraphMutationStatus>

export const NewGraphWorkItem = z
  .object({
    id: z.string().trim().min(1).max(200),
    plan_id: z.string().trim().min(1),
    parent_id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(8_000),
    kind: z.enum(["planner", "worker", "reviewer"]),
    work_type: z.enum(["coding", "decision", "research", "writing", "design", "analysis"]),
    role: z.string().trim().min(1).max(200),
    capability_packs: z.array(z.string().trim().min(1)).max(200),
    decision_scope: z.array(z.string().trim().min(1)).max(500),
    resource_scope: z.array(z.string().trim().min(1)).max(500),
    inputs: z.array(z.string().trim().min(1)).max(500),
    expected_outputs: z.array(z.string().trim().min(1)).max(500),
    validators: z.array(z.string().trim().min(1)).min(1).max(500),
    disposition: z.string().trim().min(1).max(200),
    model_group: z.enum(["ultra", "standard", "lite"]),
    risk_level: z.enum(["low", "medium", "high"]),
    review_status: z.enum(["pending", "not_required"]),
    owner_agent_id: z.string().trim().min(1).optional(),
    acceptance_criteria: z.array(z.string().trim().min(1)).min(1).max(500),
    max_attempts: z.number().int().positive().max(100),
    purpose: z.enum(["discovery", "first_slice", "delivery", "verification", "recovery", "closeout"]),
    validation_mode: z.enum(["self_check", "machine", "independent_review", "review_and_user_gate"]),
  })
  .strict()
export type NewGraphWorkItem = z.infer<typeof NewGraphWorkItem>

export const GraphValidationGateProposal = z
  .object({
    id: z.string().trim().min(1).max(200),
    work_item_id: z.string().trim().min(1),
    title: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(8_000),
    risk_level: z.enum(["low", "medium", "high"]),
    validation_mode: z.enum(["machine", "independent_review", "review_and_user_gate"]),
  })
  .strict()

export const GraphCapabilityNeedProposal = z
  .object({
    id: z.string().trim().min(1).max(200),
    capability: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(8_000),
    allowed_permission_modes: z.array(z.enum(["read_only", "workspace_write"])).min(1),
    resource_scope: z.array(z.string().trim().min(1)).max(500),
  })
  .strict()

export const GraphAttentionProposal = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(8_000),
    materiality: z.enum(["scope", "permission", "acceptance", "budget", "external_side_effect"]),
    required_decision: z.string().trim().min(1).max(8_000),
  })
  .strict()

export const GraphOperation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_work_item"), item: NewGraphWorkItem }).strict(),
  z
    .object({
      type: z.literal("add_dependency"),
      work_item_id: z.string().trim().min(1),
      depends_on_id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("remove_dependency"),
      work_item_id: z.string().trim().min(1),
      depends_on_id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("supersede_work_item"),
      work_item_id: z.string().trim().min(1),
      replacement_id: z.string().trim().min(1).optional(),
      reason: z.string().trim().min(1).max(8_000),
    })
    .strict(),
  z.object({ type: z.literal("add_validation_gate"), gate: GraphValidationGateProposal }).strict(),
  z.object({ type: z.literal("request_capability"), need: GraphCapabilityNeedProposal }).strict(),
  z.object({ type: z.literal("request_user_decision"), request: GraphAttentionProposal }).strict(),
])
export type GraphOperation = z.infer<typeof GraphOperation>

export const GraphMutationProposal = z
  .object({
    project_id: z.string().trim().min(1),
    trigger_receipt_id: z.string().trim().min(1),
    expected_revision: z.number().int().nonnegative(),
    orchestrator_version: z.number().int().positive(),
    idempotency_key: z.string().trim().min(1).max(500),
    decision: GraphMutationDecision,
    rationale: z.string().trim().min(1).max(8_000),
    evidence_refs: z.array(WorkReceiptEvidenceRef).max(1_000),
    operations: z.array(GraphOperation).max(500),
  })
  .strict()
export type GraphMutationProposal = z.infer<typeof GraphMutationProposal>

export const GraphPolicyViolation = z.enum([
  "cycle",
  "self_dependency",
  "missing_node",
  "immutable_fact",
  "scope_escalation",
  "high_risk_gate_required",
  "self_review",
  "running_dependency_change",
  "evidence_required",
  "decision_operation_mismatch",
  "invalid_plan",
  "invalid_replacement",
  "duplicate_new_node",
  "dependency_exists",
  "dependency_missing",
])
export type GraphPolicyViolation = z.infer<typeof GraphPolicyViolation>

export const GraphPolicyVerdict = z
  .object({
    result: z.enum(["allowed", "rejected"]),
    violations: z.array(GraphPolicyViolation),
  })
  .strict()
export type GraphPolicyVerdict = z.infer<typeof GraphPolicyVerdict>

export const GraphMutation = GraphMutationProposal.extend({
  id: z.string(),
  applied_revision: z.number().int().nonnegative().optional(),
  status: GraphMutationStatus,
  policy_verdict: GraphPolicyVerdict,
  created_at: z.number(),
  applied_at: z.number().optional(),
})
export type GraphMutation = z.infer<typeof GraphMutation>

export const GraphSnapshotNode = z
  .object({
    id: z.string(),
    plan_id: z.string(),
    parent_id: z.string().optional(),
    kind: z.enum(["planner", "worker", "reviewer"]),
    status: WorkItemStatus,
    owner_agent_id: z.string().optional(),
    decision_scope: z.array(z.string()),
    resource_scope: z.array(z.string()),
    acceptance_criteria: z.array(z.string()),
    risk_level: z.enum(["low", "medium", "high"]),
    purpose: z.enum(["discovery", "first_slice", "delivery", "verification", "recovery", "closeout"]),
    validation_mode: z.enum(["self_check", "machine", "independent_review", "review_and_user_gate"]),
    superseded_by_id: z.string().optional(),
  })
  .strict()

export const GraphSnapshot = z
  .object({
    project_id: z.string(),
    revision: z.number().int().nonnegative(),
    nodes: z.array(GraphSnapshotNode),
    dependencies: z.array(
      z
        .object({
          work_item_id: z.string(),
          depends_on_id: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
export type GraphSnapshot = z.infer<typeof GraphSnapshot>

export const ProjectEvent = z.object({
  id: z.string(),
  project_id: z.string(),
  type: z.string(),
  actor_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.number(),
})
export type ProjectEvent = z.infer<typeof ProjectEvent>

export const ApprovalGate = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: GateKind,
  status: GateStatus,
  title: z.string(),
  summary: z.string(),
  requested_by_agent_id: z.string().optional(),
  worktree_run_id: z.string().optional(),
  decision_note: z.string().optional(),
  requested_at: z.number(),
  decided_at: z.number().optional(),
})
export type ApprovalGate = z.infer<typeof ApprovalGate>
