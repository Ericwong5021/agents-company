import type { CompanyMessage } from "./company-contract"

// WORK-03 — 主会话降噪的纯逻辑：把消息流分离为高信号（主会话）、Thread（详细讨论）
// 与 Diagnostics（内部运行状态），主界面只展示能改变用户理解或行动的信息。
// 保持纯函数、无副作用，可脱离 Vue 单测。不删除任何原始消息，只做展示层归类。

export type MessageSignal = "high_signal" | "thread" | "diagnostics"

// 内部运行状态文本：Bidding、投影、竞标胜出、排队、原始事件等，不进入主会话。
const internalNoisePatterns: RegExp[] = [
  /\bqueued\b/i,
  /\bprojecting\b/i,
  /winner\s+selected/i,
  /\bbidding\b/i,
  /\battempt\s+\d+/i,
  /\bheartbeat\b/i,
  /tool[_\s-]?call/i,
  /raw\s+event/i,
]

export function isInternalNoise(body: string): boolean {
  return internalNoisePatterns.some((pattern) => pattern.test(body))
}

// 归类规则：带 threadID 的进入 Thread；非用户消息且命中内部噪声进入 Diagnostics；
// 其余（目标理解、计划变化、里程碑、阻塞/决定、交付、用户输入）留在主会话高信号。
export function classifyMessage(message: CompanyMessage): MessageSignal {
  if (message.threadID) return "thread"
  if (message.kind !== "user" && isInternalNoise(message.body)) return "diagnostics"
  return "high_signal"
}

export type ClassifiedMessages = {
  highSignal: CompanyMessage[]
  threads: { id: string; messages: CompanyMessage[] }[]
  diagnostics: CompanyMessage[]
}

export function classifyMessages(messages: CompanyMessage[]): ClassifiedMessages {
  const highSignal = messages.filter((message) => classifyMessage(message) === "high_signal")
  const diagnostics = messages.filter((message) => classifyMessage(message) === "diagnostics")
  const threadOrder = messages
    .filter((message) => classifyMessage(message) === "thread")
    .map((message) => message.threadID)
    .filter((id, index, all): id is string => id !== undefined && all.indexOf(id) === index)
  const threads = threadOrder.map((id) => ({
    id,
    messages: messages.filter((message) => message.threadID === id),
  }))
  return { highSignal, threads, diagnostics }
}

export function hasThreads(classified: ClassifiedMessages): boolean {
  return classified.threads.length > 0
}
