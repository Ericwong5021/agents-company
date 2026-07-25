import { generateObject, NoObjectGeneratedError } from "ai"
import { Effect } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { createHash } from "node:crypto"
import z from "zod"
import {
  GoalBriefDraft,
  GoalBriefGenerateRequest,
  GoalBriefStructuredFailure,
  type GoalBrief as GoalBriefValue,
  type GoalBriefGenerateRequest as GoalBriefGenerateRequestValue,
  type GoalBriefStructuredFailure as GoalBriefStructuredFailureValue,
} from "@agents-company/shared/experience"
import { EffectBridge } from "@/effect"
import { Provider } from "@/provider"
import {
  completeGeneration,
  create,
  extendGenerationLease,
  parseModelOutput,
  releaseGeneration,
  reserveGeneration,
} from "./goal-brief"

export const GoalBriefModelProvider = z.enum(["openai_compatible", "anthropic_compatible"])
export type GoalBriefModelProvider = z.infer<typeof GoalBriefModelProvider>

export type GoalBriefModelRequest = {
  provider: GoalBriefModelProvider
  attempt: number
  mode: "generate" | "repair"
  previousError?: string
  schema: typeof GoalBriefDraft
}

export class GoalBriefModelAdaptationError extends Error {
  readonly provider: GoalBriefModelProvider
  readonly attempts: number
  readonly recoveryActions = ["retry", "manual_edit"] as const

  constructor(provider: GoalBriefModelProvider, attempts: number) {
    super("未能生成完整 Goal Brief。你可以重试，或手动补充目标信息。")
    this.name = "GoalBriefModelAdaptationError"
    this.provider = provider
    this.attempts = attempts
  }

  toApiError(): GoalBriefStructuredFailureValue {
    return GoalBriefStructuredFailure.parse({
      code: "goal_brief_structured_output_failed",
      message: this.message,
      attempts: this.attempts,
      recoveryActions: this.recoveryActions,
    })
  }
}

export class GoalBriefRequestConflictError extends Error {
  constructor(readonly requestID: string) {
    super("同一 requestId 已用于不同的 Goal Brief 生成请求。")
    this.name = "GoalBriefRequestConflictError"
  }
}

export class GoalBriefRequestInProgressError extends Error {
  constructor(readonly requestID: string) {
    super("该 requestId 对应的 Goal Brief 正在生成中。")
    this.name = "GoalBriefRequestInProgressError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function providerValue(provider: GoalBriefModelProvider, value: unknown) {
  if (provider === "openai_compatible" && record(value) && "output" in value) return value.output
  if (provider === "anthropic_compatible" && record(value) && "input" in value) return value.input
  return value
}

function parse(provider: GoalBriefModelProvider, value: unknown) {
  const candidate = providerValue(provider, value)
  return typeof candidate === "string" ? parseModelOutput(candidate) : GoalBriefDraft.parse(candidate)
}

function issue(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 5)
      .map((item) => `${item.path.join(".") || "root"}: ${item.message}`)
      .join("; ")
  if (error instanceof Error) return error.message.slice(0, 1_000)
  return "Unknown structured output error"
}

export async function adapt(input: {
  provider: GoalBriefModelProvider
  generate: (request: GoalBriefModelRequest) => Promise<unknown>
  maxRepairAttempts?: number
}) {
  const provider = GoalBriefModelProvider.parse(input.provider)
  const maxRepairAttempts = z
    .number()
    .int()
    .min(0)
    .max(2)
    .parse(input.maxRepairAttempts ?? 2)

  const run = async (attempt: number, previousError?: string): Promise<z.infer<typeof GoalBriefDraft>> => {
    const generated = await input.generate({
      provider,
      attempt,
      mode: attempt === 1 ? "generate" : "repair",
      previousError,
      schema: GoalBriefDraft,
    })
    try {
      return parse(provider, generated)
    } catch (error) {
      const lastIssue = issue(error)
      if (attempt > maxRepairAttempts) throw new GoalBriefModelAdaptationError(provider, attempt)
      return run(attempt + 1, lastIssue)
    }
  }

  return run(1)
}

export async function createFromModel(input: {
  provider: GoalBriefModelProvider
  generate: (request: GoalBriefModelRequest) => Promise<unknown>
  maxRepairAttempts?: number
  projectId?: string
  sourceThreadId?: string
}): Promise<GoalBriefValue> {
  return create({
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId,
    source: "system_suggestion",
    brief: await adapt(input),
  })
}

const GeneratedGoalBriefDraft = GoalBriefDraft.omit({ sourceRefs: true })

export type GoalBriefStructuredGenerationCall = {
  model: LanguageModelV3
  system: string
  prompt: string
  schema: typeof GeneratedGoalBriefDraft
}

export type GoalBriefGenerationDependencies = {
  resolveDefaultModel: () => Promise<{
    adapterProvider: GoalBriefModelProvider
    model: LanguageModelV3
  }>
  generate: (input: GoalBriefStructuredGenerationCall) => Promise<unknown>
}

async function generateStructured(input: GoalBriefStructuredGenerationCall) {
  try {
    return (
      await generateObject({
        model: input.model,
        schema: input.schema,
        temperature: 0,
        system: input.system,
        prompt: input.prompt,
      })
    ).object
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text !== undefined) return error.text
    throw error
  }
}

const inFlight = new Map<
  string,
  {
    payloadHash: string
    promise: Promise<GoalBriefValue>
  }
>()

function generationPayloadHash(input: ReturnType<typeof GoalBriefGenerateRequest.parse>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestId: input.requestId,
        goal: input.goal,
        context: input.context ?? null,
        projectId: input.projectId ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
      }),
    )
    .digest("hex")
}

export async function generateAndCreate(
  inputValue: GoalBriefGenerateRequestValue,
  dependencies: GoalBriefGenerationDependencies,
) {
  const input = GoalBriefGenerateRequest.parse(inputValue)
  const payloadHash = generationPayloadHash(input)
  const existing = inFlight.get(input.requestId)
  if (existing?.payloadHash !== undefined && existing.payloadHash !== payloadHash)
    throw new GoalBriefRequestConflictError(input.requestId)
  if (existing) return existing.promise
  const ownerToken = crypto.randomUUID()
  const reservation = reserveGeneration(input.requestId, payloadHash, ownerToken)
  if (reservation.status === "conflict") throw new GoalBriefRequestConflictError(input.requestId)
  if (reservation.status === "completed") return reservation.brief
  if (reservation.status === "pending") throw new GoalBriefRequestInProgressError(input.requestId)

  const generation = (async () => {
    const heartbeat = setInterval(() => {
      try {
        extendGenerationLease(input.requestId, payloadHash, ownerToken)
      } catch {}
    }, 10_000)
    heartbeat.unref()
    try {
      const resolved = await dependencies.resolveDefaultModel()
      const brief = await adapt({
        provider: resolved.adapterProvider,
        generate: async (request) => {
          const output = await dependencies.generate({
            model: resolved.model,
            schema: GeneratedGoalBriefDraft,
            system:
              "Create one complete Goal Brief as strict structured data. Keep goal, deliverables, acceptance criteria, constraints, non-goals, assumptions, open questions, risk, plan, and approval mode semantically distinct. Never copy the goal into other fields to simulate completeness.",
            prompt: JSON.stringify({
              goal: input.goal,
              ...(input.context ? { context: input.context } : {}),
              mode: request.mode,
              ...(request.previousError ? { validationError: request.previousError } : {}),
            }),
          })
          const value =
            typeof output === "object" && output !== null
              ? { ...output, sourceRefs: [{ kind: "goal_request", id: input.requestId }] }
              : output
          return resolved.adapterProvider === "anthropic_compatible" ? { input: value } : { output: value }
        },
      })
      const completion = completeGeneration(input.requestId, payloadHash, ownerToken, {
        projectId: input.projectId,
        sourceThreadId: input.sourceThreadId,
        source: "system_suggestion",
        brief,
      })
      if (completion.status === "conflict") throw new GoalBriefRequestConflictError(input.requestId)
      if (completion.status === "ownership_lost") throw new GoalBriefRequestInProgressError(input.requestId)
      return completion.brief
    } catch (error) {
      releaseGeneration(input.requestId, payloadHash, ownerToken)
      throw error
    } finally {
      clearInterval(heartbeat)
    }
  })()
  const tracked = generation.finally(() => {
    if (inFlight.get(input.requestId)?.promise === tracked) inFlight.delete(input.requestId)
  })
  inFlight.set(input.requestId, { payloadHash, promise: tracked })
  return tracked
}

export function createFromDefaultModel(input: GoalBriefGenerateRequestValue) {
  return Effect.gen(function* () {
    const provider = yield* Provider.Service
    const bridge = yield* EffectBridge.make()
    return yield* Effect.tryPromise({
      try: () =>
        generateAndCreate(input, {
          resolveDefaultModel: async () => {
            const reference = await bridge.promise(provider.defaultModel())
            const model = await bridge.promise(provider.getModel(reference.providerID, reference.modelID))
            return {
              adapterProvider:
                model.providerID.includes("anthropic") || model.api.npm.includes("anthropic")
                  ? "anthropic_compatible"
                  : "openai_compatible",
              model: await bridge.promise(provider.getLanguage(model)),
            }
          },
          generate: generateStructured,
        }),
      catch: (error) => error,
    })
  })
}
