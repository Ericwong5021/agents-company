import type {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
  WorkProjection,
} from "@agents-company/shared/experience"

export type CompanyConnection = "connecting" | "ready" | "degraded" | "disconnected" | "recovering"

export type CompanySnapshotResource = "company" | "agents" | "work" | "channels" | "messages"

export type CompanyConnectionDiagnostic = {
  checkedAt: string
  endpoint: string
  issue: CompanyConnectionIssue["kind"]
  statusCode?: number
  controlPlaneVersion?: string
  readiness?: "ready" | "blocked" | "unknown"
  unavailable: CompanySnapshotResource[]
}

export type CompanyConnectionIssue = {
  kind:
    | "authorization_required"
    | "invalid_configuration"
    | "invalid_response"
    | "migration_required"
    | "partial_data"
    | "provider_required"
    | "service_error"
    | "service_unreachable"
    | "version_mismatch"
  title: string
  detail: string
  impact: string
  nextAction: string
  retryable: boolean
  unavailable: CompanySnapshotResource[]
  diagnostic: CompanyConnectionDiagnostic
}

export type CompanyAgent = {
  id: string
  name: string
  role?: string
  department?: string
  responsibilities: string[]
  // TEAM-01/TEAM-05：组织身份区分正式员工与在岗临时实例。
  employment: "employee" | "temporary"
  attention: "none" | "available" | "focused" | "urgent"
  activity: "idle" | "waiting" | "working" | "recovering" | "completed" | "failed" | "interrupted"
  subject?: string
  presence: "online" | "offline"
  location?: string
  since: number
  interruptibility: "interruptible" | "coordinate_first" | "needs_intervention"
  risk?: string
  collaborators: string[]
  // TEAM-01：负载与最近交付来自真实工作项事实。
  workload: {
    active: number
    blocked: number
    recentDelivery?: {
      workItemID: string
      title: string
      reviewStatus: string
      timeCompleted: number
    }
  }
  evidence?: {
    kind: "agent_run"
    timeUpdated: number
  }
}

// TEAM-01：Agent 详情 = 活动投影 + 能力证据 + 工作历史，全部来自真实事实。
export type CompanyAgentDetail = {
  agent: CompanyAgent
  capabilities: {
    pack: string
    status: string
    available: boolean
    source: string
    lastVerifiedAt?: number
    failureCount: number
    availabilityReasons: string[]
  }[]
  performances: {
    projectID: string
    outcome: string
    qualityScore: number
    reliabilityScore: number
    reviewSummary: string
    timeCreated: number
  }[]
  selections: {
    projectID: string
    decision: "selected" | "rejected"
    reason: string
    candidateRank: number
    released: boolean
  }[]
  employmentReviews: {
    status: string
    rationale: string
    timeDecided?: number
  }[]
}

export type CompanyMessage = {
  id: string
  author: string
  role: string
  body: string
  time: string
  kind: "user" | "agent" | "system"
  threadID?: string
}

export type CompanyProject = {
  id: string
  title: string
  status: string
  progress?: number
}

export type CompanyBoardThread = {
  id: string
  projectID?: string
  status: "active" | "completed" | "interrupted"
  run?: {
    state: "queued" | "running" | "projecting" | "completed" | "failed" | "interrupted"
    retryable: boolean
    error?: string
  }
  messages: {
    id: string
    agentID: string
    body: string
    status?: string
    time: string
  }[]
  bidding?: {
    roundNum: number
    state: "bidding" | "decided"
    winnerAgentID?: string
  }
}

export type CompanyProjectDetail = {
  project: {
    id: string
    title: string
    goal: string
    status: string
    ownerAgentID?: string
    sourceThreadID?: string
    executionStrategy?: "legacy_full_plan" | "seed_and_grow"
    seedMode?: "seed_pair" | "discovery_first" | "direct_single"
    graphRevision?: number
  }
  charter?: {
    value: string
    deliverables: string[]
    acceptance: string[]
    scope: string[]
    nonGoals: string[]
    constraints: string[]
    risks: { description: string; mitigation: string }[]
    milestones: string[]
    driAgentID: string
  }
  workItems: {
    id: string
    title: string
    status: string
    kind: string
    ownerAgentID?: string
    dependsOn: string[]
    reviewStatus: string
    attempt: number
    maxAttempts: number
    error?: string
    purpose?: string
    role?: string
    originKind?: string
  }[]
  artifacts: {
    id: string
    title: string
    kind: string
    workItemID?: string
    createdAt: number
  }[]
  gates: {
    id: string
    title: string
    kind: string
    status: string
  }[]
  recruitment: {
    needs: {
      id: string
      role: string
      capabilityPacks: string[]
    }[]
    selections: {
      id: string
      capabilityNeedID: string
      agentID: string
      decision: "selected" | "rejected"
      reason: string
      released: boolean
    }[]
    candidates: {
      id: string
      name: string
      lifecycle: string
    }[]
    departments: {
      id: string
      name: string
      purpose: string
      status: string
    }[]
  }
}

export type SeedGrowProjectExperience = {
  organization: OrganizationProjection
  graph: GraphChangeSummary
  validation: ValidationSummary
  discoveries: DiscoverySummary[]
}

export type CompanySnapshot = {
  connection: CompanyConnection
  issue?: CompanyConnectionIssue
  company: {
    id: string
    name: string
    provider: string
    providerConfigured?: boolean
    approvalPolicy: string
    setupGoal?: string
  }
  stats: {
    online?: number
    activeProjects?: number
    boardMessages?: number
  }
  agents: CompanyAgent[]
  messages: CompanyMessage[]
  work: WorkProjection[]
  projects: CompanyProject[]
  notice?: string
}
