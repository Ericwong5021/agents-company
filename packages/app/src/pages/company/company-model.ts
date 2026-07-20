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
  | "researching"
  | "awaiting_project_approval"
  | "planning"
  | "awaiting_development_approval"
  | "developing"
  | "verifying"
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
  title: string
  description: string
  kind: string
  status: "pending" | "running" | "blocked" | "failed" | "completed" | "cancelled"
  owner_agent_id?: string
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
  created_by_agent_id?: string
  created_at: number
}

export type CompanyProjectGate = {
  id: string
  kind: "project_approval" | "development_approval" | "merge_approval"
  status: "pending" | "approved" | "rejected"
  title: string
  summary: string
  requested_by_agent_id?: string
  decision_note?: string
  requested_at: number
  decided_at?: number
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
