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
const board = ref<FounderBoardGovernanceProjection | null>(null)
const thread = ref<CompanyBoardThread | null>(null)
const loading = ref(false)
const actionMessage = ref("")
const intervention = reactive({
  kind: "takeover" as "takeover" | "pause" | "correct" | "reject" | "redefine_goal",
  projectId: "",
  reason: "",
  newGoal: "",
})
const shadowRun = reactive({
  projectId: "",
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
const boardThreadId = computed(() =>
  [...snapshot.value.messages].reverse().find((message) => message.threadID)?.threadID)
const boardMessages = computed(() =>
  snapshot.value.messages.filter((message) => message.threadID === boardThreadId.value))
const currentRequest = computed(() =>
  [...boardMessages.value].reverse().find((message) => message.kind === "user") ?? boardMessages.value.at(-1))

function seedForms() {
  shadowRun.currentGoal ||= snapshot.value.company.setupGoal
    ?? snapshot.value.projects.at(0)?.title
    ?? "评估当前公司目标与讨论"
  comparison.shadowDecisionId ||= board.value?.shadow.decisions.at(0)?.id ?? ""
  comparison.actualDecisionId ||= board.value?.decisions.at(0)?.id ?? ""
  comparison.actualDecision ||= board.value?.decisions.at(0)?.finalDecision
    ?? board.value?.decisions.at(0)?.recommendation
    ?? ""
  convergence.shadowDecisionId ||= board.value?.shadow.decisions.at(0)?.id ?? ""
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
          || "当前 Board 尚无可用讨论记录。",
        authorizationBoundary: "Shadow 只生成建议，不发言、不建 Gate、不执行。",
        currentFacts: [
          `Provider: ${snapshot.value.company.provider}`,
          `Approval policy: ${snapshot.value.company.approvalPolicy}`,
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
        ? "Shadow 建议已写入只读投影。"
        : `Shadow 保持阻断：${result.blockReasons.join("、")}`
    },
    () => actionMessage.value = "Shadow 请求未写入，请检查上下文与 Control Plane 状态。",
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
      actionMessage.value = "Shadow 对照已写入，未冒充人工确认样本。"
      comparison.rationale = ""
    },
    () => actionMessage.value = "Shadow 对照未写入，请检查 Ledger 引用。",
  )
  loading.value = false
  await loadBoard()
}

async function convergeAdvisor() {
  const boardRunId = thread.value?.run?.id
  if (
    !boardThreadId.value
    || !boardRunId
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
        boardRunId,
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
      ? "Advisor DecisionIntent 已写入 Ledger，未创建执行。"
      : `Advisor 保持 ${result.status}：${result.events.at(-1)?.reason ?? result.authority.reason}`,
    () => actionMessage.value = "Advisor 收敛未写入，请检查 Board 来源链。",
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
      actionMessage.value = "接管记录未完成，请检查 Control Plane 状态。"
    })
  loading.value = false
  await Promise.all([loadBoard(), refresh()])
}

onMounted(loadBoard)
watch(() => snapshot.value.company.id, (companyId) => {
  if (companyId) loadBoard()
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
      <main id="main-content" class="company-page founder-board-page" lang="zh">
        <header class="company-page__header founder-board-page__header">
          <div>
            <p class="company-eyebrow">Founder governance board</p>
            <h1>董事会治理</h1>
            <p class="company-page__lede">讨论、依据、Decision Ledger 与人类接管共享同一条可追溯事实链。</p>
          </div>
          <div class="founder-principal">
            <span class="founder-principal__mark" aria-hidden="true">董</span>
            <div>
              <strong>{{ board?.principal.displayName ?? "AI 大东 · 创始人代理" }}</strong>
              <span>主体 board-ceo · 非新增员工</span>
            </div>
          </div>
        </header>

        <CompanyModuleNav />

        <section class="founder-board-status" aria-label="Advisor 状态">
          <div>
            <span>当前模式</span>
            <strong>{{ board?.mode.effective.founderTwinMode ?? "off" }}</strong>
          </div>
          <div>
            <span>治理授权</span>
            <strong>{{ board?.authorization.status ?? "not_confirmed" }}</strong>
          </div>
          <div>
            <span>代理发言</span>
            <strong>{{ board?.advisorCanSpeak ? "允许" : "已停止" }}</strong>
          </div>
        </section>

        <p v-if="board?.authorization.status !== 'authorized'" class="company-notice">
          当前模式或真实授权尚未满足，Advisor 收敛保持 fail-closed，页面不能提高模式。
        </p>

        <div class="founder-board-layout">
          <section class="company-section founder-board-takeover">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">Shadow run</p>
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
                <option value="">公司范围</option>
                <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">
                  {{ project.title }}
                </option>
              </select>
            </label>
            <UButton
              color="neutral"
              :loading="loading"
              :disabled="!shadowRun.currentGoal.trim()"
              @click="runShadow"
            >
              运行 Shadow
            </UButton>
          </section>

          <section class="company-section founder-board-takeover">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">Shadow compare</p>
                <h2>对照真实决定</h2>
              </div>
            </div>
            <label>
              <span>Shadow</span>
              <select v-model="comparison.shadowDecisionId">
                <option value="">选择建议</option>
                <option v-for="decision in board?.shadow.decisions ?? []" :key="decision.id" :value="decision.id">
                  {{ decision.recommendation || decision.id }}
                </option>
              </select>
            </label>
            <label>
              <span>Ledger 决定</span>
              <select v-model="comparison.actualDecisionId">
                <option value="">选择决定</option>
                <option v-for="decision in board?.decisions ?? []" :key="decision.id" :value="decision.id">
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

        <section class="company-section founder-board-takeover">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Advisor converge</p>
              <h2>收敛为 DecisionIntent</h2>
            </div>
            <span>{{ thread?.run?.id ?? "缺少 Board Run" }}</span>
          </div>
          <div class="founder-board-layout">
            <label>
              <span>Shadow</span>
              <select v-model="convergence.shadowDecisionId">
                <option value="">选择建议</option>
                <option v-for="decision in board?.shadow.decisions ?? []" :key="decision.id" :value="decision.id">
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
              <span>DRI Agent</span>
              <select v-model="convergence.driAgentId">
                <option value="">选择 Agent</option>
                <option v-for="agent in snapshot.agents" :key="agent.id" :value="agent.id">
                  {{ agent.name }} · {{ agent.role }}
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
            :disabled="!board?.advisorCanSpeak || !thread?.run?.id || !convergence.channelMessageId || !convergence.shadowDecisionId || !convergence.driAgentId || !convergence.subject.trim() || !convergence.context.trim()"
            @click="convergeAdvisor"
          >
            写入 Advisor Intent
          </UButton>
          <p class="company-provider-form__message">只写入治理意图与 Ledger，不创建 WorkItem 或执行。</p>
        </section>

        <div class="founder-board-layout">
          <section class="company-section founder-board-discussion">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">Board record</p>
                <h2>真实讨论记录</h2>
              </div>
            </div>
            <div class="founder-board-messages">
              <article v-for="message in snapshot.messages" :key="message.id">
                <header>
                  <strong>{{ message.author }}</strong>
                  <span>{{ message.role }} · {{ message.time }}</span>
                </header>
                <p>{{ message.body }}</p>
              </article>
              <p v-if="!snapshot.messages.length" class="company-empty">暂无已持久化 Board 消息。</p>
            </div>
          </section>

          <aside class="company-section founder-board-takeover">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">Human control</p>
                <h2>立即接管</h2>
              </div>
            </div>
            <p>写入 fence 后，创始人代理停止发言；已选项目通过现有停止链取消在途工作。</p>
            <label>
              <span>动作</span>
              <select v-model="intervention.kind">
                <option value="takeover">接管</option>
                <option value="pause">暂停</option>
                <option value="correct">纠正</option>
                <option value="reject">否决</option>
                <option value="redefine_goal">重定义目标</option>
              </select>
            </label>
            <label>
              <span>关联项目</span>
              <select v-model="intervention.projectId">
                <option value="">仅停止当前 Board 代理</option>
                <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">
                  {{ project.title }}
                </option>
              </select>
            </label>
            <label>
              <span>原因</span>
              <textarea v-model="intervention.reason" rows="4" />
            </label>
            <label v-if="intervention.kind === 'redefine_goal'">
              <span>新目标</span>
              <textarea v-model="intervention.newGoal" rows="3" />
            </label>
            <UButton
              color="error"
              :loading="loading"
              :disabled="!boardThreadId || !intervention.reason.trim() || (intervention.kind === 'redefine_goal' && !intervention.newGoal.trim())"
              @click="intervene"
            >
              写入接管并停止
            </UButton>
            <p v-if="!boardThreadId" class="company-provider-form__message">当前没有可关联的 Board Thread。</p>
            <p v-if="actionMessage" class="company-provider-form__message" role="status">{{ actionMessage }}</p>
          </aside>
        </div>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Shadow projection</p>
              <h2>Shadow 决策投影</h2>
            </div>
            <span>{{ board?.shadow.decisions.length ?? 0 }} 条</span>
          </div>
          <div class="founder-decision-list">
            <article v-for="decision in board?.shadow.decisions ?? []" :key="decision.id">
              <header>
                <div>
                  <strong>{{ decision.recommendation || "Shadow 决策被阻断" }}</strong>
                  <span>{{ decision.status }} · {{ decision.authorityClass ?? "unknown" }} · 只读</span>
                </div>
                <span class="founder-confidence">
                  {{ decision.confidence === undefined ? "置信度未记录" : `置信度 ${Math.round(decision.confidence * 100)}%` }}
                </span>
              </header>
              <p v-if="decision.blockReasons.length">
                阻断：{{ decision.blockReasons.join("、") }}
              </p>
              <details>
                <summary>查看 Shadow 依据</summary>
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
            <p v-if="!board?.shadow.decisions.length" class="company-empty">暂无 Shadow 决策投影。</p>
          </div>
        </section>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Decision evidence</p>
              <h2>Advisor 依据与 Ledger</h2>
            </div>
          </div>
          <div class="founder-decision-list">
            <article
              v-for="decision in board?.decisions ?? []"
              :id="`decision-${decision.id}`"
              :key="decision.id"
            >
              <header>
                <div>
                  <strong>{{ decision.subject || "未命名治理决定" }}</strong>
                  <span>{{ decision.authorityClass ?? "unknown" }} · {{ decision.currentStatus }}</span>
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
            <p v-if="!board?.decisions.length" class="company-empty">暂无 Ledger 决定。</p>
          </div>
        </section>

        <section class="company-section">
          <div class="company-section__heading">
            <div>
              <p class="company-eyebrow">Referenced assets</p>
              <h2>治理资产版本</h2>
            </div>
          </div>
          <div class="founder-asset-index">
            <article
              v-for="asset in board?.assets ?? []"
              :id="`asset-${asset.id}-${asset.version}`"
              :key="`${asset.id}:${asset.version}`"
            >
              <strong>{{ asset.type }}</strong>
              <span>{{ asset.authority }} · {{ asset.status }} · v{{ asset.version }}</span>
              <p>{{ asset.content }}</p>
            </article>
          </div>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
