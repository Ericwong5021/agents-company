import { useFetch, useState } from "nuxt/app"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { CompanySnapshot } from "../../shared/company-contract"
import {
  companyReconnectDelay,
  transitionCompanyConnection,
} from "../../shared/connection-state"
import { classifyGlobalEvent, nextSignalRefreshDelay } from "../../shared/company-events"

const allResources = ["company", "agents", "work", "channels", "messages"] as const

// WORK-06 — 单标签页内共享一条 SSE 订阅：事件只触发只读快照刷新（变更类动作
// 靠 request_id 幂等，多标签页订阅不会重复执行业务动作）。后端 /event 暂无
// Last-Event-ID 补发，连接/重连后以一次全量快照校准，不伪造事件回放。
// SSE 不可用时降级回既有的断线重连轮询 + 手动刷新，不静默停更。
const SIGNAL_REFRESH_MIN_INTERVAL_MS = 1_000

const sseListeners = new Set<() => void>()
let sseSource: EventSource | undefined
let sseLastRefreshAt: number | undefined
let sseRefreshTimer: ReturnType<typeof setTimeout> | undefined

function notifySseRefresh() {
  // 快照状态经 useState 共享，只需触发一个存活实例的后台刷新。
  const listener = sseListeners.values().next().value
  listener?.()
}

function scheduleSseRefresh() {
  if (sseRefreshTimer) return
  const delay = nextSignalRefreshDelay({
    now: Date.now(),
    lastRefreshAt: sseLastRefreshAt,
    minIntervalMs: SIGNAL_REFRESH_MIN_INTERVAL_MS,
  })
  sseRefreshTimer = setTimeout(() => {
    sseRefreshTimer = undefined
    sseLastRefreshAt = Date.now()
    notifySseRefresh()
  }, delay)
}

function ensureSseSource() {
  if (sseSource || typeof EventSource === "undefined") return
  const source = new EventSource("/api/agent-company/events")
  source.onmessage = (event) => {
    const kind = classifyGlobalEvent(String(event.data))
    // connected（含断线重连成功）与业务事件都收敛到节流后的全量快照校准。
    if (kind === "connected" || kind === "signal") scheduleSseRefresh()
  }
  // 连接错误由 EventSource 自动重试；持续不可用时既有 reconnect 轮询兜底。
  sseSource = source
}

function releaseSseSource() {
  if (sseListeners.size > 0 || !sseSource) return
  sseSource.close()
  sseSource = undefined
  if (sseRefreshTimer) clearTimeout(sseRefreshTimer)
  sseRefreshTimer = undefined
}

const loadingSnapshot: CompanySnapshot = {
  connection: "connecting",
  company: {
    id: "",
    name: "Agent Company",
    provider: "正在读取",
    approvalPolicy: "正在读取",
  },
  stats: {},
  agents: [],
  messages: [],
  work: [],
  projects: [],
}

function failedSnapshot(): CompanySnapshot {
  const checkedAt = new Date().toISOString()
  return {
    connection: "disconnected",
    issue: {
      kind: "service_error",
      title: "WebUI 无法读取连接状态",
      detail: "本地 WebUI 请求没有返回可识别的诊断结果。",
      impact: "当前页面不会继续显示可能过期的公司数据。",
      nextAction: "重新连接；若问题持续，请重启 WebUI。",
      retryable: true,
      unavailable: [...allResources],
      diagnostic: {
        checkedAt,
        endpoint: "WebUI proxy",
        issue: "service_error",
        readiness: "unknown",
        unavailable: [...allResources],
      },
    },
    company: {
      id: "",
      name: "Agent Company",
      provider: "未读取",
      approvalPolicy: "未读取",
    },
    stats: {},
    agents: [],
    messages: [],
    work: [],
    projects: [],
  }
}

export function useCompanySnapshot() {
  const request = useFetch<CompanySnapshot>("/api/agent-company/snapshot", {
    key: "agent-company-snapshot",
  })
  const snapshot = useState<CompanySnapshot>("agent-company-snapshot-value", () => loadingSnapshot)
  const connection = useState("agent-company-connection", () => snapshot.value.connection)
  const reconnectAttempt = useState("agent-company-reconnect-attempt", () => 0)
  const reconnectTimer = ref<ReturnType<typeof setTimeout>>()

  watch(
    [request.data, request.error],
    ([value, error]) => {
      if (error) {
        snapshot.value = failedSnapshot()
        connection.value = transitionCompanyConnection(connection.value, { type: "request_failed" })
        return
      }
      if (!value) return
      snapshot.value = value
      connection.value = transitionCompanyConnection(connection.value, {
        type: "snapshot_received",
        connection: value.connection === "recovering" || value.connection === "connecting"
          ? "disconnected"
          : value.connection,
      })
      if (value.connection === "ready" || (value.connection === "degraded" && !value.issue?.retryable)) {
        reconnectAttempt.value = 0
      }
    },
    { immediate: true },
  )

  async function refresh() {
    if (request.pending.value) return
    connection.value = transitionCompanyConnection(connection.value, { type: "request_started" })
    await request.refresh()
  }

  function scheduleReconnect() {
    if (reconnectTimer.value) clearTimeout(reconnectTimer.value)
    if (
      !import.meta.client ||
      !snapshot.value.issue?.retryable ||
      (connection.value !== "disconnected" && connection.value !== "degraded")
    ) return
    reconnectTimer.value = setTimeout(() => {
      reconnectAttempt.value += 1
      if (connection.value === "degraded") {
        void request.refresh()
        return
      }
      void refresh()
    }, companyReconnectDelay(reconnectAttempt.value))
  }

  watch(
    () => [connection.value, snapshot.value.issue?.retryable] as const,
    scheduleReconnect,
    { immediate: true },
  )

  onMounted(scheduleReconnect)

  // SSE 订阅与既有重连轮询并存：事件驱动的后台刷新不改写连接态（避免每次
  // 事件都闪现 recovering），结果到达后由快照 watcher 统一更新状态。
  const sseRefresh = () => {
    if (!request.pending.value) void request.refresh()
  }

  onMounted(() => {
    sseListeners.add(sseRefresh)
    ensureSseSource()
  })

  onBeforeUnmount(() => {
    sseListeners.delete(sseRefresh)
    releaseSseSource()
    if (reconnectTimer.value) clearTimeout(reconnectTimer.value)
  })

  return {
    ...request,
    refresh,
    data: computed(() => ({
      ...snapshot.value,
      connection: connection.value,
    })),
  }
}
