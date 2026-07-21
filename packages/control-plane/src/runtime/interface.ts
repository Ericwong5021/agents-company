import { z } from "zod"

// ---------------------------------------------------------------------------
// AgentCompany runtime contract
// ---------------------------------------------------------------------------

export const RuntimeID = z.enum(["pi", "codex", "claude-code"])
export type RuntimeID = z.infer<typeof RuntimeID>

export const RuntimeLifecycle = z.enum(["on_demand", "idle_cached"])
export type RuntimeLifecycle = z.infer<typeof RuntimeLifecycle>

export const RuntimePermissionMode = z.enum(["read_only", "workspace_write", "full_access"])
export type RuntimePermissionMode = z.infer<typeof RuntimePermissionMode>

export const RuntimeCapabilities = z.object({
  resume: z.boolean(),
  interrupt: z.boolean(),
  liveInput: z.boolean(),
  structuredEvents: z.boolean(),
  toolCalls: z.boolean(),
  structuredOutput: z.boolean(),
  workspaceRead: z.boolean(),
  workspaceWrite: z.boolean(),
  approvals: z.boolean(),
  reasoningEffort: z.boolean(),
  subagents: z.boolean(),
  usageAccounting: z.boolean(),
  dynamicSkills: z.boolean(),
  governanceSignals: z.boolean(),
})
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilities>

export const RuntimeAvailability = z.object({
  runtime: RuntimeID,
  available: z.boolean(),
  version: z.string().optional(),
  authenticated: z.boolean().optional(),
  reason: z.string().optional(),
})
export type RuntimeAvailability = z.infer<typeof RuntimeAvailability>

export const AgentRunSpec = z.object({
  runID: z.string(),
  agentID: z.string(),
  runtime: RuntimeID,
  lifecycle: RuntimeLifecycle.default("on_demand"),
  permissionMode: RuntimePermissionMode.default("workspace_write"),
  cwd: z.string().min(1),
  runtimeHome: z.string().min(1),
  prompt: z.string().min(1),
  systemPrompt: z.string().default(""),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  resumeSessionID: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  role: z.string().optional(),
  capabilityPacks: z.array(z.string()).default([]),
  requiredRuntimeCapabilities: z.array(z.keyof(RuntimeCapabilities)).default([]),
  allowSignalPublishing: z.boolean().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  workflowVersion: z.string().optional(),
})
export type AgentRunSpec = z.infer<typeof AgentRunSpec>

export const AgentRunEvent = z.object({
  runID: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.enum(["started", "runtime", "session", "message", "tool", "stderr", "completed", "failed"]),
  payload: z.record(z.string(), z.unknown()),
  time: z.number(),
})
export type AgentRunEvent = z.infer<typeof AgentRunEvent>

export const AgentRunResult = z.object({
  runID: z.string(),
  runtime: RuntimeID,
  content: z.string(),
  exitCode: z.number(),
  sessionID: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number(),
})
export type AgentRunResult = z.infer<typeof AgentRunResult>

export const RuntimeMessage = z.object({
  runID: z.string(),
  content: z.string().min(1),
  priority: z.enum(["steer", "follow_up"]).default("follow_up"),
})
export type RuntimeMessage = z.infer<typeof RuntimeMessage>

export interface AgentRunHandle {
  readonly completion: Promise<AgentRunResult>
  interrupt(): void
}

export interface AgentRuntimePort {
  readonly runtime: RuntimeID
  capabilities(): RuntimeCapabilities
  discover(): Promise<RuntimeAvailability>
  start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle
  resume(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle
  deliver(message: RuntimeMessage): Promise<void>
  interrupt(runID: string): Promise<boolean>
  stop(runID: string): Promise<boolean>
}
