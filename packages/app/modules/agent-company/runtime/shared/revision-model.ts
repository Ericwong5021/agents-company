// DELIV-06 — 基于验收标准的返工闭环展示层纯逻辑。
// 统一但可区分 Reviewer 退回与用户请求修改的返工来源，并约束交付-返工状态机的合法流转。
// 诚实边界：
//   1) 请求修改 / 接受交付等属变更类动作，R0 契约下 (ExperienceR0ImplementedMutationActions=[]) 恒为 disabled；
//      本模块只提供“合法流转判定 + 展示模型”，不代表这些动作已可执行。
//   2) 版本差异需要后端下发多版本 Artifact 列表，ExperienceArtifactView 契约当前无版本历史字段，故 diff 不虚构。

export type RevisionOrigin = "user_request_change" | "reviewer_reject"

export const revisionOriginLabels: Record<RevisionOrigin, string> = {
  user_request_change: "用户请求修改",
  reviewer_reject: "复核退回",
}

// 交付-返工生命周期状态（对应计划中的 Delivered → Revision → Reviewing → Delivered → Accepted）。
export type DeliveryLifecycleState = "delivered" | "revision" | "reviewing" | "accepted"

export const deliveryLifecycleLabels: Record<DeliveryLifecycleState, string> = {
  delivered: "已交付",
  revision: "返工中",
  reviewing: "复核中",
  accepted: "已验收",
}

const transitions: Record<DeliveryLifecycleState, DeliveryLifecycleState[]> = {
  delivered: ["revision", "accepted"],
  revision: ["reviewing"],
  reviewing: ["delivered"],
  accepted: [],
}

export function nextStatesFor(state: DeliveryLifecycleState) {
  return transitions[state]
}

export function canTransition(from: DeliveryLifecycleState, to: DeliveryLifecycleState) {
  return transitions[from].includes(to)
}

// 一条返工请求：关联到具体验收标准 / Artifact / 问题，保留来源与范围，不覆盖原始交付。
export type RevisionRequest = {
  origin: RevisionOrigin
  // 关联的验收标准或 Artifact / 问题标识；至少关联一项，避免“泛泛返工”。
  targetRefs: string[]
  note: string
}

// 返工请求有效性：必须关联至少一个具体目标且带说明，否则不构成可追溯的返工范围。
export function isActionableRevision(request: Pick<RevisionRequest, "targetRefs" | "note">) {
  return request.targetRefs.length > 0 && request.note.trim().length > 0
}

// 版本演进展示项：解决的问题 / 仍存在的限制 / 新增风险；均来自后端下发，前端不推断。
export type RevisionDeltaView = {
  fromVersion: number
  toVersion: number
  resolved: string[]
  remainingLimitations: string[]
  newRisks: string[]
}

// 是否具备可展示的版本差异：需要前后版本号且至少有一类变化条目，否则不呈现空 diff。
export function hasDisplayableDelta(delta: RevisionDeltaView) {
  return (
    delta.toVersion > delta.fromVersion &&
    delta.resolved.length + delta.remainingLimitations.length + delta.newRisks.length > 0
  )
}
