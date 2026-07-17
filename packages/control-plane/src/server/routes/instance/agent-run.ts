import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { AgentRun } from "@/agent-run/agent-run"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

export const AgentRunRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List Agent Runs",
        operationId: "agentRun.list",
        responses: { 200: { description: "Agent Runs", content: { "application/json": { schema: resolver(AgentRun.Info.array()) } } } },
      }),
      validator(
        "query",
        z.object({
          agent_id: z.string().optional(),
          workflow_run_id: z.string().optional(),
          group_session_id: z.string().optional(),
          company_project_id: z.string().optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("AgentRunRoutes.list", c, function* () {
          const query = c.req.valid("query")
          return yield* (yield* AgentRun.Service).list({
            agentID: query.agent_id,
            workflowRunID: query.workflow_run_id,
            groupSessionID: query.group_session_id,
            companyProjectID: query.company_project_id,
            limit: query.limit,
          })
        }),
    )
    .get(
      "/:runID",
      describeRoute({ summary: "Get an Agent Run", operationId: "agentRun.get", responses: { 200: { description: "Agent Run" } } }),
      validator("param", z.object({ runID: z.string().min(1) })),
      async (c) =>
        jsonRequest("AgentRunRoutes.get", c, function* () {
          return yield* (yield* AgentRun.Service).get(c.req.valid("param").runID)
        }),
    )
    .get(
      "/:runID/events",
      describeRoute({ summary: "List persisted Agent Run events", operationId: "agentRun.events", responses: { 200: { description: "Ordered runtime events" } } }),
      validator("param", z.object({ runID: z.string().min(1) })),
      async (c) =>
        jsonRequest("AgentRunRoutes.events", c, function* () {
          return yield* (yield* AgentRun.Service).events(c.req.valid("param").runID)
        }),
    )
    .post(
      "/:runID/message",
      describeRoute({ summary: "Deliver a live Agent Run message", operationId: "agentRun.message", responses: { 200: { description: "Delivered" } } }),
      validator("param", z.object({ runID: z.string().min(1) })),
      validator("json", z.object({ content: z.string().min(1), priority: z.enum(["steer", "follow_up"]).default("follow_up") })),
      async (c) =>
        jsonRequest("AgentRunRoutes.message", c, function* () {
          yield* (yield* AgentRunSupervisor.Service).deliver({ runID: c.req.valid("param").runID, ...c.req.valid("json") })
          return true
        }),
    )
    .post(
      "/:runID/interrupt",
      describeRoute({ summary: "Interrupt an Agent Run", operationId: "agentRun.interrupt", responses: { 200: { description: "Interrupt result" } } }),
      validator("param", z.object({ runID: z.string().min(1) })),
      async (c) =>
        jsonRequest("AgentRunRoutes.interrupt", c, function* () {
          return yield* (yield* AgentRunSupervisor.Service).interrupt(c.req.valid("param").runID)
        }),
    )
    .post(
      "/:runID/stop",
      describeRoute({ summary: "Stop an Agent Run", operationId: "agentRun.stop", responses: { 200: { description: "Stop result" } } }),
      validator("param", z.object({ runID: z.string().min(1) })),
      async (c) =>
        jsonRequest("AgentRunRoutes.stop", c, function* () {
          return yield* (yield* AgentRunSupervisor.Service).stop(c.req.valid("param").runID)
        }),
    ),
)
