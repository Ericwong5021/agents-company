import { Effect } from "effect"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono, type Context } from "hono"
import z from "zod"
import {
  RolloutActionRequest,
  RolloutActionResult,
  RolloutApiError,
  RolloutEvidence,
  RolloutJournal,
  RolloutPromotionDecision,
  RolloutPromotionEvaluationRequest,
  RolloutStatus,
  RolloutTransitionRequest,
  RolloutTransitionResult,
} from "@agents-company/shared/rollout"
import * as CompanyRollout from "@/company-rollout/company-rollout"
import { runRequest } from "./trace"

const Limit = z.object({
  limit: z.coerce.number().int().positive().max(500).default(500),
})

function execute<A>(operation: () => A) {
  return Effect.try({
    try: operation,
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  )
}

function errorResponse(c: Context, error: unknown) {
  if (!(error instanceof CompanyRollout.RolloutStoreError)) throw error
  if (error.code === "invalid_persisted_fact") return c.json(RolloutApiError.parse(error.toApiError()), 500)
  return c.json(RolloutApiError.parse(error.toApiError()), 409)
}

export const RolloutRoutes = () =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Read persisted rollout phase and low-level execution mode",
        operationId: "rollout.get",
        responses: {
          200: {
            description: "Rollout status",
            content: { "application/json": { schema: resolver(RolloutStatus) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      async (c) => {
        const result = await runRequest("RolloutRoutes.get", c, execute(CompanyRollout.status))
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutStatus.parse(result.value))
      },
    )
    .post(
      "/transitions",
      describeRoute({
        summary: "Advance the rollout phase by exactly one step",
        operationId: "rollout.transition",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Persisted rollout transition",
            content: { "application/json": { schema: resolver(RolloutTransitionResult) } },
          },
          409: {
            description: "Transition conflict",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      validator("json", RolloutTransitionRequest),
      async (c) => {
        const result = await runRequest(
          "RolloutRoutes.transition",
          c,
          execute(() => CompanyRollout.transition(c.req.valid("json"))),
        )
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutTransitionResult.parse(result.value))
      },
    )
    .post(
      "/actions",
      describeRoute({
        summary: "Append one candidate, local repeat, or rollback fact",
        operationId: "rollout.action",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Persisted rollout action fact",
            content: { "application/json": { schema: resolver(RolloutActionResult) } },
          },
          409: {
            description: "Action conflict",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      validator("json", RolloutActionRequest),
      async (c) => {
        const result = await runRequest(
          "RolloutRoutes.action",
          c,
          execute(() => CompanyRollout.recordAction(c.req.valid("json"))),
        )
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutActionResult.parse(result.value))
      },
    )
    .post(
      "/promotion-evaluations",
      describeRoute({
        summary: "Evaluate persisted evidence for the Pre-Public default",
        operationId: "rollout.evaluatePromotion",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Persisted deterministic promotion decision",
            content: { "application/json": { schema: resolver(RolloutPromotionDecision) } },
          },
          409: {
            description: "Promotion evaluation conflict",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      validator("json", RolloutPromotionEvaluationRequest),
      async (c) => {
        const result = await runRequest(
          "RolloutRoutes.evaluatePromotion",
          c,
          execute(() => CompanyRollout.evaluatePrePublicPromotion(c.req.valid("json"))),
        )
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutPromotionDecision.parse(result.value))
      },
    )
    .get(
      "/journal",
      describeRoute({
        summary: "List append-only rollout journal entries",
        operationId: "rollout.journal",
        responses: {
          200: {
            description: "Rollout journal",
            content: { "application/json": { schema: resolver(RolloutJournal) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      validator("query", Limit),
      async (c) => {
        const result = await runRequest(
          "RolloutRoutes.journal",
          c,
          execute(() => CompanyRollout.listJournal(c.req.valid("query").limit)),
        )
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutJournal.parse(result.value))
      },
    )
    .get(
      "/evidence",
      describeRoute({
        summary: "List rollout evidence and promotion decisions",
        operationId: "rollout.evidence",
        responses: {
          200: {
            description: "Persisted rollout evidence",
            content: { "application/json": { schema: resolver(RolloutEvidence) } },
          },
          500: {
            description: "Persisted rollout facts are invalid",
            content: { "application/json": { schema: resolver(RolloutApiError) } },
          },
        },
      }),
      validator("query", Limit),
      async (c) => {
        const result = await runRequest(
          "RolloutRoutes.evidence",
          c,
          execute(() => CompanyRollout.evidence(c.req.valid("query").limit)),
        )
        if (!result.ok) return errorResponse(c, result.error)
        return c.json(RolloutEvidence.parse(result.value))
      },
    )
