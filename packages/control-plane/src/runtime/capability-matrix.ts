import type { RuntimeCapabilities, RuntimeID } from "./interface"

// Static, declarative capability facts per runtime. This is the single source of
// truth consumed both by runtime adapters and by team selection (TEAM-02 runtime
// compatibility gate), so compatibility can be checked without instantiating ports.
export const RuntimeCapabilityMatrix: Record<RuntimeID, RuntimeCapabilities> = {
  pi: {
    resume: false,
    interrupt: true,
    liveInput: true,
    structuredEvents: true,
    toolCalls: true,
    structuredOutput: true,
    workspaceRead: true,
    workspaceWrite: true,
    approvals: true,
    reasoningEffort: true,
    subagents: false,
    usageAccounting: true,
    dynamicSkills: true,
    governanceSignals: true,
  },
  "claude-code": {
    resume: true,
    interrupt: true,
    liveInput: false,
    structuredEvents: true,
    toolCalls: true,
    structuredOutput: true,
    workspaceRead: true,
    workspaceWrite: true,
    approvals: true,
    reasoningEffort: false,
    subagents: true,
    usageAccounting: true,
    dynamicSkills: false,
    governanceSignals: false,
  },
  codex: {
    resume: true,
    interrupt: true,
    liveInput: false,
    structuredEvents: true,
    toolCalls: true,
    structuredOutput: true,
    workspaceRead: true,
    workspaceWrite: true,
    approvals: true,
    reasoningEffort: true,
    subagents: true,
    usageAccounting: true,
    dynamicSkills: false,
    governanceSignals: false,
  },
}

export function missingRuntimeCapabilities(runtime: RuntimeID, required: Array<keyof RuntimeCapabilities>) {
  return [...new Set(required)].filter((capability) => !RuntimeCapabilityMatrix[runtime][capability]).toSorted()
}
