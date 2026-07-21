import { describe, expect, test } from "bun:test"
import { cliCommand, codexPrompt, type AgentRunSpec } from "../../src/runtime"

const spec: AgentRunSpec = {
  runID: "run-1",
  agentID: "director",
  runtime: "codex",
  lifecycle: "on_demand",
  permissionMode: "read_only",
  cwd: "C:\\workspace",
  runtimeHome: "C:\\runtime",
  prompt: "Discuss the proposal",
  systemPrompt: "You are the board director. Your authority is strategy.",
  capabilityPacks: [],
  requiredRuntimeCapabilities: [],
}

describe("Codex CLI adapter", () => {
  test("carries AgentCompany identity and task context in the Codex prompt", () => {
    expect(codexPrompt(spec)).toContain("You are the board director")
    expect(codexPrompt(spec)).toContain("Discuss the proposal")
    expect(cliCommand(spec).args.at(-1)).toBe(codexPrompt(spec))
  })
})
