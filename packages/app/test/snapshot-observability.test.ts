import { channel } from "node:diagnostics_channel"
import { describe, expect, test } from "bun:test"
import type { CompanySnapshot } from "../modules/agent-company/runtime/shared/company-contract"
import {
  observeSnapshot,
  snapshotObservation,
} from "../modules/agent-company/runtime/server/utils/snapshot-observability"

const emptySnapshot = {
  connection: "ready",
  company: {
    id: "company-local",
    name: "Agent Company",
    provider: "未配置",
    approvalPolicy: "balanced",
  },
  stats: {},
  agents: [],
  messages: [],
  work: [],
  projects: [],
} satisfies CompanySnapshot

describe("snapshot observability", () => {
  test("distinguishes real empty, disconnected, service error, and demo outcomes", () => {
    expect(snapshotObservation(emptySnapshot).outcome).toBe("empty_workspace")
    expect(snapshotObservation({
      ...emptySnapshot,
      connection: "disconnected",
      issue: {
        kind: "service_unreachable",
        title: "无法连接",
        detail: "没有响应",
        impact: "未读取真实数据",
        nextAction: "重试",
        retryable: true,
        unavailable: ["company", "agents", "work", "channels", "messages"],
        diagnostic: {
          checkedAt: "2026-07-26T00:00:00.000Z",
          endpoint: "http://127.0.0.1:4096",
          issue: "service_unreachable",
          unavailable: ["company", "agents", "work", "channels", "messages"],
        },
      },
    }).outcome).toBe("disconnected")
    expect(snapshotObservation({
      ...emptySnapshot,
      connection: "disconnected",
      issue: {
        kind: "service_error",
        title: "服务错误",
        detail: "服务返回错误",
        impact: "未读取真实数据",
        nextAction: "查看日志",
        retryable: true,
        unavailable: ["company", "agents", "work", "channels", "messages"],
        diagnostic: {
          checkedAt: "2026-07-26T00:00:00.000Z",
          endpoint: "http://127.0.0.1:4096",
          issue: "service_error",
          statusCode: 500,
          unavailable: ["company", "agents", "work", "channels", "messages"],
        },
      },
    }).outcome).toBe("service_error")
    expect(snapshotObservation({
      ...emptySnapshot,
      connection: "degraded",
      issue: {
        kind: "partial_data",
        title: "部分数据不可用",
        detail: "没有完整读取工作区",
        impact: "不能确认工作区是否为空",
        nextAction: "重试",
        retryable: true,
        unavailable: ["agents", "work", "channels", "messages"],
        diagnostic: {
          checkedAt: "2026-07-26T00:00:00.000Z",
          endpoint: "http://127.0.0.1:4096",
          issue: "partial_data",
          unavailable: ["agents", "work", "channels", "messages"],
        },
      },
    }).outcome).toBe("degraded")
    expect(snapshotObservation(emptySnapshot, "demo").outcome).toBe("demo")
  })

  test("publishes the same allowlisted event to the telemetry channel", () => {
    const messages: unknown[] = []
    const telemetry = channel("agent-company.snapshot")
    const subscriber = (message: unknown) => messages.push(message)
    telemetry.subscribe(subscriber)
    try {
      expect(observeSnapshot(emptySnapshot)).toBe(emptySnapshot)
    } finally {
      telemetry.unsubscribe(subscriber)
    }
    expect(messages).toEqual([snapshotObservation(emptySnapshot)])
    expect(Object.keys(messages[0] as Record<string, unknown>).sort()).toEqual([
      "connection",
      "counts",
      "event",
      "issueKind",
      "outcome",
      "schemaVersion",
      "unavailable",
      "workspaceMode",
    ])
  })
})
