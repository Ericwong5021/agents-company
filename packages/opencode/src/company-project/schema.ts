import z from "zod"

export const ProjectStatus = z.enum([
  "intake",
  "researching",
  "awaiting_project_approval",
  "planning",
  "awaiting_development_approval",
  "developing",
  "verifying",
  "completed",
  "rejected",
  "blocked",
])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const WorkItemStatus = z.enum(["pending", "running", "blocked", "failed", "completed", "cancelled"])
export type WorkItemStatus = z.infer<typeof WorkItemStatus>

export const GateKind = z.enum(["project_approval", "development_approval"])
export type GateKind = z.infer<typeof GateKind>

export const GateStatus = z.enum(["pending", "approved", "rejected"])
export type GateStatus = z.infer<typeof GateStatus>

export const PlanPhase = z.enum(["research", "development", "replan"])
export type PlanPhase = z.infer<typeof PlanPhase>

export const Project = z.object({
  id: z.string(),
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
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().optional(),
})
export type Project = z.infer<typeof Project>

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
  parent_id: z.string().optional(),
  title: z.string(),
  description: z.string(),
  kind: z.string(),
  status: WorkItemStatus,
  owner_agent_id: z.string().optional(),
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

export const ApprovalGate = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: GateKind,
  status: GateStatus,
  title: z.string(),
  summary: z.string(),
  requested_by_agent_id: z.string().optional(),
  decision_note: z.string().optional(),
  requested_at: z.number(),
  decided_at: z.number().optional(),
})
export type ApprovalGate = z.infer<typeof ApprovalGate>
