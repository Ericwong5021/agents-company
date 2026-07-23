import z from "zod"
import { desc, eq } from "@/storage"
import * as Database from "@/storage/db"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { ChannelTable, ConversationThreadTable } from "@/conversation/conversation.sql"
import { ConversationThreadID } from "@/conversation/schema"
import { CompanyID } from "./schema"

export const Presence = z.enum(["online", "offline"])
export const Attention = z.enum(["none", "available", "focused", "urgent"])
export const Activity = z.enum(["idle", "waiting", "working", "recovering", "completed", "failed", "interrupted"])
export const Interruptibility = z.enum(["interruptible", "coordinate_first", "needs_intervention"])

export const Evidence = z
  .object({
    kind: z.literal("agent_run"),
    runID: z.string(),
    threadID: z.string().optional(),
    timeUpdated: z.number().int(),
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
        lifecycle: z.literal("employee"),
        department: z.string().optional(),
        responsibilities: z.array(z.string()),
      })
      .strict(),
    presence: Presence,
    attention: Attention,
    activity: Activity,
    location: z.string(),
    subject: z.string().optional(),
    since: z.number().int(),
    interruptibility: Interruptibility,
    risk: z.string().optional(),
    collaborators: z.array(z.string()),
    evidence: Evidence.optional(),
  })
  .strict()
  .meta({ ref: "AgentActivityProjection" })
export type AgentActivityProjection = z.infer<typeof AgentActivityProjection>

function responsibilities(value: string | null) {
  if (!value) return []
  const parsed = z.array(z.string()).safeParse(JSON.parse(value))
  return parsed.success ? parsed.data : []
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
      attention: "urgent" as const,
      interruptibility: "needs_intervention" as const,
    }
  }
  if (state === "stopped") {
    return {
      activity: "interrupted" as const,
      attention: "available" as const,
      interruptibility: "interruptible" as const,
    }
  }
  return { activity: "completed" as const, attention: "available" as const, interruptibility: "interruptible" as const }
}

export function list(companyID: CompanyID): AgentActivityProjection[] {
  return Database.use((db) =>
    db
      .select()
      .from(CompanyAgentTable)
      .where(eq(CompanyAgentTable.company_id, companyID))
      .all()
      .filter((agent) => agent.lifecycle === "employee")
      .map((agent) => {
        const run = db
          .select()
          .from(AgentRunTable)
          .where(eq(AgentRunTable.agent_id, agent.id))
          .orderBy(desc(AgentRunTable.time_updated), desc(AgentRunTable.id))
          .get()
        if (!run) {
          return AgentActivityProjection.parse({
            agent: {
              id: agent.id,
              name: agent.name,
              role: agent.role_key ?? undefined,
              description: agent.description ?? undefined,
              lifecycle: agent.lifecycle,
              department: agent.department ?? undefined,
              responsibilities: responsibilities(agent.responsibilities),
            },
            presence: "online",
            attention: "available",
            activity: "idle",
            location: "office",
            since: agent.time_updated,
            interruptibility: "interruptible",
            collaborators: [],
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
        return AgentActivityProjection.parse({
          agent: {
            id: agent.id,
            name: agent.name,
            role: agent.role_key ?? undefined,
            description: agent.description ?? undefined,
            lifecycle: agent.lifecycle,
            department: agent.department ?? undefined,
            responsibilities: responsibilities(agent.responsibilities),
          },
          presence: "online",
          ...state(run.state),
          location: channel?.title ?? "runtime",
          subject: thread?.title,
          since: run.time_started ?? run.time_updated,
          risk: run.safe_error_summary ?? undefined,
          collaborators: [],
          evidence: {
            kind: "agent_run",
            runID: run.id,
            threadID,
            timeUpdated: run.time_updated,
          },
        })
      }),
  )
}
