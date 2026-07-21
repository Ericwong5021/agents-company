import type { AgentActivityProjection, CompanyReadyState } from "@agents-company/sdk/v2/client"
import type {
  ChannelId,
  ChannelKind,
  ChannelMessageId,
  ConversationMention,
  ConversationPrincipal,
  ConversationThreadId,
  MessageAuthor,
  MessageVisibility,
  RootNeedId,
  SignalType,
  CompanyThreadResponse,
  CompanyThreadEntriesResponse,
  CompanyThreadSourceResponse,
} from "@agents-company/sdk/v2/client"

export type { ChannelKind, SignalType }

export type CompanyDisconnectedSnapshot = {
  status: "disconnected"
  company: { name: string; versionLabel: string }
  title: string
  description: string
}

export type CompanyWorkspaceAccess = {
  kind: "trusted" | "basic" | "bearer"
  can_manage_credentials: boolean
}

// ── M2 Conversation model types ──────────────────────────────────────────────

export type ConversationChannelItem = {
  id: ChannelId
  kind: ChannelKind
  title: string
  scopeID?: string
  retentionDays: number
  time: {
    created: number
    updated: number
    archived?: number
  }
}

export type ConversationMessageItem = {
  id: ChannelMessageId
  channelID: ChannelId
  rootNeedID?: RootNeedId
  sourceThreadID?: ConversationThreadId
  replyToID?: ChannelMessageId
  requestID?: string
  author: MessageAuthor
  body: string
  signalType?: SignalType
  dri?: ConversationPrincipal
  visibility: MessageVisibility
  mentions: Array<ConversationMention>
  time: {
    created: number
    updated: number
  }
}

export type ConversationPendingMessage = {
  requestID: string
  body: string
  channelID: ChannelId
  time: number
  confirmed: boolean
  messageID?: ChannelMessageId
  threadID?: ConversationThreadId
  runID?: string
}

export type ConversationThreadDetail = CompanyThreadResponse
export type ConversationThreadEntryItem = CompanyThreadEntriesResponse["items"][number]
export type ConversationThreadSource = CompanyThreadSourceResponse

export type ConversationError = {
  title: string
  description: string
  retryable: boolean
}

export type ConversationSnapshot = {
  channels: ConversationChannelItem[]
  activeChannelID: ChannelId | null
  messages: ConversationMessageItem[]
  messagesBefore: string | null
  pendingMessages: ConversationPendingMessage[]
  thread: ConversationThreadDetail | null
  threadEntries: ConversationThreadEntryItem[]
  threadEntriesBefore: string | null
  threadSources: Record<string, ConversationThreadSource>
  loadingThreadSourceIDs: string[]
  loadingChannels: boolean
  loadingMessages: boolean
  sending: boolean
  error: ConversationError | null
}

export type CompanyProjectStatus =
  | "intake"
  | "planning"
  | "executing"
  | "reviewing"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "blocked"

export type CompanyProjectSummary = {
  id: string
  goal: string
  title: string
  status: CompanyProjectStatus
  owner_agent_id?: string
  active_run_id?: string
  provider_id?: string
  model_id?: string
  output_dir: string
  created_at: number
  updated_at: number
  completed_at?: number
}

export type CompanyProjectWorkItem = {
  id: string
  project_id: string
  plan_id: string
  parent_id?: string
  title: string
  description: string
  kind: "planner" | "worker" | "reviewer"
  work_type: "coding" | "decision" | "research" | "writing" | "design" | "analysis"
  role: string
  capability_packs: string[]
  decision_scope: string[]
  resource_scope: string[]
  model_group: "ultra" | "standard" | "lite"
  risk_level: "low" | "medium" | "high"
  review_status: "pending" | "running" | "accepted" | "rejected" | "not_required"
  status: "pending" | "running" | "blocked" | "failed" | "completed" | "cancelled"
  owner_agent_id?: string
  workflow_run_id?: string
  acceptance_criteria: string[]
  attempt: number
  max_attempts: number
  error?: string
  started_at?: number
  completed_at?: number
  created_at: number
  updated_at: number
}

export type CompanyProjectArtifact = {
  id: string
  work_item_id?: string
  kind: string
  title: string
  path?: string
  content?: string
  evidence: Record<string, unknown>
  created_by_agent_id?: string
  created_at: number
}

export type CompanyProjectGate = {
  id: string
  kind: "risk_approval" | "merge_approval"
  status: "pending" | "approved" | "rejected"
  title: string
  summary: string
  requested_by_agent_id?: string
  decision_note?: string
  requested_at: number
  decided_at?: number
}

export type CompanyProjectAgentRun = {
  id: string
  agentID: string
  state: "queued" | "starting" | "running" | "interrupting" | "awaiting_recovery" | "completed" | "failed" | "stopped"
  workItemID?: string
  model?: string
}

export type CompanyProjectTokenBreakdown = {
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type CompanyProjectUsage = {
  companyProjectID: string
  runCount: number
  observedTokens: CompanyProjectTokenBreakdown
  workItems: Array<{
    workItemID: string
    runIDs: string[]
    models: string[]
    observedTokens: CompanyProjectTokenBreakdown
  }>
}

export type CompanyProjectExecutionState = {
  project: CompanyProjectSummary
  charter?: {
    scope: string[]
    success_criteria: string[]
    constraints: string[]
    acceptance_criteria: string[]
  }
  work_items: CompanyProjectWorkItem[]
  artifacts: CompanyProjectArtifact[]
  gates: CompanyProjectGate[]
  agent_runs: CompanyProjectAgentRun[]
  usage: CompanyProjectUsage
}

export function companyProjectExecutionStateEquals(
  left: CompanyProjectExecutionState | null,
  right: CompanyProjectExecutionState | null,
) {
  if (left === right) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

export type CompanyReadyWorkspaceSnapshot = {
  status: "ready"
  access: CompanyWorkspaceAccess
  agents?: AgentActivityProjection[]
} & CompanyReadyState & { conversation: ConversationSnapshot }

export type CompanyWorkspaceSnapshot =
  | { status: "loading" }
  | CompanyReadyWorkspaceSnapshot
  | { status: "error"; title: string; description: string; retryable: boolean }
  | CompanyDisconnectedSnapshot
