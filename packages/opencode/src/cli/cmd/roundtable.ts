import { cmd } from "./cmd"
import { HermesRuntimeAdapter } from "../../runtime/hermes/adapter"
import { FileBindingStore } from "../../runtime/hermes/binding-store"
import { runStandardRoundtable } from "../../runtime/roundtable"
import type { HermesRuntimeConfig } from "../../runtime/hermes/types"
import type { Argv } from "yargs"

const defaultConfig: HermesRuntimeConfig = {
  commandTemplate: "hermes -p <profileName> -z <prompt>",
  defaultTimeout: 300_000,
  profilePrefix: "agentcompany",
  bindingStorePath: ".agentcompany/runtime/hermes/bindings.json",
  cloneModePreferred: true,
}

export const RoundtableCommand = cmd({
  command: "roundtable <goal>",
  describe: "Run a multi-agent roundtable (default runtime: Hermes)",
  builder: (yargs: Argv) =>
    yargs
      .positional("goal", {
        type: "string",
        describe: "Goal or task description",
        demandOption: true,
      })
      .option("timeout", {
        type: "number",
        describe: "Timeout per agent in milliseconds",
        default: 300000,
      }),
  async handler(args) {
    const bindingStore = new FileBindingStore(defaultConfig.bindingStorePath)
    const adapter = new HermesRuntimeAdapter(defaultConfig, bindingStore)

    console.log("")
    console.log(`  Roundtable (runtime: Hermes)`)
    console.log(`  Goal: ${args.goal}`)
    console.log("")

    const messages: Array<{ from: string; to: string; content: string; runtime: string }> = []
    const result = await runStandardRoundtable(adapter, args.goal, async (msg) => {
      messages.push({
        from: msg.fromAgentId,
        to: msg.toAgentId,
        content: msg.content,
        runtime: msg.runtime?.kind ?? "?",
      })
      const kind = msg.runtime?.kind ?? "?"
      console.log(`[MessageBus runtime=${kind}] ${msg.fromAgentId} -> ${msg.toAgentId}`)
    })

    // Full transcript.
    console.log("\n" + "━".repeat(60))
    for (const msg of messages) {
      console.log(`\n\x1b[1m[${msg.from} → ${msg.to}]\x1b[0m (${msg.runtime})`)
      console.log(msg.content)
    }

    // Final CEO message is the user-facing output.
    console.log("\n" + "━".repeat(60))
    console.log("\n\x1b[1mResult:\x1b[0m")
    console.log(result.finalOutput)

    console.log(`\n${result.messages.length} messages across ${result.participants.length} turns`)
  },
})
