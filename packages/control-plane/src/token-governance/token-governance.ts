import z from "zod"
import { Context, Effect, Layer } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { AgentMessageTable } from "@/agent-message/agent-message.sql"
import { SessionTable, MessageTable } from "@/session/session.sql"
import { ThreadTable } from "@/thread/thread.sql"
import { Database } from "@/storage"

const TokenBreakdown = z.object({
  total: z.number(),
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
})
export type TokenBreakdown = z.infer<typeof TokenBreakdown>

const ThreadTokenStats = z.object({
  threadID: z.string(),
  agentID: z.string(),
  kind: z.string(),
  status: z.string(),
  budgetTokens: z.number().optional(),
  trackedSpentTokens: z.number(),
  observedTokens: TokenBreakdown,
  sessionIDs: z.array(z.string()),
})
export type ThreadTokenStats = z.infer<typeof ThreadTokenStats>

const LevelTokenStats = z.object({
  depth: z.number(),
  messageCount: z.number(),
  trackedSpentTokens: z.number(),
  observedTokens: TokenBreakdown,
  threadIDs: z.array(z.string()),
  agentIDs: z.array(z.string()),
})
export type LevelTokenStats = z.infer<typeof LevelTokenStats>

const RootNeedTokenReport = z.object({
  rootNeedID: z.string(),
  messageCount: z.number(),
  trackedSpentTokens: z.number(),
  observedTokens: TokenBreakdown,
  threads: z.array(ThreadTokenStats),
  levels: z.array(LevelTokenStats),
})
export type RootNeedTokenReport = z.infer<typeof RootNeedTokenReport>

const ProjectTokenReport = z.object({
  projectID: z.string(),
  sessionCount: z.number(),
  trackedSpentTokens: z.number(),
  observedTokens: TokenBreakdown,
  threads: z.array(ThreadTokenStats),
})
export type ProjectTokenReport = z.infer<typeof ProjectTokenReport>

export const Info = {
  TokenBreakdown,
  ThreadTokenStats,
  LevelTokenStats,
  RootNeedTokenReport,
  ProjectTokenReport,
}

const emptyTokens = (): TokenBreakdown => ({
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
})

function addTokens(total: TokenBreakdown, next: TokenBreakdown): TokenBreakdown {
  return {
    total: total.total + next.total,
    input: total.input + next.input,
    output: total.output + next.output,
    reasoning: total.reasoning + next.reasoning,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
  }
}

function messageTokens(data: unknown): TokenBreakdown {
  const message = data as {
    role?: string
    cost?: number
    tokens?: {
      total?: number
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
  }
  if (message.role !== "assistant" || !message.tokens) return emptyTokens()
  const input = message.tokens.input ?? 0
  const output = message.tokens.output ?? 0
  const reasoning = message.tokens.reasoning ?? 0
  const cacheRead = message.tokens.cache?.read ?? 0
  const cacheWrite = message.tokens.cache?.write ?? 0
  return {
    total: message.tokens.total ?? input + output + reasoning + cacheRead + cacheWrite,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: message.cost ?? 0,
  }
}

function unique(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((value): value is string => !!value))]
}

function sessionTokens(sessionIDs: string[]) {
  if (sessionIDs.length === 0) return new Map<string, TokenBreakdown>()
  const totals = new Map<string, TokenBreakdown>()
  const rows = Database.use((db) =>
    db
      .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
      .from(MessageTable)
      .where(inArray(MessageTable.session_id, sessionIDs as never[]))
      .all(),
  )
  for (const row of rows) {
    totals.set(row.sessionID, addTokens(totals.get(row.sessionID) ?? emptyTokens(), messageTokens(row.data)))
  }
  return totals
}

function buildThreadStats(input: {
  threads: {
    id: string
    agentID: string
    kind: string
    status: string
    budgetTokens: number | null
    spentTokens: number | null
  }[]
  sessions: { id: string; threadID: string | null }[]
}) {
  const tokensBySession = sessionTokens(input.sessions.map((session) => session.id))
  return input.threads.map((thread) => {
    const sessionIDs = input.sessions.filter((session) => session.threadID === thread.id).map((session) => session.id)
    return {
      threadID: thread.id,
      agentID: thread.agentID,
      kind: thread.kind,
      status: thread.status,
      budgetTokens: thread.budgetTokens ?? undefined,
      trackedSpentTokens: thread.spentTokens ?? 0,
      observedTokens: sessionIDs.map((sessionID) => tokensBySession.get(sessionID) ?? emptyTokens()).reduce(addTokens, emptyTokens()),
      sessionIDs,
    }
  })
}

export interface Interface {
  readonly rootNeed: (rootNeedID: string) => Effect.Effect<RootNeedTokenReport>
  readonly project: (projectID: string) => Effect.Effect<ProjectTokenReport>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/TokenGovernance") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const rootNeed = Effect.fn("TokenGovernance.rootNeed")(function* (rootNeedID: string) {
      const messages = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({
              threadID: AgentMessageTable.thread_id,
              depth: AgentMessageTable.depth,
              fromAgentID: AgentMessageTable.from_agent_id,
              toAgentID: AgentMessageTable.to_agent_id,
            })
            .from(AgentMessageTable)
            .where(eq(AgentMessageTable.root_need_id, rootNeedID))
            .all(),
        ),
      )
      const threadIDs = unique(messages.map((message) => message.threadID))
      const threads =
        threadIDs.length === 0
          ? []
          : yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({
                    id: ThreadTable.id,
                    agentID: ThreadTable.agent_id,
                    kind: ThreadTable.kind,
                    status: ThreadTable.status,
                    budgetTokens: ThreadTable.budget_tokens,
                    spentTokens: ThreadTable.spent_tokens,
                  })
                  .from(ThreadTable)
                  .where(inArray(ThreadTable.id, threadIDs as never[]))
                  .all(),
              ),
            )
      const sessions =
        threadIDs.length === 0
          ? []
          : yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({ id: SessionTable.id, threadID: SessionTable.thread_id })
                  .from(SessionTable)
                  .where(inArray(SessionTable.thread_id, threadIDs as never[]))
                  .all(),
              ),
            )
      const threadStats = buildThreadStats({ threads, sessions })
      const levelDepths = [...new Set(messages.map((message) => message.depth ?? 0))].sort((a, b) => a - b)
      const levels = levelDepths.map((depth) => {
        const levelMessages = messages.filter((message) => (message.depth ?? 0) === depth)
        const levelThreadIDs = unique(levelMessages.map((message) => message.threadID))
        const levelThreads = threadStats.filter((thread) => levelThreadIDs.includes(thread.threadID))
        return {
          depth,
          messageCount: levelMessages.length,
          trackedSpentTokens: levelThreads.reduce((sum, thread) => sum + thread.trackedSpentTokens, 0),
          observedTokens: levelThreads.map((thread) => thread.observedTokens).reduce(addTokens, emptyTokens()),
          threadIDs: levelThreadIDs,
          agentIDs: unique(levelMessages.flatMap((message) => [message.fromAgentID, message.toAgentID])),
        }
      })
      return {
        rootNeedID,
        messageCount: messages.length,
        trackedSpentTokens: threadStats.reduce((sum, thread) => sum + thread.trackedSpentTokens, 0),
        observedTokens: threadStats.map((thread) => thread.observedTokens).reduce(addTokens, emptyTokens()),
        threads: threadStats,
        levels,
      }
    })

    const project = Effect.fn("TokenGovernance.project")(function* (projectID: string) {
      const sessions = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ id: SessionTable.id, threadID: SessionTable.thread_id })
            .from(SessionTable)
            .where(and(eq(SessionTable.project_id, projectID as never)))
            .all(),
        ),
      )
      const threadIDs = unique(sessions.map((session) => session.threadID))
      const threads =
        threadIDs.length === 0
          ? []
          : yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({
                    id: ThreadTable.id,
                    agentID: ThreadTable.agent_id,
                    kind: ThreadTable.kind,
                    status: ThreadTable.status,
                    budgetTokens: ThreadTable.budget_tokens,
                    spentTokens: ThreadTable.spent_tokens,
                  })
                  .from(ThreadTable)
                  .where(inArray(ThreadTable.id, threadIDs as never[]))
                  .all(),
              ),
            )
      const threadStats = buildThreadStats({ threads, sessions })
      return {
        projectID,
        sessionCount: sessions.length,
        trackedSpentTokens: threadStats.reduce((sum, thread) => sum + thread.trackedSpentTokens, 0),
        observedTokens: threadStats.map((thread) => thread.observedTokens).reduce(addTokens, emptyTokens()),
        threads: threadStats,
      }
    })

    return { rootNeed, project }
  }),
)

export const defaultLayer = layer

export * as TokenGovernance from "./token-governance"
