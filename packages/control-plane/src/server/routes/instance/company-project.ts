import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { Effect } from "effect"
import z from "zod"
import {
  CompanyOutcomeSignal,
  CompanyProject,
  CompanyProjectExecution,
  OutcomeSignal,
  OutcomeSignalSubmission,
  OutcomeSignalTransition,
  OutcomeSignalTransitionSubmission,
  Project,
  WorkAttempt,
  WorkReceipt,
} from "@/company-project"
import { ProjectExecutionStrategy, SeedPolicyFacts } from "@agents-company/shared/project-orchestration"
import { AgentRun } from "@/agent-run/agent-run"
import { TokenGovernance } from "@/token-governance/token-governance"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const StartSchema = z.object({
  goal: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(240).optional(),
  session_id: z.string().min(1).optional(),
  provider_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  execution_strategy: ProjectExecutionStrategy.optional(),
  seed_policy: SeedPolicyFacts.optional(),
})

const ResolveGateSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
})

const ReceiptPageSchema = z.object({
  limit: z.coerce.number().int().positive().max(51).default(51),
  offset: z.coerce.number().int().nonnegative().max(100_000).default(0),
})
const OutcomePageSchema = ReceiptPageSchema

const CancelSchema = z.object({ reason: z.string().min(1).optional() })
const RetrySchema = z.object({
  provider_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
})

const StartResultSchema = z.object({
  project: Project,
  run_id: z.string(),
})

const GateResultSchema = z.object({
  gate: z.unknown(),
  run_id: z.string().optional(),
})
const OutcomeSubmissionResultSchema = z.object({
  signal: OutcomeSignal,
  replayed: z.boolean(),
})
const OutcomeTransitionResultSchema = z.object({
  signal: OutcomeSignal,
  transition: OutcomeSignalTransition,
  replayed: z.boolean(),
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
        description: "Creates a persistent project, forms a dynamic task tree and starts autonomous execution.",
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
          const [
            plans,
            work_items,
            work_attempts,
            work_receipts,
            outcome_signals,
            artifacts,
            gates,
            charter,
            worktree_runs,
            agent_runs,
            usage,
          ] = yield* Effect.all([
            service.listPlans(project.id),
            service.listWorkItems(project.id),
            service.listWorkAttempts(project.id),
            service.listWorkReceipts(project.id),
            (yield* CompanyOutcomeSignal.Service).list(project.id),
            service.listArtifacts(project.id),
            service.listGates(project.id),
            service.getCharter(project.id),
            service.listWorktreeRuns(project.id),
            (yield* AgentRun.Service).list({ companyProjectID: project.id, limit: 500 }),
            (yield* TokenGovernance.Service).companyProject(project.id),
          ])
          return {
            project,
            charter,
            plans,
            work_items,
            work_attempts,
            work_receipts,
            outcome_signals,
            worktree_runs,
            artifacts,
            gates,
            agent_runs,
            usage,
          }
        }),
    )
    .get(
      "/:projectID/attempts",
      describeRoute({
        summary: "List persisted work attempts",
        operationId: "companyProject.attempts",
        responses: {
          200: {
            description: "Work attempts",
            content: { "application/json": { schema: resolver(z.array(WorkAttempt)) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.attempts", c, function* () {
          return yield* (yield* CompanyProject.Service).listWorkAttempts(c.req.valid("param").projectID)
        }),
    )
    .get(
      "/:projectID/receipts",
      describeRoute({
        summary: "List persisted work receipts",
        operationId: "companyProject.receipts",
        responses: {
          200: {
            description: "Work receipts",
            content: { "application/json": { schema: resolver(z.array(WorkReceipt)) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("query", ReceiptPageSchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.receipts", c, function* () {
          return yield* (yield* CompanyProject.Service).listWorkReceipts(
            c.req.valid("param").projectID,
            c.req.valid("query"),
          )
        }),
    )
    .get(
      "/:projectID/outcomes",
      describeRoute({
        summary: "List independent outcome signals",
        operationId: "companyProject.outcomes",
        responses: {
          200: {
            description: "Outcome signals",
            content: { "application/json": { schema: resolver(z.array(OutcomeSignal)) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("query", OutcomePageSchema),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.outcomes", c, function* () {
          return yield* (yield* CompanyOutcomeSignal.Service).list(
            c.req.valid("param").projectID,
            c.req.valid("query"),
          )
        }),
    )
    .post(
      "/:projectID/outcomes",
      describeRoute({
        summary: "Submit an independent outcome signal",
        description:
          "Appends an outcome backed by a terminal Validation Gate or independently verified Artifact. Runtime completion and Work Receipt self-report are insufficient.",
        operationId: "companyProject.submitOutcome",
        responses: {
          200: {
            description: "Outcome signal",
            content: { "application/json": { schema: resolver(OutcomeSubmissionResultSchema) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("json", OutcomeSignalSubmission),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.submitOutcome", c, function* () {
          return yield* (yield* CompanyOutcomeSignal.Service).submit({
            project_id: c.req.valid("param").projectID,
            signal: c.req.valid("json"),
          })
        }),
    )
    .get(
      "/:projectID/outcomes/:outcomeID",
      describeRoute({
        summary: "Get an independent outcome signal",
        operationId: "companyProject.outcome",
        responses: {
          200: {
            description: "Outcome signal",
            content: { "application/json": { schema: resolver(OutcomeSignal) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1), outcomeID: z.string().min(1) })),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.outcome", c, function* () {
          const signal = yield* (yield* CompanyOutcomeSignal.Service).get(c.req.valid("param").outcomeID)
          if (!signal || signal.project_id !== c.req.valid("param").projectID)
            return yield* Effect.fail(new Error("Outcome signal not found"))
          return signal
        }),
    )
    .get(
      "/:projectID/outcomes/:outcomeID/transitions",
      describeRoute({
        summary: "List append-only Outcome Signal transitions",
        operationId: "companyProject.outcomeTransitions",
        responses: {
          200: {
            description: "Outcome signal transitions",
            content: { "application/json": { schema: resolver(z.array(OutcomeSignalTransition)) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1), outcomeID: z.string().min(1) })),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.outcomeTransitions", c, function* () {
          const signal = yield* (yield* CompanyOutcomeSignal.Service).get(c.req.valid("param").outcomeID)
          if (!signal || signal.project_id !== c.req.valid("param").projectID)
            return yield* Effect.fail(new Error("Outcome signal not found"))
          return yield* (yield* CompanyOutcomeSignal.Service).listTransitions(signal.id)
        }),
    )
    .post(
      "/:projectID/outcomes/:outcomeID/transitions",
      describeRoute({
        summary: "Append an Outcome Signal validation transition",
        operationId: "companyProject.transitionOutcome",
        responses: {
          200: {
            description: "Updated outcome projection",
            content: { "application/json": { schema: resolver(OutcomeTransitionResultSchema) } },
          },
        },
      }),
      validator("param", z.object({ projectID: z.string().min(1), outcomeID: z.string().min(1) })),
      validator("json", OutcomeSignalTransitionSubmission),
      async (c) =>
        jsonRequest("CompanyProjectRoutes.transitionOutcome", c, function* () {
          const signal = yield* (yield* CompanyOutcomeSignal.Service).get(c.req.valid("param").outcomeID)
          if (!signal || signal.project_id !== c.req.valid("param").projectID)
            return yield* Effect.fail(new Error("Outcome signal not found"))
          return yield* (yield* CompanyOutcomeSignal.Service).transition({
            outcome_signal_id: signal.id,
            transition: c.req.valid("json"),
          })
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
        description: "Preserves the task tree and failed attempts, then resumes retryable work with an optional model override.",
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
        description: "Resolves an exceptional risk or merge gate and resumes eligible work when approved.",
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
