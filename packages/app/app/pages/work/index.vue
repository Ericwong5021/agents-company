<script setup lang="ts">
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

function ownerName(owner?: { id: string; name?: string }) {
  if (!owner) return "尚未分配负责人";
  return owner.name ?? snapshot.value.agents.find(agent => agent.id === owner.id)?.name ?? "负责人已分配";
}

// 归一化为列表项（用于分组/搜索/排序），同时保留原始投影用于卡片渲染。
const decorated = computed(() => snapshot.value.work.map(item => ({ item, entry: toWorkListEntry(item) })));
const counts = computed(() => groupCounts(decorated.value.map(row => row.entry)));
const owners = computed(() => ownerOptions(decorated.value.map(row => row.entry)));

// 深链接/刷新保持分组、搜索与负责人筛选。
const group = ref<WorkGroupId>(workGroups.some(item => item.id === route.query.group) ? (route.query.group as WorkGroupId) : "all");
const query = ref(typeof route.query.q === "string" ? route.query.q : "");
const owner = ref<string | null>(typeof route.query.owner === "string" ? route.query.owner : null);
const filter = computed(() => ({ group: group.value, query: query.value, owner: owner.value }));

const visible = computed(() => {
  const byId = new Map(decorated.value.map(row => [row.entry.workId, row.item]));
  return selectWork(decorated.value.map(row => row.entry), filter.value).flatMap(entry => {
    const item = byId.get(entry.workId);
    return item ? [{ entry, item }] : [];
  });
});

const hasFilter = computed(() => group.value !== "all" || query.value.trim() !== "" || owner.value !== null);

function clearFilters() {
  group.value = "all";
  query.value = "";
  owner.value = null;
}

watch(filter, value => {
  router.replace({
    query: {
      ...(value.group !== "all" ? { group: value.group } : {}),
      ...(value.query.trim() ? { q: value.query } : {}),
      ...(value.owner ? { owner: value.owner } : {}),
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
            <p class="ac-workspace-eyebrow">Active execution</p>
            <h1 class="ac-workspace-title">Work</h1>
            <p class="ac-workspace-lede">
              查看目标、执行过程、失败尝试与当前进展。
            </p>
          </div>
        </header>

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

        <template v-else-if="decorated.length">
          <div class="ac-work-toolbar">
            <div class="ac-work-tabs" role="tablist" aria-label="工作分组">
              <button
                v-for="tab in workGroups"
                :key="tab.id"
                type="button"
                role="tab"
                class="ac-work-tab"
                :data-active="group === tab.id"
                :aria-selected="group === tab.id"
                @click="group = tab.id"
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
                placeholder="搜索目标或负责人"
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
                    <h2>{{ item.summary.title }}</h2>
                  </div>
                  <span class="ac-status-badge" :data-status="item.summary.userStatus">
                    {{ appConfig.experience.statusLabels[item.summary.userStatus] }}
                  </span>
                </div>

                <p class="ac-card-reason">{{ item.summary.reason.text }}</p>

                <div class="ac-progress" :aria-label="`${item.progress.completedItems} / ${item.progress.totalItems} 已完成`">
                  <span :style="{ width: `${item.progress.percent ?? 0}%` }" />
                </div>

                <div class="ac-card-footer">
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
                    <h2>{{ item.title }}</h2>
                  </div>
                  <span class="ac-status-badge" data-status="unavailable">状态不可用</span>
                </div>
                <p class="ac-card-reason">{{ item.reason.text }}</p>
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
          </section>

          <section v-else key="work-no-results" class="ac-empty-state">
            <div class="ac-empty-state__content">
              <span class="ac-empty-state__icon" aria-hidden="true">
                <UIcon name="i-lucide-filter-x" />
              </span>
              <h2>没有符合筛选条件的工作</h2>
              <p>调整分组、搜索或负责人筛选，或清除筛选查看全部工作。</p>
              <button v-if="hasFilter" type="button" class="ac-work-clear" @click="clearFilters">清除筛选</button>
            </div>
          </section>
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
