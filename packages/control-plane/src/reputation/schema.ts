import z from "zod"

export const ReputationInfo = z.object({
  id: z.string(),
  agentID: z.string(),
  score: z.number(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
})
export type ReputationInfo = z.infer<typeof ReputationInfo>

export const ReputationHistoryInfo = z.object({
  id: z.string(),
  reputationID: z.string(),
  scoreChange: z.number(),
  reason: z.string(),
  taskID: z.string().optional(),
  metadata: z.string().optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
})
export type ReputationHistoryInfo = z.infer<typeof ReputationHistoryInfo>

export const UpdateInput = z.object({
  agentID: z.string().min(1),
  scoreChange: z.number(),
  reason: z.string().min(1),
  taskID: z.string().optional(),
  metadata: z.string().optional(),
})
export type UpdateInput = z.infer<typeof UpdateInput>
