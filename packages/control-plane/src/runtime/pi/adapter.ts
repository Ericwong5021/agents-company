import type {
  AgentRunEvent,
  AgentRunHandle,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntimePort,
  RuntimeMessage,
} from "../interface"

export type PiRuntimeEventType = "agent_start" | "agent_end" | "turn" | "message" | "tool"

export interface PiRuntimeEngine {
  run(
    prompt: string,
    onEvent: (type: PiRuntimeEventType, payload: Record<string, unknown>) => void,
  ): Promise<string>
  steer(content: string): void
  followUp(content: string): void
  abort(): void
}

export type PiRuntimeEngineFactory = (spec: AgentRunSpec) => Promise<PiRuntimeEngine>

export class PiRuntimeAdapter implements AgentRuntimePort {
  readonly runtime = "pi" as const
  capabilities() {
    return {
      resume: false,
      interrupt: true,
      liveInput: true,
      structuredEvents: true,
      toolCalls: true,
      structuredOutput: true,
      workspaceRead: true,
      workspaceWrite: true,
      approvals: true,
      reasoningEffort: true,
      subagents: false,
      usageAccounting: true,
      dynamicSkills: true,
      governanceSignals: true,
    }
  }
  private readonly active = new Map<string, PiRuntimeEngine>()

  constructor(private readonly createEngine: PiRuntimeEngineFactory) {}

  async discover() {
    return {
      runtime: this.runtime,
      available: true,
      version: "0.80.7",
      authenticated: undefined,
    }
  }

  start(input: AgentRunSpec, onEvent: (event: AgentRunEvent) => void): AgentRunHandle {
    if (input.runtime !== this.runtime) throw new Error(`Runtime adapter pi cannot start ${input.runtime}`)
    const startedAt = Date.now()
    let sequence = 0
    let engine: PiRuntimeEngine | undefined
    const emit = (type: AgentRunEvent["type"], payload: Record<string, unknown>) =>
      onEvent({ runID: input.runID, sequence: sequence++, type, payload, time: Date.now() })
    const completion = (async (): Promise<AgentRunResult> => {
      emit("started", {
        runtime: this.runtime,
        cwd: input.cwd,
        permissionMode: input.permissionMode,
        capabilityPacks: input.capabilityPacks,
      })
      try {
        engine = await this.createEngine(input)
        this.active.set(input.runID, engine)
        const content = await engine.run(input.prompt, (type, payload) => {
          emit(type === "message" ? "message" : type === "tool" ? "tool" : "runtime", { piEvent: type, ...payload })
        })
        const result = {
          runID: input.runID,
          runtime: this.runtime,
          content,
          exitCode: 0,
          sessionID: input.runID,
          startedAt,
          finishedAt: Date.now(),
        }
        emit("completed", { content, exitCode: 0, sessionID: result.sessionID })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit("failed", { message, exitCode: 1 })
        return {
          runID: input.runID,
          runtime: this.runtime,
          content: "",
          exitCode: 1,
          sessionID: input.runID,
          startedAt,
          finishedAt: Date.now(),
        }
      } finally {
        if (engine && this.active.get(input.runID) === engine) this.active.delete(input.runID)
      }
    })()
    return {
      completion,
      interrupt() {
        engine?.abort()
      },
    }
  }

  resume(_input: AgentRunSpec, _onEvent: (event: AgentRunEvent) => void): AgentRunHandle {
    throw new Error("Pi runtime session resume is not available")
  }

  async deliver(message: RuntimeMessage) {
    const engine = this.active.get(message.runID)
    if (!engine) throw new Error(`Agent Run ${message.runID} is not active`)
    if (message.priority === "steer") engine.steer(message.content)
    if (message.priority === "follow_up") engine.followUp(message.content)
  }

  async interrupt(runID: string) {
    const engine = this.active.get(runID)
    if (!engine) return false
    engine.abort()
    return true
  }

  stop(runID: string) {
    return this.interrupt(runID)
  }
}
