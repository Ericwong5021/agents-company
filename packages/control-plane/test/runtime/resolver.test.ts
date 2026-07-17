import { describe, expect, test } from "bun:test"
import {
  RuntimeRegistry,
  RuntimeResolver,
  type AgentRuntimePort,
  type RuntimeCapabilities,
} from "../../src/runtime"

const capabilities = (overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  resume: true,
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
  ...overrides,
})

const adapter = (
  runtime: AgentRuntimePort["runtime"],
  input: { available?: boolean; capabilities?: Partial<RuntimeCapabilities> } = {},
): AgentRuntimePort => ({
  runtime,
  async discover() {
    return {
      runtime,
      available: input.available ?? true,
      version: "test",
      authenticated: true,
    }
  },
  capabilities: () => capabilities(input.capabilities),
  start() {
    throw new Error("not exercised by resolver tests")
  },
  resume() {
    throw new Error("not exercised by resolver tests")
  },
  async deliver() {},
  async interrupt() {
    return false
  },
  async stop() {
    return false
  },
})

describe("RuntimeResolver", () => {
  test("selects explicit, workflow, agent preference, then Pi in that order", async () => {
    const resolver = new RuntimeResolver(
      new RuntimeRegistry([adapter("pi"), adapter("codex"), adapter("claude-code")]),
    )

    expect((await resolver.resolve({ explicitRuntime: "codex", workflowRuntime: "claude-code", agentRuntime: "pi" })).runtime).toBe("codex")
    expect((await resolver.resolve({ workflowRuntime: "claude-code", agentRuntime: "codex" })).runtime).toBe("claude-code")
    expect((await resolver.resolve({ agentRuntime: "codex" })).runtime).toBe("codex")
    expect((await resolver.resolve({})).runtime).toBe("pi")
  })

  test("does not silently downgrade an unavailable explicit runtime", async () => {
    const resolver = new RuntimeResolver(
      new RuntimeRegistry([adapter("pi"), adapter("codex", { available: false })]),
    )

    await expect(resolver.resolve({ explicitRuntime: "codex" })).rejects.toThrow(
      "Explicit runtime codex is unavailable",
    )
  })

  test("rejects a runtime missing a required capability before start", async () => {
    const resolver = new RuntimeResolver(
      new RuntimeRegistry([adapter("pi", { capabilities: { workspaceWrite: false } })]),
    )

    await expect(resolver.resolve({ requiredCapabilities: ["workspaceWrite"] })).rejects.toThrow(
      "Runtime pi does not support required capabilities: workspaceWrite",
    )
  })
})
