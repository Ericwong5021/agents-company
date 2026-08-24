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
const productTelemetry = useProductTelemetry()
const telemetryMessage = ref("")
const telemetryRates = computed(() => [
  { label: "交付到达率", value: productTelemetry.metrics.value.deliveryReachRate },
  { label: "打断率", value: productTelemetry.metrics.value.interruptionRate },
  { label: "失败恢复率", value: productTelemetry.metrics.value.recoveryRate },
  { label: "验收率", value: productTelemetry.metrics.value.acceptanceRate },
])
const telemetryBreakdownGroups = computed(() => [
  { label: "版本", rows: productTelemetry.breakdowns.value.byVersion },
  { label: "场景", rows: productTelemetry.breakdowns.value.byScenario },
  { label: "批准模式", rows: productTelemetry.breakdowns.value.byApprovalMode },
])

function updateTelemetryConsent(event: Event) {
  const enabled = (event.currentTarget as HTMLInputElement).checked
  productTelemetry.setConsent(enabled)
  telemetryMessage.value = enabled
    ? "已选择加入匿名体验数据；只有配置了接收端时才会发送脱敏事件。"
    : "匿名体验数据已关闭；本地指标仍继续工作。"
}

function exportTelemetry() {
  const url = URL.createObjectURL(new Blob([productTelemetry.exportJSON()], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `agent-company-product-data-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  telemetryMessage.value = "本地体验数据已导出。"
}

function clearTelemetry() {
  if (!window.confirm("清除全部本地体验事件与聚合指标？此操作不能撤销。")) return
  productTelemetry.clear()
  telemetryMessage.value = "本地体验数据已清除；匿名上报选择未改变。"
}

const connectionLabel = computed(() => ({
  connecting: "正在连接",
  ready: "已连接",
  degraded: "部分可用",
  disconnected: "未连接",
  recovering: "正在恢复",
})[snapshot.value.connection])
const savedProviderLabel = computed(() =>
  snapshot.value.company.providerConfigured === false
    ? "未配置"
    : snapshot.value.company.provider.replace(/^已连接/, "已保存"))
function governanceStatusLabel(value?: string | null) {
  return ({
    authorized: "已授权",
    not_confirmed: "未确认授权",
    unavailable: "状态不可用",
    confirmed: "已确认",
    blocked: "已阻断",
    ready: "可启用",
  } as Record<string, string>)[value ?? "unavailable"] ?? value ?? "状态不可用"
}
function founderModeLabel(value?: string | null) {
  return ({
    off: "关闭",
    shadow: "影子建议",
    advisor: "顾问建议",
    "green-delegated": "绿色委托",
    "yellow-delegated": "黄色委托",
  } as Record<string, string>)[value ?? "off"] ?? value ?? "关闭"
}
function commonsModeLabel(value?: string | null) {
  return ({
    off: "关闭",
    "ingest-only": "仅导入",
    reading: "可阅读",
    "belief-loop": "信念循环",
  } as Record<string, string>)[value ?? "off"] ?? value ?? "关闭"
}
function capabilityLabel(value: DiscoveredModel["capabilities"]["tool_call"]) {
  return ({ supported: "支持", unsupported: "不支持", unknown: "未知" } as const)[value]
}

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
const approvalPreset = ref<"autonomous" | "balanced" | "strict">("balanced")
const approvalSaving = ref(false)
const approvalMessage = ref("")
const approvalOptions = [
  {
    value: "autonomous" as const,
    label: "自主",
    detail: "目标摘要生成后自动开始；高风险动作仍等待你的明确批准。",
  },
  {
    value: "balanced" as const,
    label: "平衡",
    detail: "先展示目标摘要，允许你调整后再开始。",
  },
  {
    value: "strict" as const,
    label: "严格",
    detail: "等待你明确开始；工作区写入也需要逐项批准。",
  },
]
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
    { value: "off" as const, label: "关闭", disabled: false },
    { value: "shadow" as const, label: "影子建议", disabled: maximum < 1 },
    {
      value: "advisor" as const,
      label: `顾问建议 · ${governanceStatusLabel(advisorReadiness.value?.status)}`,
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

watch(
  () => snapshot.value.company.approvalPolicy,
  (value) => {
    if (value === "autonomous" || value === "balanced" || value === "strict") approvalPreset.value = value
  },
  { immediate: true },
)

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

function founderDecisionTitle(
  decision: FounderControlCenterProjection["todayDelegatedDecisions"][number],
) {
  return decision.subject ?? decision.finalDecision ?? decision.recommendation ?? decision.id
}

function founderDecisionSummary(
  decision: FounderControlCenterProjection["todayDelegatedDecisions"][number],
) {
  return decision.finalDecision ?? decision.recommendation ?? decision.context ?? "尚无决定摘要"
}

function founderControlTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp)
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
      advisorMessage.value = "顾问代理未开启，请核对精确提交、三项指标与人工授权事件。"
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
    studioMessage.value = "品味、案例与评分规则需要原始成果记录 ID 和至少一个评估维度。"
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
    () => studioMessage.value = "校准项未写入，请检查候选成果。",
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
  navigateTo("/welcome?restart=1")
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
    navigateTo("/inbox?newGoal=1")
  }
}

async function saveApprovalPolicy() {
  if (approvalSaving.value) return
  approvalSaving.value = true
  approvalMessage.value = ""
  await $fetch("/api/agent-company/approval-policy", {
    method: "PUT",
    body: { approval_preset: approvalPreset.value },
  }).then(
    () => approvalMessage.value = "审批策略已保存；已启动项目和已等待审批保持原策略。",
    () => approvalMessage.value = "审批策略未保存，请检查本地服务状态。",
  )
  approvalSaving.value = false
  await refresh()
}
</script>

<template>
  <UDashboardPanel id="agent-company-settings" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <ModuleWorkspace
        eyebrow="本地运行与治理"
        title="设置"
        description="管理本地运行连接、模型服务与公司治理边界。"
        narrow
      >
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
                <dd>{{ savedProviderLabel }}</dd>
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

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>目标批准策略</h2>
                <p>决定未来目标何时开始。策略变更不会改写已启动项目或已等待的批准审批。</p>
              </div>
            </div>
            <div class="ac-provider-presets" role="radiogroup" aria-label="目标批准策略">
              <button
                v-for="option in approvalOptions"
                :key="option.value"
                type="button"
                role="radio"
                class="ac-provider-preset"
                :aria-checked="approvalPreset === option.value"
                :data-active="approvalPreset === option.value"
                @click="approvalPreset = option.value"
              >
                <span class="ac-provider-preset__label">{{ option.label }}</span>
                <span class="ac-provider-preset__desc">{{ option.detail }}</span>
              </button>
            </div>
            <div class="company-provider-form__actions">
              <span v-if="approvalMessage" role="status">{{ approvalMessage }}</span>
              <span v-else>当前保存策略：{{ snapshot.company.approvalPolicy }}</span>
              <UButton color="neutral" :loading="approvalSaving" @click="saveApprovalPolicy">保存批准策略</UButton>
            </div>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>本地体验数据</h2>
                <p>指标默认只保存在本机，用于判断目标到交付、打断、失败恢复和验收闭环。</p>
              </div>
              <span>口径 v{{ productTelemetry.metrics.value.definitionVersion }}</span>
            </div>
            <div class="ac-telemetry-metrics">
              <div v-for="metric in telemetryRates" :key="metric.label">
                <span>{{ metric.label }}</span>
                <strong>{{ Math.round(metric.value * 100) }}%</strong>
              </div>
              <div>
                <span>本地事件</span>
                <strong>{{ productTelemetry.events.value.length }}</strong>
              </div>
            </div>
            <label class="ac-telemetry-consent">
              <input
                type="checkbox"
                :checked="productTelemetry.consent.value.enabled"
                @change="updateTelemetryConsent"
              >
              <span>
                <strong>选择加入匿名体验数据</strong>
                <small>不发送 API Key、完整 Prompt、文件内容或成果正文；未配置接收端时不会产生外部请求。</small>
              </span>
            </label>
            <details v-if="productTelemetry.events.value.length" class="ac-telemetry-breakdowns">
              <summary>按版本、场景与批准模式比较</summary>
              <section v-for="group in telemetryBreakdownGroups" :key="group.label">
                <h3>{{ group.label }}</h3>
                <div v-if="group.rows.length" class="ac-telemetry-breakdowns__rows">
                  <div v-for="row in group.rows" :key="row.key">
                    <strong>{{ row.key }}</strong>
                    <span>{{ row.eventCount }} 个事件</span>
                    <span>交付到达 {{ Math.round(row.metrics.deliveryReachRate * 100) }}%</span>
                    <span>验收 {{ Math.round(row.metrics.acceptanceRate * 100) }}%</span>
                  </div>
                </div>
                <p v-else>当前事件尚未包含该维度。</p>
              </section>
            </details>
            <div class="company-provider-form__actions">
              <span v-if="telemetryMessage" role="status">{{ telemetryMessage }}</span>
              <span v-else>你可以随时查看、导出或清除本机记录。</span>
              <UButton color="neutral" variant="outline" :disabled="!productTelemetry.events.value.length" @click="exportTelemetry">
                导出数据
              </UButton>
              <UButton color="neutral" variant="ghost" :disabled="!productTelemetry.events.value.length" @click="clearTelemetry">
                清除数据
              </UButton>
            </div>
          </section>

          <section class="company-settings-section company-provider-form ac-provider-wizard">
            <div class="company-settings-section__heading">
              <div>
                <h2>模型服务</h2>
                <p>下方用于配置或替换模型连接。已保存密钥不会回填；不更换配置时无需重新输入。</p>
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
              <UButton color="neutral" variant="soft" :loading="testing" @click="testConnection">测试新配置</UButton>
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
                <span class="ac-provider-model__capabilities">
                  <span :data-support="model.capabilities.tool_call">
                    Tool {{ capabilityLabel(model.capabilities.tool_call) }}
                  </span>
                  <span :data-support="model.capabilities.structured_output">
                    结构化输出 {{ capabilityLabel(model.capabilities.structured_output) }}
                  </span>
                  <span data-support="supported">运行时可中断恢复</span>
                </span>
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
              <span>当前：{{ savedProviderLabel }} · 此处不会显示已保存密钥</span>
              <UButton color="neutral" :loading="saving" :disabled="!selectedModel" @click="saveProvider">
                验证并保存
              </UButton>
            </div>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>引导与演示</h2>
                <p>随时重新开始首次引导，或进入明确标注的演示；演示与真实数据、模型服务、项目完全隔离。</p>
              </div>
            </div>
            <div class="ac-onboarding-controls">
              <UButton color="neutral" variant="soft" @click="restartGuide">重新开始引导</UButton>
              <UButton color="neutral" variant="outline" @click="enterDemo">进入演示</UButton>
            </div>
            <p class="company-provider-form__message">重新开始引导会清除本机的演示与引导标记，不影响任何真实公司数据。</p>
          </section>

          <details>
            <summary class="company-settings-section cursor-pointer">
              <strong class="block text-sm text-highlighted">高级治理与创始人代理</strong>
              <span class="mt-2 block text-sm text-muted">
                默认收起。日常使用无需处理；仅在你要配置创始人代理、治理资产或校准时展开。
              </span>
            </summary>
            <div class="mt-5 grid gap-5">
          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>创始人代理控制台（高级）</h2>
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
              · 授权 {{ governanceStatusLabel(founderControl?.authorization.status) }}
              · 模式提升 {{ founderControl?.authorization.canRaiseModeFromUI ? "可用" : "已禁用" }}
            </p>

            <dl>
              <div>
                <dt>当前有效模式</dt>
                <dd>{{ founderModeLabel(founderControl?.mode.effective.founderTwinMode) }}</dd>
              </div>
              <div>
                <dt>今日代理决定</dt>
                <dd>{{ founderControl?.todayDelegatedDecisions.length ?? 0 }}</dd>
              </div>
              <div>
                <dt>最近黄灯摘要</dt>
                <dd>{{ founderControl?.yellowSummaries.length ?? 0 }}</dd>
              </div>
              <div>
                <dt>红灯待办</dt>
                <dd>{{ founderControl?.redPendingDecisions.length ?? 0 }}</dd>
              </div>
              <div>
                <dt>最近推翻记录</dt>
                <dd>{{ founderControl?.overrideRecords.length ?? 0 }}</dd>
              </div>
              <div>
                <dt>校准进度</dt>
                <dd>
                  {{ founderControl?.calibrationTrend.responded ?? 0 }}
                  / {{ (founderControl?.calibrationTrend.responded ?? 0) + (founderControl?.calibrationTrend.pending ?? 0) }}
                </dd>
              </div>
            </dl>

            <div class="mt-5 grid gap-x-6 gap-y-5 lg:grid-cols-2">
              <div class="min-w-0 border-t border-default pt-4">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-semibold text-highlighted">今日代理决定</h3>
                  <span class="ac-studio-status">{{ founderControl?.todayDelegatedDecisions.length ?? 0 }}</span>
                </div>
                <div v-if="founderControl?.todayDelegatedDecisions.length" class="ac-governance-list">
                  <article
                    v-for="decision in founderControl.todayDelegatedDecisions.slice(0, 5)"
                    :key="decision.id"
                  >
                    <div>
                      <strong>{{ founderDecisionTitle(decision) }}</strong>
                      <span>{{ decision.authorityClass ?? "未分类" }} · {{ decision.currentStatus }}</span>
                    </div>
                    <p>{{ founderDecisionSummary(decision) }}</p>
                    <small>{{ founderControlTime(decision.createdAt) }}</small>
                  </article>
                </div>
                <p v-else class="company-provider-form__message">今天尚无创始人代理决定。</p>
              </div>

              <div class="min-w-0 border-t border-default pt-4">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-semibold text-highlighted">黄灯摘要</h3>
                  <span class="ac-studio-status">{{ founderControl?.yellowSummaries.length ?? 0 }}</span>
                </div>
                <div v-if="founderControl?.yellowSummaries.length" class="ac-governance-list">
                  <article
                    v-for="summary in founderControl.yellowSummaries.slice(0, 5)"
                    :key="summary.runId"
                  >
                    <div>
                      <strong>{{ summary.status }}</strong>
                      <span>{{ summary.cost.actual }} / {{ summary.cost.limit }} receipt</span>
                    </div>
                    <p>
                      {{ summary.failClosedReasons.length
                        ? summary.failClosedReasons.join("；")
                        : `${summary.workItemIds.length} 个工作项，${summary.outcomeIds.length} 个 Outcome` }}
                    </p>
                    <small>{{ founderControlTime(summary.updatedAt) }}</small>
                  </article>
                </div>
                <p v-else class="company-provider-form__message">尚无黄灯执行摘要。</p>
              </div>

              <div class="min-w-0 border-t border-default pt-4">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-semibold text-highlighted">红灯待办</h3>
                  <span class="ac-studio-status">{{ founderControl?.redPendingDecisions.length ?? 0 }}</span>
                </div>
                <div v-if="founderControl?.redPendingDecisions.length" class="ac-governance-list">
                  <article
                    v-for="decision in founderControl.redPendingDecisions.slice(0, 5)"
                    :key="decision.id"
                  >
                    <div>
                      <strong>{{ founderDecisionTitle(decision) }}</strong>
                      <span>{{ decision.currentStatus }}</span>
                    </div>
                    <p>{{ founderDecisionSummary(decision) }}</p>
                    <small>{{ founderControlTime(decision.createdAt) }}</small>
                  </article>
                </div>
                <p v-else class="company-provider-form__message">当前没有待处理红灯决定。</p>
              </div>

              <div class="min-w-0 border-t border-default pt-4">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-semibold text-highlighted">推翻记录</h3>
                  <span class="ac-studio-status">{{ founderControl?.overrideRecords.length ?? 0 }}</span>
                </div>
                <div v-if="founderControl?.overrideRecords.length" class="ac-governance-list">
                  <article
                    v-for="record in founderControl.overrideRecords.slice(0, 5)"
                    :key="record.id"
                  >
                    <div>
                      <strong>{{ record.humanDecision }}</strong>
                      <span>{{ record.actorId }}</span>
                    </div>
                    <p>{{ record.reason }}</p>
                    <small>{{ founderControlTime(record.createdAt) }}</small>
                  </article>
                </div>
                <p v-else class="company-provider-form__message">尚无人工推翻记录。</p>
              </div>

              <div class="min-w-0 border-t border-default pt-4 lg:col-span-2">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-semibold text-highlighted">校准趋势</h3>
                  <span class="ac-studio-status">
                    {{ founderControl?.trends.confirmedCalibrations ?? 0 }} confirmed
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>待校准</dt>
                    <dd>{{ founderControl?.calibrationTrend.pending ?? 0 }}</dd>
                  </div>
                  <div>
                    <dt>已回应</dt>
                    <dd>{{ founderControl?.calibrationTrend.responded ?? 0 }}</dd>
                  </div>
                  <div>
                    <dt>接受 / 拒绝</dt>
                    <dd>
                      {{ founderControl?.calibrationTrend.accepted ?? 0 }}
                      / {{ founderControl?.calibrationTrend.rejected ?? 0 }}
                    </dd>
                  </div>
                  <div>
                    <dt>A/B 偏好</dt>
                    <dd>{{ founderControl?.calibrationTrend.preferences ?? 0 }}</dd>
                  </div>
                  <div>
                    <dt>影子建议匹配 / 推翻</dt>
                    <dd>
                      {{ founderControl?.trends.shadowComparisons ?? 0 }}
                      / {{ founderControl?.trends.shadowOverrides ?? 0 }}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>

            <NuxtLink to="/company/board" class="company-text-link mt-5 inline-block">打开董事会治理承载面</NuxtLink>
          </section>

          <section class="company-settings-section">
            <div class="company-settings-section__heading">
              <div>
                <h2>创始人代理模式（高级）</h2>
                <p>这里写入 Company 级原始模式，实际能力始终取全局上限与公司设置中更严格的一项。</p>
              </div>
              <span class="ac-studio-status">当前生效：{{ founderModeLabel(founderModes?.effective.founderTwinMode) }}</span>
            </div>

            <div class="company-provider-form company-provider-form__grid">
              <label>
                <span>创始人代理</span>
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
                <small>顾问建议与绿色/黄色委托只能通过各自的启用条件受控开启。</small>
              </label>
              <label>
                <span>公司知识库</span>
                <select v-model="modeDraft.companyCommonsMode">
                  <option
                    v-for="option in commonsModeOptions"
                    :key="option.value"
                    :value="option.value"
                    :disabled="option.disabled"
                  >
                    {{ commonsModeLabel(option.value) }}
                  </option>
                </select>
                <small>belief-loop 不在此入口开放。</small>
              </label>
              <div class="company-provider-form__actions company-provider-form__wide">
                <span>
                  全局上限：
                  {{ founderModeLabel(founderModes?.globalMaximum.founderTwinMode) }}
                  /
                  {{ commonsModeLabel(founderModes?.globalMaximum.companyCommonsMode) }}
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
                  <span>顾问代理启用条件（高级）</span>
                  <strong>{{ governanceStatusLabel(advisorReadiness?.status) }}</strong>
                </div>
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-refresh-cw"
                  aria-label="刷新顾问代理启用条件"
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
                      验证并开启顾问代理
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
                <h2>创始人偏好工作室（高级）</h2>
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
              人工确认：{{ governanceStatusLabel(founderStudio?.authorization.status) }} · 弱门禁，不自动提升权限级别
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
                    <span>原始成果记录 ID</span>
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

                <div v-if="studioAssets.length" class="ac-governance-list">
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

                <div v-if="founderStudio?.snapshots.length" class="ac-governance-list">
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
                    <span>候选 A 成果记录 ID</span>
                    <input v-model="calibrationDraft.firstArtifactId">
                  </label>
                  <label>
                    <span>候选 A 标签</span>
                    <input v-model="calibrationDraft.firstLabel">
                  </label>
                  <label v-if="calibrationDraft.kind === 'ab'">
                    <span>候选 B 成果记录 ID</span>
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

            </div>
          </details>
        </div>
      </ModuleWorkspace>
    </template>
  </UDashboardPanel>
</template>
