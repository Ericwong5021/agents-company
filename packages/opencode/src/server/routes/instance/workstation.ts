import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Thread } from "@/thread/thread"
import { CompanyAgent } from "@/company-agent/company-agent"
import z from "zod"
import { Effect } from "effect"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ThreadStatusSchema = z.object({
  id: z.string(),
  kind: z.enum(["primary", "reactive", "ambient"]),
  status: z.enum(["active", "paused", "completed"]),
  task_summary: z.string().optional(),
  budget_tokens: z.number().optional(),
  spent_tokens: z.number(),
})

const AgentStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_layer: z.enum(["board", "execution"]),
  status: z.enum(["idle", "busy", "focused"]),
  threads: z.array(ThreadStatusSchema),
})

const WorkstationStatusSchema = z.object({
  agents: z.array(AgentStatusSchema),
  summary: z.object({
    total_agents: z.number(),
    active_agents: z.number(),
    total_threads: z.number(),
    open_tasks: z.number(),
  }),
})

// ---------------------------------------------------------------------------
// Helper: derive org layer from agent ID
// ---------------------------------------------------------------------------

function deriveOrgLayer(agentID: string): "board" | "execution" {
  const boardIDs = ["ceo", "cto", "cfo", "coo", "cmo", "board"]
  if (boardIDs.includes(agentID.toLowerCase())) return "board"
  return "execution"
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const WorkstationRoutes = lazy(() =>
  new Hono().get(
    "/status",
    describeRoute({
      summary: "Get workstation status",
      description:
        "Returns aggregated workstation data: all agents with their current status, active threads, and summary counts.",
      operationId: "workstation.status",
      responses: {
        200: {
          description: "Workstation status",
          content: { "application/json": { schema: resolver(WorkstationStatusSchema) } },
        },
      },
    }),
    async (c) =>
      runRequest("WorkstationRoutes.status", c, function* () {
        const agentSvc = yield* CompanyAgent.Service
        const threadSvc = yield* Thread.Service

        const agentList = yield* agentSvc.list()
        const allThreads = yield* threadSvc.listActive()

        // Build per-agent data
        const agents = yield* Effect.all(
          agentList.map(function* (agent) {
            const agentThreads = allThreads.filter((t) => t.agentID === agent.id)
            const status = yield* threadSvc.agentStatus(agent.id)

            return {
              id: agent.id,
              name: agent.name,
              org_layer: deriveOrgLayer(agent.id),
              status,
              threads: agentThreads.map((t) => ({
                id: t.id,
                kind: t.kind,
                status: t.status,
                task_summary: t.description,
                budget_tokens: t.budgetTokens,
                spent_tokens: t.spentTokens,
              })),
            }
          }),
          { concurrency: 5 },
        )

        // Compute summary
        const totalAgents = agents.length
        const activeAgents = agents.filter((a) => a.status !== "idle").length
        const totalThreads = agents.reduce((sum, a) => sum + a.threads.length, 0)
        const openTasks = agents.reduce(
          (sum, a) => sum + a.threads.filter((t) => t.kind === "primary" && t.status === "active").length,
          0,
        )

        return {
          agents,
          summary: {
            total_agents: totalAgents,
            active_agents: activeAgents,
            total_threads: totalThreads,
            open_tasks: openTasks,
          },
        }
      }),
  ),
)
