import { z } from "zod"

/** @deprecated Migration-only contract for the quarantined Hermes CLI. */
export const RUNTIME_COMPILER_VERSION = "0.1.0"

/** @deprecated Hermes compatibility only. */
export interface AgentProfile {
  id: string
  name: string
  description?: string
  role?: string
  persona?: string
  instruct?: string
  tools: string[]
  model?: string
  workspace?: { strategy: "shared-project" | "per-agent" | "per-task-worktree"; cwd?: string }
  responsibilities?: string[]
  skills?: string[]
}

export const AgentRunInput = z.object({
  agentId: z.string(),
  prompt: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().optional(),
  cwd: z.string().optional(),
})
export type AgentRunInput = z.infer<typeof AgentRunInput>

export const AgentRunOutput = z.object({
  agentId: z.string(),
  runtime: z.string(),
  content: z.string(),
  rawStdout: z.string(),
  rawStderr: z.string().optional(),
  exitCode: z.number(),
  startedAt: z.number(),
  finishedAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type AgentRunOutput = z.infer<typeof AgentRunOutput>

export const RuntimeBinding = z.object({
  agentId: z.string(),
  runtimeType: z.string(),
  profileName: z.string(),
  compiledHash: z.string(),
  compiledAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type RuntimeBinding = z.infer<typeof RuntimeBinding>

export interface RuntimeCompiler {
  readonly runtimeType: string
  compile(agentId: string, profile: AgentProfile): Promise<RuntimeBinding>
  isCompiled(agentId: string): Promise<boolean>
  getBinding(agentId: string): Promise<RuntimeBinding | null>
}

export interface RuntimeAdapter {
  readonly runtimeType: string
  run(input: AgentRunInput): Promise<AgentRunOutput>
}

export interface RuntimeBindingStore {
  save(binding: RuntimeBinding): Promise<void>
  get(agentId: string): Promise<RuntimeBinding | null>
  getAll(): Promise<RuntimeBinding[]>
  delete(agentId: string): Promise<void>
}
