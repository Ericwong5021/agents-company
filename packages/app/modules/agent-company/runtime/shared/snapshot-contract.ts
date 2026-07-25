import { WorkProjectionList, type WorkProjection } from "@agents-company/shared/experience"
import type {
  CompanyAgent,
  CompanyMessage,
  CompanyProject,
} from "./company-contract"

type Parsed<T> = { ok: true; value: T } | { ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parsed<T>(value: T | undefined): Parsed<T> {
  return value === undefined ? { ok: false } : { ok: true, value }
}

export function parseHealth(value: unknown) {
  if (!isRecord(value) || value.healthy !== true) return parsed<never>(undefined)
  return parsed(text(value.version))
}

export function parseReadiness(value: unknown) {
  if (!isRecord(value) || typeof value.ready !== "boolean" || !Array.isArray(value.checks)) {
    return parsed<never>(undefined)
  }
  const checks = value.checks.map((entry) => {
    if (!isRecord(entry)) return
    const id = text(entry.id)
    const status = ["pass", "warning", "fail"].includes(String(entry.status))
      ? entry.status as "pass" | "warning" | "fail"
      : undefined
    if (!id || !status) return
    return { id, status }
  })
  if (checks.some((entry) => entry === undefined)) return parsed<never>(undefined)
  return parsed({ ready: value.ready, checks: checks.filter((entry) => entry !== undefined) })
}

export function parseCompany(value: unknown) {
  if (!isRecord(value) || value.state !== "ready" || !isRecord(value.company)) return parsed<never>(undefined)
  const id = text(value.company.id)
  const name = text(value.company.name)
  const policy = isRecord(value.company.approval_policy) ? text(value.company.approval_policy.preset) : undefined
  const provider = value.company.provider === null
    ? null
    : isRecord(value.company.provider)
      ? {
          providerID: text(value.company.provider.provider_id),
          modelID: text(value.company.provider.model_id),
        }
      : undefined
  const setupGoal = value.company.setup_goal === null
    ? undefined
    : isRecord(value.company.setup_goal)
      ? text(value.company.setup_goal.body)
      : undefined
  if (
    !id
    || !name
    || !policy
    || !["autonomous", "balanced", "strict"].includes(policy)
    || provider === undefined
    || (provider !== null && (!provider.providerID || !provider.modelID))
  ) {
    return parsed<never>(undefined)
  }
  return parsed({ id, name, policy, provider, setupGoal })
}

export function parseAgents(value: unknown): Parsed<CompanyAgent[]> {
  if (!Array.isArray(value)) return { ok: false }
  const agents = value.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.agent)) return
    const id = text(entry.agent.id)
    const name = text(entry.agent.name)
    const activity = [
      "idle",
      "waiting",
      "working",
      "recovering",
      "completed",
      "failed",
      "interrupted",
    ].includes(String(entry.activity))
      ? entry.activity as CompanyAgent["activity"]
      : undefined
    const attention = ["none", "available", "focused", "urgent"].includes(String(entry.attention))
      ? entry.attention as CompanyAgent["attention"]
      : undefined
    const interruptibility = ["interruptible", "coordinate_first", "needs_intervention"].includes(
      String(entry.interruptibility),
    )
      ? entry.interruptibility as CompanyAgent["interruptibility"]
      : undefined
    const location = text(entry.location)
    const since = number(entry.since)
    const responsibilities = Array.isArray(entry.agent.responsibilities)
      ? entry.agent.responsibilities.flatMap((item) => text(item) ?? [])
      : undefined
    const collaborators = Array.isArray(entry.collaborators)
      ? entry.collaborators.flatMap((item) => text(item) ?? [])
      : undefined
    const evidence = isRecord(entry.evidence)
      && entry.evidence.kind === "agent_run"
      && number(entry.evidence.timeUpdated) !== undefined
      ? {
          kind: "agent_run" as const,
          timeUpdated: number(entry.evidence.timeUpdated)!,
        }
      : undefined
    if (
      !id
      || !name
      || !activity
      || !attention
      || !interruptibility
      || since === undefined
      || !responsibilities
      || !collaborators
      || !["online", "offline"].includes(String(entry.presence))
    ) return
    return {
      id,
      name,
      role: text(entry.agent.role),
      department: text(entry.agent.department),
      responsibilities,
      attention,
      activity,
      subject: text(entry.subject),
      presence: entry.presence as "online" | "offline",
      location,
      since,
      interruptibility,
      risk: text(entry.risk),
      collaborators,
      evidence,
    }
  })
  if (agents.some((entry) => entry === undefined)) return { ok: false }
  return { ok: true, value: agents.filter((entry) => entry !== undefined) }
}

export function parseWorkProjections(value: unknown): Parsed<WorkProjection[]> {
  const result = WorkProjectionList.safeParse(value)
  return result.success ? { ok: true, value: result.data.items } : { ok: false }
}

export function parseProjects(value: unknown): Parsed<CompanyProject[]> {
  if (!Array.isArray(value)) return { ok: false }
  const projects = value.map((entry) => {
    if (!isRecord(entry)) return
    const id = text(entry.id)
    const title = text(entry.title) ?? text(entry.goal)
    const status = text(entry.status)
    const progress = number(entry.progress)
    if (!id || !title || !status || (progress !== undefined && (progress < 0 || progress > 100))) return
    return { id, title, status, progress }
  })
  if (projects.some((entry) => entry === undefined)) return { ok: false }
  return { ok: true, value: projects.filter((entry) => entry !== undefined) }
}

export function parseBoardChannel(value: unknown): Parsed<string | null> {
  if (!Array.isArray(value)) return { ok: false }
  const invalid = value.some((entry) => !isRecord(entry) || !text(entry.id) || !text(entry.kind))
  if (invalid) return { ok: false }
  return {
    ok: true,
    value: value.flatMap((entry) => isRecord(entry) && entry.kind === "board" ? [text(entry.id)] : [])
      .find((entry) => entry !== undefined) ?? null,
  }
}

export function parseMessages(value: unknown, agents: CompanyAgent[]): Parsed<CompanyMessage[]> {
  if (!isRecord(value) || !Array.isArray(value.items)) return { ok: false }
  const messages = value.items.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.author) || !isRecord(entry.time)) return
    const id = text(entry.id)
    const authorID = text(entry.author.id)
    const body = text(entry.body)
    const created = number(entry.time.created)
    const createdAt = created === undefined ? undefined : new Date(created)
    const kind = ["agent", "user", "system"].includes(String(entry.author.kind))
      ? entry.author.kind as "agent" | "user" | "system"
      : undefined
    if (
      !id
      || !authorID
      || !body
      || created === undefined
      || !Number.isInteger(created)
      || created < 0
      || !createdAt
      || Number.isNaN(createdAt.getTime())
      || !kind
    ) return
    const author = agents.find((agent) => agent.id === authorID)
    if (kind === "agent" && !author) return
    return {
      id,
      author: author?.name ?? (kind === "user" ? "你" : "系统"),
      role: author?.role ?? kind,
      body,
      threadID: text(entry.sourceThreadID),
      time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(createdAt),
      kind,
    }
  })
  if (messages.some((entry) => entry === undefined)) return { ok: false }
  return { ok: true, value: messages.filter((entry) => entry !== undefined) }
}
