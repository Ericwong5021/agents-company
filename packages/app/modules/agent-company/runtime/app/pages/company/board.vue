<script setup lang="ts">
import { $fetch } from "ofetch"
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"
import type { CompanyBoardThread } from "../../../shared/company-contract"

type AcceptedBoardMessage = {
  threadID: string
}

type BoardDecisionResult = {
  project: {
    id: string
    title: string
    status: string
  }
  replayed: boolean
}

const { data: snapshot, refresh } = useCompanySnapshot()
const draft = ref("")
const submitting = ref(false)
const submitError = ref("")
const activeThreadID = ref("")
const thread = ref<CompanyBoardThread>()
const pollTimer = ref<ReturnType<typeof setTimeout>>()
const lastAttempt = ref({ body: "", requestID: "" })
const refreshedThreads = new Set<string>()
const decisionOpen = ref(false)
const decisionSaving = ref(false)
const decisionError = ref("")
const decisionRequestID = ref("")
const decisionResult = ref<BoardDecisionResult>()
const emptyCharter = () => ({
  title: "",
  value: "",
  deliverables: "",
  acceptance: "",
  scope: "",
  nonGoals: "",
  constraints: "",
  risk: "",
  mitigation: "",
  driAgentID: "",
  milestones: "",
  resourceKind: "repository" as "file" | "application" | "web" | "data" | "repository" | "other",
  resourceScope: "当前公司受管仓库",
  disposition: "保留并纳入项目审计",
})
const charter = reactive(emptyCharter())

const threadRunning = computed(() =>
  thread.value?.run && ["queued", "running", "projecting"].includes(thread.value.run.state),
)

function agentName(agentID: string) {
  return snapshot.value.agents.find((agent) => agent.id === agentID)?.name ?? agentID
}

function errorMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "董事会消息发送失败，请重试。"
  const data = "data" in error && typeof error.data === "object" && error.data !== null
    ? error.data as Record<string, unknown>
    : undefined
  if (data?.kind === "provider_required") return "需要先配置模型 Provider，目标已保留。"
  if (typeof data?.statusMessage === "string") return data.statusMessage
  if ("message" in error && typeof error.message === "string") return error.message
  return "董事会消息发送失败，请重试。"
}

function currentGoal() {
  return snapshot.value.messages.find(
    (message) => message.threadID === activeThreadID.value && message.kind === "user",
  )?.body ?? ""
}

function charterSection(body: string, label: string) {
  const marker = `**${label}**`
  const start = body.indexOf(marker)
  if (start < 0) return ""
  const value = body.slice(start + marker.length).replace(/^[:：]\s*/, "")
  const next = value.search(/\n\s*-\s+\*\*/)
  return (next < 0 ? value : value.slice(0, next)).trim()
}

function lines(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
    .filter(Boolean)
}

function prepareCharter() {
  const decision = thread.value?.messages.find((message) => message.body.includes("**价值**"))?.body ?? ""
  const scope = charterSection(decision, "范围")
  const dri = charterSection(decision, "DRI")
  const milestones = charterSection(decision, "里程碑")
  const goal = currentGoal()
  charter.title ||= goal.slice(0, 72) || thread.value?.id || "董事会项目"
  charter.value ||= charterSection(decision, "价值") || goal
  charter.scope ||= scope || goal
  charter.deliverables ||= scope || goal
  charter.acceptance ||= charterSection(decision, "验收标准") || goal
  charter.nonGoals ||= charterSection(decision, "非目标") || "不执行 Charter 范围外工作"
  charter.constraints ||= charterSection(decision, "约束") || "遵守当前公司权限与批准策略"
  charter.risk ||= charterSection(decision, "主要风险")
  charter.mitigation ||= charter.risk ? "按董事会批准的处置原则保留证据并升级阻塞" : ""
  charter.milestones ||= lines(milestones).join("\n") || charter.deliverables
  charter.driAgentID ||=
    snapshot.value.agents
      .map((agent) => ({ agent, position: dri.toLowerCase().indexOf(agent.name.toLowerCase()) }))
      .filter((candidate) => candidate.position >= 0)
      .sort((left, right) => left.position - right.position)[0]?.agent.id ??
    snapshot.value.agents[0]?.id ??
    ""
  decisionError.value = ""
  decisionOpen.value = true
}

async function decide() {
  if (!thread.value || decisionSaving.value) return
  const risks = charter.risk.trim()
    ? [{ description: charter.risk.trim(), mitigation: charter.mitigation.trim() }]
    : []
  if (risks.some((risk) => !risk.mitigation)) {
    decisionError.value = "每项风险都需要处置方式"
    return
  }

  decisionRequestID.value ||= crypto.randomUUID()
  decisionSaving.value = true
  decisionError.value = ""
  const result = await $fetch<BoardDecisionResult>("/api/agent-company/board/decide", {
    method: "POST",
    body: {
      thread_id: thread.value.id,
      request_id: decisionRequestID.value,
      charter: {
        title: charter.title,
        value: charter.value,
        deliverables: lines(charter.deliverables),
        acceptance_criteria: lines(charter.acceptance),
        scope: lines(charter.scope),
        non_goals: lines(charter.nonGoals),
        constraints: lines(charter.constraints),
        resources: [{
          kind: charter.resourceKind,
          scope: charter.resourceScope,
          disposition: charter.disposition,
        }],
        risks,
        dri_agent_id: charter.driAgentID,
        milestones: lines(charter.milestones),
        open_decisions: [],
      },
    },
  })
    .then((value) => ({ value }))
    .catch((error: unknown) => ({ error }))
  decisionSaving.value = false
  if ("error" in result) {
    decisionError.value = errorMessage(result.error)
    return
  }

  decisionResult.value = result.value
  decisionOpen.value = false
  await refresh()
}

function scheduleThreadRefresh() {
  if (pollTimer.value) clearTimeout(pollTimer.value)
  if (!threadRunning.value) return
  pollTimer.value = setTimeout(() => void loadThread(), 1_200)
}

async function loadThread() {
  const threadID = activeThreadID.value
  if (!threadID) return
  const result = await $fetch<CompanyBoardThread>("/api/agent-company/board", {
    query: { thread_id: threadID },
  })
    .then((value) => ({ value }))
    .catch((error: unknown) => ({ error }))
  if (threadID !== activeThreadID.value) return
  if ("error" in result) {
    submitError.value = errorMessage(result.error)
    return
  }

  thread.value = result.value
  if (!threadRunning.value && !refreshedThreads.has(threadID)) {
    refreshedThreads.add(threadID)
    await refresh()
  }
  scheduleThreadRefresh()
}

async function submit() {
  const body = draft.value.trim()
  if (!body || submitting.value) return
  if (lastAttempt.value.body !== body) {
    lastAttempt.value = { body, requestID: crypto.randomUUID() }
  }

  submitting.value = true
  submitError.value = ""
  const result = await $fetch<AcceptedBoardMessage>("/api/agent-company/board", {
    method: "POST",
    body: {
      request_id: lastAttempt.value.requestID,
      body,
    },
  })
    .then((value) => ({ value }))
    .catch((error: unknown) => ({ error }))
  submitting.value = false
  if ("error" in result) {
    submitError.value = errorMessage(result.error)
    return
  }

  draft.value = ""
  lastAttempt.value = { body: "", requestID: "" }
  activeThreadID.value = result.value.threadID
  thread.value = undefined
  await refresh()
  await loadThread()
}

watch(activeThreadID, () => {
  decisionOpen.value = false
  decisionSaving.value = false
  decisionError.value = ""
  decisionRequestID.value = ""
  decisionResult.value = undefined
  Object.assign(charter, emptyCharter())
})

watch(
  () => snapshot.value.messages,
  (messages) => {
    if (!import.meta.client || activeThreadID.value) return
    const threadID = messages.find((message) => message.threadID)?.threadID
    if (!threadID) return
    activeThreadID.value = threadID
    void loadThread()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (pollTimer.value) clearTimeout(pollTimer.value)
})
</script>

<template>
  <UDashboardPanel id="agent-company-board" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="company-page company-page--board">
        <header class="company-page__header company-page__header--compact">
          <div>
            <p class="company-eyebrow">Board channel</p>
            <h1>Roundtable</h1>
            <p class="company-page__lede">High-signal group collaboration with visible roles and decisions.</p>
          </div>
          <div class="company-avatar-stack" aria-label="Board participants">
            <span v-for="agent in snapshot.agents.slice(0, 3)" :key="agent.id">
              {{ agent.name.slice(0, 1) }}
            </span>
          </div>
        </header>

        <CompanyModuleNav />

        <p v-if="submitError" class="company-board-state company-board-state--error" role="alert">
          {{ submitError }}
          <NuxtLink v-if="!snapshot.company.providerConfigured" to="/settings/company">配置 Provider</NuxtLink>
        </p>

        <section class="company-board-feed" aria-label="Board messages">
          <article
            v-for="message in snapshot.messages"
            :key="message.id"
            class="company-message"
            :class="`company-message--${message.kind}`"
          >
            <div class="company-message__meta">
              <strong>{{ message.author }}</strong>
              <span>{{ message.role }}</span>
              <time>{{ message.time }}</time>
            </div>
            <p>{{ message.body }}</p>
          </article>

          <div v-if="thread" class="company-board-thread">
            <div class="company-board-state">
              <span v-if="threadRunning">董事会正在 bidding 与发言…</span>
              <span v-else-if="thread.run?.state === 'completed'">本轮董事会对话已完成</span>
              <span v-else-if="thread.run?.state === 'failed'">本轮运行失败</span>
              <span v-else>{{ thread.status }}</span>
              <span v-if="thread.bidding?.winnerAgentID">
                第 {{ thread.bidding.roundNum }} 轮由 {{ agentName(thread.bidding.winnerAgentID) }} 发言
              </span>
              <span v-else-if="thread.bidding?.state === 'decided'">
                第 {{ thread.bidding.roundNum }} 轮全员 pass，自然结束
              </span>
              <UButton
                v-if="thread.run?.state === 'completed' && !thread.projectID && !decisionResult"
                size="xs"
                color="neutral"
                variant="soft"
                @click="prepareCharter"
              >
                正式下达
              </UButton>
            </div>

            <article
              v-for="message in thread.messages"
              :key="message.id"
              class="company-message company-message--thread"
            >
              <div class="company-message__meta">
                <strong>{{ agentName(message.agentID) }}</strong>
                <span>Board</span>
                <time>{{ message.time }}</time>
              </div>
              <p>{{ message.body }}</p>
            </article>

            <p v-if="thread.run?.error" class="company-board-state company-board-state--error">
              {{ thread.run.error }}
            </p>

            <form v-if="decisionOpen" class="company-charter-card" @submit.prevent="decide">
              <div class="company-charter-card__heading">
                <div>
                  <span>Project Charter</span>
                  <strong>正式下达前确认可验收边界</strong>
                </div>
                <button type="button" aria-label="Close Charter" @click="decisionOpen = false">×</button>
              </div>
              <div class="company-charter-card__grid">
                <label class="company-charter-card__wide">
                  <span>标题</span>
                  <input v-model="charter.title" required>
                </label>
                <label class="company-charter-card__wide">
                  <span>价值</span>
                  <textarea v-model="charter.value" required rows="3" />
                </label>
                <label>
                  <span>交付物（每行一项）</span>
                  <textarea v-model="charter.deliverables" required rows="4" />
                </label>
                <label>
                  <span>验收标准（每行一项）</span>
                  <textarea v-model="charter.acceptance" required rows="4" />
                </label>
                <label>
                  <span>范围（每行一项）</span>
                  <textarea v-model="charter.scope" required rows="3" />
                </label>
                <label>
                  <span>非目标（每行一项）</span>
                  <textarea v-model="charter.nonGoals" required rows="3" />
                </label>
                <label>
                  <span>约束（每行一项）</span>
                  <textarea v-model="charter.constraints" required rows="3" />
                </label>
                <label>
                  <span>里程碑（每行一项）</span>
                  <textarea v-model="charter.milestones" required rows="3" />
                </label>
                <label>
                  <span>DRI</span>
                  <select v-model="charter.driAgentID" required>
                    <option v-for="agent in snapshot.agents.slice(0, 3)" :key="agent.id" :value="agent.id">
                      {{ agent.name }}
                    </option>
                  </select>
                </label>
                <label>
                  <span>受管资源</span>
                  <input v-model="charter.resourceScope" required>
                </label>
                <label>
                  <span>主要风险</span>
                  <textarea v-model="charter.risk" rows="3" />
                </label>
                <label>
                  <span>风险处置</span>
                  <textarea v-model="charter.mitigation" rows="3" />
                </label>
              </div>
              <p v-if="decisionError" class="company-charter-card__error" role="alert">{{ decisionError }}</p>
              <div class="company-charter-card__footer">
                <span>无重大待决事项时，将按当前批准策略启动项目。</span>
                <UButton type="submit" color="neutral" :loading="decisionSaving">创建项目并执行</UButton>
              </div>
            </form>

            <article v-if="decisionResult" class="company-project-decision">
              <span>Project created</span>
              <strong>{{ decisionResult.project.title }}</strong>
              <p>{{ decisionResult.project.status }} · {{ decisionResult.project.id }}</p>
            </article>
            <article v-else-if="thread.projectID" class="company-project-decision">
              <span>Project linked</span>
              <strong>正式项目已从本 Thread 创建</strong>
              <p>{{ thread.projectID }}</p>
            </article>
          </div>
        </section>

        <form class="company-composer" @submit.prevent="submit">
          <textarea
            v-model="draft"
            rows="3"
            placeholder="向董事会下达目标…"
            :disabled="submitting"
          />
          <div class="company-composer__footer">
            <span>{{ snapshot.company.providerConfigured ? "Company Board" : "Provider 未配置" }}</span>
            <UButton
              type="submit"
              color="neutral"
              icon="i-lucide-arrow-up"
              square
              aria-label="Send to board"
              :loading="submitting"
              :disabled="!draft.trim() || submitting"
            />
          </div>
        </form>
      </div>
    </template>
  </UDashboardPanel>
</template>
