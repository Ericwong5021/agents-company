import {
  DecisionRecord,
  DecisionRecordAppendInput,
  DecisionTransition,
  DecisionTransitionAppendInput,
  DelegationPolicy,
} from "@agents-company/shared/founder-os"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { CompanyID } from "@/company/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { lazy } from "@/util/lazy"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "@/server/error"
import {
  DecisionLedgerCorrupt,
  DecisionLedgerIdempotencyConflict,
  DecisionLedgerIllegalTransition,
  DecisionLedgerNotFound,
  Service,
} from "./decision-ledger"

const DecisionParam = z.object({ decisionID: z.string().min(1) }).strict()
const DecisionListQuery = z
  .object({
    company_id: CompanyID,
    scope_type: z.enum(["company", "project", "pre_project"]).optional(),
    project_id: z.string().min(1).optional(),
    pre_project_id: z.string().min(1).optional(),
  })
  .strict()
const PolicyListQuery = z.object({ company_id: CompanyID }).strict()

const badRequest = namedErrorResponse("Invalid Founder OS ledger request", [ProductValidationError] as const)
const notFound = namedErrorResponse("Decision record not found", [DecisionLedgerNotFound.Schema] as const)
const conflict = namedErrorResponse("Decision ledger conflict", [
  DecisionLedgerIdempotencyConflict.Schema,
  DecisionLedgerIllegalTransition.Schema,
] as const)
const internalError = namedErrorResponse("Unable to complete Decision Ledger operation", [
  DecisionLedgerCorrupt.Schema,
  UnknownErrorResponse,
] as const)

export const FounderOSRoutes = lazy(() =>
  new Hono()
    .post(
      "/decisions",
      describeRoute({
        operationId: "founderOS.decisionAppend",
        summary: "Append an immutable Founder OS decision record",
        responses: {
          200: {
            description: "Appended or idempotently recovered decision record",
            content: { "application/json": { schema: resolver(DecisionRecord) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          409: conflict,
          500: internalError,
        },
      }),
      validator("json", DecisionRecordAppendInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(Service.use((service) => service.append(c.req.valid("json")))),
        ),
    )
    .get(
      "/decisions",
      describeRoute({
        operationId: "founderOS.decisions",
        summary: "List recovered Founder OS decision projections",
        responses: {
          200: {
            description: "Decision records",
            content: { "application/json": { schema: resolver(z.array(DecisionRecord)) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", DecisionListQuery, productValidationHook),
      async (c) => {
        const input = c.req.valid("query")
        return c.json(
          await AppRuntime.runPromise(
            Service.use((service) =>
              service.list({
                companyId: input.company_id,
                scopeType: input.scope_type,
                projectId: input.project_id,
                preProjectId: input.pre_project_id,
              }),
            ),
          ),
        )
      },
    )
    .get(
      "/decisions/:decisionID",
      describeRoute({
        operationId: "founderOS.decision",
        summary: "Get a Founder OS decision projection",
        responses: {
          200: {
            description: "Decision record",
            content: { "application/json": { schema: resolver(DecisionRecord) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          404: notFound,
          500: internalError,
        },
      }),
      validator("param", DecisionParam, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.get(c.req.valid("param").decisionID)),
          ),
        ),
    )
    .get(
      "/decisions/:decisionID/transitions",
      describeRoute({
        operationId: "founderOS.decisionTransitions",
        summary: "List append-only decision transitions",
        responses: {
          200: {
            description: "Decision transitions",
            content: { "application/json": { schema: resolver(z.array(DecisionTransition)) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          404: notFound,
          500: internalError,
        },
      }),
      validator("param", DecisionParam, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.transitions(c.req.valid("param").decisionID)),
          ),
        ),
    )
    .post(
      "/decisions/:decisionID/transitions",
      describeRoute({
        operationId: "founderOS.decisionTransitionAppend",
        summary: "Append a validated decision state transition",
        responses: {
          200: {
            description: "Appended or idempotently recovered transition",
            content: { "application/json": { schema: resolver(DecisionTransition) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          404: notFound,
          409: conflict,
          500: internalError,
        },
      }),
      validator("param", DecisionParam, productValidationHook),
      validator("json", DecisionTransitionAppendInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) =>
              service.appendTransition(c.req.valid("param").decisionID, c.req.valid("json")),
            ),
          ),
        ),
    )
    .get(
      "/delegation-policies",
      describeRoute({
        operationId: "founderOS.delegationPolicies",
        summary: "List versioned Founder OS delegation policies",
        responses: {
          200: {
            description: "Delegation policies",
            content: { "application/json": { schema: resolver(z.array(DelegationPolicy)) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", PolicyListQuery, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            Service.use((service) => service.policies(c.req.valid("query").company_id)),
          ),
        ),
    ),
)
