import type { AgentRuntimePort, RuntimeCapabilities, RuntimeID } from "./interface"
import { RuntimeRegistry } from "./registry"

export type RuntimeResolutionInput = {
  explicitRuntime?: RuntimeID
  workflowRuntime?: RuntimeID
  agentRuntime?: RuntimeID
  requiredCapabilities?: Array<keyof RuntimeCapabilities>
}

export class RuntimeResolver {
  constructor(private readonly registry: RuntimeRegistry) {}

  async resolve(input: RuntimeResolutionInput): Promise<AgentRuntimePort> {
    const runtime = input.explicitRuntime ?? input.workflowRuntime ?? input.agentRuntime ?? "codex"
    const port = this.registry.get(runtime)
    if (!port) {
      const prefix = input.explicitRuntime ? "Explicit runtime" : "Runtime"
      throw new Error(`${prefix} ${runtime} is unavailable`)
    }
    const availability = await port.discover()
    if (!availability.available) {
      const prefix = input.explicitRuntime ? "Explicit runtime" : "Runtime"
      throw new Error(`${prefix} ${runtime} is unavailable${availability.reason ? `: ${availability.reason}` : ""}`)
    }
    const capabilities = port.capabilities()
    const missing = (input.requiredCapabilities ?? []).filter((capability) => !capabilities[capability])
    if (missing.length) throw new Error(`Runtime ${runtime} does not support required capabilities: ${missing.join(", ")}`)
    return port
  }
}
