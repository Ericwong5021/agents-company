import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import type { AgentProfile, RuntimeAdapter } from "../legacy-interface"
import { HermesProfileCompiler } from "./compiler"
import { HermesRuntimeAdapter } from "./adapter"
import { FileBindingStore } from "./binding-store"
import { RoundtableOrchestrator } from "../roundtable"
import type { RoundtableMessage } from "../roundtable"
import type { HermesRuntimeConfig } from "./types"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestProfile(id: string, name: string, overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    name,
    persona: `You are ${name}. A test agent.`,
    tools: ["read", "edit", "bash"],
    responsibilities: ["Execute tasks", "Report results"],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("Hermes Runtime", () => {
  const testDir = path.join(process.cwd(), ".test-hermes-runtime")
  const bindingStorePath = path.join(testDir, "bindings.json")

  const config: HermesRuntimeConfig = {
    commandTemplate: "hermes -p <profileName> -z <prompt>",
    defaultTimeout: 30_000,
    profilePrefix: "agentcompany",
    bindingStorePath,
    cloneModePreferred: false,
  }

  let bindingStore: FileBindingStore
  let compiler: HermesProfileCompiler

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
    await fs.mkdir(testDir, { recursive: true })

    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    const profileDir = path.join(homeDir, ".hermes", "profiles", "agentcompany-test-agent")
    await fs.rm(profileDir, { recursive: true, force: true })

    bindingStore = new FileBindingStore(bindingStorePath)
    compiler = new HermesProfileCompiler(config, bindingStore, testDir)
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })

    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    const profileDir = path.join(homeDir, ".hermes", "profiles", "agentcompany-test-agent")
    await fs.rm(profileDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // HermesProfileCompiler
  // -----------------------------------------------------------------------

  describe("HermesProfileCompiler", () => {
    it("should create a binding for an agent from AgentProfile", async () => {
      const profile = createTestProfile("test-agent", "Test Agent")
      const binding = await compiler.compile("test-agent", profile)

      expect(binding).toBeDefined()
      expect(binding.agentId).toBe("test-agent")
      expect(binding.runtimeType).toBe("hermes")
      expect(binding.profileName).toBe("agentcompany-test-agent")
      expect(binding.compiledHash).toBeDefined()
      expect(binding.compiledAt).toBeGreaterThan(0)
    })

    it("should be idempotent — same hash returns same binding", async () => {
      const profile = createTestProfile("test-agent", "Test Agent")
      const binding1 = await compiler.compile("test-agent", profile)
      const binding2 = await compiler.compile("test-agent", profile)

      expect(binding1.compiledHash).toBe(binding2.compiledHash)
    })

    it("should recompile when persona changes", async () => {
      const profile1 = createTestProfile("test-agent", "Test Agent v1")
      const binding1 = await compiler.compile("test-agent", profile1)

      const profile2 = createTestProfile("test-agent", "Test Agent v2", {
        persona: "Different persona",
      })
      const binding2 = await compiler.compile("test-agent", profile2)

      expect(binding1.compiledHash).not.toBe(binding2.compiledHash)
    })

    it("should recompile when tools change", async () => {
      const profile1 = createTestProfile("test-agent", "Test Agent", {
        tools: ["read"],
      })
      const binding1 = await compiler.compile("test-agent", profile1)

      const profile2 = createTestProfile("test-agent", "Test Agent", {
        tools: ["read", "edit", "bash", "websearch"],
      })
      const binding2 = await compiler.compile("test-agent", profile2)

      expect(binding1.compiledHash).not.toBe(binding2.compiledHash)
    })

    it("should recompile when workspace.cwd changes", async () => {
      const profile1 = createTestProfile("test-agent", "Test Agent", {
        workspace: { strategy: "shared-project", cwd: "/tmp" },
      })
      const binding1 = await compiler.compile("test-agent", profile1)

      const profile2 = createTestProfile("test-agent", "Test Agent", {
        workspace: { strategy: "shared-project", cwd: "/var" },
      })
      const binding2 = await compiler.compile("test-agent", profile2)

      expect(binding1.compiledHash).not.toBe(binding2.compiledHash)
    })

    it("should recompile when model changes", async () => {
      const profile1 = createTestProfile("test-agent", "Test Agent", {
        model: "gpt-4",
      })
      const binding1 = await compiler.compile("test-agent", profile1)

      const profile2 = createTestProfile("test-agent", "Test Agent", {
        model: "claude-4",
      })
      const binding2 = await compiler.compile("test-agent", profile2)

      expect(binding1.compiledHash).not.toBe(binding2.compiledHash)
    })

    it("should recompile when compiledHash does not match even if binding exists", async () => {
      // Manually plant a binding with a different hash.
      await bindingStore.save({
        agentId: "test-agent",
        runtimeType: "hermes",
        profileName: "agentcompany-test-agent",
        compiledHash: "stale-hash",
        compiledAt: Date.now() - 100000,
      })

      const compiler2 = new HermesProfileCompiler(config, bindingStore, testDir)
      const profile = createTestProfile("test-agent", "Test Agent")
      const binding = await compiler2.compile("test-agent", profile)

      expect(binding.compiledHash).not.toBe("stale-hash")
    })

    it("should auto-recompile when Hermes profile directory is missing", async () => {
      const profile = createTestProfile("test-agent", "Test Agent")
      await compiler.compile("test-agent", profile)

      // Manually delete the Hermes profile directory.
      const homeDir = process.env.HOME || process.env.USERPROFILE || ""
      const profileDir = path.join(homeDir, ".hermes", "profiles", "agentcompany-test-agent")
      await fs.rm(profileDir, { recursive: true, force: true })

      // Second compile should succeed (recreate profile).
      const binding = await compiler.compile("test-agent", profile)
      expect(binding.compiledHash).toBeDefined()
    })

    it("should check if agent is compiled", async () => {
      const profile = createTestProfile("test-agent", "Test Agent")
      expect(await compiler.isCompiled("test-agent")).toBe(false)

      await compiler.compile("test-agent", profile)
      expect(await compiler.isCompiled("test-agent")).toBe(true)
    })

    it("should get binding for agent", async () => {
      const profile = createTestProfile("test-agent", "Test Agent")
      expect(await compiler.getBinding("test-agent")).toBeNull()

      const binding = await compiler.compile("test-agent", profile)
      const retrieved = await compiler.getBinding("test-agent")

      expect(retrieved).toBeDefined()
      expect(retrieved?.agentId).toBe("test-agent")
      expect(retrieved?.compiledHash).toBe(binding.compiledHash)
    })
  })

  // -----------------------------------------------------------------------
  // FileBindingStore
  // -----------------------------------------------------------------------

  describe("FileBindingStore", () => {
    it("should save and retrieve bindings", async () => {
      const binding = {
        agentId: "test",
        runtimeType: "hermes",
        profileName: "agentcompany-test",
        compiledHash: "abc123",
        compiledAt: Date.now(),
      }
      await bindingStore.save(binding)
      const retrieved = await bindingStore.get("test")

      expect(retrieved).toBeDefined()
      expect(retrieved?.agentId).toBe("test")
    })

    it("should list all bindings", async () => {
      await bindingStore.save({
        agentId: "agent1",
        runtimeType: "hermes",
        profileName: "agentcompany-agent1",
        compiledHash: "hash1",
        compiledAt: Date.now(),
      })
      await bindingStore.save({
        agentId: "agent2",
        runtimeType: "hermes",
        profileName: "agentcompany-agent2",
        compiledHash: "hash2",
        compiledAt: Date.now(),
      })

      const all = await bindingStore.getAll()
      expect(all).toHaveLength(2)
    })

    it("should delete bindings", async () => {
      await bindingStore.save({
        agentId: "test",
        runtimeType: "hermes",
        profileName: "agentcompany-test",
        compiledHash: "abc123",
        compiledAt: Date.now(),
      })
      await bindingStore.delete("test")
      const retrieved = await bindingStore.get("test")
      expect(retrieved).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // HermesRuntimeAdapter
  // -----------------------------------------------------------------------

  describe("HermesRuntimeAdapter", () => {
    it("should throw typed error when no binding exists", async () => {
      const adapter = new HermesRuntimeAdapter(config, bindingStore)
      await expect(
        adapter.run({ agentId: "nonexistent", prompt: "test" }),
      ).rejects.toThrow("No binding found for agent nonexistent")
    })

    it("should return AgentRunOutput with runtime=hermes on success", async () => {
      // Use a mock echo command as the "hermes" binary.
      const mockConfig: HermesRuntimeConfig = {
        commandTemplate: "echo '<prompt>'",
        defaultTimeout: 10_000,
        profilePrefix: "agentcompany",
        bindingStorePath,
        cloneModePreferred: false,
      }
      const mockStore = new FileBindingStore(bindingStorePath)
      const mockCompiler = new HermesProfileCompiler(mockConfig, mockStore, testDir)
      const adapter = new HermesRuntimeAdapter(mockConfig, mockStore)

      const profile = createTestProfile("test-agent", "Test Agent")
      await mockCompiler.compile("test-agent", profile)

      const result = await adapter.run({
        agentId: "test-agent",
        prompt: "Hello Hermes",
      })

      expect(result.runtime).toBe("hermes")
      expect(result.content).toBeDefined()
      expect(result.rawStdout).toBeDefined()
      expect(result.exitCode).toBe(0)
      expect(result.startedAt).toBeGreaterThan(0)
      expect(result.finishedAt).toBeGreaterThan(0)
      expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt)
      expect(result.metadata?.profileName).toBe("agentcompany-test-agent")
    })
  })

  // -----------------------------------------------------------------------
  // End-to-end smoke test with mocked Hermes CLI
  // -----------------------------------------------------------------------

  describe("End-to-end smoke (mocked Hermes CLI)", () => {
    it("should run compile → adapter.run → AgentRunOutput with all fields", async () => {
      // Create a mock shell script that simulates Hermes.
      const mockHermesBin = path.join(testDir, "mock-hermes.sh")
      await fs.writeFile(
        mockHermesBin,
        `#!/bin/bash
echo "MOCK_HERMES_OK: received"
echo "MOCK_HERMES_DEBUG: info" >&2
exit 0
`,
      )
      await fs.chmod(mockHermesBin, 0o755)

      const smokeConfig: HermesRuntimeConfig = {
        commandTemplate: `${mockHermesBin} -p <profileName> -z <prompt>`,
        defaultTimeout: 10_000,
        profilePrefix: "agentcompany",
        bindingStorePath: path.join(testDir, "smoke-bindings.json"),
        cloneModePreferred: false,
      }

      const smokeStore = new FileBindingStore(smokeConfig.bindingStorePath)
      const smokeCompiler = new HermesProfileCompiler(smokeConfig, smokeStore, testDir)
      const smokeAdapter = new HermesRuntimeAdapter(smokeConfig, smokeStore)

      // 1. Compile
      const profile = createTestProfile("smoke-agent", "Smoke Agent", {
        tools: ["read", "bash", "grep"],
        workspace: { strategy: "shared-project" },
        model: "gpt-4o",
      })
      const binding = await smokeCompiler.compile("smoke-agent", profile)

      expect(binding.profileName).toBe("agentcompany-smoke-agent")

      // 2. Run
      const result = await smokeAdapter.run({
        agentId: "smoke-agent",
        prompt: "What is the project status?",
        timeout: 10_000,
      })

      // 3. Verify AgentRunOutput — all required fields.
      expect(result.runtime).toBe("hermes")
      expect(result.content).toContain("MOCK_HERMES_OK")
      expect(result.rawStdout).toContain("MOCK_HERMES_OK")
      expect(result.rawStderr).toContain("MOCK_HERMES_DEBUG")
      expect(result.exitCode).toBe(0)
      expect(result.startedAt).toBeGreaterThan(0)
      expect(result.finishedAt).toBeGreaterThan(result.startedAt)

      // 4. Verify binding metadata propagation.
      expect(result.metadata?.profileName).toBe("agentcompany-smoke-agent")

      // 5. Verify the Hermes profile directory was created.
      const homeDir = process.env.HOME || process.env.USERPROFILE || ""
      const profileDir = path.join(homeDir, ".hermes", "profiles", "agentcompany-smoke-agent")
      const dirExists = await fs.stat(profileDir).then((s) => s.isDirectory()).catch(() => false)
      expect(dirExists).toBe(true)
    })

    it("should propagate non-zero exit code", async () => {
      const mockFailBin = path.join(testDir, "mock-hermes-fail.sh")
      await fs.writeFile(
        mockFailBin,
        `#!/bin/bash
echo "ERROR: something went wrong" >&2
exit 2
`,
      )
      await fs.chmod(mockFailBin, 0o755)

      const failConfig: HermesRuntimeConfig = {
        commandTemplate: `${mockFailBin} <profileName> <prompt>`,
        defaultTimeout: 10_000,
        profilePrefix: "agentcompany",
        bindingStorePath: path.join(testDir, "fail-bindings.json"),
        cloneModePreferred: false,
      }
      const failStore = new FileBindingStore(failConfig.bindingStorePath)
      const failCompiler = new HermesProfileCompiler(failConfig, failStore, testDir)
      const failAdapter = new HermesRuntimeAdapter(failConfig, failStore)

      const profile = createTestProfile("fail-agent", "Fail Agent")
      await failCompiler.compile("fail-agent", profile)

      const result = await failAdapter.run({
        agentId: "fail-agent",
        prompt: "test",
      })

      expect(result.exitCode).toBe(2)
      expect(result.rawStderr).toContain("ERROR")
    })
  })

  // -----------------------------------------------------------------------
  // RoundtableOrchestrator
  // -----------------------------------------------------------------------

  describe("RoundtableOrchestrator", () => {
    function createMockAdapter(): RuntimeAdapter & { calls: Array<{ agentId: string; prompt: string }> } {
      const calls: Array<{ agentId: string; prompt: string }> = []
      return {
        runtimeType: "mock",
        calls,
        async run(input) {
          calls.push({ agentId: input.agentId, prompt: input.prompt })
          return {
            agentId: input.agentId,
            runtime: "mock-runtime",
            content: `Response from ${input.agentId}`,
            rawStdout: `Response from ${input.agentId}`,
            exitCode: 0,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            metadata: { profileName: `mock-${input.agentId}` },
          }
        },
      }
    }

    it("should execute agents in fixed order", async () => {
      const mockAdapter = createMockAdapter()
      const orchestrator = new RoundtableOrchestrator(mockAdapter)

      await orchestrator.run({
        goal: "Design the system",
        participants: ["ceo", "engineer", "reviewer", "ceo"],
      })

      expect(mockAdapter.calls.map((c) => c.agentId)).toEqual([
        "ceo",
        "engineer",
        "reviewer",
        "ceo",
      ])
    })

    it("should include conversation history in subsequent prompts", async () => {
      const mockAdapter = createMockAdapter()
      const orchestrator = new RoundtableOrchestrator(mockAdapter)

      await orchestrator.run({
        goal: "Initial goal",
        participants: ["ceo", "engineer"],
      })

      // First call: just the goal.
      expect(mockAdapter.calls[0].prompt).toContain("Initial goal")

      // Second call: should include the first response in conversation history.
      expect(mockAdapter.calls[1].prompt).toContain("Response from ceo")
      expect(mockAdapter.calls[1].prompt).toContain("## Conversation History")
    })

    it("should populate runtime metadata on each message", async () => {
      const mockAdapter = createMockAdapter()
      const messages: RoundtableMessage[] = []
      const orchestrator = new RoundtableOrchestrator(mockAdapter, async (msg) => {
        messages.push(msg)
      })

      await orchestrator.run({
        goal: "Test",
        participants: ["ceo", "engineer"],
      })

      expect(messages).toHaveLength(2)
      for (const msg of messages) {
        expect(msg.runtime).toBeDefined()
        expect(msg.runtime!.kind).toBe("mock-runtime")
        expect(msg.runtime!.profileName).toMatch(/^mock-/)
      }
    })

    it("should track fromAgentId correctly for user vs agent", async () => {
      const mockAdapter = createMockAdapter()
      const messages: RoundtableMessage[] = []
      const orchestrator = new RoundtableOrchestrator(mockAdapter, async (msg) => {
        messages.push(msg)
      })

      await orchestrator.run({
        goal: "Goal",
        participants: ["ceo", "engineer", "reviewer"],
      })

      expect(messages[0].fromAgentId).toBe("user")
      expect(messages[0].toAgentId).toBe("ceo")
      expect(messages[1].fromAgentId).toBe("ceo")
      expect(messages[1].toAgentId).toBe("engineer")
      expect(messages[2].fromAgentId).toBe("engineer")
      expect(messages[2].toAgentId).toBe("reviewer")
    })

    it("should compute finalOutput from last message", async () => {
      const mockAdapter = createMockAdapter()
      const orchestrator = new RoundtableOrchestrator(mockAdapter)

      const result = await orchestrator.run({
        goal: "Goal",
        participants: ["ceo", "engineer"],
      })

      expect(result.finalOutput).toBe("Response from engineer")
      expect(result.messages).toHaveLength(2)
      expect(result.participants).toEqual(["ceo", "engineer"])
    })

    it("should require at least 2 participants", async () => {
      const mockAdapter = createMockAdapter()
      const orchestrator = new RoundtableOrchestrator(mockAdapter)

      await expect(
        orchestrator.run({ goal: "x", participants: ["ceo"] }),
      ).rejects.toThrow("Roundtable requires at least 2 participants")
    })
  })
})
