import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { Effect } from "effect"
import z from "zod"
import { CompanyProject, CompanyProjectExecution } from "@/company-project"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const StartSchema = z.object({
  goal: z.string().min(1),
  title: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  provider_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
})

const ResolveGateSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
})

const CancelSchema = z.object({ reason: z.string().min(1).optional() })
const RetrySchema = z.object({
  provider_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
})

const StartResultSchema = z.object({
  project: z.unknown(),
  run_id: z.string(),
})

const GateResultSchema = z.object({
  gate: z.unknown(),
  run_id: z.string().optional(),
})

export const CompanyProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List company projects",
        operationId: "companyProject.list",
        responses: { 200: { description: "Projects" } },
      }),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.list", c, function* () {
          return yield* (yield* CompanyProject.Service).list()
        }),
    )
    .post(
      "/",
      describeRoute({
        summary: "Start an autonomous company project",
        description: "Creates a persistent project and starts research. Execution stops at the product approval gate.",
        operationId: "companyProject.start",
        responses: {
          200: {
            description: "Project and workflow run",
            content: { "application/json": { schema: resolver(StartResultSchema) } },
          },
        },
      }),
      validator("json", StartSchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.start", c, function* () {
          return yield* (yield* CompanyProjectExecution.Service).start(c.req.valid("json"))
        }),
    )
    .get(
      "/:projectID",
      describeRoute({
        summary: "Get company project execution state",
        operationId: "companyProject.get",
        responses: { 200: { description: "Project state" } },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.get", c, function* () {
          const service = yield* CompanyProject.Service
          const project = yield* service.get(c.req.valid("param").projectID)
          if (!project) return yield* Effect.fail(new Error("Company project not found"))
          const [plans, work_items, artifacts, gates, charter, worktree_runs] = yield* Effect.all([
            service.listPlans(project.id),
            service.listWorkItems(project.id),
            service.listArtifacts(project.id),
            service.listGates(project.id),
            service.getCharter(project.id),
            service.listWorktreeRuns(project.id),
          ])
          return { project, charter, plans, work_items, worktree_runs, artifacts, gates }
        }),
    )
    .post(
      "/:projectID/cancel",
      describeRoute({
        summary: "Cancel a running company project",
        description: "Cancels the active workflow and marks running work items and the project as blocked.",
        operationId: "companyProject.cancel",
        responses: { 200: { description: "Cancelled project" } },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("json", CancelSchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.cancel", c, function* () {
          return yield* (yield* CompanyProjectExecution.Service).cancel({
            project_id: c.req.valid("param").projectID,
            reason: c.req.valid("json").reason,
          })
        }),
    )
    .post(
      "/:projectID/retry",
      describeRoute({
        summary: "Resume a blocked company project",
        description: "Reuses the approved plan, repository and worktree while allowing a model change.",
        operationId: "companyProject.retry",
        responses: {
          200: {
            description: "Project and resumed workflow run",
            content: { "application/json": { schema: resolver(StartResultSchema) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("json", RetrySchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.retry", c, function* () {
          return yield* (yield* CompanyProjectExecution.Service).retry({
            project_id: c.req.valid("param").projectID,
            ...c.req.valid("json"),
          })
        }),
    )
    .post(
      "/:projectID/gates/:gateID/resolve",
      describeRoute({
        summary: "Resolve a company project human gate",
        description: "Approval starts the next stage; rejection stops the project.",
        operationId: "companyProject.resolveGate",
        responses: {
          200: {
            description: "Gate and next workflow",
            content: { "application/json": { schema: resolver(GateResultSchema) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1), gateID: z.string().min(1) })),
      validator("json", ResolveGateSchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.resolveGate", c, function* () {
          const project = yield* (yield* CompanyProject.Service).get(c.req.valid("param").projectID)
          if (!project) return yield* Effect.fail(new Error("Company project not found"))
          const gate = (yield* (yield* CompanyProject.Service).listGates(project.id)).find(
            (item) => item.id === c.req.valid("param").gateID,
          )
          if (!gate) return yield* Effect.fail(new Error("Approval gate does not belong to this project"))
          const body = c.req.valid("json")
          return yield* (yield* CompanyProjectExecution.Service).resolveGate({
            gate_id: c.req.valid("param").gateID,
            decision: body.decision,
            note: body.note,
          })
        }),
    ),
)
