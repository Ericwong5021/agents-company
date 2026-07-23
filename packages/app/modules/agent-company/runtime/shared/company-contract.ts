export type CompanyConnection = "live" | "demo"

export type CompanyAgent = {
  id: string
  name: string
  role: string
  department: string
  activity: string
  subject: string
  presence: "online" | "offline"
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
  progress: number
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

export type CompanySnapshot = {
  connection: CompanyConnection
  company: {
    id: string
    name: string
    provider: string
    providerConfigured: boolean
    approvalPolicy: string
    setupGoal?: string
  }
  stats: {
    online: number
    activeProjects: number
    boardMessages: number
  }
  agents: CompanyAgent[]
  messages: CompanyMessage[]
  projects: CompanyProject[]
  notice?: string
}
