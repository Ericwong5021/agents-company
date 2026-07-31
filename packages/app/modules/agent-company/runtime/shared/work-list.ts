import { ExperienceNeedsUserAction, type ExperienceUserStatus, type WorkProjection } from "@agents-company/shared/experience"

// WORK-01 — 重建 Work 列表与项目进入路径（纯函数、可单测）。
//
// 默认分组不直接暴露内部 13 态枚举，而是投影为“需要处理 / 正在执行 / 待验收/已交付 / 全部”。
// 搜索、状态分组、负责人筛选与最近活动排序都在此纯逻辑层完成，UI 只负责呈现与交互。

export type WorkGroupId = "needs_you" | "running" | "delivered" | "all"
export type WorkListGroup = "needs_you" | "running" | "delivered" | "other"

export const workGroups = [
  { id: "needs_you", label: "需要处理" },
  { id: "running", label: "正在执行" },
  { id: "delivered", label: "已交付" },
  { id: "all", label: "全部" },
] as const satisfies readonly { id: WorkGroupId; label: string }[]

// 语义分组：把内部状态映射到用户可理解的四组之一（cancelled 等只出现在“全部”）。
const statusToGroup = {
  draft: "needs_you",
  needs_input: "needs_you",
  ready: "needs_you",
  paused: "needs_you",
  blocked: "needs_you",
  needs_approval: "needs_you",
  failed: "needs_you",
  running: "running",
  reviewing: "running",
  revision: "running",
  delivered: "delivered",
  accepted: "delivered",
  archived: "other",
  cancelled: "other",
} as const satisfies Record<ExperienceUserStatus, WorkListGroup>

export function workGroupOfStatus(status: ExperienceUserStatus): WorkListGroup {
  return statusToGroup[status]
}

export type WorkListEntry = {
  workId: string
  title: string
  ownerId?: string
  ownerName?: string
  updatedAt: string
  status?: ExperienceUserStatus
  group: WorkListGroup
  needsUserAction: boolean
  available: boolean
}

// 把一条 WorkProjection 归一化为列表项。状态不可用的工作视为“需要处理”（需查看诊断）。
export function toWorkListEntry(item: WorkProjection): WorkListEntry {
  if (item.availability === "unavailable")
    return {
      workId: item.workId,
      title: item.title,
      updatedAt: item.updatedAt,
      group: "needs_you",
      needsUserAction: true,
      available: false,
    }
  return {
    workId: item.summary.workId,
    title: item.summary.title,
    ownerId: item.summary.owner?.id,
    ownerName: item.summary.owner?.name,
    updatedAt: item.summary.updatedAt,
    status: item.summary.userStatus,
    group: workGroupOfStatus(item.summary.userStatus),
    needsUserAction: ExperienceNeedsUserAction[item.summary.userStatus],
    available: true,
  }
}

export type WorkFilter = {
  group: WorkGroupId
  query: string
  owner: string | null
}

export const emptyWorkFilter: WorkFilter = { group: "all", query: "", owner: null }

function matchesFilter(entry: WorkListEntry, filter: WorkFilter) {
  if (filter.group !== "all" && entry.group !== filter.group) return false
  if (filter.owner && entry.ownerId !== filter.owner) return false
  const query = filter.query.trim().toLowerCase()
  if (query && !`${entry.title} ${entry.workId} ${entry.ownerName ?? ""}`.toLowerCase().includes(query)) return false
  return true
}

// 按最近活动降序排序（updatedAt 为 ISO 时间戳，字典序即时间序）。
function byRecentActivity(left: WorkListEntry, right: WorkListEntry) {
  return right.updatedAt.localeCompare(left.updatedAt)
}

// 应用分组/搜索/负责人筛选并按最近活动排序。
export function selectWork(entries: readonly WorkListEntry[], filter: WorkFilter) {
  return entries.filter((entry) => matchesFilter(entry, filter)).sort(byRecentActivity)
}

// 各分组的数量（“全部”即总数），用于分组标签实时更新。
export function groupCounts(entries: readonly WorkListEntry[]): Record<WorkGroupId, number> {
  return {
    needs_you: entries.filter((entry) => entry.group === "needs_you").length,
    running: entries.filter((entry) => entry.group === "running").length,
    delivered: entries.filter((entry) => entry.group === "delivered").length,
    all: entries.length,
  }
}

// 去重后的负责人选项，用于负责人筛选下拉。
export function ownerOptions(entries: readonly WorkListEntry[]) {
  const seen = new Map<string, string>()
  for (const entry of entries) if (entry.ownerId && !seen.has(entry.ownerId)) seen.set(entry.ownerId, entry.ownerName ?? entry.ownerId)
  return [...seen].map(([id, name]) => ({ id, name }))
}
