import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  FounderYellowDelegationInput,
  FounderYellowDelegationProjection,
  FounderYellowReadiness,
  FounderYellowReadinessRecordInput,
  FounderYellowRollbackInput,
  FounderYellowSummary,
} from "@agents-company/shared/founder-os"
import { CompanyID } from "@/company/schema"
import { AppRuntime } from "@/effect/app-runtime"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "@/server/error"
import { lazy } from "@/util/lazy"
import { Service } from "./yellow"

const CompanyQuery = z.object({ company_id: CompanyID }).strict()
const RunParam = z.object({ runId: z.string().trim().min(1) }).strict()
const badRequest = namedErrorResponse("Invalid Founder Yellow request", [ProductValidationError] as const)
const internalError = namedErrorResponse("Unable to complete Founder Yellow request", [UnknownErrorResponse] as const)

export const FounderYellowDelegationRoutes = lazy(() =>
  new Hono()
    .get(
      "/yellow-delegations",
      describeRoute({
        operationId: "founderOS.yellowDelegationProjection",
        summary: "Read fail-closed Yellow contracts, readiness, circuit state, and summaries",
        responses: {
          200: {
            description: "Yellow delegation projection",
            content: { "application/json": { schema: resolver(FounderYellowDelegationProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyQuery, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.projection(c.req.valid("query").company_id)),
          ),
        ),
    )
    .post(
      "/yellow-delegations",
      describeRoute({
        operationId: "founderOS.yellowDelegationSubmit",
        summary: "Prepare and dispatch one contracted Yellow action through the persistent outbox",
        responses: {
          200: {
            description: "Yellow delegation summary",
            content: { "application/json": { schema: resolver(FounderYellowSummary) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderYellowDelegationInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.submit(c.req.valid("json"))),
          ),
        ),
    )
    .post(
      "/yellow-readiness",
      describeRoute({
        operationId: "founderOS.yellowReadinessRecord",
        summary: "Record human-confirmed Yellow readiness from persisted Green, W6, E0, and Outcome evidence",
        responses: {
          200: {
            description: "Yellow readiness",
            content: { "application/json": { schema: resolver(FounderYellowReadiness) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderYellowReadinessRecordInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.recordReadiness(c.req.valid("json"))),
          ),
        ),
    )
    .post(
      "/yellow-delegations/:runId/rollback",
      describeRoute({
        operationId: "founderOS.yellowRollback",
        summary: "Run the checkpoint restore handler after a failure condition or human decision",
        responses: {
          200: {
            description: "Yellow delegation summary after rollback",
            content: { "application/json": { schema: resolver(FounderYellowSummary) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", RunParam, productValidationHook),
      validator("json", FounderYellowRollbackInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) =>
              service.rollback(c.req.valid("param").runId, c.req.valid("json"))
            ),
          ),
        ),
    ),
)
