import { z } from "zod"

// ---------------------------------------------------------------------------
// Compiler version — bumped when the hash algorithm or mapping logic changes.
// Every RuntimeCompiler MUST incorporate this into compiledHash.
// ---------------------------------------------------------------------------
export const RUNTIME_COMPILER_VERSION = "0.1.0"

// ---------------------------------------------------------------------------
// AgentProfile — the uniform input contract for all runtime compilers.
// AgentCompany owns this type. Each runtime compiler receives it as-is.
// ---------------------------------------------------------------------------
export interface AgentProfile {
  id: string
  name: string
  description?: string
  role?: string

  /** Stable persona written into SOUL.md / equivalent. Per-turn context is NOT stored here. */
  persona?: string

  /** Behavioral instructions (evolvable, separate from identity). */
  instruct?: string

  /** Tool capabilities the agent is allowed to use. */
  tools: string[]

  model?: string

  workspace?: {
    strategy: "shared-project" | "per-agent" | "per-task-worktree"
    /** Absolute path – MUST exist before compile. */
    cwd?: string
  }

  responsibilities?: string[]
  skills?: string[]
}

// ---------------------------------------------------------------------------
// AgentRunInput
// ---------------------------------------------------------------------------
export const AgentRunInput = z.object({
  agentId: z.string(),
  prompt: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().optional(), // milliseconds
  cwd: z.string().optional(),
})
export type AgentRunInput = z.infer<typeof AgentRunInput>

// ---------------------------------------------------------------------------
// AgentRunOutput — generic output for ANY runtime backend.
// - rawStdout  = unmodified process stdout
// - rawStderr  = unmodified process stderr (optional if runtime doesn't capture it)
// - content    = semantically meaningful response (may equal rawStdout for simple
//   runtimes, or a parsed/filtered subset for richer ones)
// - runtime    = discriminator string (e.g. "hermes", "claude-code", "openclaw")
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// RuntimeBinding — metadata linking an AgentCompany agent to a runtime profile.
// runtimeType discriminates: "hermes", "claude-code", "openclaw", …
// ---------------------------------------------------------------------------
export const RuntimeBinding = z.object({
  agentId: z.string(),
  runtimeType: z.string(),
  profileName: z.string(),
  compiledHash: z.string(),
  compiledAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type RuntimeBinding = z.infer<typeof RuntimeBinding>

// ---------------------------------------------------------------------------
// RuntimeCompiler — compiles an AgentProfile into a runtime-specific profile
// (Hermes profile, Claude Code project, etc.).
// ---------------------------------------------------------------------------
export interface RuntimeCompiler {
  readonly runtimeType: string
  compile(agentId: string, profile: AgentProfile): Promise<RuntimeBinding>
  isCompiled(agentId: string): Promise<boolean>
  getBinding(agentId: string): Promise<RuntimeBinding | null>
}

// ---------------------------------------------------------------------------
// RuntimeAdapter — runs one agent turn through a backend runtime.
// ---------------------------------------------------------------------------
export interface RuntimeAdapter {
  readonly runtimeType: string
  run(input: AgentRunInput): Promise<AgentRunOutput>
}

// ---------------------------------------------------------------------------
// RuntimeBindingStore — persistence for RuntimeBinding records.
// ---------------------------------------------------------------------------
export interface RuntimeBindingStore {
  save(binding: RuntimeBinding): Promise<void>
  get(agentId: string): Promise<RuntimeBinding | null>
  getAll(): Promise<RuntimeBinding[]>
  delete(agentId: string): Promise<void>
}
