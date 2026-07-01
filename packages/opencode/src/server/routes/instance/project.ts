import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "@/project/instance"
import { Project } from "@/project"
import { TokenGovernance } from "@/token-governance/token-governance"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { jsonRequest, runRequest } from "./trace"

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .get(
      "/token-stats/root-need/:rootNeedID",
      describeRoute({
        summary: "Get RootNeed token stats",
        description: "Return full-chain token usage threaded by RootNeedID across delegation levels and execution threads.",
        operationId: "project.rootNeedTokenStats",
        responses: {
          200: {
            description: "RootNeed token usage report",
            content: {
              "application/json": {
                schema: resolver(TokenGovernance.Info.RootNeedTokenReport),
              },
            },
          },
        },
      }),
      validator("param", z.object({ rootNeedID: z.string().min(1) })),
      async (c) =>
        jsonRequest("ProjectRoutes.rootNeedTokenStats", c, function* () {
          const svc = yield* TokenGovernance.Service
          return yield* svc.rootNeed(c.req.valid("param").rootNeedID)
        }),
    )
    .get(
      "/:projectID/token-stats",
      describeRoute({
        summary: "Get project token stats",
        description: "Return token usage for all sessions and execution threads in a project.",
        operationId: "project.tokenStats",
        responses: {
          200: {
            description: "Project token usage report",
            content: {
              "application/json": {
                schema: resolver(TokenGovernance.Info.ProjectTokenReport),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      async (c) =>
        jsonRequest("ProjectRoutes.tokenStats", c, function* () {
          const svc = yield* TokenGovernance.Service
          return yield* svc.project(c.req.valid("param").projectID)
        }),
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await runRequest(
          "ProjectRoutes.initGit",
          c,
          Project.Service.use((svc) => svc.initGit({ directory: dir, project: prev })),
        )
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await Instance.reload({
          directory: dir,
          worktree: dir,
          project: next,
          init: () => AppRuntime.runPromise(InstanceBootstrap),
        })
        return c.json(next)
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.update", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.update({ ...body, projectID })
        }),
    )
    .post(
      "/:projectID/block",
      describeRoute({
        summary: "Block project",
        description: "Emergency-stop a project when token usage or execution risk is out of control.",
        operationId: "project.block",
        responses: {
          200: {
            description: "Blocked project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.BlockInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.block", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.block({ ...body, projectID })
        }),
    )
    .post(
      "/:projectID/unblock",
      describeRoute({
        summary: "Unblock project",
        description: "Clear a project emergency stop after the blocking condition has been resolved.",
        operationId: "project.unblock",
        responses: {
          200: {
            description: "Unblocked project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UnblockInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.unblock", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.unblock({ ...body, projectID })
        }),
    ),
)
