import type { GoalBrief } from "@agents-company/shared/experience"
import { BoardProjectCharter } from "@/company-project/schema"

export function goalProjectTitle(goal: string) {
  const subject = goal
    .split(/[。；!?！？]/)
    .map((item) => item.trim())
    .find((item) => item.length >= 12) ?? goal.trim()
  return subject.length > 180 ? `${subject.slice(0, 176)}…` : subject
}

export function goalBriefCharter(brief: GoalBrief) {
  const confirmed = brief.assumptions
    .filter((assumption) => assumption.confirmed)
    .map((assumption) => `用户已确认：${assumption.description}`)
  const directionRequirements =
    brief.version > 1 && !brief.deliverables.some((item) => item.id.startsWith("current-direction-v"))
      ? {
          deliverable: `当前方向（优先于既有结构化交付项）：${brief.goal}`,
          acceptance: `最终交付必须完整满足当前方向：${brief.goal}；验证方式：逐项核对最终成果与当前方向的一致性`,
          constraint: "当前方向与既有结构化字段冲突时，以当前方向为准",
        }
      : undefined
  return BoardProjectCharter.parse({
    title: goalProjectTitle(brief.goal),
    value: `${brief.goal}\n${brief.recommendedPlan.summary}`,
    deliverables: [
      ...(directionRequirements ? [directionRequirements.deliverable] : []),
      ...brief.deliverables.map((item) => `${item.title}：${item.description}`),
    ],
    acceptance_criteria: [
      ...(directionRequirements ? [directionRequirements.acceptance] : []),
      ...brief.acceptanceCriteria.map((item) => `${item.description}；验证方式：${item.verification}`),
    ],
    scope: [...(directionRequirements ? [brief.goal] : []), ...brief.deliverables.map((item) => item.description)],
    non_goals: brief.nonGoals.length ? brief.nonGoals : ["不执行目标摘要与交付清单以外的工作"],
    constraints: [...(directionRequirements ? [directionRequirements.constraint] : []), ...brief.constraints, ...confirmed]
      .length
      ? [
          ...(directionRequirements ? [directionRequirements.constraint] : []),
          ...brief.constraints,
          ...confirmed,
        ]
      : ["遵守当前公司权限、数据与审批边界"],
    resources: [{ kind: "other", scope: "artifacts", disposition: "保留为项目成果" }],
    risks: ["high", "critical"].includes(brief.riskLevel)
      ? [{ description: `${brief.riskLevel} 风险目标`, mitigation: "严格遵守已确认约束并保留人工验收" }]
      : [],
    dri_agent_id: "board-product-lead",
    milestones: brief.recommendedPlan.steps.map((step) => `${step.title}：${step.outcome}`),
    open_decisions: [],
  })
}
