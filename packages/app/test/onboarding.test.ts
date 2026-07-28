import { describe, expect, test } from "bun:test"
import {
  chooseDemo,
  chooseReal,
  defaultOnboardingState,
  demoScenario,
  exitDemo,
  markFirstGoalSubmitted,
  onboardingStage,
  parseOnboardingState,
  restartOnboarding,
  serializeOnboardingState,
  shouldEnterFirstGoal,
  skipOnboarding,
  type OnboardingState,
} from "../modules/agent-company/runtime/shared/onboarding"

// TRUST-04 — 引导状态读写、阶段判定与演示场景隔离的纯逻辑。

const now = "2026-07-28T00:00:00.000Z"
const connectedEmpty = { connected: true, providerConfigured: true, hasWork: false }

describe("TRUST-04 引导状态读写", () => {
  test("空值与非法值回退到未选择初始状态", () => {
    expect(parseOnboardingState(null)).toEqual(defaultOnboardingState())
    expect(parseOnboardingState("not json")).toEqual(defaultOnboardingState())
    expect(parseOnboardingState(JSON.stringify({ mode: "bogus" }))).toEqual(defaultOnboardingState())
  })

  test("序列化后可原样解析", () => {
    const state = chooseDemo(defaultOnboardingState(), now)
    expect(parseOnboardingState(serializeOnboardingState(state))).toEqual(state)
  })
})

describe("TRUST-04 阶段判定", () => {
  test("未连接时不弹出欢迎，交回常规界面", () => {
    expect(onboardingStage(defaultOnboardingState(), { connected: false, providerConfigured: false, hasWork: false }))
      .toBe("normal")
  })

  test("已连接、未选择且工作区为空时展示欢迎选择", () => {
    expect(onboardingStage(defaultOnboardingState(), connectedEmpty)).toBe("welcome")
  })

  test("已有工作时不再展示欢迎", () => {
    expect(onboardingStage(defaultOnboardingState(), { ...connectedEmpty, hasWork: true })).toBe("normal")
  })

  test("demo 模式始终进入演示，且独立于连接状态", () => {
    const demo = chooseDemo(defaultOnboardingState(), now)
    expect(onboardingStage(demo, { connected: false, providerConfigured: false, hasWork: false })).toBe("demo")
  })

  test("选择真实或跳过后进入常规界面", () => {
    expect(onboardingStage(chooseReal(defaultOnboardingState(), now), connectedEmpty)).toBe("normal")
    expect(onboardingStage(skipOnboarding(defaultOnboardingState(), now), connectedEmpty)).toBe("normal")
  })
})

describe("TRUST-04 首次真实路径", () => {
  test("真实、已连接、Provider 就绪、无工作且未提交首个目标时进入目标输入", () => {
    expect(shouldEnterFirstGoal(chooseReal(defaultOnboardingState(), now), connectedEmpty)).toBe(true)
  })

  test("Provider 未就绪不进入目标输入", () => {
    expect(shouldEnterFirstGoal(chooseReal(defaultOnboardingState(), now), { ...connectedEmpty, providerConfigured: false }))
      .toBe(false)
  })

  test("已提交首个目标后不再重复引导", () => {
    const state = markFirstGoalSubmitted(chooseReal(defaultOnboardingState(), now), now)
    expect(shouldEnterFirstGoal(state, connectedEmpty)).toBe(false)
  })

  test("demo 模式不触发真实首个目标路径", () => {
    expect(shouldEnterFirstGoal(chooseDemo(defaultOnboardingState(), now), connectedEmpty)).toBe(false)
  })
})

describe("TRUST-04 状态转换", () => {
  test("退出演示进入已跳过，重新开始引导回到未选择", () => {
    const state: OnboardingState = chooseDemo(defaultOnboardingState(), now)
    expect(exitDemo(state, now).mode).toBe("skipped")
    expect(restartOnboarding()).toEqual(defaultOnboardingState())
  })
})

describe("TRUST-04 演示场景隔离", () => {
  test("演示数据明确标注为示例且带隔离说明", () => {
    const scenario = demoScenario()
    expect(scenario.note).toContain("演示")
    expect(scenario.companyName).toContain("示例")
    expect(scenario.employees.length).toBeGreaterThan(0)
    expect(scenario.employees.every((employee) => employee.id.startsWith("demo-"))).toBe(true)
    expect(scenario.work.every((item) => item.id.startsWith("demo-"))).toBe(true)
    expect(scenario.artifacts.every((artifact) => artifact.id.startsWith("demo-"))).toBe(true)
  })
})
