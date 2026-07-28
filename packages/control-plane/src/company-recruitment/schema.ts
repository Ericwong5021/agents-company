import { NamedError } from "@agents-company/shared/util/error"
import z from "zod"
import { ProjectStatus } from "@/company-project/schema"
import { CompanyID } from "@/company/schema"

export const WorkType = z.enum(["coding", "decision", "research", "writing", "design", "analysis"])
export const RiskLevel = z.enum(["low", "medium", "high"])
export const DemandHorizon = z.enum(["project", "recurring"])
export const AgentLifecycle = z.enum(["candidate", "assigned", "employee", "archived"])

export const CapabilityNeed = z.object({
  id: z.string(),
  company_id: CompanyID,
  project_id: z.string(),
  need_key: z.string(),
  role: z.string(),
  work_type: WorkType,
  capability_packs: z.array(z.string()),
  risk_level: RiskLevel,
  demand_horizon: DemandHorizon,
  department_key: z.string().optional(),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type CapabilityNeed = z.infer<typeof CapabilityNeed>

export const CreateCapabilityNeedInput = z
  .object({
    company_id: CompanyID,
    project_id: z.string().min(1),
    need_key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    role: z.string().trim().min(1).max(160),
    work_type: WorkType,
    capability_packs: z.array(z.string().min(1)).min(1),
    risk_level: RiskLevel.default("medium"),
    demand_horizon: DemandHorizon.default("project"),
    department_key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
  })
  .strict()
export type CreateCapabilityNeedInput = z.infer<typeof CreateCapabilityNeedInput>

export const SelectionScore = z.object({
  capability_match: z.number().int().nonnegative(),
  evidence_strength: z.number().int().min(0).max(100).default(0),
  availability: z.number().int().min(0).max(100),
  historical_quality: z.number().int().min(0).max(100),
  historical_reliability: z.number().int().min(0).max(100),
  cost_efficiency: z.number().int().min(0).max(100),
  speed: z.number().int().min(0).max(100),
  risk_fit: z.number().int().min(0).max(100),
  reuse_value: z.number().int().min(0).max(100),
  total: z.number().int(),
})
export type SelectionScore = z.infer<typeof SelectionScore>

export const TeamSelection = z.object({
  id: z.string(),
  company_id: CompanyID,
  project_id: z.string(),
  capability_need_id: z.string(),
  agent_id: z.string(),
  decision: z.enum(["selected", "rejected"]),
  source: z.enum(["company_pool", "new_candidate"]),
  lifecycle_at_selection: AgentLifecycle,
  // 1 = selected, 2 = runner-up, further ranks follow; 0 = failed a hard constraint
  candidate_rank: z.number().int().nonnegative(),
  reason: z.string(),
  gaps: z.array(z.string()),
  score: SelectionScore,
  time_released: z.number().int().optional(),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type TeamSelection = z.infer<typeof TeamSelection>

export const SelectForNeedInput = z
  .object({
    capability_need_id: z.string().min(1),
    exclude_agent_ids: z.array(z.string().min(1)).default([]),
  })
  .strict()
export type SelectForNeedInput = z.infer<typeof SelectForNeedInput>

export const CapabilityEvidenceStatus = z.enum(["declared", "verified", "expired"])
export type CapabilityEvidenceStatus = z.infer<typeof CapabilityEvidenceStatus>

export const AgentCapability = z.object({
  id: z.string(),
  company_id: CompanyID,
  agent_id: z.string(),
  capability_pack: z.string(),
  source: z.enum(["profile", "selection", "delivery"]),
  status: CapabilityEvidenceStatus,
  available: z.boolean(),
  availability_reasons: z.array(z.string()),
  declared_at: z.number().int(),
  last_verified_at: z.number().int().optional(),
  last_success_selection_id: z.string().optional(),
  failure_count: z.number().int().nonnegative(),
  last_failure_at: z.number().int().optional(),
  last_failure_summary: z.string().optional(),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type AgentCapability = z.infer<typeof AgentCapability>

export const AgentCapabilityQuery = z
  .object({
    company_id: CompanyID,
    agent_id: z.string().min(1).optional(),
  })
  .strict()
export type AgentCapabilityQuery = z.infer<typeof AgentCapabilityQuery>

export const AgentPerformance = z.object({
  id: z.string(),
  company_id: CompanyID,
  project_id: z.string(),
  selection_id: z.string(),
  agent_id: z.string(),
  outcome: z.enum(["success", "failure"]),
  quality_score: z.number().int().min(0).max(100),
  reliability_score: z.number().int().min(0).max(100),
  cost_score: z.number().int().min(0).max(100),
  speed_score: z.number().int().min(0).max(100),
  review_summary: z.string(),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type AgentPerformance = z.infer<typeof AgentPerformance>

export const RecordPerformanceInput = z
  .object({
    selection_id: z.string().min(1),
    outcome: z.enum(["success", "failure"]),
    quality_score: z.number().int().min(0).max(100),
    reliability_score: z.number().int().min(0).max(100),
    cost_score: z.number().int().min(0).max(100),
    speed_score: z.number().int().min(0).max(100),
    review_summary: z.string().trim().min(1).max(4_000),
  })
  .strict()
export type RecordPerformanceInput = z.infer<typeof RecordPerformanceInput>

export const PerformanceProjectNotCompleted = NamedError.create(
  "CompanyPerformanceProjectNotCompleted",
  z
    .object({
      selection_id: z.string(),
      project_id: z.string(),
      project_status: ProjectStatus,
      required_project_status: z.literal("completed"),
      message: z.string(),
    })
    .strict(),
)

export const EmploymentReview = z.object({
  id: z.string(),
  company_id: CompanyID,
  agent_id: z.string(),
  status: z.enum(["proposed", "approved", "rejected", "retired"]),
  selected_project_count: z.number().int().nonnegative(),
  successful_project_count: z.number().int().nonnegative(),
  average_quality_score: z.number().int().min(0).max(100),
  average_reliability_score: z.number().int().min(0).max(100),
  recurring_need_count: z.number().int().nonnegative(),
  rationale: z.string(),
  decision_note: z.string().optional(),
  time_decided: z.number().int().optional(),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type EmploymentReview = z.infer<typeof EmploymentReview>

export const ReviewEmploymentInput = z
  .object({
    company_id: CompanyID,
    agent_id: z.string().min(1),
    decision: z.enum(["propose", "approve", "reject"]),
    decision_note: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
export type ReviewEmploymentInput = z.infer<typeof ReviewEmploymentInput>

export const Department = z.object({
  id: z.string(),
  company_id: CompanyID,
  department_key: z.string(),
  name: z.string(),
  purpose: z.string(),
  status: z.enum(["active", "archived"]),
  recurring_project_count: z.number().int().nonnegative(),
  evidence: z.object({
    capability_need_ids: z.array(z.string()),
    project_ids: z.array(z.string()),
  }),
  time_created: z.number().int(),
  time_updated: z.number().int(),
})
export type Department = z.infer<typeof Department>

export const EnsureDepartmentInput = z
  .object({
    company_id: CompanyID,
    department_key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(1_000),
  })
  .strict()
export type EnsureDepartmentInput = z.infer<typeof EnsureDepartmentInput>

export const DepartmentRecurringDemandNotProven = NamedError.create(
  "CompanyDepartmentRecurringDemandNotProven",
  z
    .object({
      company_id: CompanyID,
      department_key: z.string(),
      recurring_project_count: z.number().int().nonnegative(),
      required_project_count: z.literal(2),
      message: z.string(),
    })
    .strict(),
)

export const RecruitmentQuery = z
  .object({
    company_id: CompanyID,
    project_id: z.string().min(1).optional(),
  })
  .strict()
