<script setup lang="ts">
import { $fetch } from "ofetch"
import { reactive, ref } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
const provider = reactive({
  format: "openai" as "openai" | "anthropic",
  providerID: "custom",
  baseURL: "",
  modelID: "",
  apiKey: "",
  headers: "{}",
})
const saving = ref(false)
const providerMessage = ref("")
const providerError = ref("")

function parseHeaders(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
    if (!Object.values(parsed).every((entry) => typeof entry === "string")) return
    return parsed as Record<string, string>
  } catch {
    return
  }
}

function errorMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "Provider 配置失败"
  const data = "data" in error && typeof error.data === "object" && error.data !== null
    ? error.data as Record<string, unknown>
    : undefined
  if (typeof data?.message === "string") return data.message
  if (typeof data?.statusMessage === "string") return data.statusMessage
  if ("message" in error && typeof error.message === "string") return error.message
  return "Provider 配置失败"
}

async function saveProvider() {
  const headers = parseHeaders(provider.headers)
  providerError.value = headers ? "" : "Headers 必须是只含字符串值的 JSON 对象"
  providerMessage.value = ""
  if (!headers || saving.value) return

  saving.value = true
  const result = await $fetch("/api/agent-company/provider", {
    method: "PUT",
    body: {
      format: provider.format,
      provider_id: provider.providerID,
      base_url: provider.baseURL,
      model_id: provider.modelID,
      api_key: provider.apiKey,
      headers,
    },
  })
    .then(() => ({ ok: true as const }))
    .catch((error: unknown) => ({ ok: false as const, error }))
  saving.value = false
  if (!result.ok) {
    providerError.value = errorMessage(result.error)
    return
  }

  provider.apiKey = ""
  providerMessage.value = "Provider 已验证并绑定到当前公司"
  await refresh()
}
</script>

<template>
  <UDashboardPanel id="agent-company-settings" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="company-settings-page">
        <header class="company-settings-page__header">
          <h1>Settings</h1>
          <p>Manage your identity, memory, integrations, and company module.</p>
        </header>

        <nav class="company-settings-tabs" aria-label="Settings">
          <NuxtLink to="/settings/profile">Profile</NuxtLink>
          <NuxtLink to="/settings/integrations">Integrations</NuxtLink>
          <NuxtLink to="/settings/company" class="company-settings-tabs__active">Company</NuxtLink>
        </nav>

        <div class="company-settings-stack">
          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Control Plane</h2>
                <p>Local runtime connection and active company provider.</p>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="Refresh Control Plane"
                :loading="pending"
                @click="refresh()"
              />
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{{ snapshot.connection === "live" ? "Connected" : "Demo fallback" }}</dd>
              </div>
              <div>
                <dt>Company</dt>
                <dd>{{ snapshot.company.name }}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{{ snapshot.company.provider }}</dd>
              </div>
            </dl>
          </section>

          <form class="company-settings-section company-provider-form" @submit.prevent="saveProvider">
            <div class="company-settings-section__heading">
              <div>
                <h2>Model Provider</h2>
                <p>Configure an OpenAI- or Anthropic-compatible endpoint. The key is stored by the local Control Plane.</p>
              </div>
            </div>

            <div class="company-provider-form__grid">
              <label>
                <span>Format</span>
                <select v-model="provider.format">
                  <option value="openai">OpenAI compatible</option>
                  <option value="anthropic">Anthropic compatible</option>
                </select>
              </label>
              <label>
                <span>Provider ID</span>
                <input v-model="provider.providerID" required autocomplete="off">
              </label>
              <label class="company-provider-form__wide">
                <span>Endpoint</span>
                <input
                  v-model="provider.baseURL"
                  required
                  type="url"
                  placeholder="https://provider.example.com/"
                  autocomplete="url"
                >
              </label>
              <label>
                <span>Model</span>
                <input v-model="provider.modelID" required placeholder="model-id" autocomplete="off">
              </label>
              <label>
                <span>API key</span>
                <input
                  v-model="provider.apiKey"
                  required
                  type="password"
                  placeholder="Stored locally"
                  autocomplete="new-password"
                >
              </label>
              <label class="company-provider-form__wide">
                <span>Headers (JSON)</span>
                <textarea v-model="provider.headers" rows="3" spellcheck="false" />
              </label>
            </div>

            <p v-if="providerError" class="company-provider-form__message company-provider-form__message--error" role="alert">
              {{ providerError }}
            </p>
            <p v-if="providerMessage" class="company-provider-form__message" role="status">{{ providerMessage }}</p>

            <div class="company-provider-form__actions">
              <span>当前：{{ snapshot.company.provider }}</span>
              <UButton type="submit" color="neutral" :loading="saving">Verify and save</UButton>
            </div>
          </form>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Source protection</h2>
                <p>The upstream Eve template is verified against its import manifest.</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>Extension method</dt>
                <dd>Nuxt module + client plugin</dd>
              </div>
              <div>
                <dt>Template edits</dt>
                <dd>None</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
