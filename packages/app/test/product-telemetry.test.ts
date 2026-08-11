import { describe, expect, test } from "bun:test"
import {
  computeMetricBreakdowns,
  computeMetrics,
  dedupeEvents,
  isForbiddenKey,
  isSafeEvent,
  metricDefinitionVersion,
  parseConsent,
  productEventTypes,
  sanitizeEventProps,
  serializeConsent,
  shouldReportRemote,
  type ProductEvent,
} from "../modules/agent-company/runtime/shared/product-telemetry"

// QA-06 — 产品遥测纯逻辑：隐私脱敏、去重、指标口径与 opt-in 同意状态。

function event(type: ProductEvent["type"], extra: Partial<ProductEvent> = {}): ProductEvent {
  return { type, at: "2026-07-01T00:00:00.000Z", version: "1", ...extra }
}

describe("隐私脱敏", () => {
  test("命中 API Key / Prompt / 文件 / Artifact 正文等键名视为敏感", () => {
    expect(isForbiddenKey("apiKey")).toBe(true)
    expect(isForbiddenKey("api_key")).toBe(true)
    expect(isForbiddenKey("prompt")).toBe(true)
    expect(isForbiddenKey("fileContent")).toBe(true)
    expect(isForbiddenKey("artifactBody")).toBe(true)
    expect(isForbiddenKey("scenario")).toBe(false)
    expect(isForbiddenKey("status")).toBe(false)
  })

  test("sanitizeEventProps 剔除敏感键，仅保留安全维度", () => {
    expect(sanitizeEventProps({ scenario: "research", status: "delivered", apiKey: "sk-xxx", prompt: "..." })).toEqual({
      scenario: "research",
      status: "delivered",
    })
  })

  test("isSafeEvent 在 payload 含敏感键时判定不安全", () => {
    expect(isSafeEvent(event("goal_created", { props: { scenario: "research" } }))).toBe(true)
    expect(isSafeEvent(event("goal_created", { props: { prompt: "..." } }))).toBe(false)
  })
})

describe("去重与指标口径", () => {
  test("同一 type + dedupeKey 只记一次，无 dedupeKey 全保留", () => {
    const deduped = dedupeEvents([
      event("attention_requested", { dedupeKey: "gate-1" }),
      event("attention_requested", { dedupeKey: "gate-1" }),
      event("attention_requested", { dedupeKey: "gate-2" }),
      event("goal_created"),
      event("goal_created"),
    ])
    expect(deduped).toHaveLength(4)
  })

  test("从固定事件集计算北极星与护栏指标", () => {
    const metrics = computeMetrics([
      event("goal_created"),
      event("goal_created"),
      event("execution_started"),
      event("execution_started"),
      event("attention_requested"),
      event("delivery_viewed"),
      event("accepted"),
      event("failed"),
      event("recovered"),
    ])
    expect(metrics.definitionVersion).toBe(metricDefinitionVersion)
    expect(metrics.counts.goal_created).toBe(2)
    expect(metrics.deliveryReachRate).toBeCloseTo(0.5)
    expect(metrics.interruptionRate).toBeCloseTo(0.5)
    expect(metrics.recoveryRate).toBeCloseTo(1)
    expect(metrics.acceptanceRate).toBeCloseTo(1)
  })

  test("分母为 0 时比率安全返回 0，不产生 NaN", () => {
    const metrics = computeMetrics([])
    expect(metrics.deliveryReachRate).toBe(0)
    expect(metrics.interruptionRate).toBe(0)
    expect(productEventTypes.every((type) => metrics.counts[type] === 0)).toBe(true)
  })

  test("可按版本、场景和批准模式比较同一口径", () => {
    const events = [
      event("goal_created", { version: "1.0.0", scenario: "goal", props: { approvalMode: "balanced" } }),
      event("delivery_viewed", { version: "1.0.0", scenario: "delivery", props: { approvalMode: "balanced" } }),
      event("goal_created", { version: "2.0.0", scenario: "goal", props: { approvalMode: "strict" } }),
    ]
    const breakdowns = computeMetricBreakdowns(events)
    expect(breakdowns.byVersion.map(item => item.key)).toEqual(["1.0.0", "2.0.0"])
    expect(breakdowns.byScenario.map(item => item.key)).toEqual(["goal", "delivery"])
    expect(breakdowns.byApprovalMode.find(item => item.key === "balanced")?.metrics.deliveryReachRate).toBe(1)
  })
})

describe("opt-in 同意状态", () => {
  test("未决定默认关闭远程上报", () => {
    expect(parseConsent(null)).toEqual({ enabled: false })
    expect(shouldReportRemote(parseConsent(null))).toBe(false)
  })

  test("显式加入后才允许远程上报，序列化可回读", () => {
    const consent = { enabled: true, decidedAt: "2026-07-01T00:00:00.000Z" }
    expect(parseConsent(serializeConsent(consent))).toEqual(consent)
    expect(shouldReportRemote(consent)).toBe(true)
  })

  test("损坏或非法存储回退为关闭", () => {
    expect(parseConsent("{ not json")).toEqual({ enabled: false })
    expect(parseConsent(JSON.stringify({ enabled: "yes" }))).toEqual({ enabled: false })
  })
})
