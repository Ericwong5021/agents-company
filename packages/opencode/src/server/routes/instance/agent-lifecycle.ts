import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { CompanyAgent } from "@/company-agent/company-agent"
import { CompanyAgentID } from "@/company-agent/schema"
import { Thread } from "@/thread/thread"
import z from "zod"
import { Effect } from "effect"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const AgentStartResponse = z.object({
  agent: CompanyAgent.PublicInfo,
  thread: Thread.Info,
})

const AgentStopResponse = z.object({
  completedCount: z.number(),
  threads: Thread.Info.array(),
})

const AgentStatusResponse = z.object({
  agent: CompanyAgent.PublicInfo,
  activity: Thread.AgentActivity,
  status: z.enum(["idle", "busy", "paused"]),
})

const AllAgentStatusResponse = z.object({
  agents: AgentStatusResponse.array(),
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const AgentLifecycleRoutes = lazy(() =>
  new Hono()
    // -----------------------------------------------------------------------
    // POST /agents/:id/start — Start an agent (create primary thread)
    // -----------------------------------------------------------------------
    .post(
      "/agents/:id/start",
      describeRoute({
        summary: "Start an agent",
        description:
          "Start a company agent by creating a primary thread. Returns 404 if the agent does not exist, 409 if the agent already has an active primary thread.",
        operationId: "agentLifecycle.start",
        responses: {
          200: {
            description: "Agent started with primary thread created",
            content: { "application/json": { schema: resolver(AgentStartResponse) } },
          },
          ...errors(404, 409),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) => {
        const id = c.req.valid("param").id

        // Verify agent exists
        const agent = await runRequest(
          "AgentLifecycleRoutes.start.get",
          c,
          Effect.gen(function* () {
            const svc = yield* CompanyAgent.Service
            return yield* svc.get(id)
          }),
        )
        if (!agent) return c.json({ error: "agent not found" }, 404)
        if (agent.lifecycle !== "employee") return c.json({ error: "candidate must be promoted before starting" }, 409)

        // Check if agent can accept a primary thread
        const canAccept = await runRequest(
          "AgentLifecycleRoutes.start.canAccept",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.canAccept(id, "primary")
          }),
        )
        if (!canAccept) return c.json({ error: "agent already has an active primary thread" }, 409)

        // Create primary thread
        const thread = await runRequest(
          "AgentLifecycleRoutes.start.create",
          c,
          Effect.gen(function* () {
            const svc = yield* Thread.Service
            return yield* svc.create({ agentID: id, kind: "primary" })
          }),
        )

        return c.json({ agent: CompanyAgent.toPublicInfo(agent), thread })
      },
    )
    // -----------------------------------------------------------------------
    // POST /agents/:id/stop — Stop an agent (complete all active threads)
    // -----------------------------------------------------------------------
    .post(
      "/agents/:id/stop",
      describeRoute({
        summary: "Stop an agent",
        description:
          "Stop a company agent by completing all its active threads. Returns 404 if the agent does not exist.",
        operationId: "agentLifecycle.stop",
        responses: {
          200: {
            description: "Agent stopped, active threads completed",
            content: { "application/json": { schema: resolver(AgentStopResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) => {
        const id = c.req.valid("param").id

        // Verify agent exists
        const agent = await runRequest(
          "AgentLifecycleRoutes.stop.get",
          c,
          Effect.gen(function* () {
            const svc = yield* CompanyAgent.Service
            return yield* svc.get(id)
          }),
        )
        if (!agent) return c.json({ error: "agent not found" }, 404)

        // Complete all active threads for the agent
        const result = await runRequest(
          "AgentLifecycleRoutes.stop.complete",
          c,
          Effect.gen(function* () {
            const threadSvc = yield* Thread.Service
            const allThreads = yield* threadSvc.listByAgent(id)
            const activeThreads = allThreads.filter((t) => t.status === "active")
            const completed: Thread.Info[] = []
            for (const thread of activeThreads) {
              const info = yield* threadSvc.complete(thread.id)
              completed.push(info)
            }
            return { completedCount: completed.length, threads: completed }
          }),
        )

        return c.json(result)
      },
    )
    // -----------------------------------------------------------------------
    // GET /agents/:id/status — Get agent status with thread activity rollup
    // -----------------------------------------------------------------------
    .get(
      "/agents/:id/status",
      describeRoute({
        summary: "Get agent status",
        description:
          "Get the status of a specific company agent, including thread activity rollup. Returns 404 if the agent does not exist.",
        operationId: "agentLifecycle.status",
        responses: {
          200: {
            description: "Agent status with activity rollup",
            content: { "application/json": { schema: resolver(AgentStatusResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: CompanyAgentID.zod })),
      async (c) => {
        const id = c.req.valid("param").id

        // Verify agent exists
        const agent = await runRequest(
          "AgentLifecycleRoutes.status.get",
          c,
          Effect.gen(function* () {
            const svc = yield* CompanyAgent.Service
            return yield* svc.get(id)
          }),
        )
        if (!agent) return c.json({ error: "agent not found" }, 404)

        // Get activity rollup and status
        const { activity, status } = await runRequest(
          "AgentLifecycleRoutes.status.activity",
          c,
          Effect.gen(function* () {
            const threadSvc = yield* Thread.Service
            const [activity, status] = yield* Effect.all(
              [threadSvc.agentActivity(id), threadSvc.agentStatus(id)],
              { concurrency: 2 },
            )
            return { activity, status }
          }),
        )

        return c.json({ agent: CompanyAgent.toPublicInfo(agent), activity, status })
      },
    )
    // -----------------------------------------------------------------------
    // GET /agents/status — Get all agents' status (for workstation view)
    // -----------------------------------------------------------------------
    .get(
      "/agents/status",
      describeRoute({
        summary: "Get all agents' status",
        description:
          "Get the status of all company agents, including thread activity rollup for each. Designed for the workstation view.",
        operationId: "agentLifecycle.statusAll",
        responses: {
          200: {
            description: "All agents' status with activity rollup",
            content: { "application/json": { schema: resolver(AllAgentStatusResponse) } },
          },
        },
      }),
      async (c) => {
        const result = await runRequest(
          "AgentLifecycleRoutes.statusAll",
          c,
          Effect.gen(function* () {
            const agentSvc = yield* CompanyAgent.Service
            const threadSvc = yield* Thread.Service

            const agents = yield* agentSvc.list()

            const statuses = yield* Effect.all(
              agents.map((agent) =>
                Effect.gen(function* () {
                  const [activity, status] = yield* Effect.all(
                    [threadSvc.agentActivity(agent.id), threadSvc.agentStatus(agent.id)],
                    { concurrency: 2 },
                  )
                  return { agent: CompanyAgent.toPublicInfo(agent), activity, status }
                }),
              ),
              { concurrency: "unbounded" },
            )

            return { agents: statuses }
          }),
        )
        return c.json(result)
      },
    ),
)
