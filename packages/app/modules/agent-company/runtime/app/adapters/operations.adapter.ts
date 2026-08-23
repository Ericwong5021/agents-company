import type {
  CompanyOperationCategory,
  CompanyOperationImportance,
  CompanyOperationItem,
  CompanyOperationSeverity,
  CompanyOperationSummary,
} from "../../shared/company-operations"
import type { OperationDayVM, OperationItemVM, OperationsSummaryVM } from "../types/operations"

export const operationCategoryLabels: Record<CompanyOperationCategory, string> = {
  governance: "治理",
  work: "工作",
  runtime: "运行",
  quality: "质量",
  delivery: "交付",
  organization: "组织",
  system: "系统",
}

export const operationSeverityLabels: Record<CompanyOperationSeverity, string> = {
  info: "记录",
  warning: "注意",
  error: "异常",
}

export const operationImportanceLabels: Record<CompanyOperationImportance, string> = {
  primary: "主要",
  normal: "常规",
  diagnostic: "诊断",
}

const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" })
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })

function timeLabel(value: number, now: number) {
  const minutes = Math.round((value - now) / 60_000)
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute")
  return timeFormatter.format(value)
}

export function toOperationItemVM(item: CompanyOperationItem, now = Date.now()): OperationItemVM {
  const contextLabel = item.context.workItem?.title
    ?? item.context.project?.title
    ?? item.context.agent?.name
    ?? item.context.run?.state
    ?? "本地运行事实"
  return {
    id: item.id,
    category: item.category,
    categoryLabel: operationCategoryLabels[item.category],
    severity: item.severity,
    severityLabel: operationSeverityLabels[item.severity],
    importance: item.importance,
    importanceLabel: operationImportanceLabels[item.importance],
    title: item.title,
    summary: item.summary ?? contextLabel,
    occurredAt: item.occurredAt,
    time: timeLabel(item.occurredAt, now),
    href: item.href,
    contextLabel,
    details: item.details ?? [],
  }
}

export function toOperationDays(items: CompanyOperationItem[], now = Date.now()): OperationDayVM[] {
  return items.reduce<OperationDayVM[]>((groups, item) => {
    const date = dayFormatter.format(item.occurredAt)
    const mapped = toOperationItemVM(item, now)
    const previous = groups.at(-1)
    if (previous?.date === date) previous.items.push(mapped)
    else groups.push({ date, items: [mapped] })
    return groups
  }, [])
}

export function toOperationsSummary(summary: CompanyOperationSummary): OperationsSummaryVM {
  return {
    total: summary.total24h,
    errors: summary.errors24h,
    warnings: summary.warnings24h,
    recoveries: summary.recoveries24h,
  }
}
