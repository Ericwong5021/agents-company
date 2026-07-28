// TRUST-04 — 首次目标引导与显式 Demo Workspace（纯逻辑）。
// 引导阶段判定、本地引导状态的读写与转换、以及与真实数据完全隔离的演示场景，
// 均为可脱离 UI 单测的纯函数。演示数据是明确标注的脚本化示例，绝不经由真实快照接口。

import z from "zod"

export const onboardingStorageKey = "agent-company:onboarding:v1"

// unset：尚未选择 · real：连接真实工作区 · demo：查看演示 · skipped：已跳过引导（进入常规空状态）。
export type OnboardingMode = "unset" | "real" | "demo" | "skipped"

const OnboardingState = z
  .object({
    version: z.literal(1),
    mode: z.enum(["unset", "real", "demo", "skipped"]),
    firstGoalSubmitted: z.boolean(),
    updatedAt: z.string(),
  })
  .strict()

export type OnboardingState = z.infer<typeof OnboardingState>

export function defaultOnboardingState(): OnboardingState {
  return { version: 1, mode: "unset", firstGoalSubmitted: false, updatedAt: "" }
}

export function parseOnboardingState(value: string | null | undefined): OnboardingState {
  if (!value) return defaultOnboardingState()
  try {
    const parsed = OnboardingState.safeParse(JSON.parse(value) as unknown)
    if (parsed.success) return parsed.data
  } catch {}
  return defaultOnboardingState()
}

export function serializeOnboardingState(value: OnboardingState) {
  return JSON.stringify(OnboardingState.parse(value))
}

// 引导阶段：demo 全程独立于真实数据；welcome 仅在真实连接可用、尚未选择且工作区为空时出现；
// 其余（包括未连接、已有工作、已选择真实/跳过）都回到常规界面，交由既有连接状态与空状态处理。
export type OnboardingStage = "welcome" | "demo" | "normal"

export type OnboardingSnapshotView = {
  connected: boolean
  providerConfigured: boolean
  hasWork: boolean
}

export function onboardingStage(state: OnboardingState, view: OnboardingSnapshotView): OnboardingStage {
  if (state.mode === "demo") return "demo"
  if (!view.connected) return "normal"
  if (state.mode === "unset" && !view.hasWork) return "welcome"
  return "normal"
}

// 首次真实路径：已选择真实且已连接、Provider 已配置、暂无工作、且尚未提交首个目标，
// 应把用户直接带到目标输入（而非功能菜单）。Provider 配置完成后据此跳转到 Inbox。
export function shouldEnterFirstGoal(state: OnboardingState, view: OnboardingSnapshotView): boolean {
  return (
    state.mode !== "demo" &&
    view.connected &&
    view.providerConfigured &&
    !view.hasWork &&
    !state.firstGoalSubmitted
  )
}

function withMode(state: OnboardingState, mode: OnboardingMode, now: string): OnboardingState {
  return { ...state, mode, updatedAt: now }
}

export function chooseReal(state: OnboardingState, now: string) {
  return withMode(state, "real", now)
}

export function chooseDemo(state: OnboardingState, now: string) {
  return withMode(state, "demo", now)
}

export function skipOnboarding(state: OnboardingState, now: string) {
  return withMode(state, "skipped", now)
}

// 退出演示后进入常规界面，不再重复弹出欢迎选择。
export function exitDemo(state: OnboardingState, now: string) {
  return withMode(state, "skipped", now)
}

// 重新开始引导 / 删除本地演示与引导标记：回到初始未选择状态。
export function restartOnboarding(): OnboardingState {
  return defaultOnboardingState()
}

export function markFirstGoalSubmitted(state: OnboardingState, now: string): OnboardingState {
  return { ...state, firstGoalSubmitted: true, updatedAt: now }
}

// 与真实数据完全隔离的演示场景：脚本化、明确标注为示例，不来自任何网络请求，
// 也不写入真实数据库、Provider 或项目。仅用于让新用户理解产品形态。
export type DemoEmployee = {
  id: string
  name: string
  role: string
  presence: "online" | "busy" | "offline"
  focus: string
}

export type DemoWorkItem = {
  id: string
  title: string
  status: string
  progress: number
  owner: string
  latestUpdate: string
}

export type DemoArtifact = {
  id: string
  title: string
  kind: string
  summary: string
}

export type DemoScenario = {
  companyName: string
  goal: string
  note: string
  employees: DemoEmployee[]
  work: DemoWorkItem[]
  artifacts: DemoArtifact[]
}

export function demoScenario(): DemoScenario {
  return {
    companyName: "演示公司（示例）",
    goal: "把一批本地调研材料整理成结论可追溯的报告。",
    note: "以下全部为演示数据，不连接真实模型、项目或数据库。",
    employees: [
      { id: "demo-emp-lead", name: "示例·协调者", role: "组织协调", presence: "online", focus: "拆解目标并分配负责人" },
      { id: "demo-emp-research", name: "示例·研究员", role: "资料研究", presence: "busy", focus: "归纳来源要点与冲突" },
      { id: "demo-emp-writer", name: "示例·撰稿", role: "报告撰写", presence: "online", focus: "把结论写成可复核的段落" },
    ],
    work: [
      {
        id: "demo-work-report",
        title: "整理调研材料并产出报告",
        status: "进行中",
        progress: 62,
        owner: "示例·研究员",
        latestUpdate: "已完成来源去重，正在核对三处相互冲突的数据。",
      },
    ],
    artifacts: [
      {
        id: "demo-artifact-outline",
        title: "报告结构草稿",
        kind: "文档",
        summary: "示例产出：背景、方法、发现、结论四段结构，每条结论标注来源。",
      },
    ],
  }
}
