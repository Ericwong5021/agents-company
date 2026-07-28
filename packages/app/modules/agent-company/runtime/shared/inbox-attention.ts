import type { AttentionItem, WorkProjection } from "@agents-company/shared/experience"

// DELIV-01 — Inbox / Attention Center 的纯逻辑：把各工作投影下发的 attentionItems 聚合为
// 单一注意力队列，按影响与时效排序，并按五类事项计数。
// 关键红线：不制造事项。聚合只消费投影已下发的真实 attentionItems，按同一根因（同 id）去重，
// 不虚构 recommendedAction 的可用性（enabled 仍由投影决定）。

export type AttentionType = AttentionItem["type"]

export const attentionTypeLabels: Record<AttentionType, string> = {
  input: "等待补充",
  approval: "等待审批",
  blocked: "受阻",
  delivery: "待验收交付",
  failure: "执行失败",
}

// 排序权重：先按优先级（critical 最前），再按更新时间倒序（新的在前）。
const priorityRank: Record<AttentionItem["priority"], number> = { critical: 0, high: 1, normal: 2 }

export type AggregatedAttentionItem = AttentionItem & { workTitle: string }

export function aggregateAttention(works: WorkProjection[]): AggregatedAttentionItem[] {
  const seen = new Set<string>()
  return works
    .filter((work): work is Extract<WorkProjection, { availability: "available" }> => work.availability === "available")
    .flatMap((work) => work.attentionItems.map((item) => ({ ...item, workTitle: work.summary.title })))
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .sort(
      (left, right) =>
        priorityRank[left.priority] - priorityRank[right.priority] ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
}

export type AttentionCounts = Record<AttentionType, number> & { total: number }

export function countByType(items: AggregatedAttentionItem[]): AttentionCounts {
  return items.reduce<AttentionCounts>(
    (counts, item) => ({ ...counts, [item.type]: counts[item.type] + 1, total: counts.total + 1 }),
    { input: 0, approval: 0, blocked: 0, delivery: 0, failure: 0, total: 0 },
  )
}

// 供 Inbox 头部展示的分类摘要：只列出真实存在的类别，count 为 0 的类别不展示，避免噪声。
export type AttentionCategorySummary = { type: AttentionType; label: string; count: number }

export function categorySummaries(counts: AttentionCounts): AttentionCategorySummary[] {
  return (Object.keys(attentionTypeLabels) as AttentionType[])
    .map((type) => ({ type, label: attentionTypeLabels[type], count: counts[type] }))
    .filter((entry) => entry.count > 0)
}
