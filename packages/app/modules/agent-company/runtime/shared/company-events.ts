// WORK-06 — SSE 事件流的纯逻辑：事件分类、刷新节流与流停滞判定。
// 后端 GET /event 当前不提供事件 ID / Last-Event-ID 补发；断线重连后以一次
// 全量快照校准状态，前端不伪造事件回放，也不按虚构游标去重。

export type GlobalEventKind = "connected" | "heartbeat" | "signal" | "unknown"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// JSON.parse 没有不抛异常的变体；畸形事件不应中断流处理，归为 unknown。
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// 事件分类：connected（连接/重连成功，需全量校准）、heartbeat（保活）、
// signal（任何业务事件，触发节流刷新）、unknown（无法识别，不驱动界面）。
export function classifyGlobalEvent(raw: string): GlobalEventKind {
  const parsed = safeParse(raw)
  if (!record(parsed)) return "unknown"
  const type =
    typeof parsed.type === "string"
      ? parsed.type
      : record(parsed.payload) && typeof parsed.payload.type === "string"
        ? parsed.payload.type
        : undefined
  if (!type) return "unknown"
  if (type === "server.connected") return "connected"
  if (type === "server.heartbeat") return "heartbeat"
  return "signal"
}

// 合并突发事件：距上次刷新不足最小间隔时返回剩余等待毫秒，否则立即刷新（0）。
export function nextSignalRefreshDelay(input: { now: number; lastRefreshAt?: number; minIntervalMs: number }): number {
  if (input.lastRefreshAt === undefined) return 0
  const elapsed = input.now - input.lastRefreshAt
  return elapsed >= input.minIntervalMs ? 0 : input.minIntervalMs - elapsed
}

// 流停滞判定：超过 3 个心跳周期（后端每 10s 心跳）没有任何事件，视为流已停滞，
// 需要回退到快照校准而不是继续静默等待。
export function streamStalled(input: { now: number; lastEventAt: number; heartbeatIntervalMs: number }): boolean {
  return input.now - input.lastEventAt > input.heartbeatIntervalMs * 3
}
