import {
  DecisionAuthorityEvaluation,
  DecisionAuthorityInput,
  DecisionCenterActionInput,
  DecisionCenterProjection,
  DecisionRecord,
  DecisionRecordAppendInput,
  DecisionTransition,
  DecisionTransitionAppendInput,
  DelegationPolicy,
  FounderCorrectionAppendInput,
  FounderCorrectionRecord,
  FounderOSMetricContract,
  GovernanceDecision,
  GovernanceRequest,
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
import {
  DecisionAuthorityService,
  DecisionCenterService,
  FounderCorrectionService,
  GovernanceService,
} from "./authority"
import { metricContract } from "./metric"

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
const GateParam = z.object({ gateID: z.string().min(1) }).strict()
const GateResolveInput = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().min(1).max(20_000),
    actor: z.object({ kind: z.enum(["human", "ai_founder", "board", "policy_engine"]), id: z.string().min(1) }).strict(),
  })
  .strict()

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
    )
    .post(
      "/authority/evaluate",
      describeRoute({
        operationId: "founderOS.authorityEvaluate",
        summary: "Evaluate deterministic Founder OS authority",
        responses: {
          200: {
            description: "Authority evaluation",
            content: { "application/json": { schema: resolver(DecisionAuthorityEvaluation) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", DecisionAuthorityInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            DecisionAuthorityService.use((service) => service.evaluate(c.req.valid("json"))),
          ),
        ),
    )
    .post(
      "/governance",
      describeRoute({
        operationId: "founderOS.governance",
        summary: "Enter the single Founder OS governance path",
        responses: {
          200: {
            description: "Governance verdict",
            content: { "application/json": { schema: resolver(GovernanceDecision) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", GovernanceRequest, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(GovernanceService.use((service) => service.submit(c.req.valid("json")))),
        ),
    )
    .post(
      "/approval-gates/:gateID/resolve",
      describeRoute({
        operationId: "founderOS.approvalGateResolve",
        summary: "Resolve a Founder OS red approval gate",
        responses: {
          200: {
            description: "Governance verdict",
            content: { "application/json": { schema: resolver(GovernanceDecision) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", GateParam, productValidationHook),
      validator("json", GateResolveInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            GovernanceService.use((service) =>
              service.resolveGate({
                gateId: c.req.valid("param").gateID,
                ...c.req.valid("json"),
              }),
            ),
          ),
        ),
    )
    .post(
      "/corrections",
      describeRoute({
        operationId: "founderOS.correctionAppend",
        summary: "Append an immutable Founder OS correction or override",
        responses: {
          200: {
            description: "Correction record",
            content: { "application/json": { schema: resolver(FounderCorrectionRecord) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderCorrectionAppendInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            FounderCorrectionService.use((service) => service.append(c.req.valid("json"))),
          ),
        ),
    )
    .get(
      "/decision-center",
      describeRoute({
        operationId: "founderOS.decisionCenter",
        summary: "Read the persistent Decision Center projection",
        responses: {
          200: {
            description: "Decision Center projection",
            content: { "application/json": { schema: resolver(DecisionCenterProjection) } },
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
            DecisionCenterService.use((service) => service.projection(c.req.valid("query").company_id)),
          ),
        ),
    )
    .post(
      "/decision-center/:decisionID/actions",
      describeRoute({
        operationId: "founderOS.decisionCenterAction",
        summary: "Append a Decision Center accept, reject or rollback action",
        responses: {
          200: {
            description: "Updated Decision Center projection",
            content: { "application/json": { schema: resolver(DecisionCenterProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("param", DecisionParam, productValidationHook),
      validator("json", DecisionCenterActionInput, productValidationHook),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            DecisionCenterService.use((service) =>
              service.action(c.req.valid("param").decisionID, c.req.valid("json")),
            ),
          ),
        ),
    )
    .get(
      "/metrics/contract",
      describeRoute({
        operationId: "founderOS.metricContract",
        summary: "Read the frozen Founder OS metric contract",
        responses: {
          200: {
            description: "Metric contract",
            content: { "application/json": { schema: resolver(FounderOSMetricContract) } },
          },
          401: localAuthUnauthorizedResponse,
        },
      }),
      (c) => c.json(metricContract),
    ),
)
