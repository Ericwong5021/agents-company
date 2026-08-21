import { describe, expect, test } from "bun:test"
import {
  classifyMessage,
  classifyMessages,
  hasThreads,
  isInternalNoise,
} from "../modules/agent-company/runtime/shared/work-messages"
import type { CompanyMessage } from "../modules/agent-company/runtime/shared/company-contract"

// WORK-03 — 主会话降噪：高信号 / Thread / Diagnostics 归类的纯逻辑。

function message(overrides: Partial<CompanyMessage>): CompanyMessage {
  return {
    id: "m-1",
    sequence: 1,
    author: "系统",
    authorID: "system",
    role: "system",
    body: "已完成里程碑",
    time: "10:00",
    kind: "system",
    messageKind: "text",
    mentions: [],
    resources: [],
    reactions: [],
    pollVotes: [],
    deliveries: [],
    ...overrides,
  }
}

describe("isInternalNoise", () => {
  test("识别 Bidding / 投影 / 竞标胜出 / 排队 / attempt 等内部状态", () => {
    expect(isInternalNoise("bidding started")).toBe(true)
    expect(isInternalNoise("projecting state")).toBe(true)
    expect(isInternalNoise("winner selected: agent-2")).toBe(true)
    expect(isInternalNoise("task queued")).toBe(true)
    expect(isInternalNoise("attempt 3 failed")).toBe(true)
    expect(isInternalNoise("tool_call read_file")).toBe(true)
  })

  test("不误伤业务文本", () => {
    expect(isInternalNoise("我们已完成登录页面的设计")).toBe(false)
    expect(isInternalNoise("目标已理解，开始规划")).toBe(false)
  })
})

describe("classifyMessage", () => {
  test("带 threadID 的消息进入 Thread", () => {
    expect(classifyMessage(message({ threadID: "t-1", body: "详细讨论方案" }))).toBe("thread")
  })

  test("非用户消息命中内部噪声进入 Diagnostics", () => {
    expect(classifyMessage(message({ kind: "agent", body: "bidding started" }))).toBe("diagnostics")
  })

  test("用户消息即使含噪声词也留在主会话高信号", () => {
    expect(classifyMessage(message({ kind: "user", body: "帮我看下 bidding 的问题" }))).toBe("high_signal")
  })

  test("目标理解/里程碑/交付等留在主会话高信号", () => {
    expect(classifyMessage(message({ body: "交付版本 v2 已就绪" }))).toBe("high_signal")
  })

  test("Thread 优先于噪声判定（带 threadID 的噪声也归 Thread）", () => {
    expect(classifyMessage(message({ kind: "agent", threadID: "t-9", body: "bidding" }))).toBe("thread")
  })
})

describe("classifyMessages", () => {
  const messages: CompanyMessage[] = [
    message({ id: "u-1", kind: "user", body: "帮我做一个落地页" }),
    message({ id: "s-1", body: "目标已理解" }),
    message({ id: "a-1", kind: "agent", body: "bidding started" }),
    message({ id: "t-1", kind: "agent", threadID: "th-1", body: "方案讨论 A" }),
    message({ id: "t-2", kind: "agent", threadID: "th-1", body: "方案讨论 B" }),
    message({ id: "t-3", kind: "agent", threadID: "th-2", body: "另一个讨论" }),
    message({ id: "d-1", kind: "system", body: "task queued" }),
  ]

  test("高信号只保留能改变理解或行动的消息", () => {
    expect(classifyMessages(messages).highSignal.map((item) => item.id)).toEqual(["u-1", "s-1"])
  })

  test("Diagnostics 收纳内部运行状态", () => {
    expect(classifyMessages(messages).diagnostics.map((item) => item.id)).toEqual(["a-1", "d-1"])
  })

  test("Thread 按 threadID 分组且保留首次出现顺序", () => {
    const threads = classifyMessages(messages).threads
    expect(threads.map((thread) => thread.id)).toEqual(["th-1", "th-2"])
    expect(threads[0]?.messages.map((item) => item.id)).toEqual(["t-1", "t-2"])
    expect(threads[1]?.messages.map((item) => item.id)).toEqual(["t-3"])
  })

  test("hasThreads 依据真实 Thread 存在与否", () => {
    expect(hasThreads(classifyMessages(messages))).toBe(true)
    expect(hasThreads(classifyMessages([message({ id: "s-1", body: "目标已理解" })]))).toBe(false)
  })
})
