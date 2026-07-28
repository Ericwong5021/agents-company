import { describe, expect, test } from "bun:test"
import type { GoalBrief } from "@agents-company/shared/experience"
import {
  buildBriefAppendRequest,
  goalBriefView,
  parseGoalBriefAppendResponse,
} from "../modules/agent-company/runtime/shared/goal-brief-view"

function makeBrief(overrides: Partial<GoalBrief> = {}): GoalBrief {
  return {
    id: "goalBrief_1",
    version: 3,
    source: "system_suggestion",
    createdAt: "2026-07-28T00:00:00.000Z",
    goal: "交付一份可验证的季度增长分析",
    deliverables: [
      { id: "d1", title: "分析报告", description: "含结论与来源" },
      { id: "d2", title: "数据表", description: "清洗后的明细" },
    ],
    acceptanceCriteria: [{ id: "a1", description: "结论可追溯", verification: "逐项核对来源" }],
    constraints: ["不产生外部写入"],
    nonGoals: ["不做实时看板"],
    assumptions: [{ id: "as1", description: "数据来自本地导入", confirmed: false }],
    openQuestions: [],
    riskLevel: "medium",
    recommendedPlan: {
      summary: "先清洗数据，再产出分析",
      steps: [{ id: "s1", title: "清洗数据", outcome: "得到规范明细" }],
    },
    approvalMode: "balanced",
    sourceRefs: [{ kind: "goal_request", id: "req1" }],
    ...overrides,
  } as GoalBrief
}

describe("GOAL-03 goalBriefView projection", () => {
  test("投影结果导向的五个默认字段", () => {
    const view = goalBriefView(makeBrief())
    expect(view.goal).toBe("交付一份可验证的季度增长分析")
    expect(view.deliverables).toHaveLength(2)
    expect(view.acceptanceCriteria).toHaveLength(1)
    expect(view.plan.summary).toBe("先清洗数据，再产出分析")
    expect(view.riskLabel).toBe("中")
  })

  test("开放问题为空时不渲染区块", () => {
    expect(goalBriefView(makeBrief()).hasOpenQuestions).toBe(false)
    const withQuestions = goalBriefView(
      makeBrief({ openQuestions: [{ id: "q1", question: "预算范围？", impact: "影响投放规模", blocking: false, defaultAssumption: "按中等预算规划" }] }),
    )
    expect(withQuestions.hasOpenQuestions).toBe(true)
    expect(withQuestions.hasBlockingQuestions).toBe(false)
  })

  test("仅自主模式且无阻塞问题才自动开始", () => {
    expect(goalBriefView(makeBrief({ approvalMode: "autonomous" })).autoStart).toBe(true)
    expect(goalBriefView(makeBrief({ approvalMode: "strict" })).autoStart).toBe(false)
    expect(goalBriefView(makeBrief({ approvalMode: "balanced" })).autoStart).toBe(false)
    const blocked = goalBriefView(
      makeBrief({
        approvalMode: "autonomous",
        openQuestions: [{ id: "q1", question: "是否允许付费投放？", impact: "决定成本", blocking: true, defaultAssumption: "默认不付费投放" }],
      }),
    )
    expect(blocked.autoStart).toBe(false)
    expect(blocked.hasBlockingQuestions).toBe(true)
  })

  test("完整 Brief 折叠低频治理字段", () => {
    expect(goalBriefView(makeBrief()).hasFullBriefDetail).toBe(true)
    const bare = goalBriefView(makeBrief({ constraints: [], nonGoals: [], assumptions: [] }))
    expect(bare.hasFullBriefDetail).toBe(false)
  })
})

describe("GOAL-03 局部编辑合并", () => {
  test("只重写受影响字段，其余逐字沿用当前版本", () => {
    const brief = makeBrief()
    const request = buildBriefAppendRequest(brief, { goal: "交付一份可验证的年度增长分析" })
    expect(request.expectedVersion).toBe(3)
    expect(request.source).toBe("user_confirmation")
    expect(request.brief.goal).toBe("交付一份可验证的年度增长分析")
    // 未编辑字段保持不变。
    expect(request.brief.deliverables).toEqual(brief.deliverables)
    expect(request.brief.acceptanceCriteria).toEqual(brief.acceptanceCriteria)
    expect(request.brief.constraints).toEqual(brief.constraints)
    expect(request.brief.recommendedPlan).toEqual(brief.recommendedPlan)
  })

  test("可局部修改交付物与约束", () => {
    const brief = makeBrief()
    const request = buildBriefAppendRequest(brief, {
      deliverables: [{ id: "d1", title: "分析报告", description: "含结论、来源与建议" }],
      constraints: ["不产生外部写入", "只使用本地数据"],
    })
    expect(request.brief.deliverables).toHaveLength(1)
    expect(request.brief.constraints).toEqual(["不产生外部写入", "只使用本地数据"])
    // 目标未变。
    expect(request.brief.goal).toBe(brief.goal)
  })

  test("空编辑仍产出合法请求（全部沿用）", () => {
    const brief = makeBrief()
    const request = buildBriefAppendRequest(brief, {})
    expect(request.brief.goal).toBe(brief.goal)
    expect(request.brief.deliverables).toEqual(brief.deliverables)
  })

  test("非法编辑（清空交付物）确定性抛错，不静默提交", () => {
    expect(() => buildBriefAppendRequest(makeBrief(), { deliverables: [] })).toThrow()
  })
})

describe("GOAL-03 append 响应解析", () => {
  test("200 返回新版本 Brief", () => {
    const brief = makeBrief({ version: 4 })
    expect(parseGoalBriefAppendResponse(200, brief)).toEqual({ kind: "success", brief })
  })

  test("409 版本冲突携带当前版本", () => {
    expect(
      parseGoalBriefAppendResponse(409, {
        code: "version_conflict",
        message: "Goal Brief was updated by another writer",
        currentVersion: 5,
      }),
    ).toEqual({ kind: "version_conflict", currentVersion: 5 })
  })

  test("404 未找到", () => {
    expect(parseGoalBriefAppendResponse(404, { code: "not_found", message: "Goal Brief not found" })).toEqual({
      kind: "not_found",
    })
  })

  test("无法识别的响应返回 undefined", () => {
    expect(parseGoalBriefAppendResponse(200, { nope: true })).toBeUndefined()
    expect(parseGoalBriefAppendResponse(500, {})).toBeUndefined()
  })
})
