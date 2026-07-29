<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import type { FounderBoardGovernanceProjection } from "@agents-company/sdk/v2/founder-os"

const { data: snapshot, refresh } = useCompanySnapshot()
const board = ref<FounderBoardGovernanceProjection | null>(null)
const loading = ref(false)
const actionMessage = ref("")
const intervention = reactive({
  kind: "takeover" as "takeover" | "pause" | "correct" | "reject" | "redefine_goal",
  projectId: "",
  reason: "",
  newGoal: "",
})
const boardThreadId = computed(() => snapshot.value.messages.find((message) => message.threadID)?.threadID)

async function loadBoard() {
  if (!snapshot.value.company.id || loading.value) return
  loading.value = true
  board.value = await $fetch<FounderBoardGovernanceProjection>("/api/agent-company/founder-board", {
    query: { companyId: snapshot.value.company.id },
  }).catch(() => null)
  loading.value = false
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
            <strong>{{ board?.authorization.status ?? "unavailable" }}</strong>
          </div>
          <div>
            <span>代理发言</span>
            <strong>{{ board?.advisorCanSpeak ? "允许" : "已停止" }}</strong>
          </div>
        </section>

        <p v-if="board?.authorization.status !== 'authorized'" class="company-notice">
          单一 GovernanceService 尚未接入或未获真实授权，Advisor 收敛保持 fail-closed，页面不能提高模式。
        </p>

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
