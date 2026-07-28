import { describe, expect, test } from "bun:test"
import type { WorkProjection } from "@agents-company/shared/experience"
import {
  groupCounts,
  ownerOptions,
  selectWork,
  toWorkListEntry,
  workGroupOfStatus,
  type WorkListEntry,
} from "../modules/agent-company/runtime/shared/work-list"

// WORK-01 — Work 列表分组、搜索、负责人筛选与最近活动排序（纯逻辑）。

function entry(overrides: Partial<WorkListEntry> = {}): WorkListEntry {
  return {
    workId: "w1",
    title: "季度增长分析",
    ownerId: "agent-1",
    ownerName: "小岚",
    updatedAt: "2026-07-25T09:00:00.000Z",
    status: "running",
    group: "running",
    needsUserAction: false,
    available: true,
    ...overrides,
  }
}

describe("WORK-01 语义分组", () => {
  test("内部状态映射到四组之一，cancelled 归为 other 仅出现在全部", () => {
    expect(workGroupOfStatus("blocked")).toBe("needs_you")
    expect(workGroupOfStatus("needs_approval")).toBe("needs_you")
    expect(workGroupOfStatus("running")).toBe("running")
    expect(workGroupOfStatus("reviewing")).toBe("running")
    expect(workGroupOfStatus("delivered")).toBe("delivered")
    expect(workGroupOfStatus("accepted")).toBe("delivered")
    expect(workGroupOfStatus("cancelled")).toBe("other")
  })

  test("状态不可用的工作归一化为需要处理，并保留标题与时间", () => {
    const projection = {
      availability: "unavailable",
      workId: "w-bad",
      title: "状态诊断项",
      updatedAt: "2026-07-24T00:00:00.000Z",
    } as unknown as WorkProjection
    const normalized = toWorkListEntry(projection)
    expect(normalized).toMatchObject({ workId: "w-bad", group: "needs_you", needsUserAction: true, available: false })
  })
})

describe("WORK-01 分组计数", () => {
  test("按分组统计，全部为总数", () => {
    const counts = groupCounts([
      entry({ workId: "a", group: "needs_you" }),
      entry({ workId: "b", group: "running" }),
      entry({ workId: "c", group: "delivered" }),
      entry({ workId: "d", group: "other" }),
    ])
    expect(counts).toEqual({ needs_you: 1, running: 1, delivered: 1, all: 4 })
  })
})

describe("WORK-01 筛选与排序", () => {
  const entries = [
    entry({ workId: "old", title: "旧的执行", group: "running", updatedAt: "2026-07-20T00:00:00.000Z" }),
    entry({ workId: "new", title: "最新执行", group: "running", updatedAt: "2026-07-26T00:00:00.000Z" }),
    entry({ workId: "block", title: "需要审批", group: "needs_you", ownerId: "agent-2", ownerName: "阿衡", updatedAt: "2026-07-25T00:00:00.000Z" }),
  ]

  test("按最近活动降序排序", () => {
    expect(selectWork(entries, { group: "all", query: "", owner: null }).map(item => item.workId)).toEqual([
      "new",
      "block",
      "old",
    ])
  })

  test("分组筛选只保留对应组", () => {
    expect(selectWork(entries, { group: "needs_you", query: "", owner: null }).map(item => item.workId)).toEqual([
      "block",
    ])
  })

  test("搜索匹配标题或负责人，忽略大小写", () => {
    expect(selectWork(entries, { group: "all", query: "阿衡", owner: null }).map(item => item.workId)).toEqual(["block"])
    expect(selectWork(entries, { group: "all", query: "最新", owner: null }).map(item => item.workId)).toEqual(["new"])
  })

  test("负责人筛选按 ownerId 精确匹配", () => {
    expect(selectWork(entries, { group: "all", query: "", owner: "agent-2" }).map(item => item.workId)).toEqual([
      "block",
    ])
  })

  test("0 项时返回空列表", () => {
    expect(selectWork([], { group: "all", query: "", owner: null })).toEqual([])
  })
})

describe("WORK-01 负责人选项", () => {
  test("去重并保留名称", () => {
    expect(
      ownerOptions([
        entry({ workId: "a", ownerId: "agent-1", ownerName: "小岚" }),
        entry({ workId: "b", ownerId: "agent-1", ownerName: "小岚" }),
        entry({ workId: "c", ownerId: "agent-2", ownerName: "阿衡" }),
        entry({ workId: "d", ownerId: undefined, ownerName: undefined }),
      ]),
    ).toEqual([
      { id: "agent-1", name: "小岚" },
      { id: "agent-2", name: "阿衡" },
    ])
  })
})
