<script setup lang="ts">
import type { WorkProjection } from "@agents-company/shared/experience";
import {
  groupCounts,
  ownerOptions,
  selectWork,
  toWorkListEntry,
  workGroups,
  type WorkGroupId,
} from "../../../modules/agent-company/runtime/shared/work-list";

const appConfig = useAppConfig();
const { data: snapshot, pending, refresh } = useCompanySnapshot();
const { data: archivedWork } = useFetch<WorkProjection[]>("/api/agent-company/archived-work", {
  default: () => [],
});
const route = useRoute();
const router = useRouter();
const available = computed(() => ["ready", "degraded"].includes(snapshot.value.connection));
const workUnavailable = computed(() => snapshot.value.issue?.unavailable.includes("work") ?? false);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function humanLabel(value: string) {
  const labels: Record<string, string> = {
    CEO: "首席执行官",
    ceo: "首席执行官",
    CTO: "技术负责人",
    cto: "技术负责人",
    "Product Lead": "产品负责人",
    product_lead: "产品负责人",
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
    blocked: "受阻",
    superseded: "已由新计划替代",
  };
  return (labels[value] ?? value)
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/\bParent(?:\s+delivery)?\s+artifacts? bytes are persisted\b/gi, "上游交付成果已持久保存")
    .replace(/\bSuperseded by active plan\s+cpln_[A-Za-z0-9]+\b/gi, "已由当前计划替代")
    .replace(/\bcpln_[A-Za-z0-9]+\b/g, "当前计划")
    .replace(/\bsuperseded\b/gi, "已由新计划替代")
    .replace(/\bControl Plane Verification\b/gi, "系统核验")
    .replace(/\bDelivery v(\d+)\b/gi, "交付版本 $1")
    .replace(/\bProject Charter\b/gi, "项目章程")
    .replace(/\bCharter\b/gi, "工作章程")
    .replace(/\bDelivery\b/gi, "交付")
    .replace(/\bArtifacts?\b/gi, "成果")
    .replace(/持久化\s+成果/g, "持久化成果")
    .replace(/定义\s+工作章程\s+与任务树/g, "定义工作章程与任务树")
    .replace(/项目章程\s+与动态任务计划/g, "项目章程与动态任务计划");
}

function ownerName(owner?: { id: string; name?: string }) {
  if (!owner) return "尚未分配负责人";
  return humanLabel(
    owner.name ?? snapshot.value.agents.find(agent => agent.id === owner.id)?.name ?? owner.id,
  );
}

// 归一化为列表项（用于分组/搜索/排序），同时保留原始投影用于卡片渲染。
const decorated = computed(() => snapshot.value.work.map(item => ({ item, entry: toWorkListEntry(item) })));
const archivedDecorated = computed(() =>
  archivedWork.value.map(item => ({ item, entry: toWorkListEntry(item) })));
const counts = computed(() => groupCounts(decorated.value.map(row => row.entry)));
const owners = computed(() => ownerOptions(decorated.value.map(row => row.entry))
  .map(option => ({ ...option, name: humanLabel(option.name) })));

type WorkViewMode = "latest" | WorkGroupId;
const initialMode: WorkViewMode = route.query.group === "latest"
  ? "latest"
  : workGroups.some(item => item.id === route.query.group)
    ? route.query.group as WorkGroupId
    : "latest";
const mode = ref<WorkViewMode>(initialMode);
const group = computed<WorkGroupId>(() => mode.value === "latest" ? "all" : mode.value);
const query = ref(typeof route.query.q === "string" ? route.query.q : "");
const owner = ref<string | null>(typeof route.query.owner === "string" ? route.query.owner : null);
const filter = computed(() => ({ group: group.value, query: query.value, owner: owner.value }));
const pageSize = 100;
const visibleLimit = ref(pageSize);
const archivedLimit = ref(pageSize);

const matching = computed(() => {
  const byId = new Map(decorated.value.map(row => [row.entry.workId, row.item]));
  return selectWork(decorated.value.map(row => row.entry), filter.value).flatMap(entry => {
    const item = byId.get(entry.workId);
    return item ? [{ entry, item }] : [];
  });
});
const visible = computed(() =>
  mode.value === "latest" ? matching.value.slice(0, 1) : matching.value.slice(0, visibleLimit.value));
const hasMore = computed(() => mode.value !== "latest" && visible.value.length < matching.value.length);
const archivedMatching = computed(() => {
  const byId = new Map(archivedDecorated.value.map(row => [row.entry.workId, row.item]));
  return selectWork(
    archivedDecorated.value.map(row => row.entry),
    { group: "all", query: query.value, owner: owner.value },
  ).flatMap(entry => {
    const item = byId.get(entry.workId);
    return item ? [{ entry, item }] : [];
  });
});
const archivedVisible = computed(() => archivedMatching.value.slice(0, archivedLimit.value));
const hasMoreArchived = computed(() => archivedVisible.value.length < archivedMatching.value.length);

const hasFilter = computed(() => mode.value !== "latest" || query.value.trim() !== "" || owner.value !== null);

function clearFilters() {
  mode.value = "latest";
  query.value = "";
  owner.value = null;
}

function shortWorkID(value: string) {
  return value.slice(-8);
}

watch([mode, query, owner], ([selectedMode, search, selectedOwner]) => {
  visibleLimit.value = pageSize;
  archivedLimit.value = pageSize;
  router.replace({
    query: {
      ...(selectedMode !== "latest" ? { group: selectedMode } : {}),
      ...(search.trim() ? { q: search } : {}),
      ...(selectedOwner ? { owner: selectedOwner } : {}),
    },
  });
});
</script>

<template>
  <UDashboardPanel id="work" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <header class="ac-workspace-header">
          <div>
            <p class="ac-workspace-eyebrow">当前与历史工作</p>
            <h1 class="ac-workspace-title">工作</h1>
            <p class="ac-workspace-lede">
              默认只显示最近更新的工作；历史工作可按状态或“全部”主动查看。
            </p>
          </div>
        </header>

        <p v-if="typeof route.query.archived === 'string'" class="ac-brief-state" role="status">
          工作已归档，成果与执行记录仍保留。可在下方“已归档工作”中打开或恢复。
        </p>

        <div
          v-if="!available || workUnavailable"
          key="connection-state"
        >
          <CompanyConnectionState
            :connection="snapshot.connection"
            :issue="snapshot.issue"
            :pending="pending"
            show-settings
            @retry="refresh()"
          />
        </div>

        <template v-else-if="decorated.length || archivedDecorated.length">
          <div v-if="decorated.length" class="ac-work-toolbar">
            <div class="ac-work-tabs" role="tablist" aria-label="工作分组">
              <button
                type="button"
                role="tab"
                class="ac-work-tab"
                :data-active="mode === 'latest'"
                :aria-selected="mode === 'latest'"
                @click="mode = 'latest'"
              >
                最近工作
                <span class="ac-work-tab__count">{{ decorated.length ? 1 : 0 }}</span>
              </button>
              <button
                v-for="tab in workGroups"
                :key="tab.id"
                type="button"
                role="tab"
                class="ac-work-tab"
                :data-active="mode === tab.id"
                :aria-selected="mode === tab.id"
                @click="mode = tab.id"
              >
                {{ tab.label }}
                <span class="ac-work-tab__count">{{ counts[tab.id] }}</span>
              </button>
            </div>
            <div class="ac-work-filters">
              <input
                v-model="query"
                type="search"
                class="ac-work-search"
                placeholder="搜索目标、工作编号或负责人"
                aria-label="搜索工作"
              >
              <select
                v-if="owners.length"
                v-model="owner"
                class="ac-work-owner"
                aria-label="按负责人筛选"
              >
                <option :value="null">全部负责人</option>
                <option v-for="option in owners" :key="option.id" :value="option.id">{{ option.name }}</option>
              </select>
            </div>
          </div>

          <section
            v-if="visible.length"
            key="work-list"
            class="ac-card-list"
            aria-label="工作列表"
          >
            <NuxtLink
              v-for="{ entry, item } in visible"
              :key="entry.workId"
              :to="`/work/${encodeURIComponent(entry.workId)}`"
              class="ac-work-card"
            >
              <template v-if="item.availability === 'available'">
                <div class="ac-card-heading">
                  <div>
                    <p class="ac-card-kicker">{{ item.summary.phase }}</p>
                    <h2>{{ humanLabel(item.summary.title) }}</h2>
                  </div>
                  <span class="ac-status-badge" :data-status="item.summary.userStatus">
                    {{ appConfig.experience.statusLabels[item.summary.userStatus] }}
                  </span>
                </div>

                <p class="ac-card-reason">{{ humanLabel(item.summary.reason.text) }}</p>

                <div class="ac-progress" :aria-label="`${item.progress.completedItems} / ${item.progress.totalItems} 已完成`">
                  <span :style="{ width: `${item.progress.percent ?? 0}%` }" />
                </div>

                <div class="ac-card-footer">
                  <span>工作 #{{ shortWorkID(entry.workId) }}</span>
                  <span>{{ ownerName(item.summary.owner) }}</span>
                  <span>
                    {{ item.progress.completedItems }} / {{ item.progress.totalItems }}
                    <template v-if="item.progress.percent !== undefined"> · {{ item.progress.percent }}%</template>
                  </span>
                  <time :datetime="item.summary.updatedAt">
                    {{ dateTime.format(new Date(item.summary.updatedAt)) }}
                  </time>
                  <span
                    v-if="item.summary.nextAction"
                    class="ac-card-action"
                    :aria-disabled="!item.summary.nextAction.enabled"
                    :data-disabled="!item.summary.nextAction.enabled"
                  >
                    {{ appConfig.experience.actionLabels[item.summary.nextAction.id] }}
                    <small v-if="!item.summary.nextAction.enabled"> · 暂不可用</small>
                    <UIcon name="i-lucide-arrow-right" />
                  </span>
                </div>
              </template>

              <template v-else>
                <div class="ac-card-heading">
                  <div>
                    <p class="ac-card-kicker">状态诊断</p>
                    <h2>{{ humanLabel(item.title) }}</h2>
                  </div>
                  <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
                </div>
                <p class="ac-card-reason">{{ humanLabel(item.reason.text) }}</p>
                <div class="ac-card-footer">
                  <span>{{ item.diagnostics.length }} 项诊断</span>
                  <time :datetime="item.updatedAt">
                    {{ dateTime.format(new Date(item.updatedAt)) }}
                  </time>
                  <span class="ac-card-action">
                    查看诊断
                    <UIcon name="i-lucide-arrow-right" />
                  </span>
                </div>
              </template>
            </NuxtLink>
            <button
              v-if="hasMore"
              type="button"
              class="ac-work-load-more"
              @click="visibleLimit += pageSize"
            >
              加载更多（{{ matching.length - visible.length }}）
            </button>
          </section>

          <section v-else-if="!archivedMatching.length" key="work-no-results" class="ac-empty-state">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-filter-x" />
              </span>
              <h2>没有符合筛选条件的工作</h2>
              <p>调整分组、搜索或负责人筛选，或清除筛选查看全部工作。</p>
              <button v-if="hasFilter" type="button" class="ac-work-clear" @click="clearFilters">清除筛选</button>
            </div>
          </section>

          <details
            v-if="archivedMatching.length"
            class="ac-detail-panel"
            :open="typeof route.query.archived === 'string' || Boolean(query.trim())"
          >
            <summary>已归档工作（{{ archivedMatching.length }}）</summary>
            <div class="ac-card-list">
              <NuxtLink
                v-for="{ entry, item } in archivedVisible"
                :key="entry.workId"
                :to="`/work/${encodeURIComponent(entry.workId)}`"
                class="ac-work-card"
              >
                <div class="ac-card-heading">
                  <div>
                    <p class="ac-card-kicker">成果与执行记录已保留</p>
                    <h2>{{ humanLabel(entry.title) }}</h2>
                  </div>
                  <span class="ac-status-badge" data-status="archived">已归档</span>
                </div>
                <p class="ac-card-reason">
                  {{ item.availability === "available" ? item.summary.reason.text : item.reason.text }}
                </p>
                <div class="ac-card-footer">
                  <span>工作 #{{ shortWorkID(entry.workId) }}</span>
                  <span class="ac-card-action">
                    打开并恢复
                    <UIcon name="i-lucide-arrow-right" />
                  </span>
                </div>
              </NuxtLink>
              <button
                v-if="hasMoreArchived"
                type="button"
                class="ac-work-load-more"
                @click="archivedLimit += pageSize"
              >
                加载更多（{{ archivedMatching.length - archivedVisible.length }}）
              </button>
            </div>
          </details>
        </template>

        <section v-else key="work-empty" class="ac-empty-state">
          <div class="ac-empty-state__content">
            <span class="ac-empty-state__icon" aria-hidden="true">
              <UIcon name="i-lucide-panels-top-left" />
            </span>
            <h2>还没有可展示的工作</h2>
            <p>新的目标形成真实工作状态后，这里会呈现当前状态、原因与下一步。</p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
