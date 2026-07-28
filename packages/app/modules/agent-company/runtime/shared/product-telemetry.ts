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

// opt-in 同意状态：默认关闭（未决定视为关闭），用户显式选择加入才上报。
export type TelemetryConsent = { enabled: boolean; decidedAt?: string }

export function parseConsent(raw: string | null): TelemetryConsent {
  if (!raw) return { enabled: false }
  const parsed = safeJson(raw)
  if (!parsed || typeof parsed.enabled !== "boolean") return { enabled: false }
  return { enabled: parsed.enabled, decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : undefined }
}

export function serializeConsent(consent: TelemetryConsent): string {
  return JSON.stringify(consent)
}

export function shouldReportRemote(consent: TelemetryConsent): boolean {
  return consent.enabled === true
}

function safeJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
