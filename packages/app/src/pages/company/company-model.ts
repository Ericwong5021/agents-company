import type { CompanyNeedsBootstrapState, CompanyReadyState } from "@agents-company/sdk/v2/client"
import type {
  ChannelId,
  ChannelKind,
  ChannelMessageId,
  ConversationMention,
  ConversationPrincipal,
  ConversationThreadId,
  ConversationThreadStatus,
  MessageAuthor,
  MessageVisibility,
  RootNeedId,
  SignalType,
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

export type ConversationThreadMember = {
  principal: ConversationPrincipal
  time: {
    joined: number
    left?: number
  }
}

export type ConversationThreadDetail = {
  id: ConversationThreadId
  channelID: ChannelId
  rootNeedID?: RootNeedId
  projectScopeID?: string
  title: string
  status: ConversationThreadStatus
  members: ConversationThreadMember[]
  time: {
    created: number
    updated: number
    archived?: number
  }
}

export type ConversationThreadEntryItem = {
  type: "message"
  message: {
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
}

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
  loadingChannels: boolean
  loadingMessages: boolean
  sending: boolean
  error: ConversationError | null
}

export type CompanyReadyWorkspaceSnapshot = {
  status: "ready"
  access: CompanyWorkspaceAccess
} & CompanyReadyState & { conversation: ConversationSnapshot }

export type CompanyWorkspaceSnapshot =
  | { status: "loading" }
  | ({ status: "needs_bootstrap"; access: CompanyWorkspaceAccess } & CompanyNeedsBootstrapState)
  | CompanyReadyWorkspaceSnapshot
  | { status: "error"; title: string; description: string; retryable: boolean }
  | CompanyDisconnectedSnapshot
