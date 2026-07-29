import { Cause, Effect, Exit } from "effect"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  FounderAdvisorConvergence,
  FounderAdvisorConvergenceInput,
  FounderAdvisorReadiness,
  FounderAdvisorReadinessRecordInput,
  FounderBoardGovernanceProjection,
  FounderControlCenterProjection,
  FounderIntervention,
  FounderInterventionInput,
} from "@agents-company/shared/founder-os"
import { Company } from "@/company"
import * as CompanyAttention from "@/company-project/attention"
import { CompanyID } from "@/company/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { ProjectActionExecutor } from "@/project-orchestrator/project-action-executor"
import { ProjectOrchestrator } from "@/project-orchestrator/project-orchestrator"
import { lazy } from "@/util/lazy"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "@/server/error"
import * as FounderOSAdvisor from "./advisor"
import * as FounderOSAdvisorReadiness from "./advisor-readiness"
import * as FounderOSAsset from "./asset"
import { Service as DecisionLedgerService } from "./decision-ledger"
import * as FounderOSShadow from "./shadow"

const CompanyQuery = z.object({ company_id: CompanyID }).strict()
const badRequest = namedErrorResponse("Invalid Founder Advisor request", [ProductValidationError] as const)
const internalError = namedErrorResponse("Unable to complete Founder Advisor request", [UnknownErrorResponse] as const)

async function facts(companyId: string) {
  const [modes, decisions] = await Promise.all([
    AppRuntime.runPromise(Company.Service.use((service) => service.founderOSModes())),
    AppRuntime.runPromise(DecisionLedgerService.use((service) => service.list({ companyId }))),
  ])
  return { modes, decisions }
}

export const FounderAdvisorRoutes = lazy(() =>
  new Hono()
    .get(
      "/readiness",
      describeRoute({
        operationId: "company.founderAdvisorReadiness",
        summary: "Read fail-closed Advisor readiness and exact metric thresholds",
        responses: {
          200: {
            description: "Advisor readiness",
            content: { "application/json": { schema: resolver(FounderAdvisorReadiness) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyQuery, productValidationHook),
      (c) => c.json(FounderOSAdvisorReadiness.readiness(c.req.valid("query").company_id)),
    )
    .post(
      "/readiness",
      describeRoute({
        operationId: "company.founderAdvisorReadinessRecord",
        summary: "Verify W4 exact commit, benchmark thresholds, and human authorization before Advisor promotion",
        responses: {
          200: {
            description: "Verified Advisor readiness",
            content: { "application/json": { schema: resolver(FounderAdvisorReadiness) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderAdvisorReadinessRecordInput, productValidationHook),
      (c) => c.json(FounderOSAdvisorReadiness.record(c.req.valid("json"))),
    )
    .get(
      "/",
      describeRoute({
        operationId: "company.founderBoard",
        summary: "Read the real Founder governance Board surface",
        responses: {
          200: {
            description: "Board governance projection",
            content: { "application/json": { schema: resolver(FounderBoardGovernanceProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyQuery, productValidationHook),
      async (c) => {
        const companyId = c.req.valid("query").company_id
        const current = await facts(companyId)
        return c.json(FounderOSAdvisor.boardProjection({
          companyId,
          modes: current.modes,
          decisions: current.decisions,
          shadow: FounderOSShadow.boardProjection(companyId),
          studio: FounderOSAsset.projection(companyId),
        }))
      },
    )
    .post(
      "/convergences",
      describeRoute({
        operationId: "company.founderBoardConverge",
        summary: "Converge a sourced Shadow recommendation into a fail-closed Advisor DecisionIntent",
        responses: {
          200: {
            description: "Recorded intent or blocked convergence",
            content: { "application/json": { schema: resolver(FounderAdvisorConvergence) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderAdvisorConvergenceInput, productValidationHook),
      (c) => c.json(FounderOSAdvisor.converge(c.req.valid("json"))),
    )
    .post(
      "/interventions",
      describeRoute({
        operationId: "company.founderBoardIntervene",
        summary: "Persist a human intervention fence and stop scoped project work",
        responses: {
          200: {
            description: "Persisted intervention and stop effects",
            content: { "application/json": { schema: resolver(FounderIntervention) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("json", FounderInterventionInput, productValidationHook),
      async (c) => {
        const input = c.req.valid("json")
        const intervention = FounderOSAdvisor.beginIntervention(input)
        if (!input.projectId) return c.json(intervention)
        FounderOSAdvisor.recordInterventionEffect(
          intervention.id,
          "stop_requested",
          "recorded",
          `stop_work requested for ${input.projectId}`,
        )
        const outcome = await AppRuntime.runPromise(
          Effect.exit(
            Effect.gen(function* () {
              yield* ProjectOrchestrator.Service.use((orchestrator) =>
                orchestrator.pauseDispatch(input.projectId!, `Founder intervention ${intervention.id}`),
              )
              const attention = yield* CompanyAttention.Service.use((service) =>
                service.create({
                  project_id: input.projectId!,
                  idempotency_key: `founder-intervention:${intervention.id}:attention`,
                  issue: input.kind === "redefine_goal"
                    ? { issue_kind: "scope_change", risk: "high", materiality: "scope" }
                    : { issue_kind: "unresolved_material_risk", risk: "critical", materiality: "unresolved_risk" },
                  title: `Founder intervention: ${input.kind}`,
                  summary: input.reason,
                  ...(input.newGoal ? { required_decision: input.newGoal } : {}),
                  source_refs: [{ kind: "project", id: input.projectId! }],
                }),
              )
              yield* Effect.sync(() =>
                FounderOSAdvisor.recordInterventionEffect(
                  intervention.id,
                  "attention_opened",
                  "recorded",
                  attention.record.id,
                ),
              )
              const stopped = yield* ProjectActionExecutor.Service.use((executor) =>
                executor.execute({
                  project_id: input.projectId!,
                  attention_id: attention.record.id,
                  action: "stop_work",
                  idempotency_key: `founder-intervention:${intervention.id}:stop`,
                  payload: { reason: input.reason },
                }),
              )
              yield* ProjectOrchestrator.Service.use((orchestrator) =>
                orchestrator.recover({ project_id: input.projectId! }),
              )
              return stopped
            }),
          ),
        )
        if (Exit.isFailure(outcome)) {
          FounderOSAdvisor.recordInterventionEffect(
            intervention.id,
            "stop_failed",
            "failed",
            String(Cause.squash(outcome.cause)),
          )
          return c.json(FounderOSAdvisor.beginIntervention(input))
        }
        FounderOSAdvisor.recordInterventionEffect(
          intervention.id,
          "stop_completed",
          "recorded",
          outcome.value.action.id,
        )
        return c.json(FounderOSAdvisor.beginIntervention(input))
      },
    ),
)

export const FounderControlCenterRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "company.founderControlCenter",
        summary: "Read the non-mutating Founder Control Center",
        responses: {
          200: {
            description: "Founder Control Center projection",
            content: { "application/json": { schema: resolver(FounderControlCenterProjection) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyQuery, productValidationHook),
      async (c) => {
        const companyId = c.req.valid("query").company_id
        const current = await facts(companyId)
        return c.json(FounderOSAdvisor.controlCenter({
          companyId,
          modes: current.modes,
          decisions: current.decisions,
        }))
      },
    ),
)
