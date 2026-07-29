<script setup lang="ts">
import { $fetch } from "ofetch"
import { computed, onMounted, reactive, ref, watch } from "vue"
import type { FounderStudioProjection, GovernanceAsset } from "@agents-company/sdk/v2/founder-os"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"
import {
  chooseDemo,
  onboardingStorageKey,
  parseOnboardingState,
  restartOnboarding,
  serializeOnboardingState,
  shouldEnterFirstGoal,
  type OnboardingState,
} from "../../../shared/onboarding"
import {
  buildConfigureRequest,
  buildModelsRequest,
  classifyProviderError,
  providerPreset,
  providerPresets,
  type DiscoveredModel,
  type ProviderErrorInfo,
  type ProviderPresetId,
} from "../../../shared/provider-wizard"

const { data: snapshot, pending, refresh } = useCompanySnapshot()

const connectionLabel = computed(() => ({
  connecting: "正在连接",
  ready: "已连接",
  degraded: "部分可用",
  disconnected: "未连接",
  recovering: "正在恢复",
})[snapshot.value.connection])

const presetId = ref<ProviderPresetId>("openai")
const preset = computed(() => providerPreset(presetId.value))
const initial = providerPreset("openai")
const draft = reactive({
  format: initial.format as "openai" | "anthropic",
  providerId: initial.providerId,
  baseUrl: initial.baseUrl,
  apiKey: "",
})
const headersText = ref("{}")
const discovered = ref<DiscoveredModel[]>([])
const selectedModel = ref("")
const testing = ref(false)
const saving = ref(false)
const errorInfo = ref<ProviderErrorInfo | null>(null)
const message = ref("")
const onboarding = ref<OnboardingState>(parseOnboardingState(null))
const founderStudio = ref<FounderStudioProjection | null>(null)
const studioLoading = ref(false)
const studioMessage = ref("")
const assetDraft = reactive({
  type: "principle" as GovernanceAsset["type"],
  content: "",
  rationale: "",
})

onMounted(() => {
  onboarding.value = parseOnboardingState(window.localStorage.getItem(onboardingStorageKey))
  loadFounderStudio()
})

async function loadFounderStudio() {
  if (!snapshot.value.company.id || studioLoading.value) return
  studioLoading.value = true
  founderStudio.value = await $fetch<FounderStudioProjection>("/api/agent-company/founder-studio", {
    query: { companyId: snapshot.value.company.id },
  }).catch(() => null)
  studioLoading.value = false
}

async function createAssetDraft() {
  if (!assetDraft.content.trim() || !assetDraft.rationale.trim() || studioLoading.value) return
  studioLoading.value = true
  studioMessage.value = ""
  await $fetch("/api/agent-company/founder-studio", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      type: assetDraft.type,
      scope: { kind: "company" },
      content: assetDraft.content,
      rationale: assetDraft.rationale,
      tags: [],
      authority: "ai_proposed",
      sourceRefs: [],
      createdBy: "local-founder-studio",
    },
  })
    .then(() => {
      assetDraft.content = ""
      assetDraft.rationale = ""
      studioMessage.value = "候选资产已保存为 ai_proposed / draft，尚未获得人工确认。"
    })
    .catch(() => {
      studioMessage.value = "候选资产保存失败。"
    })
  studioLoading.value = false
  await loadFounderStudio()
}

async function selectStudioSnapshot(snapshotId: string) {
  if (studioLoading.value) return
  studioLoading.value = true
  await $fetch("/api/agent-company/founder-studio-select", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      snapshotId,
      reason: "Founder Studio 手动选择历史 Snapshot",
      selectedBy: "local-founder-studio",
    },
  }).catch(() => undefined)
  studioLoading.value = false
  await loadFounderStudio()
}

watch(() => snapshot.value.company.id, (companyId) => {
  if (companyId) loadFounderStudio()
})

function persistOnboarding(next: OnboardingState) {
  onboarding.value = next
  if (import.meta.client) window.localStorage.setItem(onboardingStorageKey, serializeOnboardingState(next))
}

function restartGuide() {
  persistOnboarding(restartOnboarding())
  navigateTo("/welcome")
}

function enterDemo() {
  persistOnboarding(chooseDemo(onboarding.value, new Date().toISOString()))
  navigateTo("/welcome")
}

function selectPreset(id: ProviderPresetId) {
  presetId.value = id
  const next = providerPreset(id)
  draft.format = next.format
  draft.providerId = next.providerId
  draft.baseUrl = next.baseUrl
  draft.apiKey = ""
  headersText.value = "{}"
}

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

// 输入变化后旧的发现结果不再可信，避免误用过期模型列表提交。
watch(
  () => [draft.format, draft.baseUrl, draft.apiKey, draft.providerId, headersText.value],
  () => {
    discovered.value = []
    selectedModel.value = ""
  },
)

function transportMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "连接失败，请稍后重试"
  const data = "data" in error && typeof error.data === "object" && error.data !== null
    ? (error.data as Record<string, unknown>)
    : undefined
  if (typeof data?.statusMessage === "string") return data.statusMessage
  if (typeof data?.message === "string") return data.message
  if ("message" in error && typeof error.message === "string") return error.message
  return "连接失败，请稍后重试"
}

function currentDraft() {
  const headers = parseHeaders(headersText.value)
  if (!headers) {
    errorInfo.value = { kind: "config_invalid", message: "请求头必须是只含字符串值的 JSON 对象" }
    return
  }
  return { format: draft.format, providerId: draft.providerId, baseUrl: draft.baseUrl, apiKey: draft.apiKey, headers }
}

async function testConnection() {
  message.value = ""
  errorInfo.value = null
  if (preset.value.requiresKey && !draft.apiKey.trim()) {
    errorInfo.value = { kind: "invalid_credential", message: "请填写 API 密钥" }
    return
  }
  if (!draft.baseUrl.trim()) {
    errorInfo.value = { kind: "config_invalid", message: "请填写 API 地址" }
    return
  }
  const cur = currentDraft()
  if (!cur || testing.value) return

  testing.value = true
  const result = await $fetch("/api/agent-company/provider/models", { method: "POST", body: buildModelsRequest(cur) })
    .then((value: unknown) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }))
  testing.value = false
  if (!result.ok) {
    errorInfo.value = classifyProviderError({ message: transportMessage(result.error) })
    return
  }
  const body = result.value as {
    ok: boolean
    models?: DiscoveredModel[]
    error?: { name?: string; message?: string; status?: number }
  }
  if (!body.ok || !body.models) {
    errorInfo.value = classifyProviderError(body.error ?? {})
    return
  }
  discovered.value = body.models
  selectedModel.value = body.models[0]?.model_id ?? ""
  message.value = `连接成功，发现 ${body.models.length} 个可用模型`
}

async function saveProvider() {
  message.value = ""
  errorInfo.value = null
  if (!selectedModel.value) {
    errorInfo.value = { kind: "model_not_found", message: "请先测试连接并选择一个模型" }
    return
  }
  if (!draft.apiKey.trim()) {
    errorInfo.value = { kind: "invalid_credential", message: "请填写 API 密钥" }
    return
  }
  const cur = currentDraft()
  if (!cur || saving.value) return

  saving.value = true
  const result = await $fetch("/api/agent-company/provider", {
    method: "PUT",
    body: buildConfigureRequest(cur, selectedModel.value),
  })
    .then((value: unknown) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }))
  saving.value = false
  if (!result.ok) {
    errorInfo.value = classifyProviderError({ message: transportMessage(result.error) })
    return
  }
  const body = result.value as { ok: boolean; error?: { name?: string; message?: string; status?: number } }
  if (!body.ok) {
    errorInfo.value = classifyProviderError(body.error ?? {})
    return
  }
  draft.apiKey = ""
  discovered.value = []
  selectedModel.value = ""
  message.value = "模型服务已验证并绑定到当前公司"
  await refresh()
  // 首次真实路径：Provider 配置完成后直接进入目标输入，而非停留在设置页。
  if (
    shouldEnterFirstGoal(onboarding.value, {
      connected: ["ready", "degraded"].includes(snapshot.value.connection),
      providerConfigured: snapshot.value.company.providerConfigured !== false,
      hasWork: snapshot.value.work.length > 0,
    })
  ) {
    navigateTo("/inbox")
  }
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
                <h2>Founder Studio</h2>
                <p>治理资产与不可变 Snapshot 来自本地 Control Plane；authority 与 status 不会被隐藏。</p>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="刷新 Founder Studio"
                :loading="studioLoading"
                @click="loadFounderStudio"
              />
            </div>

            <p class="company-provider-form__message">
              人工确认：{{ founderStudio?.authorization.status ?? "not_confirmed" }} · 弱门禁，不自动提升 authority
            </p>

            <div class="company-provider-form company-provider-form__grid">
              <label>
                <span>资产类型</span>
                <select v-model="assetDraft.type">
                  <option value="principle">Principle</option>
                  <option value="heuristic">Heuristic</option>
                  <option value="boundary">Boundary</option>
                  <option value="rubric">Rubric</option>
                </select>
              </label>
              <label class="company-provider-form__wide">
                <span>候选内容</span>
                <textarea v-model="assetDraft.content" rows="3" />
              </label>
              <label class="company-provider-form__wide">
                <span>判断依据</span>
                <textarea v-model="assetDraft.rationale" rows="2" />
              </label>
              <div class="company-provider-form__actions company-provider-form__wide">
                <span>写入身份：ai_proposed · 状态：draft</span>
                <UButton
                  color="neutral"
                  :loading="studioLoading"
                  :disabled="!assetDraft.content.trim() || !assetDraft.rationale.trim()"
                  @click="createAssetDraft"
                >
                  保存候选资产
                </UButton>
              </div>
            </div>
            <p v-if="studioMessage" class="company-provider-form__message" role="status">{{ studioMessage }}</p>

            <div v-if="founderStudio?.assets.length" class="ac-founder-studio-list">
              <article v-for="asset in founderStudio.assets" :key="`${asset.id}:${asset.version}`">
                <div>
                  <strong>{{ asset.type }}</strong>
                  <span>{{ asset.authority }} · {{ asset.status }} · v{{ asset.version }}</span>
                </div>
                <p>{{ asset.content }}</p>
                <small>{{ asset.current ? "当前有效版本" : "历史或未生效版本" }}</small>
              </article>
            </div>
            <p v-else class="company-provider-form__message">尚无治理资产。</p>

            <div v-if="founderStudio?.snapshots.length" class="ac-founder-studio-list">
              <article v-for="item in founderStudio.snapshots" :key="item.id">
                <div>
                  <strong>Snapshot v{{ item.version }}</strong>
                  <span>{{ item.selected ? "当前选择" : "历史版本" }}</span>
                </div>
                <p>checksum {{ item.checksum }}</p>
                <UButton
                  v-if="!item.selected"
                  color="neutral"
                  variant="soft"
                  :loading="studioLoading"
                  @click="selectStudioSnapshot(item.id)"
                >
                  选择此版本
                </UButton>
              </article>
            </div>
          </section>

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

          <section class="company-settings-section company-provider-form ac-provider-wizard">
            <div class="company-settings-section__heading">
              <div>
                <h2>模型服务</h2>
                <p>选择服务、填写必要凭据并测试连接，密钥仅保存在本机。</p>
              </div>
            </div>

            <div class="ac-provider-presets" role="radiogroup" aria-label="选择模型服务">
              <button
                v-for="option in providerPresets"
                :key="option.id"
                type="button"
                role="radio"
                :aria-checked="presetId === option.id"
                class="ac-provider-preset"
                :data-active="presetId === option.id"
                @click="selectPreset(option.id)"
              >
                <span class="ac-provider-preset__label">{{ option.label }}</span>
                <span class="ac-provider-preset__desc">{{ option.description }}</span>
              </button>
            </div>

            <div class="company-provider-form__grid">
              <label v-if="preset.requiresKey" class="company-provider-form__wide">
                <span>API 密钥</span>
                <input
                  v-model="draft.apiKey"
                  type="password"
                  :placeholder="preset.keyHint"
                  autocomplete="new-password"
                >
              </label>
              <label v-if="preset.custom || preset.local" class="company-provider-form__wide">
                <span>API 地址</span>
                <input
                  v-model="draft.baseUrl"
                  type="url"
                  placeholder="https://provider.example.com/v1"
                  autocomplete="url"
                >
              </label>

              <details class="company-provider-form__wide ac-settings-disclosure">
                <summary>高级设置</summary>
                <div class="company-provider-form__grid">
                  <label>
                    <span>接口格式</span>
                    <select v-model="draft.format">
                      <option value="openai">OpenAI compatible</option>
                      <option value="anthropic">Anthropic compatible</option>
                    </select>
                  </label>
                  <label>
                    <span>服务标识</span>
                    <input v-model="draft.providerId" autocomplete="off">
                  </label>
                  <label v-if="!(preset.custom || preset.local)" class="company-provider-form__wide">
                    <span>API 地址</span>
                    <input v-model="draft.baseUrl" type="url" autocomplete="url">
                  </label>
                  <label class="company-provider-form__wide">
                    <span>请求头 JSON</span>
                    <textarea v-model="headersText" rows="3" spellcheck="false" />
                  </label>
                </div>
              </details>
            </div>

            <div class="ac-provider-actions">
              <UButton color="neutral" variant="soft" :loading="testing" @click="testConnection">测试连接</UButton>
              <span v-if="message" class="company-provider-form__message" role="status">{{ message }}</span>
            </div>

            <div v-if="discovered.length" class="ac-provider-models" role="radiogroup" aria-label="选择模型">
              <label
                v-for="model in discovered"
                :key="model.model_id"
                class="ac-provider-model"
                :data-active="selectedModel === model.model_id"
              >
                <input v-model="selectedModel" type="radio" name="ac-provider-model" :value="model.model_id">
                <span class="ac-provider-model__name">{{ model.name }}</span>
                <span class="ac-provider-model__id">{{ model.model_id }}</span>
              </label>
            </div>

            <p
              v-if="errorInfo"
              class="company-provider-form__message company-provider-form__message--error"
              role="alert"
            >
              {{ errorInfo.message }}
            </p>

            <div class="company-provider-form__actions">
              <span>当前：{{ snapshot.company.provider }}</span>
              <UButton color="neutral" :loading="saving" :disabled="!selectedModel" @click="saveProvider">
                验证并保存
              </UButton>
            </div>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>引导与演示</h2>
                <p>随时重新开始首次引导，或进入明确标注的演示；演示与真实数据、Provider、项目完全隔离。</p>
              </div>
            </div>
            <div class="ac-onboarding-controls">
              <UButton color="neutral" variant="soft" @click="restartGuide">重新开始引导</UButton>
              <UButton color="neutral" variant="outline" @click="enterDemo">进入演示</UButton>
            </div>
            <p class="company-provider-form__message">重新开始引导会清除本机的演示与引导标记，不影响任何真实公司数据。</p>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
