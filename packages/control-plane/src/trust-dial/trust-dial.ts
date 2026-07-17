import z from "zod"
import { Context, Effect, Layer } from "effect"
import * as Reputation from "@/reputation/reputation"
import type { Finding, TaskRating } from "@/admission/schema"

export const Level = z.enum(["guarded", "standard", "trusted", "autonomous"])
export type Level = z.infer<typeof Level>

export const Decision = z.object({
  agentID: z.string(),
  score: z.number(),
  level: Level,
  taskRating: z.enum(["company", "project", "individual"]),
  autoAdmissionAllowed: z.boolean(),
  approvalRequired: z.boolean(),
  minimumApprovals: z.number(),
  reason: z.string(),
})
export type Decision = z.infer<typeof Decision>

export const EvaluateInput = z.object({
  agentID: z.string().min(1),
  taskRating: z.enum(["company", "project", "individual"]),
  accepted: z.boolean(),
  findings: z.array(
    z.object({
      item: z.string(),
      howToVerify: z.string(),
      severity: z.enum(["blocker", "warning", "info"]),
    }),
  ),
})
export type EvaluateInput = z.infer<typeof EvaluateInput>

function levelForScore(score: number): Level {
  if (score >= 60) return "autonomous"
  if (score >= 30) return "trusted"
  if (score >= 10) return "standard"
  return "guarded"
}

function canAutoAdmit(level: Level, taskRating: TaskRating, findings: readonly Finding[]) {
  if (findings.some((finding) => finding.severity === "blocker")) return false
  if (level === "autonomous") return true
  if (level === "trusted") return taskRating !== "company"
  if (level === "standard") return taskRating === "individual" && findings.length === 0
  return false
}

function minimumApprovals(level: Level, taskRating: TaskRating) {
  if (level === "guarded") return taskRating === "company" ? 2 : 1
  if (level === "standard") return taskRating === "company" || taskRating === "project" ? 1 : 0
  if (level === "trusted") return taskRating === "company" ? 1 : 0
  return 0
}

export interface Interface {
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Decision>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/TrustDial") {}

export const layer: Layer.Layer<Service, never, Reputation.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reputationSvc = yield* Reputation.Service

    const evaluate = Effect.fn("TrustDial.evaluate")(function* (input: EvaluateInput) {
      const reputation = yield* reputationSvc.get(input.agentID)
      const level = levelForScore(reputation.score)
      const autoAdmissionAllowed = input.accepted && canAutoAdmit(level, input.taskRating, input.findings)
      const approvals = input.accepted && !autoAdmissionAllowed ? minimumApprovals(level, input.taskRating) : 0
      return {
        agentID: input.agentID,
        score: reputation.score,
        level,
        taskRating: input.taskRating,
        autoAdmissionAllowed,
        approvalRequired: approvals > 0,
        minimumApprovals: approvals,
        reason: input.accepted
          ? autoAdmissionAllowed
            ? `${level} trust permits auto-admission for ${input.taskRating} work`
            : `${level} trust requires ${approvals} approval gate(s) for ${input.taskRating} work`
          : "failed admission cannot be auto-admitted",
      }
    })

    return { evaluate }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Reputation.defaultLayer))

export * as TrustDial from "./trust-dial"
