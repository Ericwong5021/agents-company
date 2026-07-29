import z from "zod"
import { CommonsAccess, CommonsPrivacyScope } from "@/company-commons/schema"

export const ReadingEvidenceRef = z
  .object({
    chunk_id: z.string().trim().min(1),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
    claim: z.string().trim().min(1).max(4_000),
  })
  .strict()
export type ReadingEvidenceRef = z.infer<typeof ReadingEvidenceRef>

export const ProjectConnection = z
  .object({
    project_id: z.string().trim().min(1),
    impact: z.string().trim().min(1).max(4_000),
  })
  .strict()
export type ProjectConnection = z.infer<typeof ProjectConnection>

export const KnowledgeReadingReceipt = z
  .object({
    source_id: z.string().trim().min(1),
    reader_agent_id: z.string().trim().min(1),
    reader_role: z.string().trim().min(1).max(300),
    work_item_id: z.string().trim().min(1),
    core_thesis: z.string().trim().min(1).max(12_000),
    important_claims: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
    company_relevance: z.string().trim().min(1).max(8_000),
    project_connections: z.array(ProjectConnection).max(100),
    agreement: z.enum(["aligned", "conflicted", "mixed", "unknown"]),
    conflicts: z.array(z.string().trim().min(1).max(4_000)).max(100),
    counter_arguments: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
    inspiration: z.array(z.string().trim().min(1).max(4_000)).max(100),
    experiment_ideas: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
    disposition: z.enum(["archive", "candidate", "reject"]),
    confidence: z.number().min(0).max(1),
    evidence_refs: z.array(ReadingEvidenceRef).min(1).max(500),
  })
  .strict()
export type KnowledgeReadingReceipt = z.infer<typeof KnowledgeReadingReceipt>

export const Interpretation = KnowledgeReadingReceipt.extend({
  id: z.string(),
  work_receipt_id: z.string().optional(),
  work_item_id: z.string().optional(),
  reader_agent_name: z.string().optional(),
  created_at: z.number(),
})
export type Interpretation = z.infer<typeof Interpretation>

export const AgentInterestProfileInput = z
  .object({
    company_id: z.string().trim().min(1),
    agent_id: z.string().trim().min(1),
    topics: z.array(z.string().trim().min(1).max(200)).max(200),
    preferred_lenses: z.array(z.string().trim().min(1).max(300)).max(100),
    excluded_topics: z.array(z.string().trim().min(1).max(200)).max(200),
    novelty_threshold: z.number().min(0).max(1),
    weekly_reading_budget: z.number().int().min(0).max(168),
    max_concurrency: z.number().int().min(1).max(3),
    privacy_scopes: z.array(CommonsPrivacyScope).min(1).max(3),
  })
  .strict()
export type AgentInterestProfileInput = z.infer<typeof AgentInterestProfileInput>

export const AgentInterestProfile = AgentInterestProfileInput.extend({
  updated_at: z.number(),
})
export type AgentInterestProfile = z.infer<typeof AgentInterestProfile>

export const ReadingAssignmentStatus = z.enum([
  "scheduling",
  "scheduled",
  "running",
  "completed",
  "failed",
  "stopped",
])
export type ReadingAssignmentStatus = z.infer<typeof ReadingAssignmentStatus>

export const ReadingAssignment = z.object({
  id: z.string(),
  source_id: z.string(),
  company_id: z.string(),
  agent_id: z.string(),
  project_id: z.string(),
  linked_project_ids: z.array(z.string()),
  work_item_id: z.string().optional(),
  idempotency_key: z.string(),
  status: ReadingAssignmentStatus,
  relevance_score: z.number(),
  novelty_score: z.number(),
  gap_score: z.number(),
  budget_score: z.number(),
  total_score: z.number(),
  budget_week: z.string(),
  budget_reserved: z.boolean(),
  error: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  stopped_at: z.number().optional(),
})
export type ReadingAssignment = z.infer<typeof ReadingAssignment>

export const ReadingScheduleInput = CommonsAccess.extend({
  source_id: z.string().trim().min(1),
  project_id: z.string().trim().min(1),
})
export type ReadingScheduleInput = z.infer<typeof ReadingScheduleInput>

export const ReadingScheduleResult = z.object({
  source_id: z.string(),
  project_id: z.string(),
  assignments: z.array(ReadingAssignment).max(3),
  eligible_agent_count: z.number().int().nonnegative(),
})
export type ReadingScheduleResult = z.infer<typeof ReadingScheduleResult>
