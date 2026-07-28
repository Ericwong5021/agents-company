import { describe, expect, test } from "bun:test"
import type { GoalBrief } from "@agents-company/shared/experience"
import {
  classifyOpenQuestions,
  disposeOpenQuestion,
  gatedActionKinds,
  requiresExplicitGate,
  resolveStartDecision,
} from "../modules/agent-company/runtime/shared/goal-brief-clarification"

// GOAL-04 — 重大歧义澄清与批准策略。
// 系统只在答案会显著改变结果、成本、权限或风险时打断用户；低风险可逆事项采用默认假设并留痕。

function question(overrides: Partial<GoalBrief["openQuestions"][number]> = {}): GoalBrief["openQuestions"][number] {
  return {
    id: "q1",
    question: "预算范围？",
    impact: "影响投放规模",
    blocking: false,
    defaultAssumption: "按中等预算规划",
    ...overrides,
  }
}

function makeBrief(overrides: Partial<GoalBrief> = {}): GoalBrief {
  return {
    id: "goalBrief_1",
    version: 1,
    source: "system_suggestion",
    createdAt: "2026-07-28T00:00:00.000Z",
    goal: "交付季度增长分析",
    deliverables: [{ id: "d1", title: "报告", description: "含结论" }],
    acceptanceCriteria: [{ id: "a1", description: "可追溯", verification: "核对来源" }],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    riskLevel: "low",
    recommendedPlan: { summary: "先清洗再分析", steps: [{ id: "s1", title: "清洗", outcome: "规范明细" }] },
    approvalMode: "balanced",
    sourceRefs: [{ kind: "goal_request", id: "req1" }],
    ...overrides,
  } as GoalBrief
}

describe("GOAL-04 开放问题材料性分类", () => {
  test("阻塞问题必须询问用户", () => {
    expect(disposeOpenQuestion(question({ blocking: true }), "low")).toMatchObject({ kind: "ask", reason: "blocking" })
  })

  test("高风险目标下非阻塞问题也需询问", () => {
    expect(disposeOpenQuestion(question({ blocking: false }), "high")).toMatchObject({
      kind: "ask",
      reason: "high_risk",
    })
    expect(disposeOpenQuestion(question({ blocking: false }), "critical")).toMatchObject({ kind: "ask" })
  })

  test("低风险可逆非阻塞问题采用默认假设，不打断用户", () => {
    const disposition = disposeOpenQuestion(question({ blocking: false }), "low")
    expect(disposition.kind).toBe("auto_adopt")
    if (disposition.kind === "auto_adopt") expect(disposition.defaultAssumption).toBe("按中等预算规划")
  })

  test("classifyOpenQuestions 把问题分到 ask 与 autoAdopted", () => {
    const classified = classifyOpenQuestions(
      makeBrief({
        riskLevel: "low",
        openQuestions: [
          question({ id: "q-block", blocking: true }),
          question({ id: "q-auto", blocking: false }),
        ],
      }),
    )
    expect(classified.ask.map((item) => item.question.id)).toEqual(["q-block"])
    expect(classified.autoAdopted.map((item) => item.question.id)).toEqual(["q-auto"])
  })
})

describe("GOAL-04 批准模式启动决策", () => {
  test("自主模式且无材料性问题时自动开始", () => {
    expect(resolveStartDecision(makeBrief({ approvalMode: "autonomous" }))).toEqual({
      start: true,
      reason: "autonomous_start",
    })
  })

  test("平衡模式展示 Brief 等待调整，不自动开始", () => {
    expect(resolveStartDecision(makeBrief({ approvalMode: "balanced" }))).toEqual({
      start: false,
      reason: "await_review",
    })
  })

  test("严格模式明确等待用户开始", () => {
    expect(resolveStartDecision(makeBrief({ approvalMode: "strict" }))).toEqual({
      start: false,
      reason: "await_user",
    })
  })

  test("仍有材料性问题时任何模式都不自动开始", () => {
    expect(
      resolveStartDecision(
        makeBrief({ approvalMode: "autonomous", openQuestions: [question({ blocking: true })] }),
      ),
    ).toEqual({ start: false, reason: "material_questions" })
  })
})

describe("GOAL-04 高风险动作显式 Gate", () => {
  test("外部写入/发布/删除/支付无论模式都必须 Gate", () => {
    for (const kind of gatedActionKinds) expect(requiresExplicitGate(kind)).toBe(true)
  })

  test("普通只读或本地动作不强制 Gate", () => {
    expect(requiresExplicitGate("read")).toBe(false)
    expect(requiresExplicitGate("workspace_write")).toBe(false)
  })
})
