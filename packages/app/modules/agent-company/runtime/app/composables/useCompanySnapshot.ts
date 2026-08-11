import { useFetch, useState } from "nuxt/app"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { CompanySnapshot } from "../../shared/company-contract"
import {
  companyReconnectDelay,
  transitionCompanyConnection,
} from "../../shared/connection-state"
import { classifyGlobalEvent, nextSignalRefreshDelay, streamStalled } from "../../shared/company-events"

const allResources = ["company", "agents", "work", "channels", "messages"] as const

const SIGNAL_REFRESH_MIN_INTERVAL_MS = 200
const SSE_HEARTBEAT_INTERVAL_MS = 10_000

type StreamStatus = "connecting" | "live" | "degraded"

const sseListeners = new Set<{
  refresh: (signal: boolean) => void
  status: (status: StreamStatus) => void
}>()
let sseSource: EventSource | undefined
let sseLastEventAt: number | undefined
let sseLastRefreshAt: number | undefined
let sseRefreshTimer: ReturnType<typeof setTimeout> | undefined
let sseStallTimer: ReturnType<typeof setInterval> | undefined
let sseEverConnected = false
let ssePendingSignal = false
let sseReleaseQueued = false

function notifySseRefresh(signal: boolean) {
  const listener = sseListeners.values().next().value
  listener?.refresh(signal)
}

function notifySseStatus(status: StreamStatus) {
  sseListeners.forEach((listener) => listener.status(status))
}

function scheduleSseRefresh(signal = false) {
  ssePendingSignal ||= signal
  if (sseRefreshTimer) return
  const delay = nextSignalRefreshDelay({
    now: Date.now(),
    lastRefreshAt: sseLastRefreshAt,
    minIntervalMs: SIGNAL_REFRESH_MIN_INTERVAL_MS,
  })
  sseRefreshTimer = setTimeout(() => {
    sseRefreshTimer = undefined
    sseLastRefreshAt = Date.now()
    const pendingSignal = ssePendingSignal
    ssePendingSignal = false
    notifySseRefresh(pendingSignal)
  }, delay)
}

function ensureSseSource() {
  if (sseSource) return
  if (typeof EventSource === "undefined") {
    notifySseStatus("degraded")
    return
  }
  notifySseStatus("connecting")
  const source = new EventSource("/api/agent-company/events")
  sseLastEventAt = Date.now()
  source.onopen = () => notifySseStatus("live")
  source.onmessage = (event) => {
    sseLastEventAt = Date.now()
    const kind = classifyGlobalEvent(String(event.data))
    if (kind === "connected") {
      scheduleSseRefresh(sseEverConnected)
      sseEverConnected = true
    }
    if (kind === "signal") scheduleSseRefresh(true)
  }
  source.onerror = () => notifySseStatus("degraded")
  sseSource = source
  sseStallTimer ??= setInterval(() => {
    if (
      sseLastEventAt === undefined ||
      !streamStalled({
        now: Date.now(),
        lastEventAt: sseLastEventAt,
        heartbeatIntervalMs: SSE_HEARTBEAT_INTERVAL_MS,
      })
    )
      return
    sseLastEventAt = Date.now()
    notifySseStatus("degraded")
    scheduleSseRefresh()
    sseSource?.close()
    sseSource = undefined
    ensureSseSource()
  }, SSE_HEARTBEAT_INTERVAL_MS)
}

function releaseSseSource() {
  if (sseListeners.size > 0 || sseReleaseQueued) return
  sseReleaseQueued = true
  queueMicrotask(() => {
    sseReleaseQueued = false
    if (sseListeners.size > 0) return
    sseSource?.close()
    sseSource = undefined
    if (sseRefreshTimer) clearTimeout(sseRefreshTimer)
    if (sseStallTimer) clearInterval(sseStallTimer)
    sseRefreshTimer = undefined
    sseStallTimer = undefined
    sseLastEventAt = undefined
    sseLastRefreshAt = undefined
    sseEverConnected = false
    ssePendingSignal = false
  })
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
  const signalVersion = useState("agent-company-signal-version", () => 0)
  const streamStatus = useState<StreamStatus>("agent-company-stream-status", () => "connecting")
  const mounted = ref(false)
  const reconnectTimer = ref<ReturnType<typeof setTimeout>>()
  const snapshotRefreshRunning = ref(false)
  const snapshotRefreshDirty = ref(false)

  function syncSnapshot() {
    if (request.error.value) {
      snapshot.value = failedSnapshot()
      connection.value = transitionCompanyConnection(connection.value, { type: "request_failed" })
      return
    }
    if (!request.data.value) return
    snapshot.value = request.data.value
    connection.value = transitionCompanyConnection(connection.value, {
      type: "snapshot_received",
      connection:
        request.data.value.connection === "recovering" || request.data.value.connection === "connecting"
          ? "disconnected"
          : request.data.value.connection,
    })
    if (
      request.data.value.connection === "ready"
      || (request.data.value.connection === "degraded" && !request.data.value.issue?.retryable)
    )
      reconnectAttempt.value = 0
  }

  watch([request.data, request.error], syncSnapshot, { immediate: true })

  async function refreshSnapshot(updateConnection: boolean) {
    if (snapshotRefreshRunning.value || request.pending.value) {
      snapshotRefreshDirty.value = true
      return
    }
    snapshotRefreshRunning.value = true
    if (updateConnection)
      connection.value = transitionCompanyConnection(connection.value, { type: "request_started" })
    await (async () => {
      do {
        snapshotRefreshDirty.value = false
        await request.refresh()
      } while (snapshotRefreshDirty.value)
    })().finally(() => {
      snapshotRefreshRunning.value = false
    })
  }

  async function refresh() {
    await refreshSnapshot(true)
  }

  watch(
    () => request.pending.value,
    (value) => {
      if (value || !snapshotRefreshDirty.value || snapshotRefreshRunning.value) return
      void refreshSnapshot(false)
    },
  )

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
        void refreshSnapshot(false)
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

  onMounted(() => {
    syncSnapshot()
    mounted.value = true
    scheduleReconnect()
  })

  // SSE 订阅与既有重连轮询并存：事件驱动的后台刷新不改写连接态（避免每次
  // 事件都闪现 recovering），结果到达后由快照 watcher 统一更新状态。
  const sseListener = {
    refresh(signal: boolean) {
      if (signal) signalVersion.value += 1
      void refreshSnapshot(false)
    },
    status(status: StreamStatus) {
      streamStatus.value = status
    },
  }

  onMounted(() => {
    sseListeners.add(sseListener)
    ensureSseSource()
  })

  onBeforeUnmount(() => {
    sseListeners.delete(sseListener)
    releaseSseSource()
    if (reconnectTimer.value) clearTimeout(reconnectTimer.value)
  })

  return {
    ...request,
    refresh,
    signalVersion,
    streamStatus,
    data: computed(() => ({
      ...(mounted.value ? snapshot.value : request.data.value ?? loadingSnapshot),
      connection: mounted.value
        ? connection.value
        : request.data.value?.connection ?? loadingSnapshot.connection,
    })),
  }
}
