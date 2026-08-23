import type {
  CompanyOperationCategory,
  CompanyOperationImportance,
  CompanyOperationSeverity,
} from "../../shared/company-operations"

export type OperationsFilterVM = {
  category: CompanyOperationCategory | ""
  severity: CompanyOperationSeverity | ""
  importance: CompanyOperationImportance | ""
  projectID: string
  agentID: string
  timeRange: "24h" | "7d" | "all"
}

export type OperationItemVM = {
  id: string
  category: CompanyOperationCategory
  categoryLabel: string
  severity: CompanyOperationSeverity
  severityLabel: string
  importance: CompanyOperationImportance
  importanceLabel: string
  title: string
  summary: string
  occurredAt: number
  time: string
  href: string
  contextLabel: string
  details: { label: string; value: string }[]
}

export type OperationDayVM = {
  date: string
  items: OperationItemVM[]
}

export type OperationsSummaryVM = {
  total: number
  errors: number
  warnings: number
  recoveries: number
}

export type OperationsProjection = {
  status: "pending" | "success" | "error"
  error: string
  streamStatus: "connecting" | "live" | "degraded"
  filters: OperationsFilterVM
  groups: OperationDayVM[]
  summary: OperationsSummaryVM
  hasMore: boolean
  loadingMore: boolean
  newRecordsAvailable: boolean
  projects: { id: string; title: string }[]
  agents: { id: string; name: string }[]
}

export type OperationsPane =
  | { kind: "closed" }
  | { kind: "filters" }
  | { kind: "detail"; operationID: string; item?: OperationItemVM; loading: boolean; error: string }
