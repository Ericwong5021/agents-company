<script setup lang="ts">
import {
  isShellNavigationActive,
  visibleShellNavigation,
} from "../utils/shell-navigation";

const sidebarOpen = useState("agent-company-shell-sidebar-open", () => false);
const route = useRoute();
const appConfig = useAppConfig();
const navigation = computed(() => visibleShellNavigation(appConfig.shell.navigation));
</script>

<template>
  <a class="ac-skip-link" href="#main-content">
    跳到主要内容
  </a>

  <UDashboardGroup unit="rem" class="ac-shell">
    <UDashboardSidebar
      id="primary"
      v-model:open="sidebarOpen"
      :default-size="16"
      :min-size="15"
      :max-size="19"
      :collapsed-size="4.5"
      collapsible
      resizable
      :menu="{ inset: true }"
      class="ac-shell-sidebar"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/inbox"
          class="ac-shell-brand"
          :class="{ 'ac-shell-brand--collapsed': collapsed }"
          aria-label="Agent Company Inbox"
        >
          <Logo class="ac-shell-brand__mark" />
          <span v-if="!collapsed" class="ac-shell-brand__text">
            Agent Company
          </span>
        </NuxtLink>

        <UDashboardSidebarCollapse
          v-if="!collapsed"
          class="ac-shell-collapse"
          aria-label="收起主导航"
        />
      </template>

      <template #default="{ collapsed }">
        <nav class="ac-primary-nav" aria-label="主导航">
          <NuxtLink
            v-for="item in navigation"
            :key="item.to"
            :to="item.to"
            class="ac-primary-nav__item"
            :class="{
              'ac-primary-nav__item--active': isShellNavigationActive(item, route.path),
              'ac-primary-nav__item--collapsed': collapsed,
            }"
            :aria-label="collapsed ? item.label : undefined"
            :aria-current="isShellNavigationActive(item, route.path) ? 'page' : undefined"
            :title="collapsed ? item.label : undefined"
          >
            <UIcon :name="item.icon" class="ac-primary-nav__icon" />
            <span v-if="!collapsed">{{ item.label }}</span>
          </NuxtLink>
        </nav>
      </template>

      <template #footer="{ collapsed }">
        <div class="ac-shell-account" :class="{ 'ac-shell-account--collapsed': collapsed }">
          <UserMenu />
          <span v-if="!collapsed">本地工作区</span>
        </div>
      </template>
    </UDashboardSidebar>

    <main id="main-content" tabindex="-1" class="ac-shell-workspace">
      <slot />
    </main>
  </UDashboardGroup>
</template>
