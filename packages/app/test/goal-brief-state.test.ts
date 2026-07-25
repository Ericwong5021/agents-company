import { describe, expect, test } from "bun:test"
import { parseGoalBriefFailure } from "../modules/agent-company/runtime/shared/goal-brief-state"

describe("Goal Brief failure state", () => {
  test("maps a strict structured failure to bounded recovery actions", () => {
    expect(parseGoalBriefFailure({
      code: "goal_brief_structured_output_failed",
      message: "The model response did not match the schema.",
      attempts: 3,
      recoveryActions: ["retry", "manual_edit"],
    })).toEqual({
      title: "目标摘要未能生成",
      detail: "本地服务尝试 3 次后，仍未形成可验证的结构化目标摘要。",
      actions: [
        {
          id: "retry",
          label: "重试",
        },
        {
          id: "manual_edit",
          label: "手动修正",
        },
      ],
    })
  })

  test("rejects incomplete or reordered recovery contracts", () => {
    expect(parseGoalBriefFailure({
      code: "goal_brief_structured_output_failed",
      message: "Invalid",
      attempts: 0,
      recoveryActions: ["retry", "manual_edit"],
    })).toBeUndefined()
    expect(parseGoalBriefFailure({
      code: "goal_brief_structured_output_failed",
      message: "Invalid",
      attempts: 1,
      recoveryActions: ["manual_edit", "retry"],
    })).toBeUndefined()
  })
})
