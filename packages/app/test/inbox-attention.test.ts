import { describe, expect, test } from "bun:test"
import type { AttentionItem, WorkProjection } from "@agents-company/shared/experience"
import {
  aggregateAttention,
  attentionTypeLabels,
  categorySummaries,
  countByType,
} from "../modules/agent-company/runtime/shared/inbox-attention"

// DELIV-01 — 注意力聚合、去重、排序与分类计数的纯逻辑。
// 仅构造纯函数实际读取的字段（id/type/priority/updatedAt），投影完整性由 shared 契约测试保证。

function item(
  id: string,
  type: AttentionItem["type"],
  priority: AttentionItem["priority"],
  updatedAt: string,
): AttentionItem {
  return { id, type, priority, updatedAt } as unknown as AttentionItem
}

function work(title: string, items: AttentionItem[]): WorkProjection {
  return { availability: "available", summary: { title }, attentionItems: items } as unknown as WorkProjection
}

function unavailableWork(): WorkProjection {
  return { availability: "unavailable", attentionItems: [] } as unknown as WorkProjection
}

describe("aggregateAttention", () => {
  test("只聚合可用工作的 attentionItems，忽略不可用工作", () => {
    const result = aggregateAttention([
      work("A", [item("a1", "approval", "high", "2026-07-01T00:00:00.000Z")]),
      unavailableWork(),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.workTitle).toBe("A")
  })

  test("按优先级（critical→high→normal）再按更新时间倒序排序", () => {
    const result = aggregateAttention([
      work("A", [
        item("normal-new", "delivery", "normal", "2026-07-05T00:00:00.000Z"),
        item("high-old", "blocked", "high", "2026-07-01T00:00:00.000Z"),
      ]),
      work("B", [
        item("critical", "failure", "critical", "2026-07-02T00:00:00.000Z"),
        item("high-new", "approval", "high", "2026-07-04T00:00:00.000Z"),
      ]),
    ])
    expect(result.map((entry) => entry.id)).toEqual(["critical", "high-new", "high-old", "normal-new"])
  })

  test("同一根因（相同 id）只保留一次，不重复堆叠", () => {
    const shared = item("dup", "approval", "high", "2026-07-01T00:00:00.000Z")
    const result = aggregateAttention([work("A", [shared]), work("B", [shared])])
    expect(result).toHaveLength(1)
    expect(result[0]!.workTitle).toBe("A")
  })
})

describe("countByType / categorySummaries", () => {
  test("按五类计数并统计总数", () => {
    const counts = countByType(
      aggregateAttention([
        work("A", [
          item("a1", "approval", "high", "2026-07-01T00:00:00.000Z"),
          item("a2", "approval", "normal", "2026-07-02T00:00:00.000Z"),
          item("b1", "blocked", "critical", "2026-07-03T00:00:00.000Z"),
        ]),
      ]),
    )
    expect(counts.approval).toBe(2)
    expect(counts.blocked).toBe(1)
    expect(counts.delivery).toBe(0)
    expect(counts.total).toBe(3)
  })

  test("分类摘要只列出真实存在的类别，count 为 0 的不展示", () => {
    const summaries = categorySummaries(
      countByType(aggregateAttention([work("A", [item("a1", "failure", "critical", "2026-07-01T00:00:00.000Z")])])),
    )
    expect(summaries).toEqual([{ type: "failure", label: attentionTypeLabels.failure, count: 1 }])
  })

  test("空队列时分类摘要为空", () => {
    expect(categorySummaries(countByType([]))).toEqual([])
  })
})
