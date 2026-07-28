import type { DeliverySummary, GoalBriefAcceptanceCriterion } from "@agents-company/shared/experience"

// DELIV-05 — Delivery Package 与用户验收状态的展示层纯逻辑。
// 明确区分 Delivered 与 Accepted，并把最初的验收标准如实呈现给用户判断。
// 诚实边界：后端 DeliverySummary 契约当前只下发整体 acceptanceState，
// 不含逐项 pass/fail/partial 状态、Reviewer 发现、已知限制与使用说明；
// 这些字段一律标记为“尚未逐项核对”，绝不伪造通过或替后端下结论。

export type AcceptanceState = DeliverySummary["acceptanceState"]

export const acceptanceStateLabels: Record<AcceptanceState, string> = {
  pending: "待验收",
  accepted: "已验收",
  revision_requested: "已请求修改",
}

export type DeliveryStage = "delivered" | "accepted" | "revision"

export function deliveryStage(state: AcceptanceState): DeliveryStage {
  if (state === "accepted") return "accepted"
  if (state === "revision_requested") return "revision"
  return "delivered"
}

// 交付完整性：契约已强制至少一个真实成果；无成果时不允许呈现为“已交付”。
export function hasConsumableOutput(delivery: Pick<DeliverySummary, "artifacts">) {
  return delivery.artifacts.length > 0
}

// 逐项验收状态：后端未下发核对结论，一律标 unverified，UI 需明示“未逐项核对”。
export type CriterionVerdict = "pass" | "fail" | "partial" | "not_applicable" | "unverified"

export const criterionVerdictLabels: Record<CriterionVerdict, string> = {
  pass: "已满足",
  fail: "未满足",
  partial: "部分满足",
  not_applicable: "不适用",
  unverified: "未逐项核对",
}

export type AcceptanceChecklistItem = {
  id: string
  description: string
  verification: string
  verdict: CriterionVerdict
}

// 用最初 Goal Brief 的验收标准构建核对清单；verdict 恒为 unverified（后端缺口）。
export function acceptanceChecklist(criteria: GoalBriefAcceptanceCriterion[]): AcceptanceChecklistItem[] {
  return criteria.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    verification: criterion.verification,
    verdict: "unverified",
  }))
}

export type DeliveryPackageView = {
  version: number
  stage: DeliveryStage
  stateLabel: string
  artifactCount: number
  hasOutput: boolean
  // 是否已具备用户可执行的验收决策入口（交付且非已验收态）。
  awaitingUserDecision: boolean
}

// 汇总 Delivery Package 顶层视图；不含未由后端下发的证据/限制/说明字段。
export function deliveryPackageView(delivery: DeliverySummary): DeliveryPackageView {
  const stage = deliveryStage(delivery.acceptanceState)
  return {
    version: delivery.version,
    stage,
    stateLabel: acceptanceStateLabels[delivery.acceptanceState],
    artifactCount: delivery.artifacts.length,
    hasOutput: hasConsumableOutput(delivery),
    awaitingUserDecision: stage === "delivered",
  }
}
