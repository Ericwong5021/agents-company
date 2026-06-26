/**
 * Example: Using Hermes Runtime with AgentCompany
 *
 * This demonstrates how to:
 * 1. Set up the Hermes runtime
 * 2. Compile agent profiles into Hermes profiles
 * 3. Run agents through Hermes
 * 4. Execute a roundtable discussion
 */

import { HermesProfileCompiler } from "./hermes/compiler"
import { HermesRuntimeAdapter } from "./hermes/adapter"
import { FileBindingStore } from "./hermes/binding-store"
import { RoundtableOrchestrator, runStandardRoundtable } from "./roundtable"
import type { AgentProfile } from "./interface"
import type { HermesRuntimeConfig } from "./hermes/types"

// Example configuration
const config: HermesRuntimeConfig = {
  commandTemplate: "hermes -p <profileName> -z <prompt>",
  defaultTimeout: 300_000, // 5 minutes
  profilePrefix: "agentcompany",
  bindingStorePath: ".agentcompany/runtime/hermes/bindings.json",
  cloneModePreferred: true,
  defaultCloneSource: "default",
}

// Helper to create a mock agent profile for testing
function createMockProfile(id: string, name: string, description: string): AgentProfile {
  return {
    id,
    name,
    description,
    persona: `You are ${name}. ${description}`,
    tools: ["read", "edit", "bash", "grep", "glob"],
    responsibilities: ["Execute assigned tasks", "Report progress"],
  }
}

export async function exampleBasicUsage() {
  // Initialize components
  const bindingStore = new FileBindingStore(config.bindingStorePath)
  const compiler = new HermesProfileCompiler(config, bindingStore, process.cwd())
  const adapter = new HermesRuntimeAdapter(config, bindingStore)

  // Create mock agent profiles
  const ceoProfile = createMockProfile("ceo", "CEO", "Chief Executive Officer")
  const engineerProfile = createMockProfile("engineer", "Engineer", "Software Engineer")
  const reviewerProfile = createMockProfile("reviewer", "Reviewer", "Code Reviewer")

  // Compile agents (creates Hermes profiles if needed)
  console.log("Compiling agent profiles...")
  const ceoBinding = await compiler.compile("ceo", ceoProfile)
  const engineerBinding = await compiler.compile("engineer", engineerProfile)
  const reviewerBinding = await compiler.compile("reviewer", reviewerProfile)

  console.log("Bindings created:", {
    ceo: ceoBinding.profileName,
    engineer: engineerBinding.profileName,
    reviewer: reviewerBinding.profileName,
  })

  // Run a single agent
  console.log("\nRunning CEO agent...")
  const ceoResult = await adapter.run({
    agentId: "ceo",
    prompt: "Analyze the current project status and provide strategic guidance.",
    timeout: 60_000,
  })

  console.log("CEO output:", ceoResult.content)
  console.log("Exit code:", ceoResult.exitCode)
  console.log("Duration:", ceoResult.finishedAt - ceoResult.startedAt, "ms")
}

export async function exampleRoundtable() {
  // Initialize components
  const bindingStore = new FileBindingStore(config.bindingStorePath)
  const compiler = new HermesProfileCompiler(config, bindingStore, process.cwd())
  const adapter = new HermesRuntimeAdapter(config, bindingStore)

  // Create mock profiles
  const ceoProfile = createMockProfile("ceo", "CEO", "Chief Executive Officer")
  const engineerProfile = createMockProfile("engineer", "Engineer", "Software Engineer")
  const reviewerProfile = createMockProfile("reviewer", "Reviewer", "Code Reviewer")

  // Compile all agents first
  await compiler.compile("ceo", ceoProfile)
  await compiler.compile("engineer", engineerProfile)
  await compiler.compile("reviewer", reviewerProfile)

  // Run standard roundtable
  console.log("\nStarting roundtable discussion...")
  const result = await runStandardRoundtable(
    adapter,
    "We need to implement a new feature for user authentication. Please discuss the approach and provide a plan.",
  )

  console.log("\nRoundtable completed!")
  console.log("Participants:", result.participants)
  console.log("\nMessages:")
  for (const msg of result.messages) {
    console.log(`[${msg.fromAgentId} → ${msg.toAgentId}]:`)
    console.log(msg.content.substring(0, 200) + "...")
    console.log("")
  }
  console.log("\nFinal output:", result.finalOutput)
}

export async function exampleCustomRoundtable() {
  const bindingStore = new FileBindingStore(config.bindingStorePath)
  const compiler = new HermesProfileCompiler(config, bindingStore, process.cwd())
  const adapter = new HermesRuntimeAdapter(config, bindingStore)

  // Create mock profiles
  const agents = {
    ceo: createMockProfile("ceo", "CEO", "Chief Executive Officer"),
    cto: createMockProfile("cto", "CTO", "Chief Technology Officer"),
    engineer: createMockProfile("engineer", "Engineer", "Software Engineer"),
    reviewer: createMockProfile("reviewer", "Reviewer", "Code Reviewer"),
    qa: createMockProfile("qa", "QA", "Quality Assurance Engineer"),
  }

  // Compile agents
  await compiler.compile("ceo", agents.ceo)
  await compiler.compile("cto", agents.cto)
  await compiler.compile("engineer", agents.engineer)
  await compiler.compile("reviewer", agents.reviewer)
  await compiler.compile("qa", agents.qa)

  // Custom roundtable with more participants
  const orchestrator = new RoundtableOrchestrator(adapter)
  const result = await orchestrator.run({
    goal: "Review and approve the new API design for the payment system.",
    participants: ["ceo", "cto", "engineer", "reviewer", "qa", "ceo"],
    context: {
      project: "payment-service",
      deadline: "2024-02-01",
    },
    timeout: 120_000,
  })

  console.log("Custom roundtable result:", result)
}

// Run examples if executed directly
if (import.meta.main) {
  exampleBasicUsage()
    .then(() => exampleRoundtable())
    .catch(console.error)
}
