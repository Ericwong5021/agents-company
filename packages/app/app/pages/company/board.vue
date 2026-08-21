<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import type {
  FounderAdvisorConvergence,
  FounderBoardGovernanceProjection,
  FounderShadowComparison,
  FounderShadowDecision,
} from "@agents-company/sdk/v2/founder-os"
import type { CompanyBoardThread } from "../../../modules/agent-company/runtime/shared/company-contract"

const { data: snapshot, refresh } = useCompanySnapshot()
const route = useRoute()
const initialRouteProject = typeof route.query.project === "string" ? route.query.project : ""
const board = ref<FounderBoardGovernanceProjection | null>(null)
const thread = ref<CompanyBoardThread | null>(null)
const loading = ref(false)
const actionMessage = ref("")
const replyTarget = ref<{ id: string; author: string; body: string }>()
const pollOpen = ref(false)
const pollQuestion = ref("")
const pollOptions = ref(["", ""])
const pollMultiple = ref(false)
const readSequenceAtOpen = ref(0)
const companyScopeConfirmed = ref(false)
const scopeInitialized = ref(Boolean(initialRouteProject))
const appliedRouteProject = ref(initialRouteProject)
const intervention = reactive({
  kind: "takeover" as "takeover" | "pause" | "correct" | "reject" | "redefine_goal",
  projectId: "",
  reason: "",
  newGoal: "",
})
const shadowRun = reactive({
  projectId: initialRouteProject,
  currentGoal: "",
})
const comparison = reactive({
  shadowDecisionId: "",
  actualDecisionId: "",
  actualDecision: "",
  alignment: "partial" as "match" | "partial" | "mismatch",
  rationale: "",
})
const convergence = reactive({
  shadowDecisionId: "",
  channelMessageId: "",
  driAgentId: "",
  subject: "",
  context: "",
  timeoutMinutes: 30,
})
const selectedShadowProject = computed(() =>
  snapshot.value.projects.find((project) => project.id === shadowRun.projectId))
const scopeProjectID = computed(() =>
  typeof route.query.project === "string" ? route.query.project : "")
const scopeProject = computed(() =>
  snapshot.value.projects.find((project) => project.id === scopeProjectID.value))
const projectScoped = computed(() => Boolean(scopeProjectID.value))
const shadowScopeReady = computed(() =>
  Boolean(shadowRun.projectId) || companyScopeConfirmed.value || snapshot.value.projects.length === 0)
const visibleBoardMessages = computed(() =>
  projectScoped.value
    ? snapshot.value.messages.filter((message) => message.body.includes(scopeProjectID.value))
    : snapshot.value.messages)
const chatMessages = computed(() => [...visibleBoardMessages.value].sort((a, b) => a.sequence - b.sequence))
const boardThreadId = computed(() =>
  chatMessages.value.findLast((message) => message.threadID)?.threadID)
const boardMessages = computed(() =>
  visibleBoardMessages.value.filter((message) => message.threadID === boardThreadId.value))
const currentRequest = computed(() =>
  [...boardMessages.value].sort((a, b) => b.sequence - a.sequence).find((message) => message.kind === "user")
  ?? boardMessages.value.at(-1))
const visibleShadowDecisions = computed(() =>
  (board.value?.shadow.decisions ?? []).filter((decision) =>
    !projectScoped.value || (decision.scope.kind === "project" && decision.scope.ref === scopeProjectID.value)))
const visibleDecisions = computed(() =>
  (board.value?.decisions ?? []).filter((decision) =>
    !projectScoped.value
    || (decision.scope.type === "project" && decision.scope.projectId === scopeProjectID.value)))
const visibleAssets = computed(() =>
  (board.value?.assets ?? []).filter((asset) =>
    !projectScoped.value
    || asset.scope.kind === "company"
    || (asset.scope.kind === "project" && asset.scope.ref === scopeProjectID.value)))
const interventionActionLabel = computed(() => ({
  takeover: "接管",
  pause: "暂停",
  correct: "纠正",
  reject: "否决",
  redefine_goal: "重定义目标",
})[intervention.kind])
const interventionEffect = computed(() =>
  intervention.projectId
    ? `提交“${interventionActionLabel.value}”会立即锁定创始人代理，并暂停所选项目的在途工作。`
    : `提交“${interventionActionLabel.value}”会锁定创始人代理，不会停止任何项目。`)
function modeLabel(value?: string | null) {
  return ({
    off: "关闭",
    shadow: "影子建议",
    advisor: "顾问建议",
    "green-delegated": "绿色委托",
    "yellow-delegated": "黄色委托",
  } as Record<string, string>)[value ?? "off"] ?? value ?? "关闭"
}
function governanceStatusLabel(value?: string | null) {
  return ({
    authorized: "已授权",
    not_confirmed: "未确认授权",
    unavailable: "状态不可用",
  } as Record<string, string>)[value ?? "unavailable"] ?? value ?? "状态不可用"
}
function authorityLabel(value?: string | null) {
  return ({
    green: "绿色权限",
    yellow: "黄色权限",
    red: "红色权限",
  } as Record<string, string>)[value ?? "unknown"] ?? "权限未判定"
}
function decisionStatusLabel(value?: string | null) {
  return ({
    suggested: "已生成建议",
    blocked: "已阻断",
    proposed: "已提出",
    awaiting_approval: "等待批准",
    accepted: "已接受",
    executed: "已执行",
    overridden: "已被人工推翻",
    failed: "执行失败",
    rolled_back: "已回滚",
    unknown: "状态未知",
  } as Record<string, string>)[value ?? "unknown"] ?? "状态未知"
}
function blockReasonLabel(value: string) {
  return ({
    snapshot_missing: "缺少创始人偏好快照",
    snapshot_checksum_invalid: "创始人偏好快照校验失败",
    context_insufficient: "当前上下文不足",
    asset_reference_missing: "缺少治理依据",
    asset_scope_forbidden: "治理依据超出可用范围",
    evidence_reference_invalid: "证据引用无效",
    model_unavailable: "模型服务不可用",
    model_timeout: "模型响应超时",
    model_output_missing: "模型没有返回建议",
    model_output_invalid: "模型建议格式无法识别",
  } as Record<string, string>)[value] ?? "治理条件未满足"
}

function shortWorkID(value: string) {
  return value.slice(-8)
}

function projectStatusLabel(value: string) {
  return ({
    running: "执行中",
    reviewing: "复核中",
    delivered: "待验收",
    accepted: "已接受",
    blocked: "受阻",
    failed: "未完成",
    cancelled: "已取消",
  } as Record<string, string>)[value] ?? value
}

function personLabel(value?: string | null) {
  if (!value) return ""
  return ({
    CEO: "首席执行官",
    ceo: "首席执行官",
    CTO: "技术负责人",
    cto: "技术负责人",
    "Product Lead": "产品负责人",
    product_lead: "产品负责人",
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
  } as Record<string, string>)[value]
    ?? value
      .replace(/\s+independent reviewer\b/gi, "（独立复核）")
      .replace(/\bProject Charter\b/gi, "项目章程")
      .replace(/\bCharter\b/gi, "工作章程")
}

function boardPersonLabel(name: string, role?: string | null) {
  const nameLabel = personLabel(name)
  const roleLabel = personLabel(role)
  return roleLabel && roleLabel !== nameLabel ? `${nameLabel} · ${roleLabel}` : nameLabel
}

function deliveryLabel(message: typeof chatMessages.value[number]) {
  const active = message.deliveries.filter((delivery) => ["pending", "triaging", "running", "held"].includes(delivery.status))
  if (!active.length) return ""
  const names = active.map((delivery) => snapshot.value.agents.find((agent) => agent.id === delivery.agentID)?.name ?? delivery.agentID)
  if (active.some((delivery) => delivery.reason === "rate_limit_cooldown")) return `${names.join("、")} 遇到限流，保留未读并等待恢复…`
  if (active.some((delivery) => delivery.status === "running")) return `${names.join("、")} 正在回复…`
  if (active.some((delivery) => delivery.status === "held")) return `${names.join("、")} 正在重新阅读新消息…`
  return `${names.join("、")} 正在判断是否需要回应…`
}

function replyTo(message: typeof chatMessages.value[number]) {
  replyTarget.value = { id: message.id, author: message.author, body: message.body }
}

async function react(messageID: string, emoji: string) {
  await $fetch("/api/agent-company/board-action", {
    method: "POST",
    body: { kind: "reaction", message_id: messageID, emoji },
  })
  await refresh()
}

async function vote(messageID: string, optionID: string) {
  await $fetch("/api/agent-company/board-action", {
    method: "POST",
    body: { kind: "vote", message_id: messageID, option_id: optionID },
  })
  await refresh()
}

async function createPoll() {
  const options = pollOptions.value.map((option) => option.trim()).filter(Boolean)
  if (!pollQuestion.value.trim() || options.length < 2 || loading.value) return
  loading.value = true
  await $fetch("/api/agent-company/board-action", {
    method: "POST",
    body: {
      kind: "poll",
      request_id: crypto.randomUUID(),
      question: pollQuestion.value.trim(),
      options,
      multiple: pollMultiple.value,
    },
  }).then(() => {
    pollQuestion.value = ""
    pollOptions.value = ["", ""]
    pollMultiple.value = false
    pollOpen.value = false
  })
  loading.value = false
  await refreshBoardMessages()
}

function replyPreview(message: typeof chatMessages.value[number]) {
  if (!message.replyToID) return
  return chatMessages.value.find((candidate) => candidate.id === message.replyToID)
}

function startsUnread(index: number) {
  const message = chatMessages.value[index]
  const previous = chatMessages.value[index - 1]
  return Boolean(
    message
    && message.sequence > readSequenceAtOpen.value
    && (!previous || previous.sequence <= readSequenceAtOpen.value),
  )
}

function seedForms() {
  const requestedProjectID = typeof route.query.project === "string" ? route.query.project : ""
  const requestedProject = snapshot.value.projects.find((project) => project.id === requestedProjectID)
  if (requestedProject && appliedRouteProject.value !== requestedProject.id) {
    shadowRun.projectId = requestedProject.id
    shadowRun.currentGoal = requestedProject.title
    intervention.projectId = requestedProject.id
    appliedRouteProject.value = requestedProject.id
    scopeInitialized.value = true
  } else if (!scopeInitialized.value && snapshot.value.projects.length) {
    shadowRun.projectId = snapshot.value.projects.at(0)?.id ?? ""
    shadowRun.currentGoal = snapshot.value.projects.at(0)?.title ?? ""
    scopeInitialized.value = true
  }
  shadowRun.currentGoal ||= selectedShadowProject.value?.title
    ?? snapshot.value.company.setupGoal
    ?? "评估当前公司目标与讨论"
  comparison.shadowDecisionId ||= visibleShadowDecisions.value.at(0)?.id ?? ""
  comparison.actualDecisionId ||= visibleDecisions.value.at(0)?.id ?? ""
  comparison.actualDecision ||= visibleDecisions.value.at(0)?.finalDecision
    ?? visibleDecisions.value.at(0)?.recommendation
    ?? ""
  convergence.shadowDecisionId ||= visibleShadowDecisions.value.at(0)?.id ?? ""
  convergence.channelMessageId ||= currentRequest.value?.id ?? ""
  convergence.driAgentId ||= snapshot.value.agents.at(0)?.id ?? ""
  convergence.subject ||= currentRequest.value?.body ?? ""
  convergence.context ||= boardMessages.value.map((message) => `${message.author}: ${message.body}`).join("\n")
}

async function loadBoard() {
  if (!snapshot.value.company.id || loading.value) return
  loading.value = true
  const [projection, boardThread] = await Promise.all([
    $fetch<FounderBoardGovernanceProjection>("/api/agent-company/founder-board", {
      query: { companyId: snapshot.value.company.id },
    }).catch(() => null),
    boardThreadId.value
      ? $fetch<CompanyBoardThread>("/api/agent-company/board", {
          query: { thread_id: boardThreadId.value },
        }).catch(() => null)
      : Promise.resolve(null),
  ])
  board.value = projection
  thread.value = boardThread
  seedForms()
  loading.value = false
}

async function runShadow() {
  if (!shadowRun.currentGoal.trim() || loading.value) return
  if (!shadowScopeReady.value) {
    actionMessage.value = "请先选择一项工作；若确需综合多项工作，请明确确认公司范围。"
    return
  }
  loading.value = true
  actionMessage.value = ""
  const source = currentRequest.value
  await $fetch<FounderShadowDecision>("/api/agent-company/founder-shadow/run", {
    method: "POST",
    body: {
      context: {
        companyId: snapshot.value.company.id,
        scope: shadowRun.projectId
          ? { kind: "project", ref: shadowRun.projectId }
          : { kind: "company" },
        currentGoal: shadowRun.currentGoal,
        discussion: boardMessages.value.map((message) => `${message.author}: ${message.body}`).join("\n")
          || "当前董事会尚无可用讨论记录。",
        authorizationBoundary: "影子模式只生成建议，不发言、不创建审批、不执行。",
        currentFacts: [
          `模型服务：${snapshot.value.company.provider}`,
          `审批策略：${snapshot.value.company.approvalPolicy}`,
        ],
        evidenceRefs: source
          ? [{ kind: "conversation", id: source.id, validity: "verified" }]
          : [],
      },
      createdBy: "local_user",
    },
  }).then(
    (result) => {
      actionMessage.value = result.status === "suggested"
        ? "影子建议已写入只读记录。"
        : `影子建议保持阻断：${result.blockReasons.map(blockReasonLabel).join("、")}`
    },
    () => actionMessage.value = "影子建议未写入，请检查上下文与本地服务状态。",
  )
  loading.value = false
  await loadBoard()
}

async function compareShadow() {
  if (
    !comparison.shadowDecisionId
    || !comparison.actualDecisionId
    || !comparison.actualDecision.trim()
    || !comparison.rationale.trim()
    || loading.value
  ) return
  loading.value = true
  actionMessage.value = ""
  await $fetch<FounderShadowComparison>("/api/agent-company/founder-shadow/compare", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      shadowDecisionId: comparison.shadowDecisionId,
      actualDecision: comparison.actualDecision,
      actualDecisionRef: {
        kind: "decision",
        id: comparison.actualDecisionId,
        validity: "verified",
      },
      alignment: comparison.alignment,
      rationale: comparison.rationale,
      comparedBy: "local_user",
    },
  }).then(
    () => {
      actionMessage.value = "影子建议对照已写入，未冒充人工确认样本。"
      comparison.rationale = ""
    },
    () => actionMessage.value = "影子建议对照未写入，请检查决策台账引用。",
  )
  loading.value = false
  await loadBoard()
}

async function convergeAdvisor() {
  const boardRunId = thread.value?.run?.id
  if (
    !boardThreadId.value
    || !convergence.channelMessageId
    || !convergence.shadowDecisionId
    || !convergence.driAgentId
    || !convergence.subject.trim()
    || !convergence.context.trim()
    || loading.value
  ) return
  loading.value = true
  actionMessage.value = ""
  await $fetch<FounderAdvisorConvergence>("/api/agent-company/founder-board/converge", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      idempotencyKey: crypto.randomUUID(),
      source: {
        boardThreadId: boardThreadId.value,
        ...(boardRunId ? { boardRunId } : {}),
        channelMessageId: convergence.channelMessageId,
        shadowDecisionId: convergence.shadowDecisionId,
      },
      subject: convergence.subject,
      context: convergence.context,
      driAgentId: convergence.driAgentId,
      timeoutAt: Date.now() + convergence.timeoutMinutes * 60_000,
      dissent: [],
    },
  }).then(
    (result) => actionMessage.value = result.status === "intent_recorded"
      ? "顾问代理的决策意图已写入决策台账，未创建执行。"
      : `顾问代理保持未执行：${result.events.at(-1)?.reason ?? result.authority.reason}`,
    () => actionMessage.value = "顾问代理未能形成决策意图，请检查董事会来源链。",
  )
  loading.value = false
  await loadBoard()
}

async function intervene() {
  if (!boardThreadId.value || !intervention.reason.trim() || loading.value) return
  loading.value = true
  actionMessage.value = ""
  await $fetch("/api/agent-company/founder-board/intervene", {
    method: "POST",
    body: {
      companyId: snapshot.value.company.id,
      idempotencyKey: crypto.randomUUID(),
      kind: intervention.kind,
      boardThreadId: boardThreadId.value,
      ...(intervention.projectId ? { projectId: intervention.projectId } : {}),
      reason: intervention.reason,
      ...(intervention.kind === "redefine_goal" ? { newGoal: intervention.newGoal } : {}),
      actorKind: "human",
      actorId: "local_user",
    },
  })
    .then(() => {
      actionMessage.value = "接管记录与停止请求已写入治理审计链。"
      intervention.reason = ""
      intervention.newGoal = ""
    })
    .catch(() => {
      actionMessage.value = "接管记录未完成，请检查本地服务状态。"
    })
  loading.value = false
  await Promise.all([loadBoard(), refresh()])
}

async function refreshBoardMessages() {
  await refresh()
  await loadBoard()
  const sequence = chatMessages.value.at(-1)?.sequence
  if (sequence !== undefined) {
    await $fetch("/api/agent-company/board-action", {
      method: "POST",
      body: { kind: "read", sequence },
    }).catch(() => undefined)
    if (import.meta.client && snapshot.value.company.id) {
      localStorage.setItem(`agent-company:board-read:${snapshot.value.company.id}`, String(sequence))
    }
  }
}

onMounted(() => {
  if (snapshot.value.company.id) {
    readSequenceAtOpen.value = Number(localStorage.getItem(`agent-company:board-read:${snapshot.value.company.id}`)) || 0
  }
  void loadBoard()
})
watch(() => snapshot.value.company.id, (companyId) => {
  if (!companyId) return
  if (import.meta.client && readSequenceAtOpen.value === 0) {
    readSequenceAtOpen.value = Number(localStorage.getItem(`agent-company:board-read:${companyId}`)) || 0
  }
  loadBoard()
})
watch(
  () => [route.query.project, snapshot.value.projects.map((project) => project.id).join(",")],
  seedForms,
)
watch(() => shadowRun.projectId, () => {
  companyScopeConfirmed.value = false
})
</script>

<template>
  <UDashboardPanel id="founder-board" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="刷新董事会治理状态"
          :loading="loading"
          @click="loadBoard"
        />
      </Navbar>
    </template>

    <template #body>
      <div class="company-page founder-board-page" lang="zh">
        <header class="company-page__header founder-board-page__header">
          <div>
            <p class="company-eyebrow">创始人治理</p>
            <h1>董事会治理</h1>
            <p class="company-page__lede">
              <template v-if="projectScoped">
                当前仅显示“{{ scopeProject?.title ?? `工作 #${shortWorkID(scopeProjectID)}` }}”的治理记录。
              </template>
              <template v-else>讨论、依据、决策台账与人工接管共享同一条可追溯事实链。</template>
            </p>
          </div>
          <div class="founder-principal">
            <span class="founder-principal__mark" aria-hidden="true">董</span>
            <div>
              <strong>{{ board?.principal.displayName ?? "AI 大东 · 创始人代理" }}</strong>
              <span>董事会创始人代理 · 非新增员工</span>
            </div>
          </div>
        </header>

        <CompanyModuleNav />

        <div class="founder-chat-shell">
          <section class="company-section founder-board-chat" aria-label="董事会群聊">
            <div class="founder-board-chat__head">
              <div>
                <p class="company-eyebrow">Board room</p>
                <h2>董事会群聊</h2>
                <span>每位董事独立阅读、判断与回应；没有主持人抢答排序。</span>
              </div>
              <div class="founder-board-chat__members" aria-label="群成员">
                <span v-for="agent in snapshot.agents" :key="agent.id" :title="boardPersonLabel(agent.name, agent.role)">
                  {{ agent.name.slice(0, 1) }}
                </span>
              </div>
            </div>

            <div class="founder-board-messages founder-board-messages--chat">
              <template v-for="(message, index) in chatMessages" :key="message.id">
              <div v-if="startsUnread(index)" class="founder-board-unread"><span>未读消息</span></div>
              <article :class="{ 'is-founder': message.kind === 'user' }">
                <div class="founder-board-message__avatar" aria-hidden="true">
                  {{ message.kind === "user" ? "我" : personLabel(message.author).slice(0, 1) }}
                </div>
                <div class="founder-board-message__content">
                  <header>
                    <strong>{{ personLabel(message.author) }}</strong>
                    <span>#{{ message.sequence }} · {{ personLabel(message.role) ? `${personLabel(message.role)} · ` : "" }}{{ message.time }}</span>
                  </header>
                  <blockquote v-if="replyPreview(message)">
                    {{ replyPreview(message)?.author }}：{{ replyPreview(message)?.body }}
                  </blockquote>
                  <p>{{ message.body }}</p>
                  <div v-if="message.mentions.length || message.resources.length" class="founder-board-message__references">
                    <span v-for="mention in message.mentions" :key="`${mention.kind}:${mention.value}`">@{{ snapshot.agents.find((agent) => agent.id === mention.value)?.name ?? personLabel(mention.value) }}</span>
                    <span v-for="resource in message.resources" :key="`${resource.kind}:${resource.label}`">{{ resource.kind }} · {{ resource.label }}</span>
                  </div>
                  <div v-if="message.poll" class="founder-board-poll">
                    <button
                      v-for="option in message.poll.options"
                      :key="option.id"
                      type="button"
                      :data-selected="message.pollVotes.some((vote) => vote.optionID === option.id && vote.selected)"
                      @click="vote(message.id, option.id)"
                    >
                      <span>{{ option.label }}</span>
                      <strong>{{ message.pollVotes.find((item) => item.optionID === option.id)?.count ?? 0 }}</strong>
                    </button>
                  </div>
                  <div class="founder-board-message__actions">
                    <button type="button" @click="replyTo(message)">回复</button>
                    <button
                      v-for="reaction in message.reactions"
                      :key="reaction.emoji"
                      type="button"
                      :data-active="reaction.reacted"
                      @click="react(message.id, reaction.emoji)"
                    >
                      {{ reaction.emoji }} {{ reaction.count }}
                    </button>
                    <button v-if="!message.reactions.some((reaction) => reaction.emoji === '👍')" type="button" @click="react(message.id, '👍')">＋ 👍</button>
                    <button v-if="!message.reactions.some((reaction) => reaction.emoji === '✅')" type="button" @click="react(message.id, '✅')">＋ ✅</button>
                  </div>
                  <span v-if="deliveryLabel(message)" class="founder-board-message__activity">{{ deliveryLabel(message) }}</span>
                </div>
              </article>
              </template>
              <p v-if="!chatMessages.length" class="company-empty">
                {{ projectScoped ? "当前工作暂无董事会群聊消息。" : "群聊还是空的。发出第一条消息，董事会成员会独立判断是否回应。" }}
              </p>
            </div>

            <template v-if="!projectScoped">
              <CompanyComposer
                :target="{ kind: 'board' }"
                :agents="snapshot.agents"
                :reply-to="replyTarget"
                @cancel-reply="replyTarget = undefined"
                @sent="replyTarget = undefined; refreshBoardMessages()"
              />
              <button type="button" class="founder-board-poll-toggle" @click="pollOpen = !pollOpen">
                {{ pollOpen ? "收起投票" : "发起投票" }}
              </button>
              <form v-if="pollOpen" class="founder-board-poll-form" @submit.prevent="createPoll">
                <input v-model="pollQuestion" maxlength="500" placeholder="投票问题">
                <input v-for="(_, index) in pollOptions" :key="index" v-model="pollOptions[index]" maxlength="300" :placeholder="`选项 ${index + 1}`">
                <div>
                  <button v-if="pollOptions.length < 12" type="button" @click="pollOptions.push('')">添加选项</button>
                  <label><input v-model="pollMultiple" type="checkbox">允许多选</label>
                  <UButton type="submit" color="neutral" :loading="loading" :disabled="!pollQuestion.trim() || pollOptions.filter((option) => option.trim()).length < 2">发布投票</UButton>
                </div>
              </form>
            </template>
          </section>

          <aside class="founder-governance-rail">
            <section class="company-section founder-board-takeover">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">Governance</p>
                  <h2>治理边界</h2>
                </div>
              </div>
              <dl class="founder-governance-facts">
                <div><dt>当前模式</dt><dd>{{ modeLabel(board?.mode.effective.founderTwinMode) }}</dd></div>
                <div><dt>治理授权</dt><dd>{{ governanceStatusLabel(board?.authorization.status) }}</dd></div>
                <div><dt>顾问发言</dt><dd>{{ board?.advisorCanSpeak ? "允许" : "已停止" }}</dd></div>
                <div><dt>决策台账</dt><dd>{{ visibleDecisions.length }} 条</dd></div>
              </dl>
              <p>群聊只形成讨论与决策意图。执行仍需进入 Decision Ledger，并通过 Founder OS 权限与审批门槛。</p>
            </section>

            <section v-if="boardThreadId" class="company-section founder-board-takeover">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">人工控制</p>
                  <h2>立即接管</h2>
                </div>
              </div>
              <p>{{ interventionEffect }}</p>
              <label><span>动作</span><select v-model="intervention.kind"><option value="takeover">接管</option><option value="pause">暂停</option><option value="correct">纠正</option><option value="reject">否决</option><option value="redefine_goal">重定义目标</option></select></label>
              <label><span>关联项目</span><select v-model="intervention.projectId"><option value="">仅停止当前董事会代理</option><option v-for="project in snapshot.projects" :key="project.id" :value="project.id">{{ project.title }}</option></select></label>
              <label><span>原因</span><textarea v-model="intervention.reason" rows="3" /></label>
              <label v-if="intervention.kind === 'redefine_goal'"><span>新目标</span><textarea v-model="intervention.newGoal" rows="3" /></label>
              <UButton color="error" :loading="loading" :disabled="!intervention.reason.trim() || (intervention.kind === 'redefine_goal' && !intervention.newGoal.trim())" @click="intervene">提交“{{ interventionActionLabel }}”</UButton>
              <p v-if="actionMessage" class="company-provider-form__message" role="status">{{ actionMessage }}</p>
            </section>
          </aside>
        </div>

        <p v-if="board?.authorization.status !== 'authorized'" class="company-notice">
          当前模式或真实授权尚未满足，顾问代理保持安全关闭，页面不能提高模式。
        </p>

        <div class="founder-board-layout">
          <section class="company-section founder-board-takeover">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">影子建议</p>
                <h2>生成只读建议</h2>
              </div>
            </div>
            <label>
              <span>目标</span>
              <textarea v-model="shadowRun.currentGoal" rows="3" />
            </label>
            <label>
              <span>项目范围</span>
              <select v-model="shadowRun.projectId">
                <option value="">公司范围（需明确确认）</option>
                <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">
                  {{ project.title }} · {{ projectStatusLabel(project.status) }} · #{{ shortWorkID(project.id) }}
                </option>
              </select>
            </label>
            <label v-if="!shadowRun.projectId && snapshot.projects.length">
              <input v-model="companyScopeConfirmed" type="checkbox">
              <span>我确认这条建议可综合多项工作的公司范围信息。</span>
            </label>
            <UButton
              color="neutral"
              :loading="loading"
              :disabled="!shadowRun.currentGoal.trim() || !shadowScopeReady"
              @click="runShadow"
            >
              生成影子建议
            </UButton>
          </section>

          <section
            v-if="visibleShadowDecisions.length && visibleDecisions.length"
            class="company-section founder-board-takeover"
          >
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">建议对照</p>
                <h2>对照真实决定</h2>
              </div>
            </div>
            <label>
              <span>影子建议</span>
              <select v-model="comparison.shadowDecisionId">
                <option value="">选择建议</option>
                <option v-for="decision in visibleShadowDecisions" :key="decision.id" :value="decision.id">
                  {{ decision.recommendation || decision.id }}
                </option>
              </select>
            </label>
            <label>
              <span>决策台账中的真实决定</span>
              <select v-model="comparison.actualDecisionId">
                <option value="">选择决定</option>
                <option v-for="decision in visibleDecisions" :key="decision.id" :value="decision.id">
                  {{ decision.subject || decision.id }}
                </option>
              </select>
            </label>
            <label>
              <span>真实决定</span>
              <textarea v-model="comparison.actualDecision" rows="3" />
            </label>
            <label>
              <span>一致性</span>
              <select v-model="comparison.alignment">
                <option value="match">一致</option>
                <option value="partial">部分一致</option>
                <option value="mismatch">不一致</option>
              </select>
            </label>
            <label>
              <span>对照依据</span>
              <textarea v-model="comparison.rationale" rows="2" />
            </label>
            <UButton
              color="neutral"
              variant="outline"
              :loading="loading"
              :disabled="!comparison.shadowDecisionId || !comparison.actualDecisionId || !comparison.actualDecision.trim() || !comparison.rationale.trim()"
              @click="compareShadow"
            >
              写入对照
            </UButton>
          </section>
        </div>

        <section
          v-if="board?.advisorCanSpeak && boardThreadId"
          class="company-section founder-board-takeover"
        >
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">顾问代理收敛</p>
              <h2>形成决策意图</h2>
            </div>
            <span>{{ boardThreadId ? "董事会群聊已连接" : "缺少董事会讨论" }}</span>
          </div>
          <div class="founder-board-layout">
            <label>
              <span>影子建议</span>
              <select v-model="convergence.shadowDecisionId">
                <option value="">选择建议</option>
                <option v-for="decision in visibleShadowDecisions" :key="decision.id" :value="decision.id">
                  {{ decision.recommendation || decision.id }}
                </option>
              </select>
            </label>
            <label>
              <span>当前请求消息</span>
              <select v-model="convergence.channelMessageId">
                <option value="">选择消息</option>
                <option v-for="message in boardMessages" :key="message.id" :value="message.id">
                  {{ message.author }} · {{ message.body }}
                </option>
              </select>
            </label>
            <label>
              <span>直接负责人</span>
              <select v-model="convergence.driAgentId">
                <option value="">选择负责人</option>
                <option v-for="agent in snapshot.agents" :key="agent.id" :value="agent.id">
                  {{ boardPersonLabel(agent.name, agent.role) }}
                </option>
              </select>
            </label>
            <label>
              <span>超时分钟</span>
              <input v-model.number="convergence.timeoutMinutes" type="number" min="1" max="1440">
            </label>
          </div>
          <label>
            <span>主题</span>
            <textarea v-model="convergence.subject" rows="2" />
          </label>
          <label>
            <span>上下文</span>
            <textarea v-model="convergence.context" rows="4" />
          </label>
          <UButton
            color="neutral"
            :loading="loading"
            :disabled="!board?.advisorCanSpeak || !boardThreadId || !convergence.channelMessageId || !convergence.shadowDecisionId || !convergence.driAgentId || !convergence.subject.trim() || !convergence.context.trim()"
            @click="convergeAdvisor"
          >
            写入决策意图
          </UButton>
          <p class="company-provider-form__message">只写入治理意图与决策台账，不创建工作项或执行。</p>
        </section>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">影子建议记录</p>
              <h2>影子建议</h2>
            </div>
            <span>{{ visibleShadowDecisions.length }} 条</span>
          </div>
          <div class="founder-decision-list">
            <article v-for="decision in visibleShadowDecisions" :key="decision.id">
              <header>
                <div>
                  <strong>{{ decision.recommendation || "影子建议已被阻断" }}</strong>
                  <span>{{ decisionStatusLabel(decision.status) }} · {{ authorityLabel(decision.authorityClass) }} · 只读</span>
                </div>
                <span class="founder-confidence">
                  {{ decision.confidence === undefined ? "置信度未记录" : `置信度 ${Math.round(decision.confidence * 100)}%` }}
                </span>
              </header>
              <p v-if="decision.blockReasons.length">
                阻断：{{ decision.blockReasons.map(blockReasonLabel).join("、") }}
              </p>
              <details>
                <summary>查看影子建议依据</summary>
                <div class="founder-evidence-groups">
                  <div>
                    <strong>原则</strong>
                    <a
                      v-for="reference in decision.principleRefs"
                      :key="`${reference.assetId}:${reference.version}`"
                      :href="`#asset-${reference.assetId}-${reference.version}`"
                    >
                      {{ reference.assetId }} v{{ reference.version }}
                    </a>
                  </div>
                  <div>
                    <strong>证据</strong>
                    <span v-for="reference in decision.evidenceRefs" :key="`${reference.kind}:${reference.id}`">
                      {{ reference.kind }} · {{ reference.id }} · {{ reference.validity }}
                    </span>
                  </div>
                  <div>
                    <strong>缺失信息</strong>
                    <span v-for="item in decision.missingInformation" :key="item">{{ item }}</span>
                  </div>
                </div>
              </details>
            </article>
            <p v-if="!visibleShadowDecisions.length" class="company-empty">当前范围暂无影子建议。</p>
          </div>
        </section>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">决策依据</p>
              <h2>顾问代理依据与决策台账</h2>
            </div>
          </div>
          <div class="founder-decision-list">
            <article
              v-for="decision in visibleDecisions"
              :id="`decision-${decision.id}`"
              :key="decision.id"
            >
              <header>
                <div>
                  <strong>{{ decision.subject || "未命名治理决定" }}</strong>
                  <span>{{ authorityLabel(decision.authorityClass) }} · {{ decisionStatusLabel(decision.currentStatus) }}</span>
                </div>
                <span class="founder-confidence">
                  {{ decision.confidence === null ? "置信度未记录" : `置信度 ${Math.round(decision.confidence * 100)}%` }}
                </span>
              </header>
              <p>{{ decision.recommendation || decision.finalDecision || "暂无建议正文" }}</p>
              <details>
                <summary>查看依据</summary>
                <div class="founder-evidence-groups">
                  <div>
                    <strong>原则</strong>
                    <a
                      v-for="reference in decision.principleRefs ?? []"
                      :key="`${reference.assetId}:${reference.version}`"
                      :href="`#asset-${reference.assetId}-${reference.version}`"
                    >
                      {{ reference.assetId }} v{{ reference.version }}
                    </a>
                  </div>
                  <div>
                    <strong>案例</strong>
                    <a
                      v-for="reference in decision.decisionCaseRefs ?? []"
                      :key="`${reference.assetId}:${reference.version}`"
                      :href="`#asset-${reference.assetId}-${reference.version}`"
                    >
                      {{ reference.assetId }} v{{ reference.version }}
                    </a>
                  </div>
                  <div>
                    <strong>证据</strong>
                    <span v-for="reference in decision.evidenceRefs ?? []" :key="`${reference.kind}:${reference.id}`">
                      {{ reference.kind }} · {{ reference.id }}
                    </span>
                  </div>
                </div>
              </details>
            </article>
            <p v-if="!visibleDecisions.length" class="company-empty">当前范围暂无决策台账记录。</p>
          </div>
        </section>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">引用资产</p>
              <h2>治理资产版本</h2>
            </div>
          </div>
          <div class="founder-asset-index">
            <article
              v-for="asset in visibleAssets"
              :id="`asset-${asset.id}-${asset.version}`"
              :key="`${asset.id}:${asset.version}`"
            >
              <strong>{{ asset.type }}</strong>
              <span>{{ asset.authority }} · {{ asset.status }} · v{{ asset.version }}</span>
              <p>{{ asset.content }}</p>
            </article>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
