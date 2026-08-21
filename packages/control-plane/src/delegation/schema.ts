import { z } from "zod"
import type { AgentMessageID } from "@/agent-message/schema"

const optionalKey = z.preprocess((input) => (input === "" ? undefined : input), z.string().min(1).optional())

// ---------------------------------------------------------------------------
// Sub-task produced by decompose
// ---------------------------------------------------------------------------

export const SubTask = z.object({
  key: optionalKey,
  parentKey: optionalKey,
  kind: z.literal("worker").optional(),
  purpose: z.literal("delivery").optional(),
  summary: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  suggestedAgent: z.string().optional(),
  workType: z.enum(["coding", "decision", "research", "writing", "design", "analysis", "knowledge_reading"]).optional(),
  role: z.string().min(1).optional(),
  capabilityPacks: z.array(z.string()).optional(),
  decisionScope: z.array(z.string()).optional(),
  resourceScope: z.array(z.string()).optional(),
  modelGroup: z.enum(["standard", "lite"]).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  dependsOn: z.array(z.string()).optional(),
}).strict()
export type SubTask = z.infer<typeof SubTask>

export const PlannerSubTask = SubTask.extend({
  kind: z.literal("worker"),
  purpose: z.literal("delivery"),
}).strict()
export type PlannerSubTask = z.infer<typeof PlannerSubTask>

// ---------------------------------------------------------------------------
// Delegation chain tracking
// ---------------------------------------------------------------------------

export const DelegationChain = z.object({
  rootNeedID: z.string(),
  depth: z.number().int().nonnegative(),
  messages: z.array(z.string()) as unknown as z.ZodType<AgentMessageID[]>,
  actors: z.array(z.string()),
})
export type DelegationChain = z.infer<typeof DelegationChain>

// ---------------------------------------------------------------------------
// Per-subtask delegation result
// ---------------------------------------------------------------------------

export const DelegationResult = z.object({
  messageID: z.string(),
  actorID: z.string(),
  status: z.enum(["spawned", "completed", "failed", "escalated"]),
})
export type DelegationResult = z.infer<typeof DelegationResult>

// ---------------------------------------------------------------------------
// Admission evaluation result
// ---------------------------------------------------------------------------

export const AdmissionResult = z.object({
  accepted: z.boolean(),
  findings: z.array(z.string()),
})
export type AdmissionResult = z.infer<typeof AdmissionResult>
