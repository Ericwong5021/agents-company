import z from "zod"
import { and, asc, desc, eq, inArray } from "@/storage"
import * as Database from "@/storage/db"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyProjectTable, CompanyWorkItemTable } from "@/company-project/company-project.sql"
import { CompanyProjectAssignmentTable } from "@/company-recruitment/company-recruitment.sql"
import { ChannelTable, ConversationThreadTable } from "@/conversation/conversation.sql"
import { ConversationThreadID } from "@/conversation/schema"
import { CompanyID } from "./schema"

export const Presence = z.enum(["online", "offline"])
export const Attention = z.enum(["none", "available", "focused", "urgent"])
export const Activity = z.enum(["idle", "waiting", "working", "recovering", "completed", "failed", "interrupted"])
export const Interruptibility = z.enum(["interruptible", "coordinate_first", "needs_intervention"])
const currentRunStates = ["queued", "starting", "running", "interrupting", "awaiting_recovery"] as const
const onlineRunStates = new Set(["queued", "starting", "running", "interrupting"])

export const Evidence = z
  .object({
    kind: z.literal("agent_run"),
    runID: z.string(),
    threadID: z.string().optional(),
    timeUpdated: z.number().int(),
  })
  .strict()

// TEAM-01：负载与最近交付来自真实工作项事实，而不是在线状态或角色名。
export const Workload = z
  .object({
    active: z.number().int(),
    blocked: z.number().int(),
    recent_delivery: z
      .object({
        work_item_id: z.string(),
        title: z.string(),
        review_status: z.string(),
        time_completed: z.number().int(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const AgentActivityProjection = z
  .object({
    agent: z
      .object({
        id: z.string(),
        name: z.string(),
        role: z.string().optional(),
        description: z.string().optional(),
        lifecycle: z.enum(["employee", "assigned"]),
        department: z.string().optional(),
        responsibilities: z.array(z.string()),
      })
      .strict(),
    // TEAM-01/TEAM-05：组织身份区分正式员工与在岗临时实例，供组织视图消费。
    employment: z.enum(["employee", "temporary"]),
    presence: Presence,
    attention: Attention,
    activity: Activity,
    location: z.string().optional(),
    subject: z.string().optional(),
    since: z.number().int(),
    interruptibility: Interruptibility,
    risk: z.string().optional(),
    collaborators: z.array(z.string()),
    workload: Workload,
    evidence: Evidence.optional(),
  })
  .strict()
  .meta({ ref: "AgentActivityProjection" })
export type AgentActivityProjection = z.infer<typeof AgentActivityProjection>

function responsibilities(value: string | null) {
  if (!value) return []
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function state(state: string) {
  if (state === "queued" || state === "starting") {
    return { activity: "waiting" as const, attention: "focused" as const, interruptibility: "interruptible" as const }
  }
  if (state === "running") {
    return {
      activity: "working" as const,
      attention: "focused" as const,
      interruptibility: "coordinate_first" as const,
    }
  }
  if (state === "interrupting" || state === "awaiting_recovery") {
    return {
      activity: "recovering" as const,
      attention: "urgent" as const,
      interruptibility: "needs_intervention" as const,
    }
  }
  if (state === "failed") {
    return {
      activity: "failed" as const,
      attention: "none" as const,
      interruptibility: "interruptible" as const,
    }
  }
  if (state === "stopped") {
    return {
      activity: "interrupted" as const,
      attention: "none" as const,
      interruptibility: "interruptible" as const,
    }
  }
  if (state === "completed")
    return { activity: "completed" as const, attention: "none" as const, interruptibility: "interruptible" as const }
  return {
    activity: "interrupted" as const,
    attention: "urgent" as const,
    interruptibility: "needs_intervention" as const,
    risk: "运行状态不可识别",
  }
}

export function list(companyID: CompanyID): AgentActivityProjection[] {
  return Database.use((db) => {
    const assignedAgentIDs = new Set(
      db
        .select({ agent_id: CompanyProjectAssignmentTable.agent_id })
        .from(CompanyProjectAssignmentTable)
        .where(
          and(
            eq(CompanyProjectAssignmentTable.company_id, companyID),
            inArray(CompanyProjectAssignmentTable.status, ["assigned", "active"]),
          ),
        )
        .all()
        .map((item) => item.agent_id),
    )
    return db
      .select()
      .from(CompanyAgentTable)
      .where(eq(CompanyAgentTable.company_id, companyID))
      .orderBy(asc(CompanyAgentTable.id))
      .all()
      // TEAM-01：在岗临时实例（assigned）也进入团队视图，与正式员工用 employment 区分。
      .filter((agent) => agent.lifecycle === "employee" || assignedAgentIDs.has(agent.id))
      .map((agent) => {
        const projectionAgent = {
          id: agent.id,
          name: agent.name,
          ...(agent.role_key ? { role: agent.role_key } : {}),
          ...(agent.description ? { description: agent.description } : {}),
          lifecycle: agent.lifecycle === "employee" ? "employee" : "assigned",
          ...(agent.department ? { department: agent.department } : {}),
          responsibilities: responsibilities(agent.responsibilities),
        }
        const employment = agent.lifecycle === "employee" ? "employee" : "temporary"
        const ownedItems = db
          .select()
          .from(CompanyWorkItemTable)
          .where(eq(CompanyWorkItemTable.owner_agent_id, agent.id))
          .all()
        const ownedProjects = db
          .select()
          .from(CompanyProjectTable)
          .where(eq(CompanyProjectTable.owner_agent_id, agent.id))
          .all()
        const activeItems = ownedItems.filter((item) => item.status === "pending" || item.status === "running")
        const blockedItems = ownedItems.filter((item) => item.status === "blocked")
        const activeItemProjects = new Set(activeItems.map((item) => item.project_id))
        const blockedItemProjects = new Set(blockedItems.map((item) => item.project_id))
        const delivered = ownedItems
          .filter((item) => item.status === "completed" && item.completed_at !== null)
          .toSorted((left, right) => right.completed_at! - left.completed_at!)[0]
        const workload = {
          active:
            activeItems.length
            + ownedProjects.filter(
              (project) =>
                ["intake", "planning", "executing", "reviewing", "awaiting_approval", "revision"].includes(project.status)
                && !activeItemProjects.has(project.id),
            ).length,
          blocked:
            blockedItems.length
            + ownedProjects.filter(
              (project) => project.status === "blocked" && !blockedItemProjects.has(project.id),
            ).length,
          ...(delivered
            ? {
                recent_delivery: {
                  work_item_id: delivered.id,
                  title: delivered.title,
                  review_status: delivered.review_status,
                  time_completed: delivered.completed_at!,
                },
              }
            : {}),
        }
        const currentRun = db
            .select()
            .from(AgentRunTable)
            .where(
              and(
                eq(AgentRunTable.agent_id, agent.id),
                inArray(AgentRunTable.state, [...currentRunStates]),
              ),
            )
            .orderBy(desc(AgentRunTable.time_updated), desc(AgentRunTable.id))
            .get()
        const run =
          currentRun
          ?? db
            .select()
            .from(AgentRunTable)
            .where(eq(AgentRunTable.agent_id, agent.id))
            .orderBy(desc(AgentRunTable.time_updated), desc(AgentRunTable.id))
            .get()
        if (!run) {
          return AgentActivityProjection.parse({
            agent: projectionAgent,
            employment,
            presence: "offline",
            attention: "none",
            activity: "idle",
            since: agent.time_updated,
            interruptibility: "interruptible",
            collaborators: [],
            workload,
          })
        }
        const threadID = run.conversation_thread_id
          ? ConversationThreadID.safeParse(run.conversation_thread_id).data
          : undefined
        const thread = threadID
          ? db.select().from(ConversationThreadTable).where(eq(ConversationThreadTable.id, threadID)).get()
          : undefined
        const channel = thread
          ? db.select().from(ChannelTable).where(eq(ChannelTable.id, thread.channel_id)).get()
          : undefined
        const projectedState = currentRun
          ? state(run.state)
          : workload.blocked > 0
            ? {
                activity: "failed" as const,
                attention: "urgent" as const,
                interruptibility: "needs_intervention" as const,
                risk: "有阻塞工作需要处理",
              }
            : workload.active > 0
              ? {
                  activity: "waiting" as const,
                  attention: "focused" as const,
                  interruptibility: "interruptible" as const,
                }
              : state(run.state)
        return AgentActivityProjection.parse({
          agent: projectionAgent,
          employment,
          presence: currentRun && onlineRunStates.has(currentRun.state) ? "online" : "offline",
          ...projectedState,
          ...(channel ? { location: channel.title } : {}),
          ...(thread?.title ? { subject: thread.title } : {}),
          since: run.time_started ?? run.time_updated,
          ...(run.safe_error_summary ? { risk: run.safe_error_summary } : {}),
          collaborators: [],
          workload,
          evidence: {
            kind: "agent_run",
            runID: run.id,
            ...(threadID ? { threadID } : {}),
            timeUpdated: run.time_updated,
          },
        })
      })
  })
}
