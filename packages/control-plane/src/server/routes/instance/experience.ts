import { Cause, Effect, Exit } from "effect"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import {
  ExperienceApiError,
  ExperienceArtifactUnavailable,
  ExperienceArtifactView,
  DiscoverySummary,
  GraphChangeSummary,
  GoalBrief,
  GoalBriefAppendRequest,
  GoalBriefCreateRequest,
  GoalBriefGenerateRequest,
  GoalBriefHistory,
  GoalBriefProjectView,
  GoalBriefStartRequest,
  GoalBriefStartResult,
  GoalBriefStructuredFailure,
  OrganizationProjection,
  ValidationSummary,
  WorkProjection,
  WorkProjectionList,
  ExperienceWorkActionRequest,
  ExperienceWorkActionResult,
  type ExperienceWorkActionRequest as ExperienceWorkActionRequestValue,
} from "@agents-company/shared/experience"
import { GoalBriefModelAdapter, GoalBriefStore } from "@/goal-brief"
import { goalBriefCharter, goalProjectTitle } from "@/goal-brief/project-charter"
import { Company } from "@/company"
import { CompanyID } from "@/company/schema"
import { CompanyProject, CompanyProjectExecution } from "@/company-project"
import { Conversation } from "@/conversation"
import { LOCAL_USER_ID } from "@/conversation/conversation.sql"
import * as ExperienceProjectionService from "@/company-project/experience-projection"
import * as WorkProjectionService from "@/company-project/work-projection"
import * as ExperienceArtifactService from "@/company-project/experience-artifact"
import * as CompanyAttention from "@/company-project/attention"
import { ProjectActionExecutor } from "@/project-orchestrator/project-action-executor"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

const ID = z.object({ briefID: z.string().trim().min(1) }).strict()
const ProjectID = z.object({ projectID: z.string().trim().min(1) }).strict()
const RequestID = z.object({ requestID: z.string().trim().min(1) }).strict()
const ReceiptID = z
  .object({
    projectID: z.string().trim().min(1),
    receiptID: z.string().trim().min(1),
  })
  .strict()
const ArtifactID = z
  .object({
    projectID: z.string().trim().min(1),
    artifactID: z.string().trim().min(1),
  })
  .strict()

function missing(message: string) {
  return ExperienceApiError.parse({ code: "not_found", message })
}

const ensureGoalBriefProjectChannel = Effect.fn("ExperienceRoutes.goalBrief.ensureProjectChannel")(function* (
  projectID: string,
) {
  const companyState = yield* (yield* Company.Service).current()
  if (companyState.state !== "ready") throw new Error("Company is not ready")
  const project = yield* (yield* CompanyProject.Service).get(projectID)
  if (!project) throw new Error("Company project not found")
  const conversation = yield* Conversation.Service
  yield* conversation.ensureProjectChannel({
    companyID: CompanyID.parse(companyState.company.id),
    projectScopeID: project.id,
    title: project.title,
    members: [
      { kind: "user", id: LOCAL_USER_ID },
      ...(project.owner_agent_id ? [{ kind: "agent" as const, id: project.owner_agent_id }] : []),
    ],
  })
  yield* conversation.recordProjectUpdate({
    companyID: CompanyID.parse(companyState.company.id),
    projectScopeID: project.id,
    requestID: `goal-brief-project-start:${project.id}`,
    author: project.owner_agent_id
      ? { kind: "agent", id: project.owner_agent_id }
      : { kind: "system", id: "control-plane" },
    body: [
      `项目已启动：${project.title}`,
      `目标：${project.goal}`,
      `负责人：${project.owner_agent_id ?? "待分配"}`,
    ].join("\n"),
    signalType: "plan",
  })
  return { companyState, project }
})

function projectActionRequest(project_id: string, input: ExperienceWorkActionRequestValue) {
  const base = {
    project_id,
    action: input.action,
    idempotency_key: input.idempotencyKey,
    expected_revision: input.expectedGraphRevision,
  }
  if (input.action === "adjust_brief")
    return {
      ...base,
      attention_id: input.attentionId,
      payload: {
        brief_id: input.briefId,
        expected_brief_version: input.expectedBriefVersion,
        expected_plan_version: input.expectedPlanVersion,
        source: input.source,
        brief: input.brief,
        change_reason: input.changeReason,
      },
    }
  if (input.action === "retry")
    return {
      ...base,
      payload: {
        reason: input.reason,
        work_item_ids: input.workItemIds,
      },
    }
  if (input.action === "resolve_blocker")
    return {
      ...base,
      attention_id: input.attentionId,
      payload: {
        resolution: input.resolution,
        approval_gate_id: "approvalGateId" in input ? input.approvalGateId : undefined,
        decision: "decision" in input ? input.decision : undefined,
      },
    }
  if (input.action === "accept_delivery")
    return {
      ...base,
      payload: {
        delivery_id: input.deliveryId,
        accepted_criterion_ids: input.acceptedCriterionIds,
        note: input.note,
      },
    }
  if (input.action === "request_change")
    return {
      ...base,
      payload: {
        delivery_id: input.deliveryId,
        reason: input.reason,
      },
    }
  if (input.action === "archive" || input.action === "restore")
    return {
      ...base,
      payload: {},
    }
  return {
    ...base,
    payload: { reason: input.reason },
  }
}

export function createExperienceRoutes(
  generateGoalBrief: typeof GoalBriefModelAdapter.createFromDefaultModel = GoalBriefModelAdapter.createFromDefaultModel,
) {
  return new Hono()
    .post(
      "/goal-brief",
      describeRoute({
        summary: "Create a validated Goal Brief",
        operationId: "experience.goalBrief.create",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Goal Brief version",
            content: { "application/json": { schema: resolver(GoalBrief) } },
          },
        },
      }),
      validator("json", GoalBriefCreateRequest),
      async (c) =>
        c.json(
          await runRequest(
            "ExperienceRoutes.goalBrief.create",
            c,
            Effect.sync(() => GoalBrief.parse(GoalBriefStore.create(c.req.valid("json")))),
          ),
        ),
    )
    .post(
      "/goal-brief/generate",
      describeRoute({
        summary: "Generate and persist a validated Goal Brief with the configured default model",
        operationId: "experience.goalBrief.generate",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Generated Goal Brief version",
            content: { "application/json": { schema: resolver(GoalBrief) } },
          },
          422: {
            description: "Structured Goal Brief generation failed after bounded repair attempts",
            content: { "application/json": { schema: resolver(GoalBriefStructuredFailure) } },
          },
          409: {
            description: "Goal Brief generation request conflict",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("json", GoalBriefGenerateRequest),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.generate",
          c,
          generateGoalBrief(c.req.valid("json")).pipe(
            Effect.match({
              onSuccess: (brief) => ({ ok: true as const, brief }),
              onFailure: (error) => ({ ok: false as const, error }),
            }),
          ),
        )
        if (result.ok) return c.json(GoalBrief.parse(result.brief))
        if (result.error instanceof GoalBriefModelAdapter.GoalBriefRequestConflictError)
          return c.json(
            ExperienceApiError.parse({
              code: "request_conflict",
              message: result.error.message,
            }),
            409,
          )
        if (result.error instanceof GoalBriefModelAdapter.GoalBriefRequestInProgressError)
          return c.json(
            ExperienceApiError.parse({
              code: "request_in_progress",
              message: result.error.message,
            }),
            409,
          )
        if (result.error instanceof GoalBriefModelAdapter.GoalBriefModelAdaptationError)
          return c.json(GoalBriefStructuredFailure.parse(result.error.toApiError()), 422)
        throw result.error
      },
    )
    .get(
      "/goal-brief/project/:projectID",
      describeRoute({
        summary: "Read the Goal Brief or a read-only legacy Charter view for a project",
        operationId: "experience.goalBrief.project",
        responses: {
          200: {
            description: "Project Goal Brief view",
            content: { "application/json": { schema: resolver(GoalBriefProjectView) } },
          },
          404: {
            description: "Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.project",
          c,
          Effect.sync(() => GoalBriefStore.projectView(c.req.valid("param").projectID)),
        )
        if (!result) return c.json(missing("Goal Brief or legacy Charter not found"), 404)
        return c.json(GoalBriefProjectView.parse(result))
      },
    )
    .get(
      "/goal-brief/request/:requestID",
      describeRoute({
        summary: "Read the completed Goal Brief for a generation request",
        operationId: "experience.goalBrief.request",
        responses: {
          200: {
            description: "Generated Goal Brief version",
            content: { "application/json": { schema: resolver(GoalBrief) } },
          },
          404: {
            description: "Completed Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", RequestID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.request",
          c,
          Effect.sync(() => GoalBriefStore.getByGenerationRequest(c.req.valid("param").requestID)),
        )
        if (!result) return c.json(missing("Completed Goal Brief not found"), 404)
        return c.json(GoalBrief.parse(result))
      },
    )
    .get(
      "/goal-brief/:briefID/versions",
      describeRoute({
        summary: "List Goal Brief versions",
        operationId: "experience.goalBrief.history",
        responses: {
          200: {
            description: "Goal Brief history",
            content: { "application/json": { schema: resolver(GoalBriefHistory) } },
          },
          404: {
            description: "Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.history",
          c,
          Effect.sync(() => GoalBriefStore.history(c.req.valid("param").briefID)),
        )
        if (!result) return c.json(missing("Goal Brief not found"), 404)
        return c.json(GoalBriefHistory.parse(result))
      },
    )
    .post(
      "/goal-brief/:briefID/start",
      describeRoute({
        summary: "Start a Project from the current Goal Brief version",
        operationId: "experience.goalBrief.start",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Started Project binding",
            content: { "application/json": { schema: resolver(GoalBriefStartResult) } },
          },
          404: {
            description: "Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
          409: {
            description: "Goal Brief start conflict",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ID),
      validator("json", GoalBriefStartRequest),
      async (c) => {
        const input = c.req.valid("json")
        const ownerToken = crypto.randomUUID()
        const reservation = GoalBriefStore.reserveStart(
          c.req.valid("param").briefID,
          input,
          ownerToken,
          Date.now(),
          5 * 60_000,
        )
        if (reservation.status === "not_found")
          return c.json(missing("Goal Brief not found"), 404)
        if (reservation.status === "version_conflict")
          return c.json(
            ExperienceApiError.parse({
              code: "version_conflict",
              message: "Goal Brief was updated before execution started",
              currentVersion: reservation.currentVersion,
            }),
            409,
          )
        if (reservation.status === "pending")
          return c.json(
            ExperienceApiError.parse({
              code: "request_in_progress",
              message: "Goal Brief is already starting",
            }),
            409,
          )
        if (reservation.status === "blocked")
          return c.json(
            ExperienceApiError.parse({
              code: "request_conflict",
              message: `请先回答会影响执行的关键问题：${reservation.questionIDs.join("、")}`,
            }),
            409,
          )
        if (reservation.status === "conflict")
          return c.json(
            ExperienceApiError.parse({
              code: "request_conflict",
              message: "Goal Brief start request conflicts with its current binding",
            }),
            409,
          )
        if (reservation.status === "completed") {
          await runRequest(
            "ExperienceRoutes.goalBrief.start.replay",
            c,
            ensureGoalBriefProjectChannel(reservation.result.projectId),
          )
          return c.json(GoalBriefStartResult.parse(reservation.result))
        }
        const outcome = await runRequest(
          "ExperienceRoutes.goalBrief.start",
          c,
          Effect.exit(
            Effect.gen(function* () {
              const companyState = yield* (yield* Company.Service).current()
              if (companyState.state !== "ready") throw new Error("Company is not ready")
              const started = yield* CompanyProjectExecution.Service.use((execution) =>
                execution.start({
                  company_id: companyState.company.id,
                  goal: reservation.brief.goal,
                  title: goalProjectTitle(reservation.brief.goal),
                  decision_request_id: input.requestId,
                  provider_id: companyState.company.provider?.provider_id,
                  model_id: companyState.company.provider?.model_id,
                  charter: goalBriefCharter(reservation.brief),
                }),
              )
              return started
            }),
          ),
        )
        if (Exit.isFailure(outcome)) {
          GoalBriefStore.releaseStart(input.requestId, ownerToken)
          throw Cause.squash(outcome.cause)
        }
        const completed = GoalBriefStore.completeStart(
          input.requestId,
          ownerToken,
          outcome.value.project.id,
          outcome.value.run_id,
        )
        await runRequest(
          "ExperienceRoutes.goalBrief.start.channel",
          c,
          ensureGoalBriefProjectChannel(completed.projectId),
        )
        return c.json(
          GoalBriefStartResult.parse(completed),
        )
      },
    )
    .post(
      "/goal-brief/:briefID/versions",
      describeRoute({
        summary: "Append a validated Goal Brief version",
        operationId: "experience.goalBrief.append",
        requestBody: {
          required: true,
          content: { "application/json": {} },
        },
        responses: {
          200: {
            description: "Goal Brief version",
            content: { "application/json": { schema: resolver(GoalBrief) } },
          },
          404: {
            description: "Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
          409: {
            description: "Goal Brief version conflict",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ID),
      validator("json", GoalBriefAppendRequest),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.append",
          c,
          Effect.sync(() => GoalBriefStore.append(c.req.valid("param").briefID, c.req.valid("json"))),
        )
        if (result.ok) return c.json(GoalBrief.parse(result.brief))
        if (result.reason === "not_found") return c.json(missing("Goal Brief not found"), 404)
        return c.json(
          ExperienceApiError.parse({
            code: "version_conflict",
            message: "Goal Brief was updated by another writer",
            currentVersion: result.currentVersion,
          }),
          409,
        )
      },
    )
    .get(
      "/goal-brief/:briefID",
      describeRoute({
        summary: "Read the current Goal Brief version",
        operationId: "experience.goalBrief.get",
        responses: {
          200: {
            description: "Goal Brief version",
            content: { "application/json": { schema: resolver(GoalBrief) } },
          },
          404: {
            description: "Goal Brief not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.goalBrief.get",
          c,
          Effect.sync(() => GoalBriefStore.get(c.req.valid("param").briefID)),
        )
        if (!result) return c.json(missing("Goal Brief not found"), 404)
        return c.json(GoalBrief.parse(result))
      },
    )
    .get(
      "/projects/:projectID/artifacts/:artifactID",
      describeRoute({
        summary: "Read a project-bound delivery Artifact without exposing local filesystem paths",
        operationId: "experience.artifact.get",
        responses: {
          200: {
            description: "Safe read-only Artifact view",
            content: { "application/json": { schema: resolver(ExperienceArtifactView) } },
          },
          404: {
            description: "Project or Artifact not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
          422: {
            description: "Artifact exists but has no safely readable content",
            content: { "application/json": { schema: resolver(ExperienceArtifactUnavailable) } },
          },
        },
      }),
      validator("param", ArtifactID),
      async (c) => {
        const input = c.req.valid("param")
        const result = await runRequest(
          "ExperienceRoutes.artifact.get",
          c,
          Effect.sync(() => ExperienceArtifactService.read(input.projectID, input.artifactID)),
        )
        if (result.status === "not_found") return c.json(missing("Artifact not found"), 404)
        if (result.status === "unavailable")
          return c.json(
            ExperienceArtifactUnavailable.parse({
              code: "artifact_unavailable",
              message: "Artifact has no safely readable content.",
            }),
            422,
          )
        return c.json(ExperienceArtifactView.parse(result.artifact))
      },
    )
    .get(
      "/work",
      describeRoute({
        summary: "List stable user-facing work projections",
        operationId: "experience.work.list",
        responses: {
          200: {
            description: "Work projections",
            content: { "application/json": { schema: resolver(WorkProjectionList) } },
          },
        },
      }),
      async (c) =>
        c.json(
          await runRequest(
            "ExperienceRoutes.work.list",
            c,
            Effect.sync(() => WorkProjectionList.parse(WorkProjectionService.list())),
          ),
        ),
    )
    .get(
      "/work/archived",
      describeRoute({
        summary: "List archived user-facing work projections",
        operationId: "experience.work.archived",
        responses: {
          200: {
            description: "Archived work projections",
            content: { "application/json": { schema: resolver(WorkProjectionList) } },
          },
        },
      }),
      async (c) =>
        c.json(
          await runRequest(
            "ExperienceRoutes.work.archived",
            c,
            Effect.sync(() => WorkProjectionList.parse(WorkProjectionService.listArchived())),
          ),
        ),
    )
    .post(
      "/work/:projectID/actions",
      describeRoute({
        summary: "Execute a durable user-facing work action",
        operationId: "experience.work.action",
        requestBody: {
          required: true,
          content: {
            "application/json": {},
          },
        },
        responses: {
          200: {
            description: "Persisted work action result",
            content: {
              "application/json": { schema: resolver(ExperienceWorkActionResult) },
            },
          },
          404: {
            description: "Project or action target not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
          409: {
            description: "Work action request conflict",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      validator("json", ExperienceWorkActionRequest),
      async (c) => {
        const input = c.req.valid("json")
        const outcome = await runRequest(
          "ExperienceRoutes.work.action",
          c,
          Effect.exit(
            ProjectActionExecutor.Service.use((executor) =>
              executor.execute(projectActionRequest(c.req.valid("param").projectID, input)),
            ),
          ),
        )
        if (Exit.isFailure(outcome)) {
          const error = Cause.squash(outcome.cause)
          if (error instanceof CompanyAttention.ProjectActionTargetNotFoundError)
            return c.json(missing(error.message), 404)
          if (error instanceof CompanyAttention.ProjectActionRequestConflictError)
            return c.json(
              ExperienceApiError.parse({
                code: "request_conflict",
                message: error.message,
              }),
              409,
            )
          throw error
        }
        const executed = outcome.value
        return c.json(
          ExperienceWorkActionResult.parse({
            actionId: executed.action.id,
            projectId: executed.action.project_id,
            action: executed.action.action,
            status: executed.action.status,
            replayed: executed.replayed,
            result: executed.action.result,
            error: executed.action.error,
          }),
        )
      },
    )
    .get(
      "/work/:projectID/organization",
      describeRoute({
        summary: "Read the source-traceable project organization projection",
        operationId: "experience.work.organization",
        responses: {
          200: {
            description: "Project organization projection",
            content: { "application/json": { schema: resolver(OrganizationProjection) } },
          },
          404: {
            description: "Project not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.work.organization",
          c,
          Effect.sync(() => ExperienceProjectionService.organization(c.req.valid("param").projectID)),
        )
        if (!result) return c.json(missing("Work organization projection not found"), 404)
        return c.json(OrganizationProjection.parse(result))
      },
    )
    .get(
      "/work/:projectID/graph",
      describeRoute({
        summary: "Read source-traceable graph change diagnostics without raw mutation operations",
        operationId: "experience.work.graph",
        responses: {
          200: {
            description: "Project graph change summary",
            content: { "application/json": { schema: resolver(GraphChangeSummary) } },
          },
          404: {
            description: "Project not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.work.graph",
          c,
          Effect.sync(() => ExperienceProjectionService.graph(c.req.valid("param").projectID)),
        )
        if (!result) return c.json(missing("Work graph projection not found"), 404)
        return c.json(GraphChangeSummary.parse(result))
      },
    )
    .get(
      "/work/:projectID/receipts/:receiptID",
      describeRoute({
        summary: "Read a source-traceable discovery summary for one persisted Work Receipt",
        operationId: "experience.work.receipt",
        responses: {
          200: {
            description: "Receipt discovery summary",
            content: { "application/json": { schema: resolver(DiscoverySummary) } },
          },
          404: {
            description: "Project or Work Receipt not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ReceiptID),
      async (c) => {
        const input = c.req.valid("param")
        const result = await runRequest(
          "ExperienceRoutes.work.receipt",
          c,
          Effect.sync(() => ExperienceProjectionService.discovery(input.projectID, input.receiptID)),
        )
        if (!result) return c.json(missing("Work Receipt discovery projection not found"), 404)
        return c.json(DiscoverySummary.parse(result))
      },
    )
    .get(
      "/work/:projectID/validation",
      describeRoute({
        summary: "Read source-traceable validation criteria and evidence summaries",
        operationId: "experience.work.validation",
        responses: {
          200: {
            description: "Project validation summary",
            content: { "application/json": { schema: resolver(ValidationSummary) } },
          },
          404: {
            description: "Project not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.work.validation",
          c,
          Effect.sync(() => ExperienceProjectionService.validation(c.req.valid("param").projectID)),
        )
        if (!result) return c.json(missing("Work validation projection not found"), 404)
        return c.json(ValidationSummary.parse(result))
      },
    )
    .get(
      "/work/:projectID",
      describeRoute({
        summary: "Read a stable user-facing work projection",
        operationId: "experience.work.get",
        responses: {
          200: {
            description: "Work projection",
            content: { "application/json": { schema: resolver(WorkProjection) } },
          },
          404: {
            description: "Work projection not found",
            content: { "application/json": { schema: resolver(ExperienceApiError) } },
          },
        },
      }),
      validator("param", ProjectID),
      async (c) => {
        const result = await runRequest(
          "ExperienceRoutes.work.get",
          c,
          Effect.sync(() => WorkProjectionService.rebuild(c.req.valid("param").projectID)),
        )
        if (!result) return c.json(missing("Work projection not found"), 404)
        return c.json(WorkProjection.parse(result))
      },
    )
}

export const ExperienceRoutes = lazy(() => createExperienceRoutes())
