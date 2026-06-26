import { cmd } from "./cmd"
import { HermesProfileCompiler } from "../../runtime/hermes/compiler"
import { HermesRuntimeAdapter } from "../../runtime/hermes/adapter"
import { FileBindingStore } from "../../runtime/hermes/binding-store"
import { runStandardRoundtable } from "../../runtime/roundtable"
import { runDoctor, formatDoctorReport } from "../../runtime/hermes/doctor"
import type { AgentProfile } from "../../runtime/interface"
import type { HermesRuntimeConfig } from "../../runtime/hermes/types"
import type { Argv } from "yargs"

const defaultConfig: HermesRuntimeConfig = {
  commandTemplate: "hermes -p <profileName> -z <prompt>",
  defaultTimeout: 300_000,
  profilePrefix: "agentcompany",
  bindingStorePath: ".agentcompany/runtime/hermes/bindings.json",
  cloneModePreferred: true,
}

function mockProfile(agentId: string): AgentProfile {
  return {
    id: agentId,
    name: agentId,
    description: `Agent ${agentId}`,
    persona: `You are ${agentId}.`,
    tools: ["read", "edit", "bash", "grep", "glob"],
    responsibilities: ["Execute tasks"],
  }
}

export const HermesCommand = cmd({
  command: "hermes",
  describe: "Hermes runtime operations",
  builder: (yargs: Argv) =>
    yargs
      // -------------------------------------------------------------------
      // doctor
      // -------------------------------------------------------------------
      .command(
        "doctor",
        "Run Hermes runtime health checks",
        (yargs) => yargs,
        async () => {
          const report = await runDoctor(defaultConfig)
          console.log(formatDoctorReport(report))
        },
      )
      // -------------------------------------------------------------------
      // compile
      // -------------------------------------------------------------------
      .command(
        "compile <agentId>",
        "Compile an agent profile to Hermes",
        (yargs) =>
          yargs.positional("agentId", {
            type: "string",
            describe: "Agent ID to compile",
            demandOption: true,
          }),
        async (args) => {
          const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
          const compiler = new HermesProfileCompiler(defaultConfig, bindingStore, process.cwd())

          console.log(`Compiling agent ${args.agentId}...`)
          const binding = await compiler.compile(args.agentId, mockProfile(args.agentId))
          console.log(`Compiled to profile: ${binding.profileName}`)
          console.log(`Hash: ${binding.compiledHash}`)
        },
      )
      // -------------------------------------------------------------------
      // run
      // -------------------------------------------------------------------
      .command(
        "run <agentId> <prompt>",
        "Run an agent through Hermes",
        (yargs) =>
          yargs
            .positional("agentId", {
              type: "string",
              describe: "Agent ID to run",
              demandOption: true,
            })
            .positional("prompt", {
              type: "string",
              describe: "Prompt for the agent",
              demandOption: true,
            })
            .option("timeout", {
              type: "number",
              describe: "Timeout in milliseconds",
              default: 300000,
            }),
        async (args) => {
          const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
          const adapter = new HermesRuntimeAdapter(defaultConfig, bindingStore)

          console.log(`Running agent ${args.agentId}...`)
          const result = await adapter.run({
            agentId: args.agentId,
            prompt: args.prompt,
            timeout: args.timeout,
          })

          console.log("\n=== Output ===")
          console.log(result.content)
          console.log("\n=== Stats ===")
          console.log(`Runtime: ${result.runtime}`)
          console.log(`Exit code: ${result.exitCode}`)
          console.log(`Duration: ${result.finishedAt - result.startedAt}ms`)
        },
      )
      // -------------------------------------------------------------------
      // agent-create
      // -------------------------------------------------------------------
      .command(
        "agent-create <agentId>",
        "Create an agent and compile it to a Hermes profile",
        (yargs) =>
          yargs
            .positional("agentId", {
              type: "string",
              describe: "Agent ID (e.g. ceo, engineer, reviewer)",
              demandOption: true,
            })
            .option("name", {
              type: "string",
              describe: "Human-readable name",
            })
            .option("role", {
              type: "string",
              describe: "Role description (e.g. 'Chief Executive Officer')",
            })
            .option("persona", {
              type: "string",
              describe: "Stable identity persona text",
            })
            .option("model", {
              type: "string",
              describe: "Model identifier (provider/model)",
            }),
        async (args) => {
          const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
          const compiler = new HermesProfileCompiler(defaultConfig, bindingStore, process.cwd())

          const name = args.name ?? args.agentId
          const role = args.role ?? "General-purpose agent"

          const profile: AgentProfile = {
            id: args.agentId,
            name,
            role,
            description: role,
            persona:
              args.persona ??
              `You are ${name}, ${role.toLowerCase()}. You are participating in a multi-agent system managed by AgentCompany. Respond as ${name}. Do not control the system schedule.`,
            tools: ["read", "edit", "bash", "grep", "glob"],
            responsibilities: [role],
            model: args.model,
          }

          console.log(`Creating agent "${args.agentId}" (${name})...`)
          const binding = await compiler.compile(args.agentId, profile)
          console.log(`Compiled to Hermes profile: ${binding.profileName}`)
          console.log(`Hash: ${binding.compiledHash}`)
        },
      )
      // -------------------------------------------------------------------
      // roundtable
      // -------------------------------------------------------------------
      .command(
        "roundtable <goal>",
        "Run a fixed roundtable: user → ceo → engineer → reviewer → ceo",
        (yargs) =>
          yargs.positional("goal", {
            type: "string",
            describe: "Goal or task description for the roundtable",
            demandOption: true,
          }),
        async (args) => {
          const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
          const adapter = new HermesRuntimeAdapter(defaultConfig, bindingStore)

          console.log("Starting roundtable discussion...")
          console.log(`Goal: ${args.goal}\n`)

          // Collect messages through MessageBus callback.
          const messages: Array<{ from: string; to: string; content: string; runtime: string }> = []
          const result = await runStandardRoundtable(adapter, args.goal, async (msg) => {
            messages.push({
              from: msg.fromAgentId,
              to: msg.toAgentId,
              content: msg.content,
              runtime: msg.runtime?.kind ?? "?",
            })
            // Log to MessageBus.
            const kind = msg.runtime?.kind ?? "?"
            const profile = msg.runtime?.profileName ?? "?"
            console.log(`[MessageBus runtime=${kind}/${profile}] ${msg.fromAgentId} -> ${msg.toAgentId}`)
          })

          // Print full output.
          console.log("\n" + "━".repeat(60))
          for (const msg of messages) {
            console.log(`\n\x1b[1m[${msg.from} → ${msg.to}]\x1b[0m (${msg.runtime})`)
            console.log(msg.content)
          }

          // Mark final CEO message as user-facing output.
          console.log("\n" + "━".repeat(60))
          console.log("\x1b[1m=== User-Facing Output ===\x1b[0m")
          console.log(result.finalOutput)

          console.log(`\n--- ${result.participants.length} turns, ${result.messages.length} messages ---`)
        },
      )
      // -------------------------------------------------------------------
      // list
      // -------------------------------------------------------------------
      .command(
        "list",
        "List all compiled Hermes bindings",
        (yargs) => yargs,
        async () => {
          const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
          const bindings = await bindingStore.getAll()

          if (bindings.length === 0) {
            console.log("No bindings found.")
            return
          }

          console.log("Compiled Hermes bindings:")
          for (const binding of bindings) {
            console.log(`  ${binding.agentId} -> ${binding.profileName}`)
            console.log(`    Hash: ${binding.compiledHash}`)
            console.log(`    Compiled: ${new Date(binding.compiledAt).toISOString()}`)
          }
        },
      ),
  async handler() {
    console.log("Use 'agents hermes --help' to see available commands")
  },
})
