import { describe, expect, test } from "bun:test"
import {
  classifyGlobalEvent,
  nextSignalRefreshDelay,
  streamStalled,
} from "../modules/agent-company/runtime/shared/company-events"

// WORK-06 — SSE 事件流纯逻辑：分类、刷新节流与停滞判定。
// 后端 /event 无 Last-Event-ID 补发，重连后以全量快照校准，不伪造事件回放。

function raw(payload: unknown): string {
  return JSON.stringify({ directory: "/tmp/company", payload })
}

describe("classifyGlobalEvent", () => {
  test("server.connected → connected（连接/重连后需全量校准）", () => {
    expect(classifyGlobalEvent(raw({ type: "server.connected" }))).toBe("connected")
  })

  test("server.heartbeat → heartbeat（仅保活，不驱动刷新）", () => {
    expect(classifyGlobalEvent(raw({ type: "server.heartbeat" }))).toBe("heartbeat")
  })

  test("任何带 type 的业务事件 → signal", () => {
    expect(classifyGlobalEvent(raw({ type: "message.created", properties: {} }))).toBe("signal")
    expect(classifyGlobalEvent(raw({ type: "project.updated" }))).toBe("signal")
  })

  test("畸形 JSON 或缺失 payload.type 不抛异常，归为 unknown", () => {
    expect(classifyGlobalEvent("not-json")).toBe("unknown")
    expect(classifyGlobalEvent("{broken")).toBe("unknown")
    expect(classifyGlobalEvent(JSON.stringify({ payload: {} }))).toBe("unknown")
    expect(classifyGlobalEvent(JSON.stringify({ payload: { type: 42 } }))).toBe("unknown")
    expect(classifyGlobalEvent(JSON.stringify(null))).toBe("unknown")
  })
})

describe("nextSignalRefreshDelay", () => {
  test("从未刷新过立即刷新", () => {
    expect(nextSignalRefreshDelay({ now: 10_000, minIntervalMs: 1_000 })).toBe(0)
  })

  test("超过最小间隔立即刷新", () => {
    expect(nextSignalRefreshDelay({ now: 10_000, lastRefreshAt: 9_000, minIntervalMs: 1_000 })).toBe(0)
    expect(nextSignalRefreshDelay({ now: 10_000, lastRefreshAt: 8_000, minIntervalMs: 1_000 })).toBe(0)
  })

  test("突发事件合并：间隔内返回剩余等待毫秒", () => {
    expect(nextSignalRefreshDelay({ now: 10_000, lastRefreshAt: 9_400, minIntervalMs: 1_000 })).toBe(400)
    expect(nextSignalRefreshDelay({ now: 10_000, lastRefreshAt: 10_000, minIntervalMs: 1_000 })).toBe(1_000)
  })
})

describe("streamStalled", () => {
  test("3 个心跳周期内有事件不算停滞", () => {
    expect(streamStalled({ now: 30_000, lastEventAt: 0, heartbeatIntervalMs: 10_000 })).toBe(false)
  })

  test("超过 3 个心跳周期没有任何事件视为停滞", () => {
    expect(streamStalled({ now: 30_001, lastEventAt: 0, heartbeatIntervalMs: 10_000 })).toBe(true)
  })
})
