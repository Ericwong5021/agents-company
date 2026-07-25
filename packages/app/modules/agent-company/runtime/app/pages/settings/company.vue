<script setup lang="ts">
import { $fetch } from "ofetch"
import { computed, reactive, ref } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot, pending, refresh } = useCompanySnapshot()
const provider = reactive(useState("agent-company-provider-draft", () => ({
  format: "openai" as "openai" | "anthropic",
  providerID: "custom",
  baseURL: "",
  modelID: "",
  apiKey: "",
  headers: "{}",
})).value)
const saving = ref(false)
const providerMessage = ref("")
const providerError = ref("")
const connectionLabel = computed(() => ({
  connecting: "正在连接",
  ready: "已连接",
  degraded: "部分可用",
  disconnected: "未连接",
  recovering: "正在恢复",
})[snapshot.value.connection])

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
  if (typeof error !== "object" || error === null) return "模型服务配置失败"
  const data = "data" in error && typeof error.data === "object" && error.data !== null
    ? error.data as Record<string, unknown>
    : undefined
  if (typeof data?.message === "string") return data.message
  if (typeof data?.statusMessage === "string") return data.statusMessage
  if ("message" in error && typeof error.message === "string") return error.message
  return "模型服务配置失败"
}

async function saveProvider() {
  const headers = parseHeaders(provider.headers)
  providerError.value = headers ? "" : "请求头必须是只含字符串值的 JSON 对象"
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
  providerMessage.value = "模型服务已验证并绑定到当前公司"
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
          <p>管理本地运行连接与 Agent Company 使用的模型服务。</p>
        </header>

        <div class="company-settings-stack">
          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>本地运行</h2>
                <p>连接本机服务并读取当前公司的真实配置。</p>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="刷新本地运行状态"
                :loading="pending"
                @click="refresh()"
              />
            </div>
            <dl>
              <div>
                <dt>连接</dt>
                <dd>{{ connectionLabel }}</dd>
              </div>
              <div>
                <dt>公司</dt>
                <dd>{{ snapshot.company.name }}</dd>
              </div>
              <div>
                <dt>模型服务</dt>
                <dd>{{ snapshot.company.provider }}</dd>
              </div>
            </dl>
          </section>

          <CompanyConnectionState
            v-if="snapshot.connection !== 'ready' && snapshot.connection !== 'degraded'"
            :connection="snapshot.connection"
            :issue="snapshot.issue"
            :pending="pending"
            @retry="refresh()"
          />

          <form class="company-settings-section company-provider-form" @submit.prevent="saveProvider">
            <div class="company-settings-section__heading">
              <div>
                <h2>模型服务</h2>
                <p>连接兼容 OpenAI 或 Anthropic 的服务，密钥仅保存在本机。</p>
              </div>
            </div>

            <div class="company-provider-form__grid">
              <label>
                <span>接口格式</span>
                <select v-model="provider.format">
                  <option value="openai">OpenAI compatible</option>
                  <option value="anthropic">Anthropic compatible</option>
                </select>
              </label>
              <label>
                <span>模型</span>
                <input v-model="provider.modelID" required placeholder="model-id" autocomplete="off">
              </label>
              <label class="company-provider-form__wide">
                <span>API 地址</span>
                <input
                  v-model="provider.baseURL"
                  required
                  type="url"
                  placeholder="https://provider.example.com/"
                  autocomplete="url"
                >
              </label>
              <label class="company-provider-form__wide">
                <span>API 密钥</span>
                <input
                  v-model="provider.apiKey"
                  required
                  type="password"
                  placeholder="仅保存在本机"
                  autocomplete="new-password"
                >
              </label>
              <details class="company-provider-form__wide ac-settings-disclosure">
                <summary>高级设置</summary>
                <div class="company-provider-form__grid">
                  <label>
                    <span>服务标识</span>
                    <input v-model="provider.providerID" required autocomplete="off">
                  </label>
                  <label>
                    <span>请求头 JSON</span>
                    <textarea v-model="provider.headers" rows="3" spellcheck="false" />
                  </label>
                </div>
              </details>
            </div>

            <p v-if="providerError" class="company-provider-form__message company-provider-form__message--error" role="alert">
              {{ providerError }}
            </p>
            <p v-if="providerMessage" class="company-provider-form__message" role="status">{{ providerMessage }}</p>

            <div class="company-provider-form__actions">
              <span>当前：{{ snapshot.company.provider }}</span>
              <UButton type="submit" color="neutral" :loading="saving">验证并保存</UButton>
            </div>
          </form>

        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
