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

export type CompanyReadySnapshot = {
  status: "ready"
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

export type CompanyWorkspaceSnapshot = CompanyReadySnapshot | CompanyDisconnectedSnapshot
