import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import type { AgentRunSpec } from "../interface"
import type { PiRuntimeEngine, PiRuntimeEngineFactory, PiRuntimeEventType } from "./adapter"

type EngineOptions = {
  resolveModel(spec: AgentRunSpec): Promise<{ model: Model<string>; idleTimeoutMs?: number }>
  getApiKey(provider: string): Promise<string | undefined>
  getTools?(spec: AgentRunSpec): Promise<AgentTool[]>
  authorizeTool?(spec: AgentRunSpec, toolName: string, args: unknown): Promise<string | undefined>
}

const writeTools = new Set(["edit", "write", "apply_patch", "notebook_edit", "change_directory"])

export function buildPiSystemPrompt(systemPrompt: string, outputSchema?: Record<string, unknown>) {
  if (!outputSchema) return systemPrompt
  return [
    systemPrompt,
    "## Required output contract",
    "Return only one JSON value that conforms to this JSON Schema. Do not wrap it in Markdown or add explanatory text.",
    JSON.stringify(outputSchema),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function createPiTurnBudget(maxTurns?: number) {
  let turns = 0
  return () => {
    if (maxTurns && turns >= maxTurns) throw new Error(`Pi runtime exceeded its maximum turn budget of ${maxTurns}`)
    return ++turns
  }
}

export function createPiIdleTimer(input: {
  timeoutMs?: number
  abort(): void
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let runningTools = 0
  const cancel = () => {
    if (timer) (input.cancel ?? clearTimeout)(timer)
    timer = undefined
  }
  const reset = () => {
    cancel()
    if (!input.timeoutMs || runningTools > 0) return
    timer = (input.schedule ?? setTimeout)(input.abort, input.timeoutMs)
  }
  return {
    start: reset,
    stop: cancel,
    event(event: AgentEvent) {
      if (event.type === "tool_execution_start") {
        runningTools++
        cancel()
        return
      }
      if (event.type === "tool_execution_end") runningTools = Math.max(0, runningTools - 1)
      if (runningTools === 0) reset()
    },
  }
}

function payload(event: AgentEvent): Record<string, unknown> {
  if (event.type === "agent_start" || event.type === "turn_start") return {}
  if (event.type === "agent_end") return { messageCount: event.messages.length }
  if (event.type === "turn_end") return { message: event.message, toolResults: event.toolResults }
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    return { message: event.message }
  }
  return {
    toolCallID: event.toolCallId,
    toolName: event.toolName,
    ...(event.type === "tool_execution_start" || event.type === "tool_execution_update" ? { args: event.args } : {}),
    ...(event.type === "tool_execution_update" ? { partialResult: event.partialResult } : {}),
    ...(event.type === "tool_execution_end" ? { result: event.result, isError: event.isError } : {}),
  }
}

function eventType(event: AgentEvent): PiRuntimeEventType {
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") return "message"
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") return "tool"
  if (event.type === "turn_start" || event.type === "turn_end") return "turn"
  return event.type === "agent_start" ? "agent_start" : "agent_end"
}

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() }
}

function finalText(messages: AgentMessage[]) {
  const message = messages.findLast((item) => item.role === "assistant")
  if (!message || message.role !== "assistant") return ""
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
}

class CorePiRuntimeEngine implements PiRuntimeEngine {
  private readonly agent: Agent

  constructor(
    private readonly spec: AgentRunSpec,
    model: Model<string>,
    tools: AgentTool[],
    options: EngineOptions,
    private readonly idleTimeoutMs?: number,
  ) {
    const consumeTurn = createPiTurnBudget(spec.maxTurns)
    this.agent = new Agent({
      initialState: {
        systemPrompt: buildPiSystemPrompt(spec.systemPrompt, spec.outputSchema),
        model,
        thinkingLevel: spec.reasoningEffort ?? "off",
        tools,
      },
      transformContext: async (messages) => {
        consumeTurn()
        return messages
      },
      getApiKey: options.getApiKey,
      beforeToolCall: async (context) => {
        if (spec.permissionMode === "read_only" && writeTools.has(context.toolCall.name)) {
          return { block: true, reason: `Tool ${context.toolCall.name} is not allowed in read_only mode` }
        }
        const reason = await options.authorizeTool?.(spec, context.toolCall.name, context.args)
        return reason ? { block: true, reason } : undefined
      },
      steeringMode: "all",
      followUpMode: "one-at-a-time",
    })
  }

  async run(prompt: string, onEvent: (type: PiRuntimeEventType, payload: Record<string, unknown>) => void) {
    const idle = createPiIdleTimer({ timeoutMs: this.idleTimeoutMs, abort: () => this.agent.abort() })
    const unsubscribe = this.agent.subscribe((event) => {
      idle.event(event)
      onEvent(eventType(event), payload(event))
    })
    idle.start()
    try {
      await this.agent.prompt(prompt)
      if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage)
      return finalText(this.agent.state.messages)
    } finally {
      idle.stop()
      unsubscribe()
    }
  }

  steer(content: string) {
    this.agent.steer(userMessage(content))
  }

  followUp(content: string) {
    this.agent.followUp(userMessage(content))
  }

  abort() {
    this.agent.abort()
  }
}

export function createPiRuntimeEngineFactory(options: EngineOptions): PiRuntimeEngineFactory {
  return async (spec) => {
    const [resolved, tools] = await Promise.all([options.resolveModel(spec), options.getTools?.(spec) ?? []])
    return new CorePiRuntimeEngine(spec, resolved.model, tools, options, resolved.idleTimeoutMs)
  }
}
