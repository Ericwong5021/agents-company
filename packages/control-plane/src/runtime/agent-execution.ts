import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { createCliRuntimeAdapter } from "./cli-adapter"
import type { AgentRunEvent, AgentRunHandle, AgentRunSpec, RuntimeID, RuntimeMessage } from "./interface"
import { RuntimeRegistry } from "./registry"

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/

export type RuntimeHome = {
  root: string
  home: string
  logs: string
  skills: string
}

export async function createRuntimeHome(input: { root: string; runID: string; runtime: RuntimeID }): Promise<RuntimeHome> {
  if (!SAFE_RUN_ID.test(input.runID)) throw new Error(`Invalid Agent Run id: ${input.runID}`)
  const root = path.resolve(input.root)
  const runRoot = path.resolve(root, input.runID)
  if (!runRoot.startsWith(`${root}${path.sep}`)) throw new Error("Agent Run path escapes the runtime root")
  const home = path.join(runRoot, "home")
  const logs = path.join(runRoot, "logs")
  const skills = path.join(runRoot, "skills")
  await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(logs, { recursive: true, mode: 0o700 }), mkdir(skills, { recursive: true, mode: 0o700 })])
  await writeFile(path.join(runRoot, "runtime.json"), JSON.stringify({ run_id: input.runID, runtime: input.runtime, created_at: Date.now() }), { mode: 0o600 })
  return { root: runRoot, home, logs, skills }
}

export class AgentExecutionSupervisor {
  private readonly active = new Map<string, { handle: AgentRunHandle; runtime: RuntimeID }>()

  constructor(
    private readonly registry = new RuntimeRegistry([
      createCliRuntimeAdapter("codex"),
      createCliRuntimeAdapter("claude-code"),
    ]),
  ) {}

  start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void) {
    if (this.active.has(input.runID)) throw new Error(`Agent Run ${input.runID} is already active`)
    const adapter = this.registry.get(input.runtime)
    if (!adapter) throw new Error(`Runtime ${input.runtime} is unavailable`)
    const handle = adapter.start(input, onEvent)
    this.active.set(input.runID, { handle, runtime: input.runtime })
    void handle.completion.finally(() => this.active.delete(input.runID))
    return handle
  }

  async interrupt(runID: string) {
    const active = this.active.get(runID)
    if (!active) return false
    active.handle.interrupt()
    return true
  }

  async deliver(message: RuntimeMessage) {
    const active = this.active.get(message.runID)
    if (!active) throw new Error(`Agent Run ${message.runID} is not active`)
    await this.registry.get(active.runtime)!.deliver(message)
  }

  async stop(runID: string) {
    const active = this.active.get(runID)
    if (!active) return false
    return this.registry.get(active.runtime)!.stop(runID)
  }
}
