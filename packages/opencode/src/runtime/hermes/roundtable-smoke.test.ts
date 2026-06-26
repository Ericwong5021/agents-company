import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import type { AgentProfile, RuntimeAdapter, AgentRunInput } from "../interface"
import { HermesProfileCompiler } from "./compiler"
import { HermesRuntimeAdapter } from "./adapter"
import { FileBindingStore } from "./binding-store"
import { RoundtableOrchestrator } from "../roundtable"
import type { RoundtableMessage } from "../roundtable"
import type { HermesRuntimeConfig } from "./types"

// ---------------------------------------------------------------------------
// Workspace smoke test — runs a full roundtable with a real mocked Hermes CLI.
// The mock simulates Hermes output so we can verify the full pipeline:
// compile → run → MessageBus → runtime.kind.
// ---------------------------------------------------------------------------

describe("Workspace smoke (Hermes roundtable)", () => {
  const testDir = path.join(process.cwd(), ".test-hermes-workspace-smoke")
  const hermesMockDir = path.join(testDir, "hermes-bin")

  const profileIds = ["ceo", "engineer", "reviewer"]
  const profiles: AgentProfile[] = [
    {
      id: "ceo",
      name: "CEO",
      role: "Chief Executive Officer",
      description: "Strategic decision-maker",
      persona: "You are the CEO. You make strategic decisions and provide direction.",
      tools: ["read", "bash"],
      responsibilities: ["Strategic planning", "Decision making"],
      workspace: { strategy: "shared-project", cwd: testDir },
    },
    {
      id: "engineer",
      name: "Engineer",
      role: "Software Engineer",
      description: "Implements solutions",
      persona: "You are an Engineer. You implement features and fix bugs.",
      tools: ["read", "edit", "bash", "grep", "glob"],
      responsibilities: ["Implementation", "Testing"],
      workspace: { strategy: "shared-project", cwd: testDir },
    },
    {
      id: "reviewer",
      name: "Reviewer",
      role: "Code Reviewer",
      description: "Reviews code and provides feedback",
      persona: "You are a Reviewer. You review code for quality, correctness, and security.",
      tools: ["read", "grep", "glob"],
      responsibilities: ["Code review", "Quality assurance"],
      workspace: { strategy: "shared-project", cwd: testDir },
    },
  ]

  let bindingStore: FileBindingStore
  let compiler: HermesProfileCompiler
  let adapter: HermesRuntimeAdapter
  let mockHermesPath: string

  beforeAll(async () => {
    // Clean up any leftover state.
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(testDir, { recursive: true })
    await fs.mkdir(hermesMockDir, { recursive: true })

    // Create a mock Hermes CLI that simulates a real agent response.
    // Each profile returns a response that includes the profile name and
    // mentions its role, to verify workspace context is being passed.
    mockHermesPath = path.join(hermesMockDir, "mock-hermes.sh")
    await fs.writeFile(
      mockHermesPath,
      `#!/bin/bash
# Mock Hermes CLI that simulates an agent response.
# Reads profile name from -p flag and prompt from -z flag.
echo "AgentCompany Hermes Runtime"
echo "Profile: $2"
echo "---"
echo "I am the $(echo $2 | sed 's/agentcompany-//') agent."
echo "I have received the task and will now respond."
echo "My response is: I understand the requirements and will proceed."
echo "I acknowledge the workspace context provided."
echo "---"
echo "END_OF_TURN"
exit 0
`,
    )
    await fs.chmod(mockHermesPath, 0o755)

    const config: HermesRuntimeConfig = {
      commandTemplate: `${mockHermesPath} -p <profileName> -z <prompt>`,
      defaultTimeout: 30_000,
      profilePrefix: "agentcompany",
      bindingStorePath: path.join(testDir, "bindings.json"),
      cloneModePreferred: false,
    }

    bindingStore = new FileBindingStore(config.bindingStorePath!)
    compiler = new HermesProfileCompiler(config, bindingStore, testDir)
    adapter = new HermesRuntimeAdapter(config, bindingStore)

    // Compile all profiles.
    for (let i = 0; i < profileIds.length; i++) {
      await compiler.compile(profileIds[i], profiles[i])
    }
  })

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should compile all 3 agent profiles to Hermes", async () => {
    for (const id of profileIds) {
      const compiled = await compiler.isCompiled(id)
      expect(compiled).toBe(true)
    }
  })

  it("should run a roundtable and produce messages with runtime.kind = 'hermes'", async () => {
    const messages: RoundtableMessage[] = []
    const orchestrator = new RoundtableOrchestrator(adapter, async (msg) => {
      messages.push(msg)
    })

    const result = await orchestrator.run({
      goal: "Discuss how to implement user authentication for the project. Provide a plan.",
      participants: ["ceo", "engineer", "reviewer", "ceo"],
    })

    // 1. All messages should have runtime metadata set to "hermes".
    for (const msg of messages) {
      expect(msg.runtime).toBeDefined()
      expect(msg.runtime!.kind).toBe("hermes")
      expect(msg.runtime!.profileName).toMatch(/^agentcompany-/)
    }

    // 2. The roundtable should produce messages in the correct order.
    expect(messages.map((m) => m.fromAgentId)).toEqual([
      "user",
      "ceo",
      "engineer",
      "reviewer",
    ])
    expect(messages.map((m) => m.toAgentId)).toEqual([
      "ceo",
      "engineer",
      "reviewer",
      "ceo",
    ])

    // 3. Each message should contain the simulated Hermes response.
    for (const msg of messages) {
      expect(msg.content).toContain("AgentCompany Hermes Runtime")
    }

    // 4. Final output is the last CEO message.
    expect(result.finalOutput).toBe(messages[messages.length - 1].content)
    expect(result.participants).toEqual(["ceo", "engineer", "reviewer", "ceo"])
  })

  it("should inject workspace context into agent prompts", async () => {
    // Track the prompts received by each agent.
    const prompts: Array<{ agentId: string; prompt: string }> = []
    const trackingAdapter: RuntimeAdapter = {
      runtimeType: "hermes",
      async run(input: AgentRunInput) {
        prompts.push({ agentId: input.agentId, prompt: input.prompt })
        return {
          agentId: input.agentId,
          runtime: "hermes",
          content: `Response from ${input.agentId}`,
          rawStdout: `Response from ${input.agentId}`,
          exitCode: 0,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          metadata: { profileName: `agentcompany-${input.agentId}` },
        }
      },
    }

    const messages: RoundtableMessage[] = []
    const orchestrator = new RoundtableOrchestrator(trackingAdapter, async (msg) => {
      messages.push(msg)
    })

    await orchestrator.run({
      goal: "Implement authentication",
      participants: ["ceo", "engineer", "reviewer", "ceo"],
    })

    // The CEO's first prompt should contain the goal.
    expect(prompts[0].prompt).toContain("Implement authentication")

    // The engineer's prompt should contain conversation history from CEO.
    expect(prompts[1].prompt).toContain("## Conversation History")
    expect(prompts[1].prompt).toContain("Response from ceo")

    // The reviewer's prompt should contain both CEO and engineer responses.
    expect(prompts[2].prompt).toContain("## Conversation History")
    expect(prompts[2].prompt).toContain("Response from ceo")
    expect(prompts[2].prompt).toContain("Response from engineer")
  })

  it("should have all messages flowing through MessageBus", async () => {
    const messages: RoundtableMessage[] = []
    const orchestrator = new RoundtableOrchestrator(adapter, async (msg) => {
      messages.push(msg)
    })

    await orchestrator.run({
      goal: "Test",
      participants: ["ceo", "engineer", "reviewer", "ceo"],
    })

    // Every agent response should be in MessageBus.
    expect(messages).toHaveLength(4)
    for (const msg of messages) {
      expect(msg.fromAgentId).toBeTruthy()
      expect(msg.toAgentId).toBeTruthy()
      expect(msg.content).toBeTruthy()
      expect(msg.timestamp).toBeGreaterThan(0)
      expect(msg.runtime).toBeDefined()
    }

    // Verify runtime.kind = "hermes" on every message.
    for (const msg of messages) {
      expect(msg.runtime!.kind).toBe("hermes")
    }
  })
})
