export type AgentStatus = "idle" | "busy" | "paused"
export type ThreadKind = "primary" | "reactive" | "ambient"
export type ThreadStatus = "active" | "paused" | "completed"

export interface ThreadInfo {
  id: string
  agentID: string
  kind: ThreadKind
  status: ThreadStatus
  sessionID?: string
  description?: string
  budgetTokens?: number
  spentTokens: number
  time?: { created: number; updated: number }
}

export interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  color?: string
  icon?: string
  model?: string
  org_layer?: string
  department?: string
}

export interface WorkstationStatusProject {
  id: string
  blocked: boolean
  blocked_reason?: string
  blocked_by_agent_id?: string
  time_blocked?: number
}

export interface WorkstationStatusAgent {
  id: string
  name: string
  org_layer: string
  status: AgentStatus
  threads: Array<{
    id: string
    kind: ThreadKind
    status: ThreadStatus
    task_summary?: string
    budget_tokens?: number
    spent_tokens: number
  }>
}

export interface ApprovalPrompt {
  id: string
  from_agent_id: string
  to_agent_id: string
  root_need_id?: string
  thread_id?: string
  in_reply_to?: string
  task_summary?: string
  body: string
  depth: number
  time_created: number
}

export interface CollaborationNode {
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

export interface CollaborationTree {
  root_need_id: string
  total_messages: number
  max_depth: number
  nodes: CollaborationNode[]
}

export interface CollaborationRow {
  node: CollaborationNode
  level: number
}

export interface WorkstationStatus {
  project: WorkstationStatusProject
  agents: WorkstationStatusAgent[]
  summary: {
    total_agents: number
    active_agents: number
    total_threads: number
    open_tasks: number
    pending_approvals?: number
  }
  approvals?: ApprovalPrompt[]
  collaboration_trees?: CollaborationTree[]
}

export interface ProjectTokenStats {
  trackedSpentTokens: number
  observedTokens: {
    total: number
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
}

export interface AgentCardData {
  id: string
  name: string
  icon?: string
  color?: string
  description?: string
  model?: string
  orgLayer?: string
  department?: string
  status: AgentStatus
  threads: ThreadInfo[]
  totalTokens: number
}

export interface OfficeModel {
  project?: WorkstationStatusProject
  agents: AgentCardData[]
  summary: {
    totalAgents: number
    activeAgents: number
    totalThreads: number
    openTasks: number
    trackedTokens: number
    observedTokens: number
    blocked: boolean
    pendingApprovals: number
  }
  approvals: ApprovalPrompt[]
  collaborationTrees: CollaborationTree[]
  presence: {
    idle: number
    busy: number
    paused: number
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function flattenCollaborationNodes(nodes: CollaborationNode[], level = 0): CollaborationRow[] {
  return nodes.flatMap((node) => [
    { node, level },
    ...flattenCollaborationNodes(node.children, level + 1),
  ])
}

function threadFromStatus(thread: WorkstationStatusAgent["threads"][number], agentID: string): ThreadInfo {
  return {
    id: thread.id,
    agentID,
    kind: thread.kind,
    status: thread.status,
    description: thread.task_summary,
    budgetTokens: thread.budget_tokens,
    spentTokens: thread.spent_tokens,
  }
}

export function buildOfficeModel(input: {
  agents: CompanyAgentInfo[]
  threads: ThreadInfo[]
  statuses: Record<string, AgentStatus>
  workstation?: WorkstationStatus
  tokenStats?: ProjectTokenStats
}): OfficeModel {
  const statusAgents = new Map((input.workstation?.agents ?? []).map((agent) => [agent.id, agent]))
  const agents = input.agents.map((agent) => {
    const statusAgent = statusAgents.get(agent.id)
    const threads = statusAgent
      ? statusAgent.threads.map((thread) => threadFromStatus(thread, agent.id))
      : input.threads.filter((thread) => thread.agentID === agent.id && thread.status === "active")
    return {
      id: agent.id,
      name: agent.name,
      icon: agent.icon,
      color: agent.color,
      description: agent.description,
      model: agent.model,
      orgLayer: agent.org_layer ?? statusAgent?.org_layer,
      department: typeof agent.department === "string" ? agent.department : undefined,
      status: statusAgent?.status ?? input.statuses[agent.id] ?? "idle",
      threads,
      totalTokens: threads.reduce((sum, thread) => sum + thread.spentTokens, 0),
    }
  })
  const presence = {
    idle: agents.filter((agent) => agent.status === "idle").length,
    busy: agents.filter((agent) => agent.status === "busy").length,
    paused: agents.filter((agent) => agent.status === "paused").length,
  }
  const fallbackThreads = agents.reduce((sum, agent) => sum + agent.threads.length, 0)
  return {
    project: input.workstation?.project,
    agents,
    approvals: input.workstation?.approvals ?? [],
    collaborationTrees: input.workstation?.collaboration_trees ?? [],
    presence,
    summary: {
      totalAgents: input.workstation?.summary.total_agents ?? agents.length,
      activeAgents: input.workstation?.summary.active_agents ?? agents.filter((agent) => agent.status !== "idle").length,
      totalThreads: input.workstation?.summary.total_threads ?? fallbackThreads,
      openTasks: input.workstation?.summary.open_tasks ?? agents.reduce(
        (sum, agent) => sum + agent.threads.filter((thread) => thread.kind === "primary").length,
        0,
      ),
      trackedTokens:
        input.tokenStats?.trackedSpentTokens ?? agents.reduce((sum, agent) => sum + agent.totalTokens, 0),
      observedTokens: input.tokenStats?.observedTokens.total ?? 0,
      blocked: input.workstation?.project.blocked ?? false,
      pendingApprovals: input.workstation?.summary.pending_approvals ?? input.workstation?.approvals?.length ?? 0,
    },
  }
}
