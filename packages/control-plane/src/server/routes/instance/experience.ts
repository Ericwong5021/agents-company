import { Effect } from "effect"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import {
  ExperienceApiError,
  ExperienceArtifactUnavailable,
  ExperienceArtifactView,
  GoalBrief,
  GoalBriefAppendRequest,
  GoalBriefCreateRequest,
  GoalBriefGenerateRequest,
  GoalBriefHistory,
  GoalBriefProjectView,
  GoalBriefStructuredFailure,
  WorkProjection,
  WorkProjectionList,
} from "@agents-company/shared/experience"
import { GoalBriefModelAdapter, GoalBriefStore } from "@/goal-brief"
import * as WorkProjectionService from "@/company-project/work-projection"
import * as ExperienceArtifactService from "@/company-project/experience-artifact"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

const ID = z.object({ briefID: z.string().trim().min(1) }).strict()
const ProjectID = z.object({ projectID: z.string().trim().min(1) }).strict()
const ArtifactID = z
  .object({
    projectID: z.string().trim().min(1),
    artifactID: z.string().trim().min(1),
  })
  .strict()

function missing(message: string) {
  return ExperienceApiError.parse({ code: "not_found", message })
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
