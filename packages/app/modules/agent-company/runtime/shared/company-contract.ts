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
}

export type CompanyProject = {
  id: string
  title: string
  status: string
  progress: number
}

export type CompanySnapshot = {
  connection: CompanyConnection
  company: {
    id: string
    name: string
    provider: string
    approvalPolicy: string
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
