import { describe, expect, test } from "bun:test"
import {
  goalDraftRequest,
  isCurrentGoalDraftRequest,
  parseGoalBriefGenerationResponse,
  parseGoalDraftStorage,
  serializeGoalDraftStorage,
} from "../modules/agent-company/runtime/shared/goal-brief-generation"

const brief = {
  id: "brief-local",
  version: 1,
  source: "system_suggestion",
  createdAt: "2026-07-26T00:00:00.000Z",
  goal: "形成一份可验证的本地研究摘要",
  deliverables: [{ id: "delivery-1", title: "研究摘要", description: "包含结论与来源" }],
  acceptanceCriteria: [
    { id: "criterion-1", description: "结论可追溯", verification: "逐项检查来源" },
  ],
  constraints: ["不创建项目"],
  nonGoals: ["不启动执行"],
  assumptions: [],
  openQuestions: [],
  riskLevel: "low",
  recommendedPlan: {
    summary: "先整理目标，再确认是否正式提交",
    steps: [{ id: "step-1", title: "整理目标", outcome: "形成只读摘要" }],
  },
  approvalMode: "balanced",
  sourceRefs: [{ kind: "goal_request", id: "request-local" }],
}

describe("Goal Brief generation response", () => {
  test("restores only a requestId bound to the exact persisted goal", () => {
    const stored = {
      version: 1 as const,
      draft: "形成可验证报告",
      request: {
        goal: "形成可验证报告",
        requestId: "request-1",
      },
    }
    expect(parseGoalDraftStorage(serializeGoalDraftStorage(stored))).toEqual(stored)
    expect(parseGoalDraftStorage(JSON.stringify({
      ...stored,
      draft: "另一个目标",
    }))).toEqual({ version: 1, draft: "另一个目标", request: null })
    expect(parseGoalDraftStorage("{")).toEqual({ version: 1, draft: "", request: null })
  })

  test("reuses one requestId for retry and rejects a stale response after editing", () => {
    const current = { goal: "形成可验证报告", requestId: "request-1" }
    expect(goalDraftRequest(" 形成可验证报告 ", current, () => "request-2")).toEqual(current)
    expect(goalDraftRequest("形成另一份报告", current, () => "request-2")).toEqual({
      goal: "形成另一份报告",
      requestId: "request-2",
    })
    expect(isCurrentGoalDraftRequest("形成可验证报告", current, current)).toBe(true)
    expect(isCurrentGoalDraftRequest("已编辑的目标", null, current)).toBe(false)
  })

  test("accepts only an unbound Goal Brief success", () => {
    expect(parseGoalBriefGenerationResponse(200, brief)).toEqual({
      kind: "success",
      brief,
    })
    expect(
      parseGoalBriefGenerationResponse(200, {
        ...brief,
        projectId: "project-unexpected",
      }),
    ).toBeUndefined()
  })

  test("preserves structured failure and generation conflicts by status", () => {
    expect(
      parseGoalBriefGenerationResponse(422, {
        code: "goal_brief_structured_output_failed",
        message: "无法形成完整结构",
        attempts: 3,
        recoveryActions: ["retry", "manual_edit"],
      }),
    ).toMatchObject({ kind: "structured_failure" })
    expect(
      parseGoalBriefGenerationResponse(409, {
        code: "request_conflict",
        message: "requestId 已用于不同目标",
      }),
    ).toEqual({
      kind: "conflict",
      error: {
        code: "request_conflict",
        message: "requestId 已用于不同目标",
      },
    })
    expect(parseGoalBriefGenerationResponse(409, {
      code: "not_found",
      message: "错误类型不匹配",
    })).toBeUndefined()
  })
})
