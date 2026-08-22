<script setup lang="ts">
import type {
  CompanyConnection,
  CompanySnapshot,
} from "../../modules/agent-company/runtime/shared/company-contract";
import { activeShellNavigationItem } from "../utils/shell-navigation";

const route = useRoute();
const appConfig = useAppConfig();
const sidebarOpen = useState("agent-company-shell-sidebar-open", () => false);
const connectionState = useState<CompanyConnection | undefined>("agent-company-connection");
const snapshotState = useState<CompanySnapshot | undefined>("agent-company-snapshot-value");
const hydrated = ref(false);

const activeItem = computed(() =>
  activeShellNavigationItem(appConfig.shell.navigation, route.path),
);
const observedConnection = computed(() =>
  connectionState.value ?? snapshotState.value?.connection ?? "connecting");
const connection = computed(() => hydrated.value ? observedConnection.value : "connecting");
const connectionLabel = computed(() => {
  if (connection.value === "ready") return "已连接";
  if (
    connection.value === "degraded"
    && snapshotState.value?.issue?.kind === "provider_required"
  ) return "需要配置";
  if (connection.value === "degraded") return "部分可用";
  if (connection.value === "disconnected") return "已断开";
  if (connection.value === "recovering") return "正在恢复";
  return "正在连接";
});
const connectionAriaLabel = computed(() =>
  `本地连接状态：${connectionLabel.value}${snapshotState.value?.issue?.title
    ? `，${snapshotState.value.issue.title}`
    : ""}`);

function openSidebar() {
  sidebarOpen.value = true;
}

onMounted(() => {
  hydrated.value = true;
});
</script>

<template>
  <UDashboardNavbar
    class="ac-shell-navbar"
    :toggle="false"
    :ui="{ left: 'min-w-0', right: 'gap-2' }"
  >
    <template #left>
      <NuxtLink to="/company" class="ac-mobile-brand" aria-label="打开公司总览">
        <Logo />
      </NuxtLink>
      <UButton
        class="ac-shell-navbar__menu min-h-10 min-w-10 lg:hidden"
        color="neutral"
        variant="ghost"
        icon="i-lucide-menu"
        aria-label="打开主导航"
        :disabled="!hydrated"
        @click="openSidebar"
      />
      <slot name="title">
        <span class="ac-shell-navbar__title">
          {{ activeItem?.label ?? "Agent Company" }}
        </span>
      </slot>
    </template>

    <template #right>
      <NuxtLink
        to="/settings"
        class="ac-connection-pill"
        :data-connection="connection"
        :aria-label="connectionAriaLabel"
      >
        <span class="ac-connection-pill__dot" aria-hidden="true" />
        <span class="ac-connection-pill__label">{{ connectionLabel }}</span>
      </NuxtLink>
      <slot />
      <span class="ac-mobile-account"><UserMenu /></span>
    </template>
  </UDashboardNavbar>
</template>
