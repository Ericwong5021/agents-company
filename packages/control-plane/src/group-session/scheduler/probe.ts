import type { AddressedAs, Bid, BidLevel, BidType, ReactionEmoji } from "./bidding.types"
import { Stream, Effect, Ref } from "effect"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import type { ModelID, ProviderID } from "@/provider/schema"

export interface ProbeInput {
  persona: { name: string; role: string; description: string }
  brain?: { big?: string; small?: string }
  lastEvent: string
  transcript: string
  members: Array<{ name: string; role: string }>
  groupSessionID: string
  onPublicRationale?: (reason: string) => Effect.Effect<void>
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
    `Decide independently whether this agent should respond to the latest unread group message. Do not speak merely because of seniority, turn order, or to acknowledge prior speakers.`,
    `A human message deserves engagement from the group, not a reply from every agent. Use must for a direct request, blocker, correction, direct responsibility, or material objection; want for a distinct answer or action that materially advances the conversation; could for a non-essential addition that should normally stay silent; pass for agreement, acknowledgement, repetition, or no new value.`,
    `After another agent speaks, respond only to a direct ask, a material correction, or a necessary next action. If the latest visible message is your own, pass.`,
    `Use addressedAs=direct only when the user or another agent explicitly addresses this agent, mention for a role or @ mention, otherwise none.`,
    `When level is could or pass, optionally choose one lightweight reaction from 👀, ✅, 🎯, 👍, ❤️ if it communicates useful acknowledgement without adding a repetitive message. Omit reaction when silence is better.`,
    `Output ONLY a JSON object with fields: level, type, addressedAs, reason, and optional reaction.`,
    `reason must be a complete public decision note in the language of the last event: explain relevance, distinct value or why passing, material risk or opportunity, and the proposed next action. Do not reveal private hidden reasoning.`,
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
    const reaction = typeof parsed.reaction === "string" && ["👀", "✅", "🎯", "👍", "❤️"].includes(parsed.reaction)
      ? parsed.reaction as ReactionEmoji
      : undefined
    return {
      level,
      type,
      addressedAs,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 1200) : "",
      reaction,
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
    const model = yield* ctx.provider.resolveBrainModel(input.brain ?? {}, "support", ctx.model?.providerID)
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

    const text = yield* Ref.make("")
    yield* ctx.llm
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
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const raw = (yield* Ref.get(text)) + event.text
            yield* Ref.set(text, raw)
            const reason = partialPublicRationale(raw)
            if (reason && input.onPublicRationale) yield* input.onPublicRationale(reason)
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )

    return parseBid(yield* Ref.get(text))
  }).pipe(Effect.catchCause(() => Effect.succeed(fallbackPass("probe call failed"))))
}

function partialPublicRationale(raw: string) {
  const start = raw.match(/"reason"\s*:\s*"([\s\S]*)$/)?.[1]
  if (!start) return undefined
  const content = start.match(/^((?:\\.|[^"\\])*)/)?.[1] ?? start
  const reason = content
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\")
    .trim()
  return reason.length ? reason.slice(0, 1200) : undefined
}
