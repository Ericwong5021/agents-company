import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Thread } from "@/thread/thread"
import { CompanyAgent } from "@/company-agent/company-agent"
import { Project } from "@/project"
import { Instance } from "@/project/instance"
import { AgentMessage } from "@/agent-message/agent-message"
import { CompanyProject } from "@/company-project"
import { AuditEvent } from "@/audit-event/audit-event"
import z from "zod"
import { Effect } from "effect"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { validator } from "hono-openapi"

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

const OrgLayerSchema = z.enum(["board", "department", "project", "execution", "tool"])

const AgentStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_layer: OrgLayerSchema,
  status: z.enum(["idle", "busy", "paused"]),
  threads: z.array(ThreadStatusSchema),
})

const ApprovalSchema = z.object({
  id: z.string(),
  source: z.enum(["message", "project_gate"]),
  project_id: z.string().optional(),
  gate_kind: z.enum(["risk_approval", "merge_approval"]).optional(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  root_need_id: z.string().optional(),
  thread_id: z.string().optional(),
  in_reply_to: z.string().optional(),
  task_summary: z.string().optional(),
  body: z.string(),
  depth: z.number(),
  time_created: z.number(),
})

interface CollaborationNode {
  id: string
  kind: "fyi" | "request" | "reply" | "proposal"
  from_agent_id: string
  to_agent_id: string
  task_summary?: string
  outcome?: string
  depth: number
  time_created: number
  children: CollaborationNode[]
}

const CollaborationNodeSchema: z.ZodType<CollaborationNode> = z
  .lazy(() =>
    z.object({
      id: z.string(),
      kind: z.enum(["fyi", "request", "reply", "proposal"]),
      from_agent_id: z.string(),
      to_agent_id: z.string(),
      task_summary: z.string().optional(),
      outcome: z.string().optional(),
      depth: z.number(),
      time_created: z.number(),
      children: z.array(CollaborationNodeSchema),
    }),
  )
  .meta({ ref: "WorkstationCollaborationNode" })

const CollaborationTreeSchema = z.object({
  root_need_id: z.string(),
  total_messages: z.number(),
  max_depth: z.number(),
  nodes: z.array(CollaborationNodeSchema),
})

const WorkstationStatusSchema = z.object({
  project: z.object({
    id: z.string(),
    company_project_id: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    output_dir: z.string().optional(),
    active_run_id: z.string().optional(),
    blocked: z.boolean(),
    blocked_reason: z.string().optional(),
    blocked_by_agent_id: z.string().optional(),
    time_blocked: z.number().optional(),
  }),
  agents: z.array(AgentStatusSchema),
  summary: z.object({
    total_agents: z.number(),
    active_agents: z.number(),
    total_threads: z.number(),
    open_tasks: z.number(),
    pending_approvals: z.number(),
  }),
  approvals: z.array(ApprovalSchema),
  collaboration_trees: z.array(CollaborationTreeSchema),
})

const ResolveApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  actorAgentID: z.string().optional(),
  reason: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Helper: derive org layer from agent ID
// ---------------------------------------------------------------------------

function deriveOrgLayer(agentID: string): z.infer<typeof OrgLayerSchema> {
  const boardIDs = ["ceo", "cto", "cfo", "coo", "cmo", "board"]
  if (boardIDs.includes(agentID.toLowerCase())) return "board"
  return "execution"
}

function orgLayer(agent: CompanyAgent.Info): z.infer<typeof OrgLayerSchema> {
  const parsed = OrgLayerSchema.safeParse(agent.org_layer)
  if (parsed.success) return parsed.data
  return deriveOrgLayer(agent.id)
}

function buildCollaborationTree(rootNeedID: string, messages: AgentMessage.Info[]) {
  const nodes = new Map<string, CollaborationNode>()
  const roots: CollaborationNode[] = []
  const lastRequestAtDepth = new Map<number, CollaborationNode>()

  for (const message of [...messages].sort((a, b) => a.time.created - b.time.created)) {
    const node = {
      id: message.id,
      kind: message.kind,
      from_agent_id: message.fromAgentID,
      to_agent_id: message.toAgentID,
      task_summary: message.taskSummary,
      outcome: message.outcome,
      depth: message.depth,
      time_created: message.time.created,
      children: [],
    }
    const parent =
      (message.inReplyTo ? nodes.get(message.inReplyTo) : undefined) ?? lastRequestAtDepth.get(message.depth - 1)
    if (parent) parent.children.push(node)
    else roots.push(node)
    nodes.set(message.id, node)
    if (message.kind === "request") lastRequestAtDepth.set(message.depth, node)
  }

  return {
    root_need_id: rootNeedID,
    total_messages: messages.length,
    max_depth: messages.reduce((max, message) => Math.max(max, message.depth), 0),
    nodes: roots,
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const WorkstationRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get workstation status",
        description:
          "Returns aggregated workstation data: all agents with their current status, active threads, approval prompts, and summary counts.",
        operationId: "workstation.status",
        responses: {
          200: {
            description: "Workstation status",
            content: { "application/json": { schema: resolver(WorkstationStatusSchema) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("WorkstationRoutes.status", c, function* () {
          const agentSvc = yield* CompanyAgent.Service
          const threadSvc = yield* Thread.Service
          const projectSvc = yield* Project.Service
          const messageSvc = yield* AgentMessage.Service
          const companyProjectSvc = yield* CompanyProject.Service

          const agentList = yield* agentSvc.list()
          const allThreads = yield* threadSvc.listActive()
          const project = (yield* projectSvc.get(Instance.project.id)) ?? Instance.project
          const approvals = yield* messageSvc.listPendingApprovals({ limit: 20 })
          const companyProjects = yield* companyProjectSvc.list()
          const projectGates = yield* companyProjectSvc.listGates(undefined, "pending")
          const projectWorkItems = yield* Effect.all(
            companyProjects.map((item) => companyProjectSvc.listWorkItems(item.id)),
          )
          const latestCompanyProject = companyProjects[0]
          const latestBlockedWorkItem = projectWorkItems[0]?.find(
            (item) => item.status === "blocked" || item.status === "failed",
          )
          const collaborationTrees = yield* Effect.all(
            [...new Set(approvals.flatMap((approval) => (approval.rootNeedID ? [approval.rootNeedID] : [])))].map(
              (rootNeedID) =>
                Effect.gen(function* () {
                  return buildCollaborationTree(rootNeedID, yield* messageSvc.listByRootNeed(rootNeedID))
                }),
            ),
            { concurrency: 5 },
          )

          const agents = yield* Effect.all(
            agentList.map((agent) =>
              Effect.gen(function* () {
                const agentThreads = allThreads.filter((t) => t.agentID === agent.id)
                const status = yield* threadSvc.agentStatus(agent.id)

                return {
                  id: agent.id,
                  name: agent.name,
                  org_layer: orgLayer(agent),
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
            ),
            { concurrency: 5 },
          )

          const totalAgents = agents.length
          const activeAgents = agents.filter((a) => a.status !== "idle").length
          const totalThreads = agents.reduce((sum, a) => sum + a.threads.length, 0)
          const openTasks = projectWorkItems
            .flat()
            .filter((item) => !["completed", "cancelled"].includes(item.status)).length

          return {
            project: {
              id: project.id,
              company_project_id: latestCompanyProject?.id,
              title: latestCompanyProject?.title,
              status: latestCompanyProject?.status,
              output_dir: latestCompanyProject?.output_dir,
              active_run_id: latestCompanyProject?.active_run_id,
              blocked: project.block !== undefined || latestCompanyProject?.status === "blocked",
              blocked_reason: project.block?.reason ?? latestBlockedWorkItem?.error,
              blocked_by_agent_id: project.block?.byAgentID ?? latestBlockedWorkItem?.owner_agent_id,
              time_blocked: project.block?.time ?? latestBlockedWorkItem?.updated_at,
            },
            agents,
            summary: {
              total_agents: totalAgents,
              active_agents: activeAgents,
              total_threads: totalThreads,
              open_tasks: openTasks,
              pending_approvals: approvals.length + projectGates.length,
            },
            approvals: [
              ...projectGates.map((gate) => ({
                id: gate.id,
                source: "project_gate" as const,
                project_id: gate.project_id,
                gate_kind: gate.kind,
                from_agent_id: gate.requested_by_agent_id ?? "project-lead",
                to_agent_id: "user",
                task_summary: gate.title,
                body: gate.summary,
                depth: 0,
                time_created: gate.requested_at,
              })),
              ...approvals.map((approval) => ({
                id: approval.id,
                source: "message" as const,
                from_agent_id: approval.fromAgentID,
                to_agent_id: approval.toAgentID,
                root_need_id: approval.rootNeedID,
                thread_id: approval.threadID,
                in_reply_to: approval.inReplyTo,
                task_summary: approval.taskSummary,
                body: approval.body,
                depth: approval.depth,
                time_created: approval.time.created,
              })),
            ],
            collaboration_trees: collaborationTrees,
          }
        }),
    )
    .post(
      "/approval/:messageID/resolve",
      describeRoute({
        summary: "Resolve workstation approval",
        description: "Approve or reject an admission message that is waiting for user approval.",
        operationId: "workstation.resolveApproval",
        responses: {
          200: {
            description: "Resolved approval message",
            content: { "application/json": { schema: resolver(AgentMessage.Info) } },
          },
        },
      }),
      validator("param", z.object({ messageID: z.string().min(1) })),
      validator("json", ResolveApprovalSchema),
      async (c) =>
        jsonRequest("WorkstationRoutes.resolveApproval", c, function* () {
          const messageSvc = yield* AgentMessage.Service
          const message = yield* messageSvc.get(c.req.valid("param").messageID)
          if (!message) return yield* Effect.fail(new Error("Approval message not found"))
          if (message.outcome !== "needs_approval") {
            return yield* Effect.fail(new Error("Approval message is not pending"))
          }
          const body = c.req.valid("json")
          const updated = yield* messageSvc.updateOutcome({
            id: message.id,
            outcome: body.decision === "approve" ? "success" : "rejected",
            read: true,
          })
          yield* AuditEvent.record({
            rootNeedID: message.rootNeedID,
            kind: "admission",
            action: body.decision === "approve" ? "approved" : "rejected",
            actorAgentID: body.actorAgentID,
            targetAgentID: message.fromAgentID,
            subjectID: message.id,
            subjectType: "agent_message",
            granted: body.decision === "approve",
            metadata: {
              reason: body.reason,
              inReplyTo: message.inReplyTo,
              threadID: message.threadID,
              depth: message.depth,
            },
          })
          return updated
        }),
    ),
)
