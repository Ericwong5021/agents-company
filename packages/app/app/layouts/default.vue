<script setup lang="ts">
import {
  activeShellNavigationItem,
  isShellNavigationActive,
  visibleShellNavigation,
} from "../utils/shell-navigation";
import type { CompanySnapshot } from "../../modules/agent-company/runtime/shared/company-contract";
import { aggregateAttention } from "../../modules/agent-company/runtime/shared/inbox-attention";

const sidebarOpen = useState("agent-company-shell-sidebar-open", () => false);
const route = useRoute();
const snapshot = useState<CompanySnapshot | undefined>("agent-company-snapshot-value");
const telemetry = useProductTelemetry();
const observedWorkStatuses = ref<Record<string, string>>({});
const attentionCount = computed(() => snapshot.value
  ? aggregateAttention(snapshot.value.work).length
    + snapshot.value.work.filter(work => work.availability === "unavailable").length
  : 0);

watch(
  () => snapshot.value?.work,
  works => {
    if (!works) return;
    const nextStatuses: Record<string, string> = {};
    works.forEach(work => {
      if (work.availability === "unavailable") {
        telemetry.record("failed", {
          dedupeKey: `unavailable:${work.workId}:${work.diagnostics.map(item => item.id).join(":")}`,
          scenario: "work_projection",
          props: { availability: "unavailable", diagnosticCount: work.diagnostics.length },
        });
        return;
      }
      const workID = work.summary.workId;
      const previous = observedWorkStatuses.value[workID];
      nextStatuses[workID] = work.summary.userStatus;
      work.attentionItems.forEach(item => {
        telemetry.record("attention_requested", {
          dedupeKey: item.id,
          scenario: "attention_center",
          props: { type: item.type, priority: item.priority },
        });
        if (item.type === "blocked") telemetry.record("blocked", {
          dedupeKey: item.id,
          scenario: "execution",
          props: { priority: item.priority },
        });
        if (item.type === "failure") telemetry.record("failed", {
          dedupeKey: item.id,
          scenario: "execution",
          props: { priority: item.priority },
        });
      });
      if (previous && ["blocked", "failed"].includes(previous) && !["blocked", "failed"].includes(work.summary.userStatus))
        telemetry.record("recovered", {
          scenario: "execution",
          props: { from: previous, to: work.summary.userStatus },
        });
    });
    observedWorkStatuses.value = nextStatuses;
  },
  { deep: true, immediate: true },
);
const scopedNavigationTargets = new Set(["/company/board", "/team"]);
const appConfig = useAppConfig();
const routeProjectID = computed(() => {
  const queryProject = typeof route.query.project === "string" ? route.query.project : "";
  if (queryProject) return queryProject;
  if (!route.path.startsWith("/work/")) return "";
  return Array.isArray(route.params.projectID)
    ? route.params.projectID[0] ?? ""
    : typeof route.params.projectID === "string"
      ? route.params.projectID
      : "";
});
const navigation = computed(() => visibleShellNavigation(appConfig.shell.navigation).map(item =>
  scopedNavigationTargets.has(item.to) && routeProjectID.value
    ? { ...item, to: `${item.to}?project=${encodeURIComponent(routeProjectID.value)}` }
    : item));
const pageTitle = computed(() => activeShellNavigationItem(navigation.value, route.path)?.label);
const railNavigation = computed(() => navigation.value.filter(item => item.to.split("?", 1)[0] !== "/settings"));
const mobileNavigation = computed(() => navigation.value.filter(item => item.mobileLabel));
const settingsNavigation = computed(() => navigation.value.find(item => item.to.split("?", 1)[0] === "/settings"));
const paneGroups = computed(() => [
  {
    label: "公司",
    items: navigation.value.filter(item => ["/company", "/company/board", "/company/operations"].includes(item.to.split("?", 1)[0] ?? "")),
  },
  {
    label: "执行",
    items: navigation.value.filter(item => ["/inbox", "/work"].includes(item.to.split("?", 1)[0] ?? "")),
  },
  {
    label: "组织与成果",
    items: navigation.value.filter(item => ["/team", "/library"].includes(item.to.split("?", 1)[0] ?? "")),
  },
  {
    label: "系统",
    items: navigation.value.filter(item => item.to.split("?", 1)[0] === "/settings"),
  },
].filter(group => group.items.length));
const recentWork = computed(() => (snapshot.value?.work ?? []).flatMap(work => {
  if (work.availability === "unavailable") return [];
  if (["accepted", "archived", "cancelled", "failed"].includes(work.summary.userStatus)) return [];
  return [{
    id: work.summary.workId,
    phase: work.summary.phase,
    status: work.summary.userStatus,
    title: work.summary.title,
  }];
}).slice(0, 5));
const windowConnection = computed(() => snapshot.value?.connection ?? "connecting");
const windowConnectionLabel = computed(() => {
  if (windowConnection.value === "ready") return "本地已连接";
  if (windowConnection.value === "degraded") return "部分可用";
  if (windowConnection.value === "disconnected") return "本地未连接";
  if (windowConnection.value === "recovering") return "正在恢复";
  return "正在连接";
});

function closeSidebar() {
  sidebarOpen.value = false;
}

watch(() => route.fullPath, closeSidebar);

useHead(() => ({
  title: pageTitle.value,
}));
</script>

<template>
  <a class="ac-skip-link" href="#main-content">
    跳到主要内容
  </a>

  <div class="ac-window-stage">
    <div class="ac-window">
      <header class="ac-window-titlebar">
        <div class="ac-window-controls" aria-hidden="true">
          <span class="ac-window-control ac-window-control--close" />
          <span class="ac-window-control ac-window-control--minimize" />
          <span class="ac-window-control ac-window-control--maximize" />
        </div>

        <div class="ac-window-title">
          <Logo class="ac-window-title__mark" />
          <span>Agent Company</span>
          <span class="ac-window-title__separator">·</span>
          <em>{{ pageTitle ?? "公司总览" }}</em>
        </div>

        <div class="ac-window-status" :data-connection="windowConnection">
          <span aria-hidden="true" />
          {{ windowConnectionLabel }}
        </div>
      </header>

      <UDashboardGroup unit="rem" class="ac-shell">
        <aside class="ac-shell-rail" aria-label="主要区域">
          <NuxtLink to="/company" class="ac-shell-rail__brand" aria-label="Agent Company 公司总览">
            <Logo />
          </NuxtLink>

          <nav class="ac-shell-rail__navigation" aria-label="主导航">
            <div class="ac-shell-rail__nav">
              <NuxtLink
                v-for="item in railNavigation"
                :key="item.to"
                :to="item.to"
                class="ac-shell-rail__item"
                :class="{ 'ac-shell-rail__item--active': isShellNavigationActive(item, route.path) }"
                :aria-label="item.label"
                :aria-current="isShellNavigationActive(item, route.path) ? 'page' : undefined"
                :title="item.label"
              >
                <UIcon :name="item.icon" />
                <span
                  v-if="item.to === '/inbox' && attentionCount"
                  class="ac-shell-rail__badge"
                  :aria-label="`${attentionCount} 项待处理`"
                >{{ attentionCount > 99 ? "99+" : attentionCount }}</span>
              </NuxtLink>
            </div>

            <div class="ac-shell-rail__footer">
              <NuxtLink
                v-if="settingsNavigation"
                :to="settingsNavigation.to"
                class="ac-shell-rail__item"
                :class="{ 'ac-shell-rail__item--active': isShellNavigationActive(settingsNavigation, route.path) }"
                :aria-label="settingsNavigation.label"
                :aria-current="isShellNavigationActive(settingsNavigation, route.path) ? 'page' : undefined"
                :title="settingsNavigation.label"
              >
                <UIcon :name="settingsNavigation.icon" />
              </NuxtLink>
              <UserMenu />
            </div>
          </nav>
        </aside>

        <button
          v-if="sidebarOpen"
          type="button"
          class="ac-navigation-scrim"
          aria-label="关闭导航"
          @click="closeSidebar"
        />

        <aside class="ac-navigation-pane" :data-open="sidebarOpen">
          <header class="ac-navigation-pane__header">
            <div class="ac-navigation-pane__company">
              <span class="ac-navigation-pane__mark"><Logo /></span>
              <span>
                <strong>{{ snapshot?.company.name ?? "Agent Company" }}</strong>
                <small>本地 AI 公司</small>
              </span>
            </div>
            <button type="button" class="ac-navigation-pane__close" aria-label="关闭导航" @click="closeSidebar">
              <UIcon name="i-lucide-x" />
            </button>
          </header>

          <div class="ac-navigation-pane__body">
            <nav class="ac-navigation-pane__nav" aria-label="工作区导航">
              <section v-for="group in paneGroups" :key="group.label" class="ac-navigation-pane__group">
                <h2>{{ group.label }}</h2>
                <NuxtLink
                  v-for="item in group.items"
                  :key="item.to"
                  :to="item.to"
                  class="ac-navigation-pane__item"
                  :class="{ 'ac-navigation-pane__item--active': isShellNavigationActive(item, route.path) }"
                  :aria-current="isShellNavigationActive(item, route.path) ? 'page' : undefined"
                >
                  <span class="ac-navigation-pane__item-icon"><UIcon :name="item.icon" /></span>
                  <span class="ac-navigation-pane__item-copy">
                    <strong>{{ item.label }}</strong>
                    <small>{{ item.description }}</small>
                  </span>
                  <span v-if="item.to === '/inbox' && attentionCount" class="ac-navigation-pane__count">
                    {{ attentionCount > 99 ? "99+" : attentionCount }}
                  </span>
                </NuxtLink>
              </section>
            </nav>

            <section class="ac-navigation-pane__work" aria-labelledby="active-work-heading">
              <header>
                <h2 id="active-work-heading">进行中的工作</h2>
                <NuxtLink to="/work">查看全部</NuxtLink>
              </header>
              <div v-if="recentWork.length" class="ac-navigation-pane__work-list">
                <NuxtLink
                  v-for="work in recentWork"
                  :key="work.id"
                  :to="`/work/${encodeURIComponent(work.id)}`"
                  class="ac-navigation-pane__work-item"
                  :data-status="work.status"
                >
                  <span class="ac-navigation-pane__work-dot" aria-hidden="true" />
                  <span>
                    <strong>{{ work.title }}</strong>
                    <small>{{ appConfig.experience.statusLabels[work.status] }} · {{ work.phase }}</small>
                  </span>
                </NuxtLink>
              </div>
              <p v-else class="ac-navigation-pane__empty">当前没有进行中的工作</p>
            </section>
          </div>

          <footer class="ac-navigation-pane__footer" :data-connection="windowConnection">
            <span aria-hidden="true" />
            <span>
              <strong>{{ windowConnectionLabel }}</strong>
              <small>Control Plane</small>
            </span>
          </footer>
        </aside>

        <main id="main-content" tabindex="-1" class="ac-shell-workspace">
          <slot />
        </main>
      </UDashboardGroup>

      <nav class="ac-mobile-tabbar" aria-label="移动端主导航">
        <NuxtLink
          v-for="item in mobileNavigation"
          :key="item.to"
          :to="item.to"
          class="ac-mobile-tabbar__item"
          :class="{ 'ac-mobile-tabbar__item--active': isShellNavigationActive(item, route.path) }"
          :aria-current="isShellNavigationActive(item, route.path) ? 'page' : undefined"
        >
          <span class="ac-mobile-tabbar__icon">
            <UIcon :name="item.icon" />
            <span
              v-if="item.to === '/inbox' && attentionCount"
              class="ac-mobile-tabbar__badge"
              :aria-label="`${attentionCount} 项待处理`"
            >{{ attentionCount > 99 ? "99+" : attentionCount }}</span>
          </span>
          <span>{{ item.mobileLabel }}</span>
        </NuxtLink>
      </nav>
    </div>
  </div>
</template>
