import { useFetch, useState } from "nuxt/app"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
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

  function synchronizeSnapshot() {
    if (request.error.value) {
      snapshot.value = failedSnapshot()
      connection.value = transitionCompanyConnection(connection.value, { type: "request_failed" })
      return
    }
    if (!request.data.value) return
    snapshot.value = request.data.value
    connection.value = transitionCompanyConnection(connection.value, {
      type: "snapshot_received",
      connection: request.data.value.connection === "recovering" || request.data.value.connection === "connecting"
        ? "disconnected"
        : request.data.value.connection,
    })
    if (
      request.data.value.connection === "ready"
      || (request.data.value.connection === "degraded" && !request.data.value.issue?.retryable)
    ) reconnectAttempt.value = 0
  }

  watch([request.data, request.error], synchronizeSnapshot, { immediate: true })

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

  onMounted(async () => {
    if (connection.value === "connecting") {
      await request
      synchronizeSnapshot()
    }
    scheduleReconnect()
  })

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
