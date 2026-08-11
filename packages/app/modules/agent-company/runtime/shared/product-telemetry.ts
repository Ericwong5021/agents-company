// QA-06 — 本地优先的产品遥测纯逻辑：事件定义、隐私脱敏、指标计算与 opt-in 同意状态。
// 关键红线：默认本地保存、默认关闭远程上报（opt-in）；禁止采集 API Key / 完整 Prompt /
// 文件内容 / Artifact 正文；指标口径带版本，避免口径悄悄变化。

export const productEventTypes = [
  "goal_created",
  "brief_ready",
  "execution_started",
  "attention_requested",
  "blocked",
  "delivery_viewed",
  "accepted",
  "revision_requested",
  "failed",
  "recovered",
] as const
export type ProductEventType = (typeof productEventTypes)[number]

export type ProductEventProps = Record<string, string | number | boolean>

export type ProductEvent = {
  type: ProductEventType
  at: string
  scenario?: string
  version: string
  // dedupeKey 用于把同一根因的重复触发折叠为一次（如同一 Gate 的多次渲染）。
  dedupeKey?: string
  props?: ProductEventProps
}

export const productTelemetryStorageKey = "agent-company:product-telemetry:v1"
export const productTelemetryConsentKey = "agent-company:product-telemetry-consent:v1"
export const productTelemetryEventLimit = 5_000

// 禁止采集的字段（键名命中即视为敏感），覆盖 API Key、Prompt、文件与 Artifact 正文、令牌与密钥。
const forbiddenKeyPattern =
  /(api[_-]?key|apikey|token|secret|password|credential|prompt|message|content|body|file|artifact)/i

export function isForbiddenKey(key: string): boolean {
  return forbiddenKeyPattern.test(key)
}

// 脱敏：剔除任何命中禁采规则的键，返回只含安全维度（版本/场景/枚举/计数）的 props。
export function sanitizeEventProps(props: ProductEventProps | undefined): ProductEventProps {
  if (!props) return {}
  return Object.fromEntries(Object.entries(props).filter(([key]) => !isForbiddenKey(key)))
}

// 校验事件 payload 是否安全：任一键命中禁采规则即为不安全。
export function isSafeEvent(event: ProductEvent): boolean {
  return Object.keys(event.props ?? {}).every((key) => !isForbiddenKey(key))
}

// 去重：同一 type + dedupeKey 只记一次；无 dedupeKey 的事件全部保留。
export function dedupeEvents(events: ProductEvent[]): ProductEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    if (!event.dedupeKey) return true
    const key = `${event.type}::${event.dedupeKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventProps(value: unknown): ProductEventProps | undefined {
  if (!record(value)) return
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean",
  )
  return sanitizeEventProps(Object.fromEntries(entries))
}

function productEvent(value: unknown): ProductEvent | undefined {
  if (!record(value)) return
  if (!productEventTypes.includes(value.type as ProductEventType)) return
  if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return
  if (typeof value.version !== "string" || !value.version) return
  if (value.scenario !== undefined && typeof value.scenario !== "string") return
  if (value.dedupeKey !== undefined && typeof value.dedupeKey !== "string") return
  return {
    type: value.type as ProductEventType,
    at: value.at,
    version: value.version,
    scenario: typeof value.scenario === "string" ? value.scenario : undefined,
    dedupeKey: typeof value.dedupeKey === "string" ? value.dedupeKey : undefined,
    props: eventProps(value.props),
  }
}

export function parseStoredEvents(raw: string | null): ProductEvent[] {
  if (!raw) return []
  const parsed = safeJson(raw)
  if (!Array.isArray(parsed)) return []
  return dedupeEvents(parsed.flatMap((value) => {
    const parsedEvent = productEvent(value)
    return parsedEvent && isSafeEvent(parsedEvent) ? [parsedEvent] : []
  })).slice(-productTelemetryEventLimit)
}

export function appendProductEvent(events: ProductEvent[], event: ProductEvent): ProductEvent[] {
  const safe = {
    ...event,
    props: sanitizeEventProps(event.props),
  }
  if (!isSafeEvent(safe)) return events
  return dedupeEvents([...events, safe]).slice(-productTelemetryEventLimit)
}

// 指标口径版本：口径变化时递增，历史数据据此比较。
export const metricDefinitionVersion = "1"

export type ProductMetrics = {
  definitionVersion: string
  counts: Record<ProductEventType, number>
  // 北极星：从创建目标到查看交付的漏斗到达率。
  deliveryReachRate: number
  // 护栏：中断率（每次执行触发多少次注意力请求）、恢复率、验收率。
  interruptionRate: number
  recoveryRate: number
  acceptanceRate: number
}

export type ProductMetricBreakdown = {
  key: string
  eventCount: number
  metrics: ProductMetrics
}

export type ProductMetricBreakdowns = {
  byVersion: ProductMetricBreakdown[]
  byScenario: ProductMetricBreakdown[]
  byApprovalMode: ProductMetricBreakdown[]
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

export function computeMetrics(events: ProductEvent[]): ProductMetrics {
  const deduped = dedupeEvents(events)
  const counts = productEventTypes.reduce(
    (acc, type) => ({ ...acc, [type]: deduped.filter((event) => event.type === type).length }),
    {} as Record<ProductEventType, number>,
  )
  return {
    definitionVersion: metricDefinitionVersion,
    counts,
    deliveryReachRate: ratio(counts.delivery_viewed, counts.goal_created),
    interruptionRate: ratio(counts.attention_requested, counts.execution_started),
    recoveryRate: ratio(counts.recovered, counts.failed),
    acceptanceRate: ratio(counts.accepted, counts.delivery_viewed),
  }
}

function breakdown(events: ProductEvent[], key: (event: ProductEvent) => string | undefined) {
  const groups = events.reduce<Record<string, ProductEvent[]>>((result, event) => {
    const value = key(event)
    if (!value) return result
    result[value] = [...(result[value] ?? []), event]
    return result
  }, {})
  return Object.entries(groups)
    .map(([value, grouped]) => ({ key: value, eventCount: grouped.length, metrics: computeMetrics(grouped) }))
    .toSorted((left, right) => right.eventCount - left.eventCount || left.key.localeCompare(right.key))
}

export function computeMetricBreakdowns(events: ProductEvent[]): ProductMetricBreakdowns {
  const safe = dedupeEvents(events).filter(isSafeEvent)
  return {
    byVersion: breakdown(safe, event => event.version),
    byScenario: breakdown(safe, event => event.scenario),
    byApprovalMode: breakdown(safe, event =>
      typeof event.props?.approvalMode === "string" ? event.props.approvalMode : undefined),
  }
}

// opt-in 同意状态：默认关闭（未决定视为关闭），用户显式选择加入才上报。
export type TelemetryConsent = { enabled: boolean; decidedAt?: string }

export function parseConsent(raw: string | null): TelemetryConsent {
  if (!raw) return { enabled: false }
  const parsed = safeJson(raw)
  if (!record(parsed) || typeof parsed.enabled !== "boolean") return { enabled: false }
  return { enabled: parsed.enabled, decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : undefined }
}

export function serializeConsent(consent: TelemetryConsent): string {
  return JSON.stringify(consent)
}

export function shouldReportRemote(consent: TelemetryConsent): boolean {
  return consent.enabled === true
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
