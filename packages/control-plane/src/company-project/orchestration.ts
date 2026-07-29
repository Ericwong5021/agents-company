// TEAM-03: risk-driven orchestration. Organization complexity must match task
// risk instead of a fixed Worker + Independent Reviewer pipeline. This module
// is a pure rule layer: the planner model proposes facts, but the final
// verification strength is derived here so prompt changes can never bypass
// mandatory review or gates for high-risk work.

export const verificationStrengths = ["self_check", "auto_verify", "independent_review", "review_with_gate"] as const
export type VerificationStrength = (typeof verificationStrengths)[number]

export type OrchestrationInput = {
  work_type: "coding" | "decision" | "research" | "writing" | "design" | "analysis" | "knowledge_reading"
  declared_risk?: "low" | "medium" | "high"
  approval_preset: string
}

const riskRank = { low: 0, medium: 1, high: 2 } as const

// Rule-layer risk floor derived from verifiable side effects, not from the
// planner's label: coding writes the user's repository and ends in a merge to
// the main branch, so it stays high risk even when a model marks it low.
const riskFloor = (work_type: OrchestrationInput["work_type"]) => (work_type === "coding" ? "high" : "low")

const baseline = { low: "self_check", medium: "auto_verify", high: "independent_review" } as const

export function orchestrationPlan(input: OrchestrationInput) {
  const declared = input.declared_risk ?? (input.work_type === "coding" ? "high" : "medium")
  const floor = riskFloor(input.work_type)
  const risk_level = riskRank[declared] >= riskRank[floor] ? declared : floor
  // Coding merges are an external side effect on the primary repository: any
  // non-autonomous preset keeps the human merge gate, so review runs with a gate.
  const gate = risk_level === "high" && input.work_type === "coding" && input.approval_preset !== "autonomous"
  // A strict Brief raises verification strength by one level but never lowers
  // it; nothing can reduce high-risk work below independent review.
  const raised =
    input.approval_preset === "strict" && baseline[risk_level] !== "independent_review"
      ? verificationStrengths[verificationStrengths.indexOf(baseline[risk_level]) + 1]!
      : baseline[risk_level]
  const strength: VerificationStrength = gate ? "review_with_gate" : raised
  const reviewer = strength === "independent_review" || strength === "review_with_gate"
  const reasons = [
    declared === risk_level
      ? `任务申报风险为 ${declared}。`
      : `任务申报风险为 ${declared}，但 ${input.work_type} 会写入主仓库并合并主分支，规则层提升为 ${risk_level}。`,
    gate
      ? `高风险外部动作在“${input.approval_preset}”审批模式下必须经过独立复核和用户 Gate。`
      : reviewer
        ? "高价值结论需要未参与执行的独立 Reviewer 验收。"
        : strength === "auto_verify"
          ? "普通任务由 Work Type 结构化验证自动把关，不再无条件创建 Reviewer。"
          : "低风险可逆任务由单 Agent 执行并自检验收条件。",
    ...(input.approval_preset === "strict" && raised !== baseline[risk_level]
      ? [`“strict”审批模式将验证强度从 ${baseline[risk_level]} 提升到 ${raised}。`]
      : []),
  ]
  const alternatives = verificationStrengths
    .filter((candidate) => candidate !== strength)
    .map((candidate) =>
      verificationStrengths.indexOf(candidate) < verificationStrengths.indexOf(strength)
        ? `${candidate}：验证强度低于当前风险等级要求，被规则层拒绝。`
        : `${candidate}：允许，但会为该风险等级增加不必要的延迟与模型调用。`,
    )
  return { risk_level, strength, reviewer, gate, reasons, alternatives }
}
