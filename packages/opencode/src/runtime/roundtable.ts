import type { RuntimeAdapter } from "./interface"

// ---------------------------------------------------------------------------
// RoundtableMessage — an agent's single utterance in a roundtable.
// runtime metadata tells downstream consumers (TUI, logs) which backend
// produced the message and which runtime profile was used.
// ---------------------------------------------------------------------------
export interface RoundtableMessage {
  fromAgentId: string
  toAgentId: string
  content: string
  timestamp: number
  runtime?: {
    kind: string
    profileName?: string
  }
}

export interface RoundtableInput {
  goal: string
  participants: string[] // agent IDs in execution order
  context?: Record<string, unknown>
  timeout?: number
}

export interface RoundtableResult {
  participants: string[]
  messages: RoundtableMessage[]
  finalOutput: string
}

export class RoundtableOrchestrator {
  constructor(
    private readonly runtimeAdapter: RuntimeAdapter,
    private readonly onMessage?: (msg: RoundtableMessage) => Promise<void>,
  ) {}

  async run(input: RoundtableInput): Promise<RoundtableResult> {
    const { goal, participants, context, timeout } = input

    if (participants.length < 2) {
      throw new Error("Roundtable requires at least 2 participants")
    }

    const messages: RoundtableMessage[] = []
    let currentMessage = goal

    // Execute the fixed roundtable flow — AgentCompany controls the schedule.
    for (let i = 0; i < participants.length; i++) {
      const fromAgentId = i === 0 ? "user" : participants[i - 1]
      const toAgentId = participants[i]

      // Build prompt: conversation history + current task.
      const prompt = this.buildPrompt(currentMessage, messages, toAgentId)

      // Run through the runtime adapter.
      const result = await this.runtimeAdapter.run({
        agentId: toAgentId,
        prompt,
        context,
        timeout,
      })

      // Build message with runtime metadata.
      const runtime =
        result.metadata && typeof result.metadata.profileName === "string"
          ? { kind: result.runtime, profileName: result.metadata.profileName }
          : { kind: result.runtime }

      const message: RoundtableMessage = {
        fromAgentId,
        toAgentId,
        content: result.content,
        timestamp: Date.now(),
        runtime,
      }

      messages.push(message)

      // Write to MessageBus (external handler or fallback).
      await this.writeToMessageBus(message)

      // Next agent receives this agent's output.
      currentMessage = result.content
    }

    const finalOutput = messages[messages.length - 1].content

    return { participants, messages, finalOutput }
  }

  // ---------------------------------------------------------------------------
  // Context building — AgentCompany, not Hermes, owns the context.
  // ---------------------------------------------------------------------------

  private buildPrompt(
    currentMessage: string,
    history: RoundtableMessage[],
    agentId: string,
  ): string {
    const sections: string[] = []

    sections.push(`You are agent: ${agentId}`)
    sections.push("")

    if (history.length > 0) {
      sections.push("## Conversation History")
      for (const msg of history) {
        sections.push(`[${msg.fromAgentId} → ${msg.toAgentId}]:`)
        sections.push(msg.content)
        sections.push("")
      }
    }

    sections.push("## Current Task")
    sections.push(currentMessage)

    return sections.join("\n")
  }

  // ---------------------------------------------------------------------------
  // MessageBus — every agent utterance enters AgentCompany's bus.
  // ---------------------------------------------------------------------------

  private async writeToMessageBus(message: RoundtableMessage): Promise<void> {
    if (this.onMessage) {
      await this.onMessage(message)
      return
    }
    // Fallback log when no external handler is wired.
    const runtimeTag = message.runtime
      ? `[runtime=${message.runtime.kind}]`
      : "[runtime=?]"
    console.log(
      `[MessageBus]${runtimeTag} ${message.fromAgentId} -> ${message.toAgentId}: ${message.content.substring(0, 100)}...`,
    )
  }
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

export function createRoundtable(
  runtimeAdapter: RuntimeAdapter,
  onMessage?: (msg: RoundtableMessage) => Promise<void>,
): RoundtableOrchestrator {
  return new RoundtableOrchestrator(runtimeAdapter, onMessage)
}

/** Standard fixed roundtable: user → ceo → engineer → reviewer → ceo. */
export async function runStandardRoundtable(
  runtimeAdapter: RuntimeAdapter,
  goal: string,
  onMessage?: (msg: RoundtableMessage) => Promise<void>,
): Promise<RoundtableResult> {
  const orchestrator = createRoundtable(runtimeAdapter, onMessage)
  return orchestrator.run({
    goal,
    participants: ["ceo", "engineer", "reviewer", "ceo"],
  })
}
