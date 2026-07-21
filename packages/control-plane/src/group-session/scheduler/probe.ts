import type { Bid, BidLevel, BidType, AddressedAs } from "./bidding.types"
import { Stream, Effect } from "effect"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import type { ModelID, ProviderID } from "@/provider/schema"

export interface ProbeInput {
  persona: { name: string; role: string; description: string }
  lastEvent: string
  transcript: string
  members: Array<{ name: string; role: string }>
  groupSessionID: string
}

export function buildProbePrompt(input: ProbeInput): string {
  const lines: string[] = [
    `<persona>`,
    `Name: ${input.persona.name}`,
    `Role: ${input.persona.role}`,
    `Description: ${input.persona.description}`,
    `</persona>`,
    ``,
    `<group_members>`,
    ...input.members.map((m) => `- ${m.name} (${m.role})`),
    `</group_members>`,
    ``,
    `<last_event>`,
    input.lastEvent,
    `</last_event>`,
    ``,
    `<recent_transcript>`,
    input.transcript,
    `</recent_transcript>`,
    ``,
    `Based on the above, is this agent interested in speaking now?`,
    `Output ONLY a JSON object with fields: level, type, addressedAs, reason.`,
  ]
  return lines.join("\n")
}

export function parseBid(raw: string): Bid {
  try {
    const trimmed = raw.trim()
    const start = trimmed.indexOf("{")
    if (start === -1) return fallbackPass("no JSON found")
    const json = trimmed.slice(start)
    const end = json.lastIndexOf("}")
    if (end === -1) return fallbackPass("no JSON found")
    const parsed = JSON.parse(json.slice(0, end + 1))
    const level = validateLevel(parsed.level)
    if (!level) return fallbackPass("invalid level")
    const type = parsed.type && ["objection", "answer", "question", "claim", "info", "support"].includes(parsed.type)
      ? (parsed.type as BidType)
      : ("info" as BidType)
    const addressedAs = parsed.addressedAs && ["direct", "mention", "none"].includes(parsed.addressedAs)
      ? (parsed.addressedAs as AddressedAs)
      : ("none" as AddressedAs)
    return {
      level,
      type,
      addressedAs,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
    }
  } catch {
    return fallbackPass("invalid JSON")
  }
}

function validateLevel(v: unknown): BidLevel | null {
  if (v === "must" || v === "want" || v === "could" || v === "pass") return v
  return null
}

function fallbackPass(reason: string): Bid {
  return { level: "pass", type: "info", addressedAs: "none", reason: `fallback: ${reason}` }
}

/**
 * Context object holding services needed by probeOne.
 * Injected by the caller (group-session.ts chat()) to avoid Layer dependency bloat.
 */
export interface ProbeCtx {
  agentSvc: Agent.Interface
  provider: Provider.Interface
  llm: LLM.Interface
  probeAgent?: Agent.Info
  model?: { providerID: ProviderID; modelID: ModelID }
}

/**
 * Run a probe for one member agent using the provided service context.
 * Calls the probe LLM (small model, no tools), parses the JSON bid result.
 * Always succeeds — any failure degrades to pass.
 */
export function probeOne(
  ctx: ProbeCtx,
  input: ProbeInput,
): Effect.Effect<Bid> {
  return Effect.gen(function* () {
    const probeAgent = ctx.probeAgent
    if (!probeAgent) return fallbackPass("probe agent unavailable")
    const model = ctx.model
      ? yield* ctx.provider.getModel(ctx.model.providerID, ctx.model.modelID)
      : yield* Effect.gen(function* () {
          const defaultConfig = yield* ctx.provider.defaultModel()
          return (
            (yield* ctx.provider.getSmallModel(defaultConfig.providerID)) ??
            (yield* ctx.provider.getModel(defaultConfig.providerID, defaultConfig.modelID))
          )
        })
    if (!model) return fallbackPass("no model available")

    const probePrompt = buildProbePrompt(input)

    const userModel = { providerID: model.providerID, modelID: model.id }

    const user: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: undefined as any,
      role: "user",
      agent: "probe",
      model: userModel,
      time: { created: Date.now() },
    }

    const text = yield* ctx.llm
      .stream({
        agent: probeAgent,
        user,
        system: [],
        prebuiltSystem: [probePrompt],
        small: true,
        tools: {},
        model: model as any,
        sessionID: input.groupSessionID,
        retries: 1,
        messages: [],
      })
      .pipe(
        Stream.filter((e) => "type" in e && e.type === "text-delta"),
        Stream.map((e: any) => e.text),
        Stream.mkString,
        Effect.orElseSucceed(() => ""),
      )

    return parseBid(text)
  }).pipe(Effect.catchCause(() => Effect.succeed(fallbackPass("probe call failed"))))
}
