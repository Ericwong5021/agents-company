export type CompanyOperationCategory = "governance" | "work" | "runtime" | "quality" | "delivery" | "organization" | "system"
export type CompanyOperationSeverity = "info" | "warning" | "error"
export type CompanyOperationImportance = "primary" | "normal" | "diagnostic"

export type CompanyOperationItem = {
  id: string
  category: CompanyOperationCategory
  severity: CompanyOperationSeverity
  importance: CompanyOperationImportance
  eventType: string
  title: string
  summary?: string
  occurredAt: number
  source: { kind: string; id: string }
  refs: {
    rootNeedID?: string
    projectID?: string
    threadID?: string
    agentID?: string
    runID?: string
    workItemID?: string
  }
  context: {
    project?: { id: string; title: string }
    agent?: { id: string; name: string }
    run?: { id: string; state: string }
    workItem?: { id: string; title: string }
  }
  href: string
  details?: Array<{ label: string; value: string }>
}

export type CompanyOperationPage = {
  items: CompanyOperationItem[]
  nextCursor?: string
}

export type CompanyOperationSummary = { total24h: number; errors24h: number; warnings24h: number; recoveries24h: number }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined
}

function optionalReference(value: unknown) {
  if (!record(value)) return {}
  return {
    rootNeedID: text(value.rootNeedID),
    projectID: text(value.projectID),
    threadID: text(value.threadID),
    agentID: text(value.agentID),
    runID: text(value.runID),
    workItemID: text(value.workItemID),
  }
}

function optionalContext(value: unknown) {
  if (!record(value)) return {}
  const projectID = record(value.project) ? text(value.project.id) : undefined
  const projectTitle = record(value.project) ? text(value.project.title) : undefined
  const agentID = record(value.agent) ? text(value.agent.id) : undefined
  const agentName = record(value.agent) ? text(value.agent.name) : undefined
  const runID = record(value.run) ? text(value.run.id) : undefined
  const runState = record(value.run) ? text(value.run.state) : undefined
  const workItemID = record(value.workItem) ? text(value.workItem.id) : undefined
  const workItemTitle = record(value.workItem) ? text(value.workItem.title) : undefined
  const project = projectID && projectTitle
    ? { id: projectID, title: projectTitle }
    : undefined
  const agent = agentID && agentName
    ? { id: agentID, name: agentName }
    : undefined
  const run = runID && runState
    ? { id: runID, state: runState }
    : undefined
  const workItem = workItemID && workItemTitle
    ? { id: workItemID, title: workItemTitle }
    : undefined
  return {
    project,
    agent,
    run,
    workItem,
  }
}

export function companyOperationItem(value: unknown): CompanyOperationItem | undefined {
  if (!record(value) || !record(value.source)) return undefined
  const id = text(value.id)
  const category = enumValue(value.category, ["governance", "work", "runtime", "quality", "delivery", "organization", "system"] as const)
  const severity = enumValue(value.severity, ["info", "warning", "error"] as const)
  const importance = enumValue(value.importance, ["primary", "normal", "diagnostic"] as const)
  const eventType = text(value.eventType)
  const title = text(value.title)
  const occurredAt = finiteNumber(value.occurredAt)
  const sourceKind = text(value.source.kind)
  const sourceID = text(value.source.id)
  const href = text(value.href)
  if (!id || !category || !severity || !importance || !eventType || !title || occurredAt === undefined || !sourceKind || !sourceID || !href) return undefined
  const details = Array.isArray(value.details)
    ? value.details.flatMap((detail) => {
        const label = record(detail) ? text(detail.label) : undefined
        const detailValue = record(detail) ? text(detail.value) : undefined
        return label && detailValue ? [{ label, value: detailValue }] : []
      })
    : undefined
  return { id, category, severity, importance, eventType, title, summary: text(value.summary), occurredAt, source: { kind: sourceKind, id: sourceID }, refs: optionalReference(value.refs), context: optionalContext(value.context), href, details }
}

export function companyOperationPage(value: unknown): CompanyOperationPage | undefined {
  if (!record(value) || !Array.isArray(value.items)) return undefined
  const items = value.items.map(companyOperationItem)
  if (items.some(item => !item)) return undefined
  const nextCursor = value.nextCursor === undefined ? undefined : text(value.nextCursor)
  if (value.nextCursor !== undefined && !nextCursor) return undefined
  return {
    items: items as CompanyOperationItem[],
    nextCursor,
  }
}

export function companyOperationSummary(value: unknown): CompanyOperationSummary | undefined {
  if (!record(value)) return undefined
  const summary = [value.total24h, value.errors24h, value.warnings24h, value.recoveries24h]
  if (!summary.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0)) return undefined
  return {
    total24h: value.total24h as number,
    errors24h: value.errors24h as number,
    warnings24h: value.warnings24h as number,
    recoveries24h: value.recoveries24h as number,
  }
}
