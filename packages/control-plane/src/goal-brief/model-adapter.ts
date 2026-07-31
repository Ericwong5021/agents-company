import { generateObject, generateText, NoObjectGeneratedError, tool } from "ai"
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
        id: generatedID("system-assumption", index),
        description: generatedText(item, ["description", "assumption", "text", "value"]),
        confirmed: false,
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

function explicitDeliverableSegments(value: string) {
  const matches = [...value.matchAll(/\bD(\d{1,2})\b/gi)].filter((match) => {
    const index = match.index ?? 0
    const before = value.slice(Math.max(0, index - 24), index)
    const after = value.slice(index + match[0].length, index + match[0].length + 24)
    return !/D\d{1,2}\s*[–—-]\s*$/i.test(before) && !/^\s*[–—-]\s*D\d{1,2}\b/i.test(after)
  })
  return matches.map((match, index) => ({
    label: `D${Number(match[1])}`,
    body: value.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? value.length),
  }))
}

function numericAnchors(value: string) {
  return [...value.matchAll(/\d[\d,，]*(?:\.\d+)?%?/g)].map((match) => {
    const raw = match[0]
    const percentage = raw.endsWith("%")
    const numeric = raw.replace(/[%+,，]/g, "")
    const parsed = Number(numeric)
    return `${Number.isFinite(parsed) ? parsed : numeric}${percentage ? "%" : ""}`
  })
}

function validateExplicitDeliverableMapping(source: string, draft: z.infer<typeof GoalBriefDraft>) {
  const sourceByLabel = new Map<string, string[]>()
  for (const segment of explicitDeliverableSegments(source))
    sourceByLabel.set(segment.label, [...(sourceByLabel.get(segment.label) ?? []), segment.body])

  for (const [label, bodies] of sourceByLabel) {
    const marker = new RegExp(`\\b${label}\\b`, "i")
    const deliverables = draft.deliverables.filter(
      (item) => item.id.toUpperCase() === label || marker.test(`${item.title}\n${item.description}`),
    )
    if (!deliverables.length) throw new Error(`Explicit deliverable ${label} is missing. Preserve every numbered deliverable.`)
    const relatedCriteria = draft.acceptanceCriteria.filter((item) =>
      marker.test(`${item.description}\n${item.verification}`),
    )
    const relatedSteps = draft.recommendedPlan.steps.filter((item) => marker.test(`${item.title}\n${item.outcome}`))
    const target = [
      ...deliverables.flatMap((item) => [item.title, item.description]),
      ...relatedCriteria.flatMap((item) => [item.description, item.verification]),
      ...relatedSteps.flatMap((item) => [item.title, item.outcome]),
    ].join("\n")
    const targetAnchors = new Set(numericAnchors(target))
    const missing = [...new Set(numericAnchors(bodies.join("\n")))].filter((anchor) => !targetAnchors.has(anchor))
    if (missing.length)
      throw new Error(
        `Explicit deliverable ${label} is missing user-supplied anchors: ${missing.join(", ")}. Keep each requirement in its original numbered deliverable and do not move it to another deliverable or a global constraint.`,
      )
  }
}

const externalActionPattern =
  /部署|上传|发布|付款|采购|外联|联系|发送|招募|报名|收费|签约|实地|踩点|线下|试运行|访谈|问卷回收|deploy|upload|publish|pay|purchase|contact|recruit|enroll|charge|sign|on-site|field visit|pilot/i

const externalBoundaryPattern =
  /仅(?:准备|形成)|不执行|不得执行|未授权|待(?:人工|用户)批准|批准后|模板|清单|脚本|候选|approval|not execute|preparation only/i

function applyExternalActionBoundary(draft: z.infer<typeof GoalBriefDraft>) {
  const planText = JSON.stringify(draft.recommendedPlan)
  if (!externalActionPattern.test(planText)) return draft
  const constraint = "目标摘要的生成不构成执行授权；任何对外、线下、资金、发布或不可逆动作均须在执行前获得用户明确批准。"
  return GoalBriefDraft.parse({
    ...draft,
    constraints: draft.constraints.includes(constraint)
      ? draft.constraints
      : [...draft.constraints.slice(0, 99), constraint],
    recommendedPlan: {
      summary: externalBoundaryPattern.test(draft.recommendedPlan.summary)
        ? draft.recommendedPlan.summary
        : `${draft.recommendedPlan.summary} 本轮只形成可在本地审阅的准备材料；外部或线下动作须另行获得用户明确批准。`,
      steps: draft.recommendedPlan.steps.map((step) => {
        const text = `${step.title}\n${step.outcome}`
        if (!externalActionPattern.test(text) || externalBoundaryPattern.test(text)) return step
        return {
          ...step,
          title: `准备“${step.title}”所需材料`.slice(0, 240),
          outcome: `${step.outcome} 本轮仅形成材料、模板与人工检查点，不执行相关外部、线下、资金或发布动作。`,
        }
      }),
    },
  })
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
  validate?: (draft: z.infer<typeof GoalBriefDraft>) => void
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
      const parsed = parse(provider, generated, input.sourceRefs)
      input.validate?.(parsed)
      return parsed
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
  outputMode: "object" | "tool"
  system: string
  prompt: string
  schema: typeof GeneratedGoalBriefDraft
  abortSignal: AbortSignal
}

export type GoalBriefGenerationDependencies = {
  resolveDefaultModel: () => Promise<{
    adapterProvider: GoalBriefModelProvider
    model: LanguageModelV3
    outputMode?: "object" | "tool"
  }>
  generate: (input: GoalBriefStructuredGenerationCall) => Promise<unknown>
}

async function generateStructured(input: GoalBriefStructuredGenerationCall) {
  if (input.outputMode === "tool") {
    const result = await generateText({
      model: input.model,
      tools: {
        submitGoalBrief: tool({
          description: "Submit the complete Goal Brief",
          inputSchema: input.schema,
        }),
      },
      toolChoice: { type: "tool", toolName: "submitGoalBrief" },
      temperature: 0,
      system: input.system,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
    })
    return result.toolCalls.find((call) => call.toolName === "submitGoalBrief")?.input ?? result.text
  }
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
      const generatedBrief = await adapt({
        provider: resolved.adapterProvider,
        sourceRefs: [{ kind: "goal_request", id: input.requestId }],
        validate: (draft) =>
          validateExplicitDeliverableMapping(`${input.goal}\n${input.context ?? ""}`, draft),
        generate: async (request) => {
          const output = await dependencies.generate({
            model: resolved.model,
            outputMode: resolved.outputMode ?? "object",
            schema: GeneratedGoalBriefDraft,
            system:
              "Create one complete Goal Brief as strict structured data. Keep goal, deliverables, acceptance criteria, constraints, non-goals, assumptions, open questions, risk, plan, and approval mode semantically distinct. Never copy the goal into other fields to simulate completeness. Preserve every explicit numbered deliverable label and keep every requirement, number, formula, date, percentage, and hard rule in the exact numbered deliverable where the user placed it. Never move a requirement between D1, D2, D3, or any other numbered deliverable, even when it also applies globally. Every generated assumption must set confirmed to false; only a later explicit user response may confirm an assumption. Goal Brief generation never authorizes deployment, upload, publishing, payment, procurement, external contact, recruitment, enrollment, field visits, or offline execution. Represent such actions only as local preparation materials and future steps gated by explicit user approval.",
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
      const brief = applyExternalActionBoundary(generatedBrief)
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
              outputMode: model.capabilities.toolcall ? "tool" : "object",
            }
          },
          generate: generateStructured,
        }),
      catch: (error) => error,
    })
  })
}
