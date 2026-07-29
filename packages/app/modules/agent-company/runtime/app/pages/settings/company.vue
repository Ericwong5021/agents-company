<script setup lang="ts">
import { $fetch } from "ofetch"
import { computed, onMounted, reactive, ref, watch } from "vue"
import type {
  FounderAdvisorReadiness,
  FounderCalibrationItem,
  FounderControlCenterProjection,
  FounderOSModeState,
  FounderStudioProjection,
  GovernanceAsset,
} from "@agents-company/sdk/v2/founder-os"
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
const founderControl = ref<FounderControlCenterProjection | null>(null)
const founderModes = ref<FounderOSModeState | null>(null)
const advisorReadiness = ref<FounderAdvisorReadiness | null>(null)
const studioLoading = ref(false)
const controlLoading = ref(false)
const modeLoading = ref(false)
const advisorLoading = ref(false)
const studioMessage = ref("")
const modeMessage = ref("")
const advisorMessage = ref("")
const assetDraft = reactive({
  type: "principle" as GovernanceAsset["type"],
  content: "",
  rationale: "",
  authority: "ai_proposed" as "ai_proposed" | "external_source",
  sourceRefId: "",
  dimensions: "",
  tags: "",
})
const snapshotDraft = reactive({
  profileSummary: "",
  promptTemplateVersion: "founder-studio-v1",
  modelConfigRef: "company-default-model",
  retrievalConfigRef: "founder-assets-v1",
  permissionConfigRef: "company-scope-v1",
})
const calibrationDraft = reactive({
  kind: "accept" as FounderCalibrationItem["kind"],
  prompt: "",
  firstArtifactId: "",
  firstLabel: "",
  secondArtifactId: "",
  secondLabel: "",
})
const studioAssets = computed(() =>
  (founderStudio.value?.assets ?? []).filter(
    (asset, index, assets) =>
      asset.current || assets.findIndex((candidate) => candidate.id === asset.id) === index,
  ),
)
function isLatestAssetVersion(asset: GovernanceAsset) {
  return founderStudio.value?.assets.find((candidate) => candidate.id === asset.id)?.version === asset.version
}
const founderModeOptions = computed(() => {
  const globalOrder = ["off", "shadow", "advisor", "green-delegated", "yellow-delegated"] as const
  const maximum = globalOrder.indexOf(founderModes.value?.globalMaximum.founderTwinMode ?? "off")
  return [
    { value: "off" as const, label: "off", disabled: false },
    { value: "shadow" as const, label: "shadow", disabled: maximum < 1 },
    {
      value: "advisor" as const,
      label: `advisor · ${advisorReadiness.value?.status ?? "not_confirmed"}`,
      disabled: true,
    },
  ]
})
const commonsModeOptions = computed(() => {
  const order = ["off", "ingest-only", "reading"] as const
  const globalOrder = ["off", "ingest-only", "reading", "belief-loop"] as const
  const maximum = globalOrder.indexOf(founderModes.value?.globalMaximum.companyCommonsMode ?? "off")
  return order.map((value, index) => ({ value, disabled: index > maximum }))
})
const modeDraft = reactive({
  founderTwinMode: "off" as "off" | "shadow",
  companyCommonsMode: "off" as "off" | "ingest-only" | "reading",
})
const advisorDraft = reactive({
  benchmarkReportId: "",
  exactCommitSha: "",
  worktreeRunId: "",
  authorizationEventId: "",
})

onMounted(() => {
  onboarding.value = parseOnboardingState(window.localStorage.getItem(onboardingStorageKey))
  loadFounderStudio()
  loadFounderControl()
  loadFounderModes()
  loadAdvisorReadiness()
})

async function loadFounderStudio() {
  if (!snapshot.value.company.id || studioLoading.value) return
  studioLoading.value = true
  founderStudio.value = await $fetch<FounderStudioProjection>("/api/agent-company/founder-studio", {
    query: { companyId: snapshot.value.company.id },
  }).catch(() => null)
  if (!snapshotDraft.profileSummary && founderStudio.value?.snapshots[0]?.profileSummary)
    snapshotDraft.profileSummary = founderStudio.value.snapshots[0].profileSummary
  studioLoading.value = false
}

async function loadFounderControl() {
  if (!snapshot.value.company.id || controlLoading.value) return
  controlLoading.value = true
  founderControl.value = await $fetch<FounderControlCenterProjection>("/api/agent-company/founder-control-center", {
    query: { companyId: snapshot.value.company.id },
  }).catch(() => null)
  controlLoading.value = false
}

async function loadFounderModes() {
  if (!snapshot.value.company.id || modeLoading.value) return
  modeLoading.value = true
  founderModes.value = await $fetch<FounderOSModeState>("/api/agent-company/founder-modes").catch(() => null)
  if (founderModes.value) {
    modeDraft.founderTwinMode =
      founderModes.value.company.founderTwinMode === "shadow"
      && founderModes.value.globalMaximum.founderTwinMode !== "off"
        ? "shadow"
        : "off"
    modeDraft.companyCommonsMode = ["off", "ingest-only", "reading"].includes(founderModes.value.company.companyCommonsMode)
      ? founderModes.value.company.companyCommonsMode as typeof modeDraft.companyCommonsMode
      : "reading"
  }
  modeLoading.value = false
}

async function loadAdvisorReadiness() {
  if (!snapshot.value.company.id || advisorLoading.value) return
  advisorLoading.value = true
  advisorReadiness.value = await $fetch<FounderAdvisorReadiness>(
    "/api/agent-company/founder-advisor-readiness",
    { query: { companyId: snapshot.value.company.id } },
  ).catch(() => null)
  if (!advisorDraft.benchmarkReportId && advisorReadiness.value?.benchmarkReportId)
    advisorDraft.benchmarkReportId = advisorReadiness.value.benchmarkReportId
  advisorLoading.value = false
}

async function confirmAdvisorReadiness() {
  if (
    advisorLoading.value
    || !advisorDraft.benchmarkReportId.trim()
    || !/^[a-f0-9]{40}$/.test(advisorDraft.exactCommitSha)
    || !advisorDraft.worktreeRunId.trim()
    || !advisorDraft.authorizationEventId.trim()
  )
    return
  advisorLoading.value = true
  advisorMessage.value = ""
  advisorReadiness.value = await $fetch<FounderAdvisorReadiness>(
    "/api/agent-company/founder-advisor-readiness",
    {
      method: "POST",
      body: {
        schemaVersion: 1,
        companyId: snapshot.value.company.id,
        idempotencyKey: crypto.randomUUID(),
        benchmarkReportId: advisorDraft.benchmarkReportId,
        exactCommit: {
          sha: advisorDraft.exactCommitSha,
          worktreeRunId: advisorDraft.worktreeRunId,
        },
        authorizationEventId: advisorDraft.authorizationEventId,
        actor: { kind: "human", id: "local_user" },
      },
    },
  ).then(
    (value) => {
      advisorMessage.value = "W4 readiness 已确认，Company 模式已由 shadow 受控提升为 advisor。"
      return value
    },
    () => {
      advisorMessage.value = "Advisor 未开启，请核对 exact commit、三项指标与人工授权事件。"
      return advisorReadiness.value
    },
  )
  advisorLoading.value = false
  await Promise.all([loadFounderModes(), loadFounderControl()])
}

async function saveFounderModes() {
  if (modeLoading.value) return
  modeLoading.value = true
  modeMessage.value = ""
  founderModes.value = await $fetch<FounderOSModeState>("/api/agent-company/founder-modes", {
    method: "PUT",
    body: modeDraft,
  }).then(
    (value) => {
      modeMessage.value = "公司模式已保存，实际能力仍受全局上限约束。"
      return value
    },
    () => {
      modeMessage.value = "模式未保存，请检查全局上限与 Delegation Readiness。"
      return founderModes.value
    },
  )
  modeLoading.value = false
  await loadFounderControl()
}

async function createAssetDraft() {
  if (!assetDraft.content.trim() || !assetDraft.rationale.trim() || studioLoading.value) return
  const caseType = ["taste_reference", "taste_anti_reference", "decision_case", "rubric"].includes(assetDraft.type)
  if (caseType && (!assetDraft.sourceRefId.trim() || !assetDraft.dimensions.trim())) {
    studioMessage.value = "品味、案例与 Rubric 需要原始 Artifact ID 和至少一个评估维度。"
    return
  }
  studioLoading.value = true
  studioMessage.value = ""
  await $fetch(caseType
    ? "/api/agent-company/founder-studio/cases"
    : "/api/agent-company/founder-studio", {
    method: "POST",
    body: caseType
      ? {
          companyId: snapshot.value.company.id,
          kind: assetDraft.type,
          scope: { kind: "company" },
          content: assetDraft.content,
          rationale: assetDraft.rationale,
          dimensions: assetDraft.dimensions.split(",").map((value) => value.trim()).filter(Boolean),
          sourceRefs: [{ kind: "artifact", id: assetDraft.sourceRefId.trim() }],
          authority: assetDraft.authority,
          createdBy: "local-founder-studio",
        }
      : {
          companyId: snapshot.value.company.id,
          type: assetDraft.type,
          scope: { kind: "company" },
          content: assetDraft.content,
          rationale: assetDraft.rationale,
          tags: assetDraft.tags.split(",").map((value) => value.trim()).filter(Boolean),
          authority: assetDraft.authority,
          sourceRefs: assetDraft.sourceRefId.trim()
            ? [{ kind: "artifact", id: assetDraft.sourceRefId.trim() }]
            : [],
          createdBy: "local-founder-studio",
        },
  })
    .then(() => {
      assetDraft.content = ""
      assetDraft.rationale = ""
      assetDraft.sourceRefId = ""
      assetDraft.dimensions = ""
      assetDraft.tags = ""
      studioMessage.value =
        assetDraft.authority === "external_source"
          ? "外部来源候选已保存为 external_source / draft，尚未获得人工确认。"
          : "AI 候选已保存为 ai_proposed / draft，尚未获得人工确认。"
    })
    .catch(() => {
      studioMessage.value = "候选资产保存失败。"
    })
  studioLoading.value = false
  await loadFounderStudio()
}

async function reviseAsset(asset: GovernanceAsset) {
  const content = window.prompt("输入修订后的内容", asset.content)
  if (!content?.trim()) return
  const rationale = window.prompt("输入本次修订依据", asset.rationale)
  if (!rationale?.trim()) return
  studioLoading.value = true
  await $fetch(`/api/agent-company/founder-studio/assets/${encodeURIComponent(asset.id)}/versions`, {
    method: "POST",
    body: {
      baseVersion: asset.version,
      content,
      rationale,
      tags: asset.tags,
      authority: "ai_proposed",
      status: "draft",
      sourceRefs: asset.sourceRefs,
      actorKind: "ai",
      createdBy: "local-founder-studio",
    },
  }).then(
    () => studioMessage.value = "修订已追加为 ai_proposed / draft。",
    () => studioMessage.value = "修订未写入，请刷新后重试。",
  )
  studioLoading.value = false
  await loadFounderStudio()
}

async function confirmAsset(asset: GovernanceAsset) {
  const reason = window.prompt("输入人工确认依据，确认后该版本进入 active")
  if (!reason?.trim()) return
  studioLoading.value = true
  await $fetch(`/api/agent-company/founder-studio/assets/${encodeURIComponent(asset.id)}/versions`, {
    method: "POST",
    body: {
      baseVersion: asset.version,
      content: asset.content,
      rationale: `${asset.rationale}\n\n人工确认：${reason}`,
      tags: asset.tags,
      authority: "human_confirmed",
      status: "active",
      sourceRefs: asset.sourceRefs,
      actorKind: "human",
      createdBy: "local_user",
      confirmation: {
        eventId: `founder-studio-confirmation:${crypto.randomUUID()}`,
        confirmedBy: "local_user",
      },
    },
  }).then(
    () => studioMessage.value = "人工确认事件已记录，新版本已激活。",
    () => studioMessage.value = "确认未写入，AI 或外部来源不能自行提升 authority。",
  )
  studioLoading.value = false
  await loadFounderStudio()
}

async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function compileStudioSnapshot() {
  if (!snapshotDraft.profileSummary.trim() || studioLoading.value) return
  studioLoading.value = true
  const activeAssets = (founderStudio.value?.assets ?? [])
    .filter((asset) => asset.current && asset.status === "active")
    .map((asset) => ({
      id: asset.id,
      version: asset.version,
      type: asset.type,
      content: asset.content,
    }))
    .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`))
  await $fetch("/api/agent-company/founder-studio/snapshots", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      profileSummary: snapshotDraft.profileSummary,
      promptTemplateVersion: snapshotDraft.promptTemplateVersion,
      modelConfigRef: snapshotDraft.modelConfigRef,
      retrievalConfigRef: snapshotDraft.retrievalConfigRef,
      permissionConfigRef: snapshotDraft.permissionConfigRef,
      compiledPromptHash: await sha256(JSON.stringify({
        profileSummary: snapshotDraft.profileSummary,
        promptTemplateVersion: snapshotDraft.promptTemplateVersion,
        assets: activeAssets,
      })),
      scope: { kind: "company" },
      createdBy: "local-founder-studio",
    },
  }).then(
    () => studioMessage.value = "不可变 Snapshot 已编译，明文 Prompt 未持久化。",
    () => studioMessage.value = "Snapshot 未编译，请确认已有激活资产和完整 Profile。",
  )
  studioLoading.value = false
  await loadFounderStudio()
}

async function enqueueCalibration() {
  if (
    !calibrationDraft.prompt.trim()
    || !calibrationDraft.firstArtifactId.trim()
    || !calibrationDraft.firstLabel.trim()
    || (
      calibrationDraft.kind === "ab"
      && (!calibrationDraft.secondArtifactId.trim() || !calibrationDraft.secondLabel.trim())
    )
    || studioLoading.value
  )
    return
  studioLoading.value = true
  await $fetch("/api/agent-company/founder-studio/calibrations", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      kind: calibrationDraft.kind,
      scope: { kind: "company" },
      prompt: calibrationDraft.prompt,
      candidates: [
        { artifactId: calibrationDraft.firstArtifactId, label: calibrationDraft.firstLabel },
        ...(calibrationDraft.kind === "ab"
          ? [{ artifactId: calibrationDraft.secondArtifactId, label: calibrationDraft.secondLabel }]
          : []),
      ],
      createdBy: "local-founder-studio",
    },
  }).then(
    () => {
      calibrationDraft.prompt = ""
      calibrationDraft.firstArtifactId = ""
      calibrationDraft.firstLabel = ""
      calibrationDraft.secondArtifactId = ""
      calibrationDraft.secondLabel = ""
      studioMessage.value = "校准项已进入人工队列。"
    },
    () => studioMessage.value = "校准项未写入，请检查候选 Artifact。",
  )
  studioLoading.value = false
  await loadFounderStudio()
}

async function respondCalibration(
  item: FounderCalibrationItem,
  response: "accept" | "reject" | "prefer_first" | "prefer_second",
) {
  const reason = window.prompt("输入本次人工选择的原因")
  if (!reason?.trim()) return
  studioLoading.value = true
  await $fetch("/api/agent-company/founder-studio/calibration-responses", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      requestId: item.id,
      response,
      reason,
      actorKind: "human",
      confirmationEventId: `founder-calibration:${crypto.randomUUID()}`,
      confirmedBy: "local_user",
    },
  }).then(
    () => studioMessage.value = "人工校准已追加，不会自动激活治理资产。",
    () => studioMessage.value = "校准响应未写入。",
  )
  studioLoading.value = false
  await loadFounderStudio()
}

async function selectStudioSnapshot(snapshotId: string) {
  if (studioLoading.value) return
  studioLoading.value = true
  await $fetch("/api/agent-company/founder-studio/snapshot-selection", {
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
  if (!companyId) return
  loadFounderStudio()
  loadFounderControl()
  loadFounderModes()
  loadAdvisorReadiness()
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
                <h2>Founder Control Center</h2>
                <p>只读显示代理模式、待办与校准趋势；未获授权时不能在这里提高模式。</p>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="刷新 Founder Control Center"
                :loading="controlLoading"
                @click="loadFounderControl"
              />
            </div>

            <p class="company-provider-form__message">
              {{ founderControl?.principal.displayName ?? "AI 大东 · 创始人代理" }}
              · 授权 {{ founderControl?.authorization.status ?? "unavailable" }}
              · 模式提升 {{ founderControl?.authorization.canRaiseModeFromUI ? "可用" : "已禁用" }}
            </p>

            <dl>
              <div>
                <dt>当前有效模式</dt>
                <dd>{{ founderControl?.mode.effective.founderTwinMode ?? "off" }}</dd>
              </div>
              <div>
                <dt>待处理决定</dt>
                <dd>{{ founderControl?.pending.proposedDecisions ?? 0 }}</dd>
              </div>
              <div>
                <dt>红灯待办</dt>
                <dd>{{ founderControl?.pending.redDecisions ?? 0 }}</dd>
              </div>
              <div>
                <dt>停止失败</dt>
                <dd>{{ founderControl?.pending.failedStops ?? 0 }}</dd>
              </div>
              <div>
                <dt>Shadow 对比</dt>
                <dd>{{ founderControl?.trends.shadowComparisons ?? 0 }}</dd>
              </div>
              <div>
                <dt>真实接管</dt>
                <dd>{{ founderControl?.trends.takeoverEvents ?? 0 }}</dd>
              </div>
            </dl>

            <NuxtLink to="/company/board" class="company-text-link">打开董事会治理承载面</NuxtLink>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Founder OS 模式</h2>
                <p>这里写入 Company 级原始模式，实际能力始终取全局上限与公司设置中更严格的一项。</p>
              </div>
              <span class="ac-studio-status">effective {{ founderModes?.effective.founderTwinMode ?? "off" }}</span>
            </div>

            <div class="company-provider-form company-provider-form__grid">
              <label>
                <span>Founder Twin</span>
                <select v-model="modeDraft.founderTwinMode">
                  <option
                    v-for="option in founderModeOptions"
                    :key="option.value"
                    :value="option.value"
                    :disabled="option.disabled"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <small>Advisor 与 Green/Yellow 只能通过各自的 Delegation Readiness 受控路径开启。</small>
              </label>
              <label>
                <span>Company Commons</span>
                <select v-model="modeDraft.companyCommonsMode">
                  <option
                    v-for="option in commonsModeOptions"
                    :key="option.value"
                    :value="option.value"
                    :disabled="option.disabled"
                  >
                    {{ option.value === "reading" ? "interpreting" : option.value }}
                  </option>
                </select>
                <small>belief-loop 不在此入口开放。</small>
              </label>
              <div class="company-provider-form__actions company-provider-form__wide">
                <span>
                  全局上限：
                  {{ founderModes?.globalMaximum.founderTwinMode ?? "off" }}
                  /
                  {{ founderModes?.globalMaximum.companyCommonsMode ?? "off" }}
                </span>
                <UButton color="neutral" :loading="modeLoading" @click="saveFounderModes">
                  保存公司模式
                </UButton>
              </div>
            </div>
            <p v-if="modeMessage" class="company-provider-form__message" role="status">{{ modeMessage }}</p>

            <div class="ac-advisor-readiness" :data-status="advisorReadiness?.status ?? 'not_confirmed'">
              <div class="ac-advisor-readiness__heading">
                <div>
                  <span>W4 Advisor readiness</span>
                  <strong>{{ advisorReadiness?.status ?? "not_confirmed" }}</strong>
                </div>
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-refresh-cw"
                  aria-label="刷新 Advisor readiness"
                  :loading="advisorLoading"
                  @click="loadAdvisorReadiness"
                />
              </div>
              <dl class="ac-advisor-readiness__metrics">
                <div>
                  <dt>确认样本</dt>
                  <dd>{{ advisorReadiness?.metrics.confirmedSampleCount ?? 0 }}</dd>
                </div>
                <div>
                  <dt>红灯召回</dt>
                  <dd>{{ advisorReadiness?.metrics.redRecall === null || advisorReadiness?.metrics.redRecall === undefined ? "missing" : `${Math.round(advisorReadiness.metrics.redRecall * 100)}%` }}</dd>
                </div>
                <div>
                  <dt>追溯率</dt>
                  <dd>{{ advisorReadiness?.metrics.traceabilityRate === null || advisorReadiness?.metrics.traceabilityRate === undefined ? "missing" : `${Math.round(advisorReadiness.metrics.traceabilityRate * 100)}%` }}</dd>
                </div>
                <div>
                  <dt>历史一致</dt>
                  <dd>{{ advisorReadiness?.metrics.historicalAgreementRate === null || advisorReadiness?.metrics.historicalAgreementRate === undefined ? "missing" : `${Math.round(advisorReadiness.metrics.historicalAgreementRate * 100)}%` }}</dd>
                </div>
              </dl>
              <p v-if="advisorReadiness?.failClosedReasons.length" class="company-provider-form__message">
                {{ advisorReadiness.failClosedReasons.join(" ") }}
              </p>
              <details v-if="advisorReadiness?.status !== 'ready'">
                <summary>提交受控 readiness 证据</summary>
                <div class="company-provider-form company-provider-form__grid">
                  <label>
                    <span>Benchmark report ID</span>
                    <input v-model="advisorDraft.benchmarkReportId">
                  </label>
                  <label>
                    <span>W4 exact commit SHA</span>
                    <input v-model="advisorDraft.exactCommitSha" maxlength="40">
                  </label>
                  <label>
                    <span>Merged WorktreeRun ID</span>
                    <input v-model="advisorDraft.worktreeRunId">
                  </label>
                  <label>
                    <span>Human authorization event ID</span>
                    <input v-model="advisorDraft.authorizationEventId">
                  </label>
                  <div class="company-provider-form__actions company-provider-form__wide">
                    <span>缺少样本或任一阈值未达标时保持 fail-closed。</span>
                    <UButton
                      color="neutral"
                      :loading="advisorLoading"
                      :disabled="
                        !advisorDraft.benchmarkReportId.trim()
                        || !/^[a-f0-9]{40}$/.test(advisorDraft.exactCommitSha)
                        || !advisorDraft.worktreeRunId.trim()
                        || !advisorDraft.authorizationEventId.trim()
                      "
                      @click="confirmAdvisorReadiness"
                    >
                      验证并开启 Advisor
                    </UButton>
                  </div>
                </div>
              </details>
              <p v-if="advisorMessage" class="company-provider-form__message" role="status">{{ advisorMessage }}</p>
            </div>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>Founder Studio</h2>
                <p>Profile、治理资产、品味校准与不可变 Snapshot 共享同一条本地事实链。</p>
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

            <div class="ac-studio-workbench">
              <section class="ac-studio-pane">
                <div class="ac-studio-pane__heading">
                  <div>
                    <span>01 · Governance assets</span>
                    <h3>候选规则与品味案例</h3>
                  </div>
                  <strong>{{ studioAssets.length }}</strong>
                </div>

                <div class="company-provider-form company-provider-form__grid">
                  <label>
                    <span>资产类型</span>
                    <select v-model="assetDraft.type">
                      <option value="constitution">Constitution</option>
                      <option value="principle">Principle</option>
                      <option value="heuristic">Heuristic</option>
                      <option value="boundary">Boundary</option>
                      <option value="taste_reference">Taste reference</option>
                      <option value="taste_anti_reference">Taste anti-reference</option>
                      <option value="rubric">Rubric</option>
                      <option value="decision_case">Decision case</option>
                    </select>
                  </label>
                  <label>
                    <span>草稿来源</span>
                    <select v-model="assetDraft.authority">
                      <option value="ai_proposed">AI proposal</option>
                      <option value="external_source">External source</option>
                    </select>
                  </label>
                  <label class="company-provider-form__wide">
                    <span>候选内容</span>
                    <textarea v-model="assetDraft.content" rows="4" />
                  </label>
                  <label class="company-provider-form__wide">
                    <span>判断依据</span>
                    <textarea v-model="assetDraft.rationale" rows="3" />
                  </label>
                  <label>
                    <span>原始 Artifact ID</span>
                    <input v-model="assetDraft.sourceRefId" placeholder="品味与案例必填">
                  </label>
                  <label v-if="['taste_reference', 'taste_anti_reference', 'decision_case', 'rubric'].includes(assetDraft.type)">
                    <span>评估维度</span>
                    <input v-model="assetDraft.dimensions" placeholder="逗号分隔">
                  </label>
                  <label v-else>
                    <span>标签</span>
                    <input v-model="assetDraft.tags" placeholder="逗号分隔">
                  </label>
                  <div class="company-provider-form__actions company-provider-form__wide">
                    <span>所有新内容先进入 draft。</span>
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

                <div v-if="studioAssets.length" class="ac-founder-studio-list">
                  <article
                    v-for="asset in studioAssets"
                    :id="`asset-${asset.id}-${asset.version}`"
                    :key="`${asset.id}:${asset.version}`"
                  >
                    <div>
                      <strong>{{ asset.type }}</strong>
                      <span>{{ asset.authority }} · {{ asset.status }} · v{{ asset.version }}</span>
                    </div>
                    <p>{{ asset.content }}</p>
                    <small>
                      {{ asset.current ? "当前激活版本" : "候选或历史版本" }}
                      <template v-if="asset.approvedAt"> · approved {{ new Date(asset.approvedAt).toLocaleDateString("zh-CN") }}</template>
                    </small>
                    <div class="ac-studio-row-actions">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        :loading="studioLoading"
                        :disabled="!isLatestAssetVersion(asset)"
                        @click="reviseAsset(asset)"
                      >
                        修订为草稿
                      </UButton>
                      <UButton
                        v-if="asset.status === 'draft' && isLatestAssetVersion(asset)"
                        color="neutral"
                        variant="soft"
                        :loading="studioLoading"
                        @click="confirmAsset(asset)"
                      >
                        人工确认并激活
                      </UButton>
                    </div>
                  </article>
                </div>
                <p v-else class="company-provider-form__message">尚无治理资产。</p>
              </section>

              <section class="ac-studio-pane">
                <div class="ac-studio-pane__heading">
                  <div>
                    <span>02 · Founder profile</span>
                    <h3>编译不可变 Snapshot</h3>
                  </div>
                  <strong>{{ founderStudio?.snapshots.length ?? 0 }}</strong>
                </div>

                <div class="company-provider-form company-provider-form__grid">
                  <label class="company-provider-form__wide">
                    <span>Founder Profile</span>
                    <textarea
                      v-model="snapshotDraft.profileSummary"
                      rows="5"
                      placeholder="只写稳定的创始人判断方式与边界，不放入无关私密上下文"
                    />
                  </label>
                  <label>
                    <span>Prompt template</span>
                    <input v-model="snapshotDraft.promptTemplateVersion">
                  </label>
                  <label>
                    <span>Model config</span>
                    <input v-model="snapshotDraft.modelConfigRef">
                  </label>
                  <label>
                    <span>Retrieval config</span>
                    <input v-model="snapshotDraft.retrievalConfigRef">
                  </label>
                  <label>
                    <span>Permission config</span>
                    <input v-model="snapshotDraft.permissionConfigRef">
                  </label>
                  <div class="company-provider-form__actions company-provider-form__wide">
                    <span>Snapshot 只引用已激活资产，不保存编译 Prompt 明文。</span>
                    <UButton
                      color="neutral"
                      :loading="studioLoading"
                      :disabled="!snapshotDraft.profileSummary.trim()"
                      @click="compileStudioSnapshot"
                    >
                      编译 Snapshot
                    </UButton>
                  </div>
                </div>

                <div v-if="founderStudio?.snapshots.length" class="ac-founder-studio-list">
                  <article v-for="item in founderStudio.snapshots" :key="item.id">
                    <div>
                      <strong>Snapshot v{{ item.version }}</strong>
                      <span>{{ item.selected ? "当前选择" : "历史版本" }}</span>
                    </div>
                    <p class="ac-studio-snapshot-hash">{{ item.checksum }}</p>
                    <small>
                      principles {{ item.activePrincipleIds.length }}
                      · heuristics {{ item.activeHeuristicIds.length }}
                      · cases {{ item.decisionCaseIds.length }}
                      · taste {{ item.tasteExampleIds.length }}
                      · rubrics {{ item.rubricIds.length }}
                    </small>
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

              <section class="ac-studio-pane ac-studio-pane--wide">
                <div class="ac-studio-pane__heading">
                  <div>
                    <span>03 · Calibration queue</span>
                    <h3>记录接受、拒绝与 A/B 偏好</h3>
                  </div>
                  <strong>{{ founderStudio?.calibrationQueue.filter(item => item.status === "pending").length ?? 0 }}</strong>
                </div>

                <div class="company-provider-form company-provider-form__grid">
                  <label>
                    <span>校准类型</span>
                    <select v-model="calibrationDraft.kind">
                      <option value="accept">接受</option>
                      <option value="reject">拒绝</option>
                      <option value="ab">A/B</option>
                    </select>
                  </label>
                  <label class="company-provider-form__wide">
                    <span>判断问题</span>
                    <textarea v-model="calibrationDraft.prompt" rows="2" />
                  </label>
                  <label>
                    <span>候选 A Artifact ID</span>
                    <input v-model="calibrationDraft.firstArtifactId">
                  </label>
                  <label>
                    <span>候选 A 标签</span>
                    <input v-model="calibrationDraft.firstLabel">
                  </label>
                  <label v-if="calibrationDraft.kind === 'ab'">
                    <span>候选 B Artifact ID</span>
                    <input v-model="calibrationDraft.secondArtifactId">
                  </label>
                  <label v-if="calibrationDraft.kind === 'ab'">
                    <span>候选 B 标签</span>
                    <input v-model="calibrationDraft.secondLabel">
                  </label>
                  <div class="company-provider-form__actions company-provider-form__wide">
                    <span>AI 只能排队，选择必须由本地用户确认。</span>
                    <UButton color="neutral" :loading="studioLoading" @click="enqueueCalibration">
                      加入校准队列
                    </UButton>
                  </div>
                </div>

                <div v-if="founderStudio?.calibrationQueue.length" class="ac-calibration-list">
                  <article v-for="item in founderStudio.calibrationQueue" :key="item.id">
                    <div>
                      <strong>{{ item.prompt }}</strong>
                      <span>{{ item.kind }} · {{ item.status }}</span>
                    </div>
                    <p>{{ item.candidates.map(candidate => candidate.label).join(" / ") }}</p>
                    <div v-if="item.status === 'pending'" class="ac-studio-row-actions">
                      <template v-if="item.kind === 'ab'">
                        <UButton color="neutral" variant="soft" @click="respondCalibration(item, 'prefer_first')">选择 A</UButton>
                        <UButton color="neutral" variant="soft" @click="respondCalibration(item, 'prefer_second')">选择 B</UButton>
                      </template>
                      <template v-else>
                        <UButton color="neutral" variant="soft" @click="respondCalibration(item, 'accept')">接受</UButton>
                        <UButton color="neutral" variant="outline" @click="respondCalibration(item, 'reject')">拒绝</UButton>
                      </template>
                    </div>
                    <small v-else>{{ item.response }} · {{ item.reason }}</small>
                  </article>
                </div>
              </section>
            </div>
            <p v-if="studioMessage" class="company-provider-form__message" role="status">{{ studioMessage }}</p>
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
