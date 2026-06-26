import { Effect } from "effect"
import { AgentMessage } from "./agent-message"
import { Identifier } from "@/id/id"
import { CompanyAgent } from "@/company-agent"
import type { CompanyAgentID } from "@/company-agent/schema"

export const MAX_DELEGATION_DEPTH = 5

// ---------------------------------------------------------------------------
// Org layer hierarchy
// ---------------------------------------------------------------------------

export const OrgLayer = {
  board: 0,
  department: 1,
  project: 2,
  execution: 3,
  tool: 4,
} as const

export type OrgLayerName = keyof typeof OrgLayer

/**
 * Parse an org layer name into its numeric level.
 * Returns undefined for unrecognised names.
 */
export function parseOrgLayer(name: string): number | undefined {
  return OrgLayer[name as OrgLayerName]
}

/**
 * Check whether a delegator at fromLayer can delegate to a target at toLayer.
 * Lower numeric value = higher authority. Delegator must be at a higher
 * authority layer (strictly lower number) than the target.
 *
 * board(0) -> anyone OK
 * tool(4) -> anyone BLOCKED (no lower layer exists)
 * Agents without an assigned org_layer are treated as execution(3).
 */
export function canDelegate(fromLayer: string | undefined, toLayer: string | undefined): boolean {
  const from = fromLayer ? parseOrgLayer(fromLayer) ?? OrgLayer.execution : OrgLayer.execution
  const to = toLayer ? parseOrgLayer(toLayer) ?? OrgLayer.execution : OrgLayer.execution
  return from < to
}

// ---------------------------------------------------------------------------
// Resolve target agent by name or ID
// ---------------------------------------------------------------------------

function resolveTarget(
  target: string,
  agents: CompanyAgent.Info[],
): CompanyAgent.Info | undefined {
  // Try exact ID match first
  const byId = agents.find((a) => a.id === target)
  if (byId) return byId
  // Try case-insensitive name match
  const lower = target.toLowerCase()
  return agents.find((a) => a.name.toLowerCase() === lower)
}

// ---------------------------------------------------------------------------
// message_agent — send an FYI message
// ---------------------------------------------------------------------------

export interface MessageAgentInput {
  fromId: string
  toId: string
  body: string
  threadID?: string
  rootNeedID?: string
}

export function messageAgent(
  input: MessageAgentInput,
  companyAgentSvc: CompanyAgent.Interface,
  agentMessageSvc: AgentMessage.Interface,
) {
  return Effect.gen(function* () {
    const agents = yield* companyAgentSvc.list()
    const target = resolveTarget(input.toId, agents)
    if (!target) return yield* Effect.fail(new Error(`message_agent: target agent "${input.toId}" not found`))

    const msg = yield* agentMessageSvc.create({
      fromAgentID: input.fromId,
      toAgentID: target.id,
      kind: "fyi",
      body: input.body,
      threadID: input.threadID,
      rootNeedID: input.rootNeedID,
    })

    return {
      messageID: msg.id,
      toAgentID: target.id,
      toAgentName: target.name,
    }
  })
}

// ---------------------------------------------------------------------------
// delegate — create a request + child task
// ---------------------------------------------------------------------------

export interface DelegateInput {
  fromId: string
  toId: string
  body: string
  taskSummary: string
  threadID?: string
  rootNeedID?: string
  depth?: number
}

export function delegate(
  input: DelegateInput,
  companyAgentSvc: CompanyAgent.Interface,
  agentMessageSvc: AgentMessage.Interface,
) {
  return Effect.gen(function* () {
    const depth = input.depth ?? 0
    if (depth >= MAX_DELEGATION_DEPTH) {
      return yield* Effect.fail(
        new Error(`delegate: max delegation depth (${MAX_DELEGATION_DEPTH}) exceeded`),
      )
    }
    if (input.fromId === input.toId) {
      return yield* Effect.fail(new Error("delegate: cannot delegate to self"))
    }

    const agents = yield* companyAgentSvc.list()
    const delegator = agents.find((a) => a.id === input.fromId)
    const target = resolveTarget(input.toId, agents)
    if (!target) return yield* Effect.fail(new Error(`delegate: target agent "${input.toId}" not found`))

    // Org layer validation — delegator must outrank target
    if (delegator && !canDelegate(delegator.org_layer, target.org_layer)) {
      const fromLayer = delegator.org_layer ?? "execution"
      const toLayer = target.org_layer ?? "execution"
      return yield* Effect.fail(
        new Error(
          `delegate: agent "${delegator.name}" (${fromLayer}) cannot delegate to "${target.name}" (${toLayer}) — delegator must be at a higher org layer`,
        ),
      )
    }

    // Cross-department warning — valid for cross-functional projects, but worth logging
    if (delegator?.department && target.department && delegator.department !== target.department) {
      yield* Effect.logWarning(
        `delegate: cross-department delegation from "${delegator.name}" (${delegator.department}) to "${target.name}" (${target.department})`,
      )
    }

    // Pre-generate ID so we can reference it as rootNeedID
    const id = Identifier.ascending("message")
    const rootNeedID = input.rootNeedID ?? id

    const msg = yield* agentMessageSvc.create({
      id,
      fromAgentID: input.fromId,
      toAgentID: target.id,
      kind: "request",
      body: input.body,
      taskSummary: input.taskSummary,
      threadID: input.threadID,
      rootNeedID,
      depth,
    })

    return {
      messageID: msg.id,
      toAgentID: target.id,
      toAgentName: target.name,
      taskSummary: input.taskSummary,
      depth: depth + 1,
    }
  })
}

// ---------------------------------------------------------------------------
// reply — reply to a request message
// ---------------------------------------------------------------------------

export interface ReplyInput {
  fromId: string
  originalMessageId: string
  body: string
  outcome?: string
}

export function reply(
  input: ReplyInput,
  agentMessageSvc: AgentMessage.Interface,
) {
  return Effect.gen(function* () {
    const original = yield* agentMessageSvc.get(input.originalMessageId)
    if (!original) {
      return yield* Effect.fail(
        new Error(`reply: original message "${input.originalMessageId}" not found`),
      )
    }

    const msg = yield* agentMessageSvc.create({
      fromAgentID: input.fromId,
      toAgentID: original.fromAgentID,
      kind: "reply",
      body: input.body,
      inReplyTo: input.originalMessageId,
      threadID: original.threadID,
      rootNeedID: original.rootNeedID,
      depth: original.depth,
      outcome: input.outcome,
    })

    return {
      messageID: msg.id,
      toAgentID: original.fromAgentID,
      inReplyTo: input.originalMessageId,
    }
  })
}

// ---------------------------------------------------------------------------
// propose — bottom-up proposal from report to manager
// ---------------------------------------------------------------------------

export interface ProposeInput {
  fromId: string
  body: string
  rationale: string
  threadID?: string
  rootNeedID?: string
  depth?: number
}

export function propose(
  input: ProposeInput,
  companyAgentSvc: CompanyAgent.Interface,
  agentMessageSvc: AgentMessage.Interface,
) {
  return Effect.gen(function* () {
    const depth = input.depth ?? 0
    if (depth >= MAX_DELEGATION_DEPTH) {
      return yield* Effect.fail(
        new Error(`propose: max proposal depth (${MAX_DELEGATION_DEPTH}) exceeded`),
      )
    }

    const agents = yield* companyAgentSvc.list()
    const sender = agents.find((a) => a.id === input.fromId)
    if (!sender) {
      return yield* Effect.fail(new Error(`propose: sender agent "${input.fromId}" not found`))
    }

    if (!sender.reports_to) {
      return yield* Effect.fail(new Error("propose: no superior to propose to"))
    }

    const superior = agents.find((a) => a.id === sender.reports_to)
    if (!superior) {
      return yield* Effect.fail(
        new Error(`propose: superior agent "${sender.reports_to}" not found`),
      )
    }

    if (input.fromId === superior.id) {
      return yield* Effect.fail(new Error("propose: cannot propose to self"))
    }

    const proposalBody = `${input.body}\n\n**Rationale:** ${input.rationale}`

    const id = Identifier.ascending("message")
    const rootNeedID = input.rootNeedID ?? id

    const msg = yield* agentMessageSvc.create({
      id,
      fromAgentID: input.fromId,
      toAgentID: superior.id,
      kind: "proposal",
      body: proposalBody,
      threadID: input.threadID,
      rootNeedID,
      depth,
    })

    return {
      messageID: msg.id,
      toAgentID: superior.id,
      toAgentName: superior.name,
      depth: depth + 1,
    }
  })
}

// ---------------------------------------------------------------------------
// Drain unread messages for an agent (for session-start injection)
// ---------------------------------------------------------------------------

export function drainUnread(
  agentId: string,
  agentMessageSvc: AgentMessage.Interface,
) {
  return Effect.gen(function* () {
    const unread = yield* agentMessageSvc.listByAgent(agentId, { unreadOnly: true, limit: 100 })
    if (unread.length === 0) return ""

    // Mark all as read
    yield* Effect.forEach(unread, (msg) => agentMessageSvc.markRead(msg.id), { concurrency: "unbounded" })

    // Render as context block
    const lines = unread.map((msg) => {
      const header = `[${msg.kind}] from=${msg.fromAgentID} at=${new Date(msg.time.created).toISOString()}`
      const replyTag = msg.inReplyTo ? ` in_reply_to=${msg.inReplyTo}` : ""
      const threadTag = msg.threadID ? ` thread=${msg.threadID}` : ""
      return `<agent-message${replyTag}${threadTag}>\n${header}\n${msg.body}${msg.taskSummary ? `\nTask: ${msg.taskSummary}` : ""}${msg.outcome ? `\nOutcome: ${msg.outcome}` : ""}\n</agent-message>`
    })

    return `## Unread messages (${unread.length})\n\n${lines.join("\n\n")}`
  })
}
