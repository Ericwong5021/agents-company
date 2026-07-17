import { z } from "zod"
import type { AgentMessageID } from "@/agent-message/schema"

// ---------------------------------------------------------------------------
// Sub-task produced by decompose
// ---------------------------------------------------------------------------

export const SubTask = z.object({
  summary: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  suggestedAgent: z.string().optional(),
})
export type SubTask = z.infer<typeof SubTask>

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
