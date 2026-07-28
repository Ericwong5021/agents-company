import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { AgentMessage } from "../../src/agent-message/agent-message"
import { AuditEvent } from "../../src/audit-event/audit-event"
import { CompanyAgent } from "../../src/company-agent/company-agent"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

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

const CollaborationNodeBody: z.ZodType<CollaborationNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.enum(["fyi", "request", "reply", "proposal"]),
    from_agent_id: z.string(),
    to_agent_id: z.string(),
    task_summary: z.string().optional(),
    outcome: z.string().optional(),
    depth: z.number(),
    time_created: z.number(),
    children: z.array(CollaborationNodeBody),
  }),
)

const WorkstationBody = z.object({
  project: z.object({
    id: z.string(),
    blocked: z.boolean(),
    blocked_reason: z.string().optional(),
    blocked_by_agent_id: z.string().optional(),
    time_blocked: z.number().optional(),
  }),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      org_layer: z.enum(["board", "department", "project", "execution", "tool"]),
      status: z.enum(["idle", "busy", "paused"]),
      threads: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["primary", "reactive", "ambient"]),
          status: z.enum(["active", "paused", "completed"]),
          task_summary: z.string().optional(),
          budget_tokens: z.number().optional(),
          spent_tokens: z.number(),
        }),
      ),
    }),
  ),
  summary: z.object({
    total_agents: z.number(),
    active_agents: z.number(),
    total_threads: z.number(),
    open_tasks: z.number(),
    pending_approvals: z.number(),
  }),
  approvals: z.array(
    z.object({
      id: z.string(),
      from_agent_id: z.string(),
      to_agent_id: z.string(),
      root_need_id: z.string().optional(),
      thread_id: z.string().optional(),
      in_reply_to: z.string().optional(),
      task_summary: z.string().optional(),
      body: z.string(),
      depth: z.number(),
      time_created: z.number(),
    }),
  ),
  collaboration_trees: z.array(
    z.object({
      root_need_id: z.string(),
      total_messages: z.number(),
      max_depth: z.number(),
      nodes: z.array(CollaborationNodeBody),
    }),
  ),
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("workstation routes", () => {
  test("projects configured org layer and active thread status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          CompanyAgent.Service.use((svc) =>
            svc.create({
              id: "department-lead",
              name: "Department Lead",
              lifecycle: "employee",
              org_layer: "department",
              department: "engineering",
              responsibilities: ["Translate strategy into project plans"],
            }),
          ).pipe(Effect.provide(CompanyAgent.defaultLayer)),
        )

        const app = Server.Default().app
        expect((await app.request("/agents/department-lead/start", { method: "POST" })).status).toBe(200)

        const res = await app.request("/workstation/status")
        expect(res.status).toBe(200)
        const body = WorkstationBody.parse(await res.json())
        const agent = body.agents.find((item) => item.id === "department-lead")

        expect(body.project.blocked).toBe(false)
        expect(agent).toBeDefined()
        expect(agent?.org_layer).toBe("department")
        expect(agent?.status).toBe("busy")
        expect(agent?.threads).toHaveLength(1)
        expect(agent?.threads[0].kind).toBe("primary")
        expect(agent?.threads[0].status).toBe("active")
        expect(body.summary.active_agents).toBeGreaterThanOrEqual(1)
        expect(body.summary.total_threads).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("surfaces project emergency stop state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const initial = WorkstationBody.parse(await (await app.request("/workstation/status")).json())
        const block = await app.request(`/project/${initial.project.id}/block`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: "Token usage exceeded emergency threshold",
            byAgentID: "dept-head",
          }),
        })
        expect(block.status).toBe(200)

        const blocked = WorkstationBody.parse(await (await app.request("/workstation/status")).json())
        expect(blocked.project).toMatchObject({
          id: initial.project.id,
          blocked: true,
          blocked_reason: "Token usage exceeded emergency threshold",
          blocked_by_agent_id: "dept-head",
        })
        expect(blocked.project.time_blocked).toBeGreaterThan(0)

        const unblock = await app.request(`/project/${initial.project.id}/unblock`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Budget reset and run paused" }),
        })
        expect(unblock.status).toBe(200)

        const unblocked = WorkstationBody.parse(await (await app.request("/workstation/status")).json())
        expect(unblocked.project).toMatchObject({
          id: initial.project.id,
          blocked: false,
        })
        expect(unblocked.project.blocked_reason).toBeUndefined()
      },
    })
  })

  test("surfaces and resolves approval prompts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const request = await Effect.runPromise(
          AgentMessage.Service.use((svc) =>
            svc.create({
              id: "message_request",
              fromAgentID: "department-lead",
              toAgentID: "execution-agent",
              rootNeedID: "root_need_approval",
              threadID: "thread_approval",
              kind: "request",
              depth: 1,
              taskSummary: "Ship gated change",
              body: "Ship gated change",
            }),
          ).pipe(Effect.provide(AgentMessage.defaultLayer)),
        )
        const approval = await Effect.runPromise(
          AgentMessage.Service.use((svc) =>
            svc.create({
              fromAgentID: "execution-agent",
              toAgentID: "department-lead",
              rootNeedID: "root_need_approval",
              threadID: "thread_approval",
              inReplyTo: request.id,
              kind: "reply",
              depth: 1,
              taskSummary: "Ship gated change",
              body: "Approval required: 1\nReason: low trust",
              outcome: "needs_approval",
            }),
          ).pipe(Effect.provide(AgentMessage.defaultLayer)),
        )

        const app = Server.Default().app
        const status = WorkstationBody.parse(await (await app.request("/workstation/status")).json())
        expect(status.summary.pending_approvals).toBe(1)
        expect(status.approvals[0]).toMatchObject({
          id: approval.id,
          from_agent_id: "execution-agent",
          to_agent_id: "department-lead",
          root_need_id: "root_need_approval",
          task_summary: "Ship gated change",
        })
        expect(status.collaboration_trees).toHaveLength(1)
        expect(status.collaboration_trees[0]).toMatchObject({
          root_need_id: "root_need_approval",
          total_messages: 2,
          max_depth: 1,
        })
        expect(status.collaboration_trees[0].nodes[0]).toMatchObject({
          id: request.id,
          from_agent_id: "department-lead",
          to_agent_id: "execution-agent",
        })
        expect(status.collaboration_trees[0].nodes[0].children[0]).toMatchObject({
          id: approval.id,
          outcome: "needs_approval",
        })

        const resolved = await app.request(`/workstation/approval/${approval.id}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "approve",
            actorAgentID: "ceo",
            reason: "Manual review passed",
          }),
        })
        expect(resolved.status).toBe(200)
        expect(AgentMessage.Info.parse(await resolved.json()).outcome).toBe("success")

        const after = WorkstationBody.parse(await (await app.request("/workstation/status")).json())
        expect(after.summary.pending_approvals).toBe(0)
        expect(after.approvals).toHaveLength(0)

        const audit = await Effect.runPromise(
          AuditEvent.Service.use((svc) => svc.listByRootNeed("root_need_approval")).pipe(
            Effect.provide(AuditEvent.defaultLayer),
          ),
        )
        expect(audit.some((event) => event.kind === "admission" && event.action === "approved")).toBe(true)
      },
    })
  })
})
