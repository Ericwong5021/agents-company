import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import type {
  CompanyAgent,
  CompanyMessage,
  CompanyProject,
  CompanySnapshot,
} from "../../shared/company-contract"

const fixture: CompanySnapshot = {
  connection: "demo",
  company: {
    id: "local-agent-company",
    name: "Agent Company",
    provider: "Local Control Plane",
    providerConfigured: false,
    approvalPolicy: "Balanced",
  },
  stats: {
    online: 3,
    activeProjects: 2,
    boardMessages: 18,
  },
  agents: [
    {
      id: "ceo",
      name: "CEO",
      role: "Company direction",
      department: "Board",
      activity: "working",
      subject: "Reviewing the launch brief",
      presence: "online",
    },
    {
      id: "cto",
      name: "CTO",
      role: "Technical strategy",
      department: "Engineering",
      activity: "working",
      subject: "Validating the Control Plane adapter",
      presence: "online",
    },
    {
      id: "product-lead",
      name: "Product Lead",
      role: "User value",
      department: "Product",
      activity: "waiting",
      subject: "Preparing the next board decision",
      presence: "online",
    },
  ],
  messages: [
    {
      id: "message-1",
      author: "You",
      role: "Founder",
      body: "Move the Agent Company experience onto the Eve shell without weakening the group collaboration model.",
      time: "09:42",
      kind: "user",
    },
    {
      id: "message-2",
      author: "CEO",
      role: "Board",
      body: "The upstream shell remains intact. Company navigation and data access now enter through one isolated Nuxt module.",
      time: "09:44",
      kind: "agent",
    },
    {
      id: "message-3",
      author: "CTO",
      role: "Engineering",
      body: "The adapter reads the real local Control Plane when available and exposes an explicit demo state when it is offline.",
      time: "09:45",
      kind: "agent",
    },
  ],
  projects: [
    {
      id: "project-eve-shell",
      title: "Eve shell integration",
      status: "In progress",
      progress: 72,
    },
    {
      id: "project-control-plane",
      title: "Control Plane projection",
      status: "Validation",
      progress: 48,
    },
  ],
  notice: "Control Plane is offline. Showing deterministic module data.",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeAgents(value: unknown): CompanyAgent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.agent)) return []
    return [{
      id: text(entry.agent.id, crypto.randomUUID()),
      name: text(entry.agent.name, "Agent"),
      role: text(entry.agent.role, "Company employee"),
      department: text(entry.agent.department, "Company"),
      activity: text(entry.activity, "idle"),
      subject: text(entry.subject, "Available for work"),
      presence: entry.presence === "offline" ? "offline" as const : "online" as const,
    }]
  })
}

function normalizeProjects(value: unknown): CompanyProject[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    return [{
      id: text(entry.id, crypto.randomUUID()),
      title: text(entry.title, text(entry.goal, "Untitled project")),
      status: text(entry.status, "Active"),
      progress: Math.max(0, Math.min(100, number(entry.progress, 0))),
    }]
  })
}

function normalizeMessages(value: unknown, agents: CompanyAgent[]): CompanyMessage[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.author)) return []
    const authorID = text(entry.author.id, "system")
    const author = agents.find((agent) => agent.id === authorID)
    const created = isRecord(entry.time) ? number(entry.time.created) : 0
    return [{
      id: text(entry.id, crypto.randomUUID()),
      author: author?.name ?? (entry.author.kind === "user" ? "You" : "System"),
      role: author?.role ?? text(entry.author.kind, "system"),
      body: text(entry.body),
      threadID: text(entry.sourceThreadID) || undefined,
      time: created
        ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(created))
        : "",
      kind: entry.author.kind === "agent"
        ? "agent" as const
        : entry.author.kind === "user"
          ? "user" as const
          : "system" as const,
    }]
  })
}

export default defineEventHandler(async (event): Promise<CompanySnapshot> => {
  const config = useRuntimeConfig(event)
  const baseURL = new URL(config.agentCompanyControlPlaneUrl)
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const request = (path: string) => ofetch<unknown>(new URL(path, baseURL).toString(), { headers })

  const state = await request("/company").catch(() => undefined)
  if (!isRecord(state) || state.state !== "ready" || !isRecord(state.company)) return fixture

  const companyID = text(state.company.id)
  const [agentsRaw, projectsRaw, channelsRaw] = await Promise.all([
    request(`/company/agents?company_id=${encodeURIComponent(companyID)}`).catch(() => []),
    request("/company-project").catch(() => []),
    request(`/company/channels?company_id=${encodeURIComponent(companyID)}`).catch(() => []),
  ])
  const agents = normalizeAgents(agentsRaw)
  const channels = Array.isArray(channelsRaw) ? channelsRaw : []
  const board = channels.find((entry) => isRecord(entry) && entry.kind === "board")
  const messagesRaw = isRecord(board)
    ? await request(`/company/channels/${encodeURIComponent(text(board.id))}/messages?company_id=${encodeURIComponent(companyID)}&limit=30`).catch(() => ({ items: [] }))
    : { items: [] }
  const messages = normalizeMessages(messagesRaw, agents)
  const projects = normalizeProjects(projectsRaw)
  const provider = isRecord(state.company.provider)
    ? `${text(state.company.provider.provider_id, "provider")} / ${text(state.company.provider.model_id, "model")}`
    : "Not configured"
  const approvalPolicy = isRecord(state.company.approval_policy)
    ? text(state.company.approval_policy.preset, "Balanced")
    : "Balanced"

  return {
    connection: "live",
    company: {
      id: companyID,
      name: text(state.company.name, "Agent Company"),
      provider,
      providerConfigured: isRecord(state.company.provider),
      approvalPolicy,
      setupGoal: isRecord(state.company.setup_goal) ? text(state.company.setup_goal.body) || undefined : undefined,
    },
    stats: {
      online: agents.filter((agent) => agent.presence === "online").length,
      activeProjects: projects.filter((project) => !["completed", "cancelled", "failed"].includes(project.status.toLowerCase())).length,
      boardMessages: messages.length,
    },
    agents,
    messages,
    projects,
  }
})
