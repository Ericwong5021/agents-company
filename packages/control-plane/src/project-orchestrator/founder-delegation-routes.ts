import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  FounderGreenDelegationInput,
  FounderGreenDelegationProjection,
  FounderGreenDelegationRun,
  FounderGreenReadiness,
  FounderGreenReadinessRecordInput,
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
import { Service } from "./founder-delegation"

const CompanyQuery = z.object({ company_id: CompanyID }).strict()
const badRequest = namedErrorResponse("Invalid Founder Green delegation request", [ProductValidationError] as const)
const internalError = namedErrorResponse("Unable to complete Founder Green delegation request", [UnknownErrorResponse] as const)

export const FounderGreenDelegationRoutes = lazy(() =>
  new Hono()
    .get(
      "/green-delegations",
      describeRoute({
        operationId: "founderOS.greenDelegationProjection",
        summary: "Read fail-closed Green delegation readiness and auditable chains",
        responses: {
          200: {
            description: "Green delegation projection",
            content: { "application/json": { schema: resolver(FounderGreenDelegationProjection) } },
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
      "/green-delegations",
      describeRoute({
        operationId: "founderOS.greenDelegationSubmit",
        summary: "Authorize and process one Green allowlisted Work Receipt through the existing vertical chain",
        responses: {
          200: {
            description: "Green delegation run",
            content: { "application/json": { schema: resolver(FounderGreenDelegationRun) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderGreenDelegationInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.submit(c.req.valid("json"))),
          ),
        ),
    )
    .post(
      "/green-readiness",
      describeRoute({
        operationId: "founderOS.greenReadinessRecord",
        summary: "Record human-authorized Green readiness from verified persisted evidence",
        responses: {
          200: {
            description: "Verified Green readiness",
            content: { "application/json": { schema: resolver(FounderGreenReadiness) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderGreenReadinessRecordInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.recordReadiness(c.req.valid("json"))),
          ),
        ),
    ),
)
