import { Effect } from "effect"
import { CompanyAgent } from "@/company-agent"
import { Config } from "@/config"
import type { CompanyAgentID } from "@/company-agent/schema"
import { resolve as resolveWorkspaceContext } from "@/workspace/context-resolver"
import type { OrgStructure } from "@/workspace/clearance"

export type PrepareInput = {
  agentID: CompanyAgentID
  transcript: string
  message: string
  companyAgents: CompanyAgent.Interface
  config: Config.Interface
}

export type Prepared = {
  runtime: "pi" | "codex" | "claude-code"
  brain: {
    big: string
    small: string
  }
  systemPrompt: string
  prompt: string
}

function section(name: string, content?: string) {
  return content?.trim() ? `<${name}>\n${content.trim()}\n</${name}>` : undefined
}

export const prepare = Effect.fn("AgentTurn.prepare")(function* (input: PrepareInput) {
  const agent = yield* input.companyAgents.get(input.agentID)
  if (!agent) return yield* Effect.die(new Error(`Company agent was not found: ${input.agentID}`))

  const workspace = yield* resolveWorkspaceContext(input.agentID, (yield* input.config.get()).org as OrgStructure | undefined).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  const systemPrompt = [
    section("agent_identity", agent.system_prompt),
    section("agent_instructions", agent.instruct),
    section("agent_relationships", agent.relationships),
    section("agent_workspace_context", workspace?.standingSummary),
    "Speak naturally as this person in a live group conversation. Your responsibilities guide what you notice and decide; they do not require a fixed response format. Prefer one concise message that directly advances the latest point.",
  ]
    .filter(Boolean)
    .join("\n\n")

  return {
    runtime:
      agent.preferred_runtime === "pi" || agent.preferred_runtime === "claude-code" ? agent.preferred_runtime : "codex",
    brain: {
      big: agent.model,
      small: agent.small_model,
    },
    systemPrompt,
    prompt: [
      input.transcript,
      `<current_message>\n${input.message}\n</current_message>`,
      "Respond to the latest message in context. Do not repeat the transcript, summarize everyone, announce your role, or invent a formal review unless the conversation requires one.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  } satisfies Prepared
})

export * as AgentTurn from "./agent-turn"
