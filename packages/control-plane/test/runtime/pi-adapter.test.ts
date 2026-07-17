import { describe, expect, test } from "bun:test"
import { PiRuntimeAdapter, type PiRuntimeEngine } from "../../src/runtime/pi/adapter"
import type { AgentRunEvent, AgentRunSpec } from "../../src/runtime"

const spec: AgentRunSpec = {
  runID: "run-1",
  agentID: "engineer",
  runtime: "pi",
  lifecycle: "on_demand",
  permissionMode: "workspace_write",
  cwd: "C:\\workspace",
  runtimeHome: "C:\\runtime",
  prompt: "Implement the task",
  systemPrompt: "You are an engineer",
  capabilityPacks: [],
  requiredRuntimeCapabilities: [],
}

describe("PiRuntimeAdapter", () => {
  test("normalizes a Pi run into AgentCompany events and result", async () => {
    const events: AgentRunEvent[] = []
    const adapter = new PiRuntimeAdapter(async () => ({
      async run(_prompt, onEvent) {
        onEvent("agent_start", {})
        onEvent("message", { text: "done" })
        onEvent("agent_end", {})
        return "done"
      },
      steer() {},
      followUp() {},
      abort() {},
    }))

    const result = await adapter.start(spec, (event) => events.push(event)).completion

    expect(result.runtime).toBe("pi")
    expect(result.content).toBe("done")
    expect(result.exitCode).toBe(0)
    expect(events.map((event) => event.type)).toEqual(["started", "runtime", "message", "runtime", "completed"])
  })

  test("routes live messages and interruption to the active Pi engine", async () => {
    let release!: () => void
    let steered = ""
    let followedUp = ""
    let aborted = false
    const engine: PiRuntimeEngine = {
      async run() {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return "stopped"
      },
      steer(content) {
        steered = content
      },
      followUp(content) {
        followedUp = content
      },
      abort() {
        aborted = true
        release()
      },
    }
    const adapter = new PiRuntimeAdapter(async () => engine)
    const handle = adapter.start(spec, () => {})
    await Bun.sleep(0)

    await adapter.deliver({ runID: spec.runID, content: "change direction", priority: "steer" })
    await adapter.deliver({ runID: spec.runID, content: "then summarize", priority: "follow_up" })
    expect(await adapter.interrupt(spec.runID)).toBe(true)
    await handle.completion

    expect(steered).toBe("change direction")
    expect(followedUp).toBe("then summarize")
    expect(aborted).toBe(true)
  })

  test("does not disguise a fresh run as session recovery", () => {
    const adapter = new PiRuntimeAdapter(async () => ({
      run: async () => "",
      steer() {},
      followUp() {},
      abort() {},
    }))
    expect(() => adapter.resume({ ...spec, resumeSessionID: "pi-session" }, () => {})).toThrow(
      "Pi runtime session resume is not available",
    )
  })
})
