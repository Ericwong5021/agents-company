import { generateObject, NoObjectGeneratedError } from "ai"
import { Effect } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { createHash } from "node:crypto"
import z from "zod"
import {
  GoalBriefDraft,
  GoalBriefAcceptanceCriterion,
  GoalBriefAssumption,
  GoalBriefDeliverable,
  GoalBriefGenerateRequest,
  GoalBriefOpenQuestion,
  GoalBriefPlanStep,
  GoalBriefStructuredFailure,
  type GoalBrief as GoalBriefValue,
  type GoalBriefGenerateRequest as GoalBriefGenerateRequestValue,
  type GoalBriefStructuredFailure as GoalBriefStructuredFailureValue,
} from "@agents-company/shared/experience"
import { EffectBridge } from "@/effect"
import { Provider } from "@/provider"
import { Log } from "@/util"
import {
  completeGeneration,
  create,
  extendGenerationLease,
  parseModelJson,
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
  readonly reason: string
  readonly recoveryActions = ["retry", "manual_edit"] as const

  constructor(provider: GoalBriefModelProvider, attempts: number, reason = "结构化字段不完整") {
    super("未能生成完整 Goal Brief。你可以重试，或手动补充目标信息。")
    this.name = "GoalBriefModelAdaptationError"
    this.provider = provider
    this.attempts = attempts
    this.reason = reason
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

function generatedID(kind: string, index: number) {
  return `${kind}-${index + 1}`
}

function generatedText(value: unknown, keys: string[]) {
  if (typeof value === "string") return value
  if (!record(value)) return value
  return keys.map((key) => value[key]).find((item): item is string => typeof item === "string")
}

function generatedRiskLevel(value: unknown) {
  const normalized = (record(value) ? JSON.stringify(value) : String(value)).trim().toLowerCase()
  if (normalized.includes("critical") || normalized.includes("严重")) return "critical"
  if (normalized.includes("high") || normalized.includes("高")) return "high"
  if (normalized.includes("medium") || normalized.includes("中")) return "medium"
  if (normalized.includes("low") || normalized.includes("低")) return "low"
  return "medium"
}

function generatedApprovalMode(value: unknown) {
  const normalized = (record(value) ? JSON.stringify(value) : String(value)).trim().toLowerCase()
  if (normalized.includes("autonomous") || normalized.includes("自主") || normalized.includes("自动"))
    return "autonomous"
  if (normalized.includes("balanced") || normalized.includes("平衡")) return "balanced"
  if (normalized.includes("strict") || normalized.includes("严格")) return "strict"
  return "balanced"
}

function normalizeCandidate(value: unknown, sourceRefs?: z.infer<typeof GoalBriefDraft>["sourceRefs"]) {
  const candidate = typeof value === "string" ? parseModelJson(value) : value
  if (!record(candidate)) return candidate
  const deliverables = Array.isArray(candidate.deliverables)
    ? candidate.deliverables.map((item, index) =>
        record(item)
          ? {
              id: typeof item.id === "string" ? item.id : generatedID("deliverable", index),
              title:
                typeof item.title === "string"
                  ? item.title
                  : typeof item.name === "string"
                    ? item.name
                    : item.title,
              description: item.description,
            }
          : item,
      )
    : candidate.deliverables
  const acceptanceCriteria = Array.isArray(candidate.acceptanceCriteria)
    ? candidate.acceptanceCriteria.map((item, index) => {
        if (!record(item)) return item
        const description = generatedText(item, ["description", "criterion", "text"])
        return {
          id: typeof item.id === "string" ? item.id : generatedID("criterion", index),
          description,
          verification:
            generatedText(item, ["verification", "verificationMethod", "check"])
            ?? (typeof description === "string" ? `逐项核验是否满足：${description}` : undefined),
        }
      })
    : candidate.acceptanceCriteria
  const assumptions = Array.isArray(candidate.assumptions)
    ? candidate.assumptions.map((item, index) => ({
        id: record(item) && typeof item.id === "string" ? item.id : generatedID("assumption", index),
        description: generatedText(item, ["description", "assumption", "text", "value"]),
        confirmed: record(item) && typeof item.confirmed === "boolean" ? item.confirmed : false,
      }))
    : candidate.assumptions
  const openQuestions = Array.isArray(candidate.openQuestions)
    ? candidate.openQuestions.map((item, index) => {
        if (!record(item)) return item
        return {
          id: typeof item.id === "string" ? item.id : generatedID("question", index),
          question: generatedText(item, ["question", "text"]),
          impact:
            generatedText(item, ["impact", "reason"])
            ?? "不同答案会改变执行范围、优先级或验收方式。",
          blocking: typeof item.blocking === "boolean" ? item.blocking : false,
          defaultAssumption:
            generatedText(item, ["defaultAssumption", "default", "assumption"])
            ?? "采用不扩大范围、纯本地且可逆的最小方案。",
        }
      })
    : candidate.openQuestions
  const plan = [candidate.recommendedPlan, candidate.plan, candidate.executionPlan].find(record)
  const planSteps = plan && [plan.steps, plan.actions].find(Array.isArray)
  const normalizedSteps = Array.isArray(planSteps)
    ? planSteps.map((item, index) =>
        record(item)
          ? {
              id: typeof item.id === "string" ? item.id : generatedID("step", index),
              title: generatedText(item, ["title", "name"]),
              outcome: generatedText(item, ["outcome", "description", "result"]),
            }
          : item,
      )
    : Array.isArray(deliverables)
      ? deliverables.map((item, index) =>
          record(item)
            ? {
                id: generatedID("step", index),
                title: item.title,
                outcome: item.description,
              }
            : item,
        )
      : undefined
  return {
    goal: candidate.goal,
    deliverables,
    acceptanceCriteria,
    constraints: Array.isArray(candidate.constraints)
      ? candidate.constraints.map((item) => generatedText(item, ["description", "constraint", "text", "value"]))
      : candidate.constraints,
    nonGoals: Array.isArray(candidate.nonGoals)
      ? candidate.nonGoals.map((item) => generatedText(item, ["description", "nonGoal", "text", "value"]))
      : candidate.nonGoals,
    assumptions,
    openQuestions,
    riskLevel: generatedRiskLevel(candidate.riskLevel),
    recommendedPlan: {
      summary:
        (plan && generatedText(plan, ["summary", "description"]))
        ?? "先梳理现状，再形成交付内容并按完成标准逐项核验。",
      steps: normalizedSteps,
    },
    approvalMode: generatedApprovalMode(candidate.approvalMode),
    sourceRefs: candidate.sourceRefs ?? sourceRefs,
  }
}

function parse(
  provider: GoalBriefModelProvider,
  value: unknown,
  sourceRefs?: z.infer<typeof GoalBriefDraft>["sourceRefs"],
) {
  return GoalBriefDraft.parse(normalizeCandidate(providerValue(provider, value), sourceRefs))
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
  sourceRefs?: z.infer<typeof GoalBriefDraft>["sourceRefs"]
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
      return parse(provider, generated, input.sourceRefs)
    } catch (error) {
      const lastIssue = issue(error)
      if (attempt > maxRepairAttempts) throw new GoalBriefModelAdaptationError(provider, attempt, lastIssue)
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

const GeneratedGoalBriefDraft = GoalBriefDraft.omit({
  deliverables: true,
  acceptanceCriteria: true,
  assumptions: true,
  openQuestions: true,
  recommendedPlan: true,
  sourceRefs: true,
}).extend({
  deliverables: z
    .array(
      GoalBriefDeliverable.extend({
        id: z.string().trim().min(1).max(240).optional(),
        title: z.string().trim().min(1).max(240).optional(),
        name: z.string().trim().min(1).max(240).optional(),
      }).superRefine((value, context) => {
        if (!value.title && !value.name)
          context.addIssue({
            code: "custom",
            path: ["title"],
            message: "Deliverable title or name is required",
          })
      }),
    )
    .min(1)
    .max(100),
  acceptanceCriteria: z
    .array(GoalBriefAcceptanceCriterion.extend({ id: z.string().trim().min(1).max(240).optional() }))
    .min(1)
    .max(200),
  assumptions: z.array(GoalBriefAssumption.extend({ id: z.string().trim().min(1).max(240).optional() })).max(100),
  openQuestions: z
    .array(GoalBriefOpenQuestion.extend({ id: z.string().trim().min(1).max(240).optional() }))
    .max(100),
  recommendedPlan: GoalBriefDraft.shape.recommendedPlan.extend({
    steps: z
      .array(GoalBriefPlanStep.extend({ id: z.string().trim().min(1).max(240).optional() }))
      .min(1)
      .max(100),
  }),
})
const log = Log.create({ service: "goal-brief" })

export type GoalBriefStructuredGenerationCall = {
  model: LanguageModelV3
  system: string
  prompt: string
  schema: typeof GeneratedGoalBriefDraft
  abortSignal: AbortSignal
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
        abortSignal: input.abortSignal,
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
    const abortSignal = AbortSignal.timeout(150_000)
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
        sourceRefs: [{ kind: "goal_request", id: input.requestId }],
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
            abortSignal,
          })
          return resolved.adapterProvider === "anthropic_compatible" ? { input: output } : { output }
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
      if (error instanceof GoalBriefModelAdaptationError)
        log.warn("structured generation failed", {
          requestID: input.requestId,
          attempts: error.attempts,
          reason: error.reason,
        })
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
