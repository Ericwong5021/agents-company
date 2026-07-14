import type { CompanyNeedsBootstrapState, CompanyReadyState } from "@agents-company/sdk/v2/client"

export type CompanyAgent = {
  id: string
  name: string
  role: string
  avatar: string
  status: "online" | "working" | "reviewing"
}

export type CompanyChannel = {
  id: string
  section: "公司" | "项目" | "Direct"
  name: string
  preview?: string
  badge?: number
  agent?: string
}

export type CompanyMessage = {
  id: string
  agent: string
  time: string
  body: string[]
  bubble?: boolean
}

export type CompanyThreadEvent = {
  id: string
  agent: string
  time: string
  body: string
  detail?: string
  duration?: string
}

export type CompanyDelivery = {
  id: string
  status: "pending" | "approved"
  targetBranch: string
  requesterAgentID: string
  repository: string
  reason: string
  risk: string
  reversibility: string
  checks: Array<{ label: string; value: string }>
  evidence: Array<{ label: string; value: string }>
  files: string[]
  previewImage: string
  sourceLabel: string
}

export type CompanyDemoSnapshot = {
  status: "demo"
  company: { name: string; versionLabel: string }
  currentUserAgentID: string
  agents: Record<string, CompanyAgent>
  channels: CompanyChannel[]
  featuredChannelID: string
  featuredDescription: string
  participantAgentIDs: string[]
  participantCount: number
  dateLabel: string
  messages: CompanyMessage[]
  delivery: CompanyDelivery
  threadTitle: string
  threadEvents: CompanyThreadEvent[]
  userMessages: string[]
}

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

export type CompanyWorkspaceSnapshot =
  | { status: "loading" }
  | ({ status: "needs_bootstrap"; access: CompanyWorkspaceAccess } & CompanyNeedsBootstrapState)
  | ({ status: "ready"; access: CompanyWorkspaceAccess } & CompanyReadyState)
  | { status: "error"; title: string; description: string; retryable: boolean }
  | CompanyDisconnectedSnapshot
  | CompanyDemoSnapshot
