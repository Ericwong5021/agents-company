import type {
  CompanyOperationItem,
  CompanyOperationPage,
  CompanyOperationSummary,
} from "../../../shared/company-operations"
import {
  toOperationDays,
  toOperationItemVM,
  toOperationsSummary,
} from "../../adapters/operations.adapter"
import type {
  OperationsFilterVM,
  OperationsPane,
  OperationsProjection,
} from "../../types/operations"

function errorText(error: unknown) {
  if (error && typeof error === "object" && "statusMessage" in error && typeof error.statusMessage === "string")
    return error.statusMessage
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return "暂时无法读取运营记录。"
}

export function useOperationsPresenter() {
  const { data: snapshot, signalVersion, streamStatus } = useCompanySnapshot()
  const route = useRoute()
  const filters = reactive<OperationsFilterVM>({
    category: "",
    severity: "",
    importance: "",
    projectID: "",
    agentID: "",
    timeRange: "24h",
  })
  const items = ref<CompanyOperationItem[]>([])
  const nextCursor = ref<string>()
  const summary = ref({ total24h: 0, errors24h: 0, warnings24h: 0, recoveries24h: 0 } satisfies CompanyOperationSummary)
  const status = ref<"pending" | "success" | "error">("pending")
  const error = ref("")
  const loadingMore = ref(false)
  const newRecordsAvailable = ref(false)
  const pane = ref<OperationsPane>({ kind: "closed" })
  const detailItems = ref<Record<string, CompanyOperationItem>>({})
  const rangeAnchor = ref(Date.now())
  let requestGeneration = 0

  function filterQuery(limit = "50") {
    return {
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.severity ? { severity: filters.severity } : {}),
      ...(filters.importance ? { importance: filters.importance } : {}),
      ...(filters.projectID ? { project_id: filters.projectID } : {}),
      ...(filters.agentID ? { agent_id: filters.agentID } : {}),
      ...(filters.timeRange === "all"
        ? {}
        : { from: String(rangeAnchor.value - (filters.timeRange === "24h" ? 24 : 7 * 24) * 60 * 60 * 1_000) }),
      limit,
    }
  }

  function operationURL(cursor?: string, limit?: string) {
    const params = new URLSearchParams({ ...filterQuery(limit), ...(cursor ? { cursor } : {}) })
    return `/api/agent-company/operations?${params}`
  }

  async function load(reset = true) {
    const generation = ++requestGeneration
    rangeAnchor.value = Date.now()
    if (reset) status.value = "pending"
    loadingMore.value = false
    error.value = ""
    const [page, nextSummary] = await Promise.all([
      $fetch<CompanyOperationPage>(operationURL()).then(value => ({ value }), reason => ({ error: reason })),
      $fetch<CompanyOperationSummary>("/api/agent-company/operations/summary").then(value => ({ value }), () => ({})),
    ])
    if (generation !== requestGeneration) return
    if (!("value" in page)) {
      status.value = "error"
      error.value = errorText(page.error)
      return
    }
    items.value = page.value.items
    nextCursor.value = page.value.nextCursor
    if ("value" in nextSummary) summary.value = nextSummary.value
    status.value = "success"
    newRecordsAvailable.value = false
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value) return
    const generation = requestGeneration
    const cursor = nextCursor.value
    loadingMore.value = true
    error.value = ""
    const page = await $fetch<CompanyOperationPage>(operationURL(cursor)).then(
      value => ({ value }),
      reason => ({ error: reason }),
    )
    if (generation !== requestGeneration || cursor !== nextCursor.value) return
    loadingMore.value = false
    if (!("value" in page)) {
      error.value = errorText(page.error)
      return
    }
    items.value = [...items.value, ...page.value.items]
    nextCursor.value = page.value.nextCursor
  }

  async function openDetail(operationID: string) {
    const source = detailItems.value[operationID]
    if (source) {
      pane.value = { kind: "detail", operationID, item: toOperationItemVM(source), loading: false, error: "" }
      return
    }
    pane.value = { kind: "detail", operationID, loading: true, error: "" }
    const result = await $fetch<CompanyOperationItem>(
      `/api/agent-company/operations/${encodeURIComponent(operationID)}`,
    ).then(value => ({ value }), reason => ({ error: reason }))
    if (pane.value.kind !== "detail" || pane.value.operationID !== operationID) return
    if (!("value" in result)) {
      pane.value = { kind: "detail", operationID, loading: false, error: errorText(result.error) }
      return
    }
    detailItems.value = { ...detailItems.value, [operationID]: result.value }
    pane.value = {
      kind: "detail",
      operationID,
      item: toOperationItemVM(result.value),
      loading: false,
      error: "",
    }
  }

  function updateFilters(next: Partial<OperationsFilterVM>) {
    Object.assign(filters, next)
  }

  function openFilters() {
    pane.value = { kind: "filters" }
  }

  function closePane() {
    pane.value = { kind: "closed" }
  }

  async function probeNewRecords() {
    if (status.value !== "success") return
    const generation = requestGeneration
    const currentID = items.value[0]?.id
    const page = await $fetch<CompanyOperationPage>(operationURL(undefined, "1")).catch(() => undefined)
    if (generation !== requestGeneration || status.value !== "success") return
    if (page?.items[0]?.id && page.items[0].id !== currentID) newRecordsAvailable.value = true
  }

  const projection = computed<OperationsProjection>(() => ({
    status: status.value,
    error: error.value,
    streamStatus: streamStatus.value,
    filters: { ...filters },
    groups: toOperationDays(items.value),
    summary: toOperationsSummary(summary.value),
    hasMore: Boolean(nextCursor.value),
    loadingMore: loadingMore.value,
    newRecordsAvailable: newRecordsAvailable.value,
    projects: snapshot.value.projects.map(project => ({ id: project.id, title: project.title })),
    agents: snapshot.value.agents.map(agent => ({ id: agent.id, name: agent.name })),
  }))

  watch(filters, () => void load(), { deep: true })
  watch(signalVersion, (version, previous) => {
    if (route.path === "/company/operations" && version > previous) void probeNewRecords()
  })
  onMounted(() => void load())

  return {
    projection,
    pane,
    load,
    loadMore,
    openDetail,
    updateFilters,
    openFilters,
    closePane,
  }
}
