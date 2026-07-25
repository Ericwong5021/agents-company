import { useFetch, useState } from "nuxt/app"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import type { CompanySnapshot } from "../../shared/company-contract"
import {
  companyReconnectDelay,
  transitionCompanyConnection,
} from "../../shared/connection-state"

const allResources = ["company", "agents", "work", "channels", "messages"] as const

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
      if (value.connection === "ready" || value.connection === "degraded") reconnectAttempt.value = 0
    },
    { immediate: true },
  )

  async function refresh() {
    if (request.pending.value) return
    connection.value = transitionCompanyConnection(connection.value, { type: "request_started" })
    await request.refresh()
  }

  watch(
    () => [connection.value, snapshot.value.issue?.retryable] as const,
    ([state, retryable]) => {
      if (reconnectTimer.value) clearTimeout(reconnectTimer.value)
      if (!import.meta.client || state !== "disconnected" || !retryable) return
      reconnectTimer.value = setTimeout(() => {
        reconnectAttempt.value += 1
        void refresh()
      }, companyReconnectDelay(reconnectAttempt.value))
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
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
