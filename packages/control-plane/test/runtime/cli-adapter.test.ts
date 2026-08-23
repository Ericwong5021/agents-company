import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { cliCommand, codexPrompt, findCliRuntimeBinary, type AgentRunSpec } from "../../src/runtime"

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
    expect(cliCommand(spec).args).toContain("approval_policy=\"never\"")
    expect(cliCommand(spec).args).toContain("--ignore-user-config")
    expect(cliCommand(spec).args).not.toContain("--ask-for-approval")
  })

  test("finds Codex in user installation directories outside the service PATH", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agent-company-runtime-"))
    const binary = path.join(home, ".bun", "bin", process.platform === "win32" ? "codex.exe" : "codex")
    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, "")
    chmodSync(binary, 0o700)

    expect(findCliRuntimeBinary("codex", { HOME: home, PATH: "/usr/bin:/bin" })).toBe(binary)
    rmSync(home, { recursive: true, force: true })
  })
})
