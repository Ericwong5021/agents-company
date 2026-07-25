<script setup lang="ts">
import type { GoalBriefProjectView } from "@agents-company/shared/experience";

const route = useRoute();
const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const workID = computed(() => Array.isArray(route.params.projectID)
  ? route.params.projectID[0]
  : route.params.projectID);
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const work = computed(() => snapshot.value.work.find(item =>
  (item.availability === "available" ? item.summary.workId : item.workId) === workID.value));
const {
  data: goalBriefResult,
  status: goalBriefStatus,
  error: goalBriefError,
  refresh: refreshGoalBrief,
} = useFetch<GoalBriefProjectView>(() =>
  `/api/agent-company/projects/${encodeURIComponent(workID.value ?? "")}/goal-brief`);
const goalBrief = computed(() => goalBriefResult.value && "kind" in goalBriefResult.value
  ? goalBriefResult.value
  : undefined);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function briefSourceLabel(source: string) {
  if (source === "user_confirmation") return "用户确认";
  if (source === "user_input") return "用户输入";
  if (source === "system_suggestion") return "系统建议";
  return "旧项目 Charter";
}

function briefApprovalLabel(mode: string) {
  if (mode === "autonomous") return "自主推进";
  if (mode === "strict") return "严格审批";
  return "平衡审批";
}

function artifactKindLabel(kind: string) {
  if (kind === "report") return "报告";
  if (kind === "file") return "文件";
  if (kind === "link") return "链接";
  return "成果";
}

function artifactRoute(projectID: string, artifactID: string) {
  return `/library/artifacts/${encodeURIComponent(projectID)}/${encodeURIComponent(artifactID)}`;
}
</script>

<template>
  <UDashboardPanel id="work-detail" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <NuxtLink to="/work" class="ac-back-link">
          <UIcon name="i-lucide-arrow-left" />
          返回 Work
        </NuxtLink>

        <CompanyConnectionState
          v-if="!available || workUnavailable"
          class="mt-5"
          :connection="snapshot.connection"
          :issue="snapshot.issue"
          :pending="pending"
          show-settings
          @retry="refresh()"
        />

        <template v-else-if="work?.availability === 'available'">
          <header class="ac-workspace-header mt-5">
            <div>
              <p class="ac-workspace-eyebrow">{{ work.summary.phase }}</p>
              <h1 class="ac-workspace-title">{{ work.summary.title }}</h1>
              <p class="ac-workspace-lede">{{ work.summary.reason.text }}</p>
            </div>
            <span class="ac-status-badge" :data-status="work.summary.userStatus">
              {{ appConfig.experience.statusLabels[work.summary.userStatus] }}
            </span>
          </header>

          <div class="ac-detail-stack">
            <section class="ac-detail-panel" aria-live="polite">
              <div class="ac-detail-heading">
                <div>
                  <p class="ac-card-kicker">Goal</p>
                  <h2>目标摘要</h2>
                </div>
                <span
                  v-if="goalBrief?.kind === 'goal_brief'"
                  class="ac-status-badge"
                >
                  版本 {{ goalBrief.brief.version }}
                </span>
                <span
                  v-else-if="goalBrief?.kind === 'legacy_charter'"
                  class="ac-status-badge"
                  data-status="unavailable"
                >
                  旧数据 · 只读
                </span>
              </div>

              <div v-if="goalBriefStatus === 'pending'" class="ac-brief-state">
                正在读取目标摘要…
              </div>

              <div v-else-if="goalBriefError" class="ac-brief-state ac-brief-state--error">
                <h3>目标摘要暂时不可用</h3>
                <p>未能从本地服务读取经过验证的目标信息，页面不会根据工作标题猜测。</p>
                <UButton color="neutral" variant="outline" @click="refreshGoalBrief()">
                  重新读取
                </UButton>
              </div>

              <template v-else-if="goalBrief?.kind === 'goal_brief'">
                <p class="ac-brief-goal">{{ goalBrief.brief.goal }}</p>
                <dl class="ac-brief-meta">
                  <div>
                    <dt>来源</dt>
                    <dd>{{ briefSourceLabel(goalBrief.brief.source) }}</dd>
                  </div>
                  <div>
                    <dt>审批模式</dt>
                    <dd>{{ briefApprovalLabel(goalBrief.brief.approvalMode) }}</dd>
                  </div>
                </dl>
                <div class="ac-brief-grid">
                  <section>
                    <h3>交付内容</h3>
                    <article
                      v-for="deliverable in goalBrief.brief.deliverables"
                      :key="deliverable.id"
                      class="ac-brief-item"
                    >
                      <strong>{{ deliverable.title }}</strong>
                      <p>{{ deliverable.description }}</p>
                    </article>
                  </section>
                  <section>
                    <h3>验收标准</h3>
                    <article
                      v-for="criterion in goalBrief.brief.acceptanceCriteria"
                      :key="criterion.id"
                      class="ac-brief-item"
                    >
                      <strong>{{ criterion.description }}</strong>
                      <p>{{ criterion.verification }}</p>
                    </article>
                  </section>
                </div>
                <div v-if="goalBrief.brief.constraints.length" class="ac-brief-constraints">
                  <h3>约束</h3>
                  <ul>
                    <li v-for="constraint in goalBrief.brief.constraints" :key="constraint">
                      {{ constraint }}
                    </li>
                  </ul>
                </div>
              </template>

              <template v-else-if="goalBrief?.kind === 'legacy_charter'">
                <p class="ac-brief-state">
                  这是从旧项目 Charter 读取的只读目标摘要。缺失字段不会被推断或补写。
                </p>
                <p class="ac-brief-goal">{{ goalBrief.brief.goal }}</p>
                <dl class="ac-brief-meta">
                  <div>
                    <dt>来源</dt>
                    <dd>{{ briefSourceLabel(goalBrief.brief.source) }}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>{{ goalBrief.brief.version }}</dd>
                  </div>
                </dl>
                <div class="ac-brief-grid">
                  <section>
                    <h3>交付内容</h3>
                    <ul>
                      <li v-for="deliverable in goalBrief.brief.deliverables" :key="deliverable">
                        {{ deliverable }}
                      </li>
                    </ul>
                  </section>
                  <section>
                    <h3>验收标准</h3>
                    <ul>
                      <li v-for="criterion in goalBrief.brief.acceptanceCriteria" :key="criterion">
                        {{ criterion }}
                      </li>
                    </ul>
                  </section>
                </div>
                <div v-if="goalBrief.brief.constraints.length" class="ac-brief-constraints">
                  <h3>约束</h3>
                  <ul>
                    <li v-for="constraint in goalBrief.brief.constraints" :key="constraint">
                      {{ constraint }}
                    </li>
                  </ul>
                </div>
              </template>
            </section>

            <section class="ac-detail-panel">
              <div class="ac-detail-heading">
                <div>
                  <p class="ac-card-kicker">Progress</p>
                  <h2>当前进展</h2>
                </div>
                <strong v-if="work.progress.percent !== undefined">{{ work.progress.percent }}%</strong>
              </div>
              <div class="ac-progress" :aria-label="`${work.progress.completedItems} / ${work.progress.totalItems} 已完成`">
                <span :style="{ width: `${work.progress.percent ?? 0}%` }" />
              </div>
              <p class="ac-card-reason">{{ work.progress.reason.text }}</p>
              <div class="ac-card-footer">
                <span>{{ work.progress.completedItems }} / {{ work.progress.totalItems }} 项完成</span>
                <time :datetime="work.progress.updatedAt">
                  {{ dateTime.format(new Date(work.progress.updatedAt)) }}
                </time>
                <span
                  v-if="work.progress.nextAction"
                  class="ac-card-action"
                  :aria-disabled="!work.progress.nextAction.enabled"
                  :data-disabled="!work.progress.nextAction.enabled"
                >
                  {{ appConfig.experience.actionLabels[work.progress.nextAction.id] }}
                  <small v-if="!work.progress.nextAction.enabled"> · 暂不可用</small>
                </span>
              </div>
              <div
                v-if="work.summary.allowedActions.some(action => !action.enabled)"
                class="ac-disabled-actions"
                aria-label="当前不可用动作"
              >
                <template v-for="action in work.summary.allowedActions" :key="action.id">
                  <span v-if="!action.enabled" aria-disabled="true">
                    {{ appConfig.experience.actionLabels[action.id] }} · {{ action.disabledReason }}
                  </span>
                </template>
              </div>
            </section>

            <section v-if="work.attentionItems.length" class="ac-detail-panel">
              <div class="ac-detail-heading">
                <div>
                  <p class="ac-card-kicker">Attention</p>
                  <h2>需要处理</h2>
                </div>
                <strong>{{ work.attentionItems.length }}</strong>
              </div>
              <article
                v-for="item in work.attentionItems"
                :key="item.id"
                class="ac-inline-item"
              >
                <h3>{{ item.title }}</h3>
                <p>{{ item.reason.text }}</p>
                <span
                  v-if="item.recommendedAction"
                  :aria-disabled="!item.recommendedAction.enabled"
                  :data-disabled="!item.recommendedAction.enabled"
                >
                  {{ appConfig.experience.actionLabels[item.recommendedAction.id] }}
                  <small v-if="!item.recommendedAction.enabled"> · 暂不可用</small>
                </span>
              </article>
            </section>

            <section v-if="work.delivery" class="ac-detail-panel">
              <div class="ac-detail-heading">
                <div>
                  <p class="ac-card-kicker">Delivery</p>
                  <h2>交付版本 {{ work.delivery.version }}</h2>
                </div>
                <strong>{{ work.delivery.artifacts.length }} 项成果</strong>
              </div>
              <p class="ac-card-reason">{{ work.delivery.reason.text }}</p>
              <div v-if="work.delivery.artifacts.length" class="ac-artifact-list">
                <NuxtLink
                  v-for="artifact in work.delivery.artifacts"
                  :key="artifact.id"
                  class="ac-artifact-link"
                  :to="artifactRoute(artifact.projectId, artifact.id)"
                >
                  <span>
                    <strong>{{ artifact.title }}</strong>
                    <small>{{ artifactKindLabel(artifact.kind) }}</small>
                  </span>
                  <UIcon name="i-lucide-arrow-up-right" />
                </NuxtLink>
              </div>
              <span
                v-if="work.delivery.nextAction"
                class="ac-card-action"
                :aria-disabled="!work.delivery.nextAction.enabled"
                :data-disabled="!work.delivery.nextAction.enabled"
              >
                {{ appConfig.experience.actionLabels[work.delivery.nextAction.id] }}
                <small v-if="!work.delivery.nextAction.enabled"> · 暂不可用</small>
              </span>
            </section>

            <details v-if="work.diagnostics.length" class="ac-detail-panel ac-diagnostic-panel">
              <summary>状态诊断 {{ work.diagnostics.length }} 项</summary>
              <ul>
                <li v-for="diagnostic in work.diagnostics" :key="diagnostic.id">
                  {{ diagnostic.message }}
                </li>
              </ul>
            </details>
          </div>
        </template>

        <template v-else-if="work?.availability === 'unavailable'">
          <header class="ac-workspace-header mt-5">
            <div>
              <p class="ac-workspace-eyebrow">Status diagnostics</p>
              <h1 class="ac-workspace-title">{{ work.title }}</h1>
              <p class="ac-workspace-lede">{{ work.reason.text }}</p>
            </div>
            <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
          </header>

          <section class="ac-detail-panel">
            <div class="ac-detail-heading">
              <div>
                <p class="ac-card-kicker">Diagnostics</p>
                <h2>状态诊断</h2>
              </div>
              <strong>{{ work.diagnostics.length }} 项</strong>
            </div>
            <ul class="ac-diagnostic-list">
              <li v-for="diagnostic in work.diagnostics" :key="diagnostic.id">
                {{ diagnostic.message }}
              </li>
            </ul>
          </section>
        </template>

        <section v-else class="ac-empty-state mt-5">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-file-question" />
            </span>
            <h1>没有找到这项工作</h1>
            <p>当前真实工作状态中没有对应记录，页面不会用临时项目数据代替。</p>
            <UButton class="ac-empty-state__action" color="neutral" to="/work">
              返回 Work
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
