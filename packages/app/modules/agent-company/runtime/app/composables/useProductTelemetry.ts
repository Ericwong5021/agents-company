import { useRuntimeConfig, useState } from "nuxt/app"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import {
  appendProductEvent,
  computeMetricBreakdowns,
  computeMetrics,
  metricDefinitionVersion,
  parseConsent,
  parseStoredEvents,
  productTelemetryConsentKey,
  productTelemetryStorageKey,
  sanitizeEventProps,
  serializeConsent,
  shouldReportRemote,
  type ProductEvent,
  type ProductEventProps,
  type ProductEventType,
  type TelemetryConsent,
} from "../../shared/product-telemetry"

export function useProductTelemetry() {
  const runtimeConfig = useRuntimeConfig()
  const events = useState<ProductEvent[]>("agent-company-product-telemetry-events", () => [])
  const consent = useState<TelemetryConsent>("agent-company-product-telemetry-consent", () => ({ enabled: false }))
  const hydrated = useState("agent-company-product-telemetry-hydrated", () => false)
  const reporting = ref(false)

  function load() {
    if (!import.meta.client) return
    events.value = parseStoredEvents(localStorage.getItem(productTelemetryStorageKey))
    consent.value = parseConsent(localStorage.getItem(productTelemetryConsentKey))
    hydrated.value = true
  }

  function persist() {
    if (!import.meta.client || !hydrated.value) return
    localStorage.setItem(productTelemetryStorageKey, JSON.stringify(events.value))
  }

  async function report(event: ProductEvent) {
    if (!shouldReportRemote(consent.value)) return
    reporting.value = true
    await $fetch("/api/agent-company/product-telemetry", {
      method: "POST",
      body: { consent: true, events: [event] },
    }).catch(() => undefined)
    reporting.value = false
  }

  function record(
    type: ProductEventType,
    input: { dedupeKey?: string; scenario?: string; props?: ProductEventProps } = {},
  ) {
    if (!import.meta.client) return
    if (!hydrated.value) load()
    if (
      input.dedupeKey
      && events.value.some(event => event.type === type && event.dedupeKey === input.dedupeKey)
    ) return
    const event = {
      type,
      at: new Date().toISOString(),
      version: String(runtimeConfig.public.agentCompanyVersion || "local"),
      scenario: input.scenario,
      dedupeKey: input.dedupeKey,
      props: sanitizeEventProps(input.props),
    }
    const next = appendProductEvent(events.value, event)
    events.value = next
    persist()
    void report(event)
  }

  function setConsent(enabled: boolean) {
    consent.value = { enabled, decidedAt: new Date().toISOString() }
    if (import.meta.client) localStorage.setItem(productTelemetryConsentKey, serializeConsent(consent.value))
  }

  function clear() {
    events.value = []
    if (import.meta.client) localStorage.removeItem(productTelemetryStorageKey)
  }

  function exportJSON() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      definitionVersion: metricDefinitionVersion,
      events: events.value,
      metrics: computeMetrics(events.value),
    }, null, 2)
  }

  function syncStorage(event: StorageEvent) {
    if (event.key === productTelemetryStorageKey) events.value = parseStoredEvents(event.newValue)
    if (event.key === productTelemetryConsentKey) consent.value = parseConsent(event.newValue)
  }

  onMounted(() => {
    load()
    window.addEventListener("storage", syncStorage)
  })
  onBeforeUnmount(() => window.removeEventListener("storage", syncStorage))

  return {
    events,
    consent,
    hydrated,
    reporting,
    metrics: computed(() => computeMetrics(events.value)),
    breakdowns: computed(() => computeMetricBreakdowns(events.value)),
    record,
    setConsent,
    clear,
    exportJSON,
  }
}
