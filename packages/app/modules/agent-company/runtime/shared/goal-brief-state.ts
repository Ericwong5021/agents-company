import { GoalBriefStructuredFailure } from "@agents-company/shared/experience"

export type GoalBriefFailureView = {
  title: string
  detail: string
  actions: {
    id: "retry" | "manual_edit"
    label: string
  }[]
}

export function parseGoalBriefFailure(value: unknown): GoalBriefFailureView | undefined {
  const result = GoalBriefStructuredFailure.safeParse(value)
  if (!result.success) return
  return {
    title: "目标摘要未能生成",
    detail: `本地服务尝试 ${result.data.attempts} 次后，仍未形成可验证的结构化目标摘要。`,
    actions: result.data.recoveryActions.map((id) => ({
      id,
      label: id === "retry" ? "重试" : "手动修正",
    })),
  }
}
