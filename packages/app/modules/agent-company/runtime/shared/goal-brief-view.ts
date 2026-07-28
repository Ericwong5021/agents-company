import {
  ExperienceApiError,
  GoalBrief,
  GoalBriefAppendRequest,
  GoalBriefDraft,
  type ExperienceApiError as ExperienceApiErrorValue,
  type GoalBrief as GoalBriefValue,
  type GoalBriefDraft as GoalBriefDraftValue,
  type GoalBriefSource,
} from "@agents-company/shared/experience"
import { classifyOpenQuestions, resolveStartDecision } from "./goal-brief-clarification"

// GOAL-03 — 以结果为中心的 Goal Brief 视图与局部编辑。
//
// 纯函数、无副作用、可单测。默认卡片只投影“用户在一屏内判断系统是否理解目标、
// 最终拿到什么、如何完成、需要决定什么”所需的五个字段；低频字段（约束、非目标、
// 假设、完整计划、来源引用）折叠进“完整 Brief”。局部编辑只重写受影响字段，
// 其余字段逐字沿用当前版本，避免把目标文本复制成多个字段。

export const approvalModeCopy = {
  autonomous: { label: "自主执行", autoStart: true, detail: "确认后立即开始，仅在高风险动作前暂停。" },
  balanced: { label: "先看 Brief", autoStart: false, detail: "展示目标摘要，允许你在开始前调整。" },
  strict: { label: "等待你开始", autoStart: false, detail: "在你明确开始前不会执行。" },
} as const

export const riskLevelCopy = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
} as const

// 默认卡片直接呈现的“结果导向”视图。低频字段不进入主区。
export function goalBriefView(brief: GoalBriefValue) {
  const mode = approvalModeCopy[brief.approvalMode]
  const blockingQuestions = brief.openQuestions.filter((question) => question.blocking)
  // GOAL-04：按材料性把开放问题分为“需要用户决定”与“系统已采用默认假设”。
  const classified = classifyOpenQuestions(brief)
  const startDecision = resolveStartDecision(brief)
  return {
    goal: brief.goal,
    deliverables: brief.deliverables,
    acceptanceCriteria: brief.acceptanceCriteria,
    plan: brief.recommendedPlan,
    openQuestions: brief.openQuestions,
    // 开放问题为空时不渲染无意义区块。
    hasOpenQuestions: brief.openQuestions.length > 0,
    hasBlockingQuestions: blockingQuestions.length > 0,
    // GOAL-04：只有材料性问题需要用户决定；其余问题的默认假设由系统采用并展示。
    materialQuestions: classified.ask.map((item) => ({ ...item.question, askReason: item.reason })),
    autoAdoptedAssumptions: classified.autoAdopted.map((item) => ({
      id: item.question.id,
      question: item.question.question,
      defaultAssumption: item.defaultAssumption,
    })),
    hasMaterialQuestions: classified.ask.length > 0,
    hasAutoAdoptedAssumptions: classified.autoAdopted.length > 0,
    approvalMode: brief.approvalMode,
    approvalLabel: mode.label,
    approvalDetail: mode.detail,
    // GOAL-04：启动决策综合批准模式与材料性问题；仍有需用户决定的问题时不自动开始。
    autoStart: startDecision.start,
    startReason: startDecision.reason,
    riskLevel: brief.riskLevel,
    riskLabel: riskLevelCopy[brief.riskLevel],
    // 折叠到“完整 Brief”的低频治理字段。
    fullBrief: {
      constraints: brief.constraints,
      nonGoals: brief.nonGoals,
      assumptions: brief.assumptions,
      planSteps: brief.recommendedPlan.steps,
      sourceRefs: brief.sourceRefs,
    },
    hasFullBriefDetail:
      brief.constraints.length > 0 ||
      brief.nonGoals.length > 0 ||
      brief.assumptions.length > 0,
  }
}

export type GoalBriefView = ReturnType<typeof goalBriefView>

// 用户可局部编辑的字段：目标、交付物、验收标准、约束。其余字段沿用当前版本。
// 复用 shared 的 GoalBriefDraft 校验，避免混用不同 zod 实例。
export const GoalBriefFieldEdit = GoalBriefDraft.pick({
  goal: true,
  deliverables: true,
  acceptanceCriteria: true,
  constraints: true,
}).partial()
export type GoalBriefFieldEdit = Partial<
  Pick<GoalBriefDraftValue, "goal" | "deliverables" | "acceptanceCriteria" | "constraints">
>

// 把局部编辑合并进当前 Brief，产出可提交的 append 请求。只重写受影响字段。
export function buildBriefAppendRequest(
  brief: GoalBriefValue,
  edit: GoalBriefFieldEdit,
  source: GoalBriefSource = "user_confirmation",
) {
  const patch = GoalBriefFieldEdit.parse(edit)
  return GoalBriefAppendRequest.parse({
    expectedVersion: brief.version,
    source,
    brief: {
      goal: patch.goal ?? brief.goal,
      deliverables: patch.deliverables ?? brief.deliverables,
      acceptanceCriteria: patch.acceptanceCriteria ?? brief.acceptanceCriteria,
      constraints: patch.constraints ?? brief.constraints,
      nonGoals: brief.nonGoals,
      assumptions: brief.assumptions,
      openQuestions: brief.openQuestions,
      riskLevel: brief.riskLevel,
      recommendedPlan: brief.recommendedPlan,
      approvalMode: brief.approvalMode,
      sourceRefs: brief.sourceRefs,
    },
  })
}

export type GoalBriefAppendResponse =
  | { kind: "success"; brief: GoalBriefValue }
  | { kind: "version_conflict"; currentVersion: number }
  | { kind: "not_found" }

export function parseGoalBriefAppendResponse(
  status: number,
  value: unknown,
): GoalBriefAppendResponse | undefined {
  if (status === 200) {
    const result = GoalBrief.safeParse(value)
    return result.success ? { kind: "success", brief: result.data } : undefined
  }
  if (status !== 404 && status !== 409) return
  const result = ExperienceApiError.safeParse(value)
  if (!result.success) return
  if (result.data.code === "not_found") return { kind: "not_found" }
  if (result.data.code === "version_conflict")
    return { kind: "version_conflict", currentVersion: result.data.currentVersion }
  return
}

export type GoalBriefAppendError = Extract<ExperienceApiErrorValue, { code: "not_found" | "version_conflict" }>
