<script setup lang="ts">
import type { CompanySnapshot } from "../../modules/agent-company/runtime/shared/company-contract"
import { aggregateAttention, attentionTypeLabels } from "../../modules/agent-company/runtime/shared/inbox-attention"
import type { AppShellContextItem, AppShellContextSection, AppShellContextTone, AppShellNavigationItem } from "../../modules/agent-company/runtime/app/types/app-shell"
import { activeShellNavigationItem, isShellNavigationActive, visibleShellNavigation } from "../utils/shell-navigation"

const sidebarStorageKey = "agent-company:shell-context-width:v1"
const sidebarOpen = useState("agent-company-shell-sidebar-open", () => false)
const sidebarWidth = useState("agent-company-shell-context-width", () => 320)
const route = useRoute()
const snapshot = useState<CompanySnapshot | undefined>("agent-company-snapshot-value")
const telemetry = useProductTelemetry()
const observedWorkStatuses = ref<Record<string, string>>({})
const sidebarWidthHydrated = ref(false)
const appConfig = useAppConfig()
const statusLabels = appConfig.experience.statusLabels as Record<string, string>
const activityLabels = appConfig.experience.activityLabels as Record<string, string>
const attentionItems = computed(() => aggregateAttention(snapshot.value?.work ?? []))
const attentionCount = computed(() => attentionItems.value.length + (snapshot.value?.work.filter(work => work.availability === "unavailable").length ?? 0))

watch(
  () => snapshot.value?.work,
  works => {
    if (!works) return
    const nextStatuses: Record<string, string> = {}
    works.forEach(work => {
      if (work.availability === "unavailable") {
        telemetry.record("failed", {
          dedupeKey: `unavailable:${work.workId}:${work.diagnostics.map(item => item.id).join(":")}`,
          scenario: "work_projection",
          props: { availability: "unavailable", diagnosticCount: work.diagnostics.length },
        })
        return
      }
      const workID = work.summary.workId
      const previous = observedWorkStatuses.value[workID]
      nextStatuses[workID] = work.summary.userStatus
      work.attentionItems.forEach(item => {
        telemetry.record("attention_requested", {
          dedupeKey: item.id,
          scenario: "attention_center",
          props: { type: item.type, priority: item.priority },
        })
        if (item.type === "blocked") telemetry.record("blocked", {
          dedupeKey: item.id,
          scenario: "execution",
          props: { priority: item.priority },
        })
        if (item.type === "failure") telemetry.record("failed", {
          dedupeKey: item.id,
          scenario: "execution",
          props: { priority: item.priority },
        })
      })
      if (previous && ["blocked", "failed"].includes(previous) && !["blocked", "failed"].includes(work.summary.userStatus))
        telemetry.record("recovered", { scenario: "execution", props: { from: previous, to: work.summary.userStatus } })
    })
    observedWorkStatuses.value = nextStatuses
  },
  { deep: true, immediate: true },
)

const scopedNavigationTargets = new Set(["/company/board", "/team"])
const routeProjectID = computed(() => {
  const queryProject = typeof route.query.project === "string" ? route.query.project : ""
  if (queryProject) return queryProject
  if (!route.path.startsWith("/work/")) return ""
  return Array.isArray(route.params.projectID)
    ? route.params.projectID[0] ?? ""
    : typeof route.params.projectID === "string" ? route.params.projectID : ""
})
const navigation = computed(() => visibleShellNavigation(appConfig.shell.navigation).map(item =>
  scopedNavigationTargets.has(item.to) && routeProjectID.value
    ? { ...item, to: `${item.to}?project=${encodeURIComponent(routeProjectID.value)}` }
    : item))
const pageTitle = computed(() => activeShellNavigationItem(navigation.value, route.path)?.label ?? "公司总览")
const railNavigation = computed<AppShellNavigationItem[]>(() => navigation.value
  .filter(item => item.to.split("?", 1)[0] !== "/settings")
  .map(item => ({
    icon: item.icon,
    label: item.label,
    to: item.to,
    active: isShellNavigationActive(item, route.path),
    badge: item.to.split("?", 1)[0] === "/inbox" ? attentionCount.value : undefined,
  })))
const mobileNavigation = computed(() => navigation.value.filter(item => item.mobileLabel))
const settingsNavigation = computed<AppShellNavigationItem | undefined>(() => {
  const item = navigation.value.find(entry => entry.to.split("?", 1)[0] === "/settings")
  if (!item) return
  return { icon: item.icon, label: item.label, to: item.to, active: isShellNavigationActive(item, route.path) }
})
const shellWork = computed(() => (snapshot.value?.work ?? []).map(work => work.availability === "available"
  ? { id: work.summary.workId, phase: work.summary.phase, status: work.summary.userStatus, title: work.summary.title }
  : { id: work.workId, phase: "投影不可用", status: "failed", title: work.title }))
const activeWork = computed(() => shellWork.value.filter(work => !["accepted", "archived", "cancelled", "failed"].includes(work.status)))
const historicalWork = computed(() => shellWork.value.filter(work => ["accepted", "archived", "cancelled", "failed"].includes(work.status)))
const windowConnection = computed(() => snapshot.value?.connection ?? "connecting")
const windowConnectionLabel = computed(() => {
  if (windowConnection.value === "ready") return "本地已连接"
  if (windowConnection.value === "degraded") return "部分可用"
  if (windowConnection.value === "disconnected") return "本地未连接"
  if (windowConnection.value === "recovering") return "正在恢复"
  return "正在连接"
})

function workTone(status: string): AppShellContextTone {
  if (["blocked", "failed"].includes(status)) return "danger"
  if (["needs_input", "needs_approval", "revision"].includes(status)) return "warning"
  if (["running", "reviewing"].includes(status)) return "success"
  if (["ready", "delivered"].includes(status)) return "accent"
  return "muted"
}

function workItem(work: typeof shellWork.value[number]): AppShellContextItem {
  return {
    id: work.id,
    label: work.title,
    to: `/work/${encodeURIComponent(work.id)}`,
    description: work.phase,
    meta: statusLabels[work.status] ?? work.status,
    icon: "i-lucide-briefcase-business",
    active: route.path === `/work/${work.id}`,
    tone: workTone(work.status),
  }
}

function attentionItem(item: typeof attentionItems.value[number]): AppShellContextItem {
  const panel = item.type === "approval" ? "approval" : item.type === "delivery" ? "artifact" : item.type === "input" ? "thread" : "diagnostics"
  const icon = item.type === "approval" ? "i-lucide-shield-check" : item.type === "delivery" ? "i-lucide-package-check" : item.type === "input" ? "i-lucide-message-circle-question" : "i-lucide-triangle-alert"
  return {
    id: item.id,
    label: item.title,
    to: `/work/${encodeURIComponent(item.workId)}?panel=${panel}&attention=${encodeURIComponent(item.id)}`,
    description: item.workTitle,
    meta: attentionTypeLabels[item.type],
    icon,
    tone: ["blocked", "failure"].includes(item.type) ? "danger" : "warning",
  }
}

const contextTitle = computed(() => {
  if (route.path.startsWith("/company/board")) return "董事会"
  if (route.path.startsWith("/company/operations")) return "运营中心"
  if (route.path.startsWith("/work")) return "工作项目"
  if (route.path.startsWith("/team")) return "Agent 团队"
  if (route.path.startsWith("/library")) return "产物库"
  if (route.path.startsWith("/inbox")) return "待处理"
  if (route.path.startsWith("/settings")) return "设置"
  return snapshot.value?.company.name ?? "Agent Company"
})
const contextSubtitle = computed(() => {
  if (route.path.startsWith("/company/board")) return "会议、项目讨论与治理"
  if (route.path.startsWith("/company/operations")) return "运行状态、异常与历史执行"
  if (route.path.startsWith("/work")) return "目标、执行与交付"
  if (route.path.startsWith("/team")) return "在线状态与当前负载"
  if (route.path.startsWith("/library")) return "成果、知识与版本"
  if (route.path.startsWith("/inbox")) return `${attentionCount.value} 项需要关注`
  if (route.path.startsWith("/settings")) return "选择一个类别"
  return "本地 AI 公司"
})
const contextSections = computed<AppShellContextSection[]>(() => {
  if (route.path.startsWith("/company/board")) {
    const projects = snapshot.value?.projects ?? []
    const ongoing = projects.filter(project => !["accepted", "archived", "cancelled", "completed"].includes(project.status))
    const archived = projects.filter(project => ["accepted", "archived", "cancelled", "completed"].includes(project.status))
    const projectItem = (project: typeof projects[number], history = false): AppShellContextItem => ({
      id: project.id,
      label: project.title,
      to: `/company/board?project=${encodeURIComponent(project.id)}`,
      description: history ? "历史项目讨论" : "项目讨论",
      meta: statusLabels[project.status] ?? project.status,
      icon: history ? "i-lucide-archive" : "i-lucide-message-square-more",
      active: routeProjectID.value === project.id,
      tone: history ? "muted" : workTone(project.status),
    })
    return [
      { id: "boardroom", label: "董事会", items: [{ id: "company-boardroom", label: "公司董事会", to: "/company/board", description: "全公司战略与治理讨论", icon: "i-lucide-messages-square", active: !routeProjectID.value, tone: "accent" }] },
      { id: "ongoing-projects", label: "进行中", items: ongoing.map(project => projectItem(project)), emptyLabel: "当前没有项目讨论" },
      { id: "archived-projects", label: "已结束", items: archived.map(project => projectItem(project, true)), emptyLabel: "暂无已结束会议" },
    ]
  }
  if (route.path.startsWith("/company/operations")) return [
    { id: "attention", label: "需要关注", items: attentionItems.value.slice(0, 8).map(attentionItem), emptyLabel: "当前没有异常或待审批事项" },
    { id: "running", label: "运行中", items: activeWork.value.slice(0, 10).map(workItem), emptyLabel: "当前没有运行中的工作" },
  ]
  if (route.path.startsWith("/work")) return [
    { id: "active-work", label: "当前工作", items: activeWork.value.map(workItem), emptyLabel: "当前没有进行中的工作" },
    { id: "work-history", label: "最近结束", items: historicalWork.value.slice(0, 10).map(workItem), emptyLabel: "暂无历史工作" },
  ]
  if (route.path.startsWith("/team")) {
    const agents = snapshot.value?.agents ?? []
    const agentItem = (agent: typeof agents[number]): AppShellContextItem => ({
      id: agent.id,
      label: agent.name,
      to: `/team/${encodeURIComponent(agent.id)}`,
      description: agent.role ?? agent.department ?? "Agent",
      meta: activityLabels[agent.activity] ?? agent.activity,
      initials: agent.name.slice(0, 1),
      active: route.path === `/team/${agent.id}`,
      tone: agent.attention === "urgent" || agent.activity === "failed" ? "danger" : agent.activity === "recovering" ? "warning" : agent.presence === "online" ? "success" : "muted",
    })
    return [
      { id: "online-agents", label: "在线", items: agents.filter(agent => agent.presence === "online").map(agentItem), emptyLabel: "当前没有在线 Agent" },
      { id: "offline-agents", label: "离线", items: agents.filter(agent => agent.presence === "offline").map(agentItem), emptyLabel: "当前没有离线 Agent" },
    ]
  }
  if (route.path.startsWith("/library")) return [{ id: "library-views", label: "资料视图", items: [
    { id: "deliveries", label: "成果与交付", to: "/library", description: "当前成果与历史版本", icon: "i-lucide-package-open", active: route.path === "/library", tone: "accent" },
    { id: "beliefs", label: "公司信念", to: "/library/beliefs", description: "已采纳的组织认知", icon: "i-lucide-brain", active: route.path.startsWith("/library/beliefs") },
    { id: "interpretations", label: "材料解读", to: "/library/interpretations", description: "来源、解释与证据", icon: "i-lucide-book-open-text", active: route.path.startsWith("/library/interpretations") },
    { id: "patches", label: "能力补丁", to: "/library/patches", description: "学习产生的变更", icon: "i-lucide-git-pull-request-arrow", active: route.path.startsWith("/library/patches") },
  ] }]
  if (route.path.startsWith("/settings")) return [{ id: "settings-views", label: "设置", items: [
    { id: "company-settings", label: "公司", to: "/settings", icon: "i-lucide-building-2", active: route.path === "/settings" || route.path === "/settings/company", tone: "accent" },
    { id: "profile-settings", label: "个人与记忆", to: "/settings/profile", icon: "i-lucide-user-round-cog", active: route.path.startsWith("/settings/profile") },
    { id: "integration-settings", label: "集成", to: "/settings/integrations", icon: "i-lucide-unplug", active: route.path.startsWith("/settings/integrations") },
  ] }]
  if (route.path.startsWith("/inbox")) return [{ id: "inbox-attention", label: "需要你处理", items: attentionItems.value.map(attentionItem), emptyLabel: "当前没有待处理事项" }]
  return [
    { id: "company-attention", label: "需要关注", items: attentionItems.value.slice(0, 6).map(attentionItem), emptyLabel: "公司当前运行正常" },
    { id: "company-work", label: "进行中的工作", items: activeWork.value.slice(0, 8).map(workItem), emptyLabel: "当前没有进行中的工作" },
  ]
})

function closeSidebar() {
  sidebarOpen.value = false
}

onMounted(() => {
  const storedWidth = Number(localStorage.getItem(sidebarStorageKey))
  if (Number.isFinite(storedWidth) && storedWidth >= 240 && storedWidth <= 520) sidebarWidth.value = storedWidth
  sidebarWidthHydrated.value = true
})
watch(sidebarWidth, width => {
  if (sidebarWidthHydrated.value) localStorage.setItem(sidebarStorageKey, String(width))
})
watch(() => route.fullPath, closeSidebar)
useHead(() => ({ title: pageTitle.value }))
</script>

<template>
  <a class="ac-skip-link" href="#main-content">跳到主要内容</a>
  <div class="ac-boardroom ac-app-window-stage">
    <div class="ac-app-window">
      <AppTitlebar :page-title="pageTitle" :connection="windowConnection" :connection-label="windowConnectionLabel" />
      <div class="ac-app-shell">
        <AppRail :items="railNavigation" :settings="settingsNavigation">
          <template #account><UserMenu /></template>
        </AppRail>
        <button v-if="sidebarOpen" type="button" class="ac-app-shell__scrim" aria-label="关闭当前模块导航" @click="closeSidebar" />
        <AppResizablePane v-model="sidebarWidth" class="ac-app-shell__sidebar" :data-open="sidebarOpen" :min="240" :max="520" :step="16" label="调整当前模块导航宽度">
          <ContextSidebar :title="contextTitle" :subtitle="contextSubtitle" :sections="contextSections" :searchable="!route.path.startsWith('/settings')" :open="sidebarOpen" :connection="windowConnection" :connection-label="windowConnectionLabel" @close="closeSidebar" />
        </AppResizablePane>
        <WorkspaceStage><slot /></WorkspaceStage>
      </div>
      <nav class="ac-mobile-tabbar" aria-label="移动端主导航">
        <NuxtLink v-for="item in mobileNavigation" :key="item.to" :to="item.to" class="ac-mobile-tabbar__item" :class="{ 'ac-mobile-tabbar__item--active': isShellNavigationActive(item, route.path) }" :aria-current="isShellNavigationActive(item, route.path) ? 'page' : undefined">
          <span class="ac-mobile-tabbar__icon">
            <UIcon :name="item.icon" />
            <ClientOnly><span v-if="item.to === '/inbox' && attentionCount" class="ac-mobile-tabbar__badge" :aria-label="`${attentionCount} 项待处理`">{{ attentionCount > 99 ? "99+" : attentionCount }}</span></ClientOnly>
          </span>
          <span>{{ item.mobileLabel }}</span>
        </NuxtLink>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.ac-app-window-stage {
  display: grid;
  width: 100%;
  height: 100svh;
  overflow: hidden;
  place-items: center;
  background: var(--ac-boardroom-canvas);
  padding: 24px;
}

.ac-app-window {
  display: flex;
  width: min(1480px, 100%);
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: var(--ac-boardroom-paper);
  box-shadow: var(--ac-boardroom-shadow-dialog);
}

.ac-app-shell {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 0;
  flex: 1;
  grid-template-columns: 72px auto minmax(0, 1fr);
  overflow: hidden;
  background: var(--ac-boardroom-canvas);
}

.ac-app-shell__sidebar {
  height: 100%;
}

.ac-app-shell__scrim {
  display: none;
}

@media (max-width: 1023px) {
  .ac-app-shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .ac-app-shell > .ac-app-shell__sidebar {
    position: absolute;
    z-index: 100;
    inset: 0 auto 0 0;
    width: min(320px, calc(100% - 32px)) !important;
    transform: translateX(-104%);
    box-shadow: var(--ac-boardroom-shadow-dialog);
    transition: transform var(--ac-boardroom-motion-slow) var(--ac-boardroom-ease-out);
  }

  .ac-app-shell__sidebar[data-open="true"] {
    transform: translateX(0);
  }

  .ac-app-shell__sidebar :deep(.ac-ui-resizable-pane__handle) {
    display: none;
  }

  .ac-app-shell__scrim {
    position: absolute;
    z-index: 90;
    inset: 0;
    display: block;
    background: var(--ac-boardroom-overlay);
  }
}

@media (max-width: 720px) {
  .ac-app-window-stage {
    padding: 0;
  }

  .ac-app-window {
    border-radius: 0;
    box-shadow: none;
  }
}
</style>
