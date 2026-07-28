import type { CompanyAgent } from "./company-contract"

// WORK-04 — Composer 统一意图入口的纯逻辑：发送目标、@Agent 提及、幂等策略、
// 草稿恢复与失败文案。保持纯函数、无副作用，可脱离 Vue 单测。
// 变更类干预（暂停/停止等）由 WORK-07 运行控制条按投影如实呈现，Composer 不伪造。

export type ComposerTarget = { kind: "board" } | { kind: "project"; projectId: string; title: string }

export function composerTargetLabel(target: ComposerTarget): string {
  if (target.kind === "board") return "公司看板"
  return `当前项目 · ${target.title}`
}

export function composerIntentHint(target: ComposerTarget): string {
  if (target.kind === "board") return "作为新目标或公司讨论发出，由本地服务按意图分类路由。"
  return "作为对该项目的追问或补充发出，不会创建新项目。"
}

export const MAX_MENTIONS = 20

export type MentionOption = { agentId: string; name: string; role?: string }

// 提及候选来自公司真实名册；是否对目标频道可见由本地服务校验，前端不预判。
export function mentionOptions(agents: Pick<CompanyAgent, "id" | "name" | "role">[]): MentionOption[] {
  return agents
    .filter((agent, index, all) => all.findIndex((entry) => entry.id === agent.id) === index)
    .map((agent) => ({ agentId: agent.id, name: agent.name, role: agent.role }))
}

export function toggleMention(selected: string[], agentId: string): string[] {
  if (selected.includes(agentId)) return selected.filter((id) => id !== agentId)
  if (selected.length >= MAX_MENTIONS) return selected
  return [...selected, agentId]
}

export function canSubmit(input: { body: string; sending: boolean }): boolean {
  return !input.sending && input.body.trim().length > 0
}

// 幂等策略：同一草稿沿用同一 request_id，仅在服务端确认接受后轮换。
// 双击、Enter 重复、断线重试都携带同一 request_id，由本地服务按请求去重。
export function shouldRotateRequestID(outcome: "accepted" | "failed"): boolean {
  return outcome === "accepted"
}

// 草稿按发送目标隔离存取，项目切换、断线与刷新后可恢复。
export function draftStorageKey(target: ComposerTarget): string {
  if (target.kind === "board") return "agent-company-composer:board"
  return `agent-company-composer:project:${target.projectId}`
}

// 可发现的文本意图动作：仅做输入辅助前缀，不虚构后端命令。
export const composerQuickIntents = [
  { id: "adjust", label: "调整方向", prefix: "调整方向：" },
  { id: "constraint", label: "添加约束", prefix: "添加约束：" },
  { id: "summary", label: "请求总结", prefix: "请求总结：" },
] as const

export function applyQuickIntent(body: string, prefix: string): string {
  if (body.startsWith(prefix)) return body
  return `${prefix}${body}`
}

// 发送失败文案：如实说明原因并强调内容已保留，不把失败说成成功。
export function sendFailureText(statusCode?: number): string {
  if (statusCode === 401 || statusCode === 403) return "目标频道不接受你的发言（无权限或提及对象不在频道内），内容已保留。"
  if (statusCode === 404) return "目标频道不存在或已归档，内容已保留。"
  if (statusCode === 409) return "同一请求编号已提交过不同内容，请刷新页面后重试，内容已保留。"
  if (statusCode === 503) return "本地服务暂不可用，内容已保留，可稍后重试。"
  return "发送未完成，内容已保留，可重试。"
}
