import { z } from "zod"
import type { RuntimeBinding } from "../interface"

// HermesRuntimeBinding - Extended binding with Hermes-specific metadata
export const HermesRuntimeBinding = z.object({
  agentId: z.string(),
  runtimeType: z.literal("hermes"),
  profileName: z.string(),
  compiledHash: z.string(),
  compiledAt: z.number(),
  metadata: z.object({
    soulMdPath: z.string().optional(),
    toolsets: z.array(z.string()).optional(),
    cloneSource: z.string().optional(),
    compilerVersion: z.string().optional(),
    commandMode: z.string().optional(),
  }).optional(),
})
export type HermesRuntimeBinding = z.infer<typeof HermesRuntimeBinding>

// HermesRuntimeConfig - Configuration for the Hermes runtime
export const HermesRuntimeConfig = z.object({
  commandTemplate: z.string().default("hermes -p <profileName> -z <prompt>"),
  defaultTimeout: z.number().default(300_000), // 5 minutes
  profilePrefix: z.string().default("agentcompany"),
  bindingStorePath: z.string().default(".agentcompany/runtime/hermes/bindings.json"),
  cloneModePreferred: z.boolean().default(true),
  defaultCloneSource: z.string().optional(),
})
export type HermesRuntimeConfig = z.infer<typeof HermesRuntimeConfig>

// HermesRuntimeErrorCode - Error codes for Hermes runtime operations
export const HermesRuntimeErrorCode = z.enum([
  "PROFILE_NOT_FOUND",
  "COMPILATION_FAILED",
  "EXECUTION_TIMEOUT",
  "EXECUTION_FAILED",
  "BINDING_NOT_FOUND",
  "INVALID_CONFIG",
  "HERMES_NOT_AVAILABLE",
  "WORKSPACE_NOT_FOUND",
  "UNKNOWN",
])
export type HermesRuntimeErrorCode = z.infer<typeof HermesRuntimeErrorCode>

// HermesRuntimeError - Structured error from Hermes runtime
export class HermesRuntimeError extends Error {
  constructor(
    public readonly code: HermesRuntimeErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "HermesRuntimeError"
  }
}

// Tool capability mapping
export const TOOLSET_MAPPING: Record<string, string[]> = {
  "read": ["read"],
  "write": ["write"],
  "edit": ["edit"],
  "bash": ["bash", "execute"],
  "glob": ["search", "glob"],
  "grep": ["search", "grep"],
  "websearch": ["search", "web"],
  "webfetch": ["fetch", "web"],
}
