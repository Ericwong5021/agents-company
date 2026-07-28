import type {
  GoalBrief as GoalBriefValue,
  GoalBriefOpenQuestion as GoalBriefOpenQuestionValue,
} from "@agents-company/shared/experience"

// GOAL-04 — 重大歧义澄清与批准策略（纯函数、无副作用、可单测）。
//
// 材料性原则：系统只在答案会显著改变结果、成本、权限或风险时打断用户。
// - 阻塞问题（blocking）必须由用户回答。
// - 高/严重风险目标下的开放问题也需用户确认。
// - 其余低风险可逆问题由系统采用其默认假设并记录，不逐项打断用户。

export type OpenQuestionDisposition =
  | { kind: "ask"; reason: "blocking" | "high_risk"; question: GoalBriefOpenQuestionValue }
  | { kind: "auto_adopt"; question: GoalBriefOpenQuestionValue; defaultAssumption: string }

const highRiskLevels = new Set<GoalBriefValue["riskLevel"]>(["high", "critical"])

// 单个开放问题的处置：打断询问，或采用默认假设。
export function disposeOpenQuestion(
  question: GoalBriefOpenQuestionValue,
  riskLevel: GoalBriefValue["riskLevel"],
): OpenQuestionDisposition {
  if (question.blocking) return { kind: "ask", reason: "blocking", question }
  if (highRiskLevels.has(riskLevel)) return { kind: "ask", reason: "high_risk", question }
  return { kind: "auto_adopt", question, defaultAssumption: question.defaultAssumption }
}

// 把 Brief 的开放问题划分为“需要用户决定”与“系统已采用默认假设”两组。
export function classifyOpenQuestions(brief: GoalBriefValue) {
  const dispositions = brief.openQuestions.map((question) => disposeOpenQuestion(question, brief.riskLevel))
  return {
    dispositions,
    ask: dispositions.filter((item): item is Extract<OpenQuestionDisposition, { kind: "ask" }> => item.kind === "ask"),
    autoAdopted: dispositions.filter(
      (item): item is Extract<OpenQuestionDisposition, { kind: "auto_adopt" }> => item.kind === "auto_adopt",
    ),
  }
}

export type StartReason = "material_questions" | "autonomous_start" | "await_review" | "await_user"

// 三种批准模式 + 材料性 → 启动决策。
// 只要还有需要用户决定的材料性问题，任何模式都不自动开始。
// 自主模式在无材料性问题时自动开始；平衡模式展示 Brief 等待短暂调整；严格模式明确等待用户开始。
export function resolveStartDecision(brief: GoalBriefValue): { start: boolean; reason: StartReason } {
  if (classifyOpenQuestions(brief).ask.length > 0) return { start: false, reason: "material_questions" }
  if (brief.approvalMode === "autonomous") return { start: true, reason: "autonomous_start" }
  if (brief.approvalMode === "balanced") return { start: false, reason: "await_review" }
  return { start: false, reason: "await_user" }
}

// 高风险动作分类：无论批准模式如何，这些动作都必须走显式 Gate。
export const gatedActionKinds = ["external_write", "publish", "delete", "payment"] as const
export type GatedActionKind = (typeof gatedActionKinds)[number]

export function requiresExplicitGate(actionKind: string): boolean {
  return (gatedActionKinds as readonly string[]).includes(actionKind)
}
