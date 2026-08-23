<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script setup lang="ts">
import type { AppShellNavigationItem } from "../../types/app-shell"

defineProps<{
  items: AppShellNavigationItem[]
  settings?: AppShellNavigationItem
}>()
</script>

<template>
  <aside class="ac-app-rail" aria-label="主要区域">
    <NuxtLink to="/company" class="ac-app-rail__brand" aria-label="Agent Company 公司总览">
      <Logo />
    </NuxtLink>

    <nav class="ac-app-rail__navigation" aria-label="主导航">
      <NuxtLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="ac-app-rail__item"
        :class="{ 'ac-app-rail__item--active': item.active }"
        :aria-label="item.label"
        :aria-current="item.active ? 'page' : undefined"
        :title="item.label"
      >
        <UIcon :name="item.icon" />
        <span v-if="item.badge" class="ac-app-rail__badge" :aria-label="`${item.badge} 项待处理`">
          {{ item.badge > 99 ? "99+" : item.badge }}
        </span>
      </NuxtLink>
      <NuxtLink
        v-if="settings"
        :to="settings.to"
        class="ac-app-rail__item ac-app-rail__settings"
        :class="{ 'ac-app-rail__item--active': settings.active }"
        :aria-label="settings.label"
        :aria-current="settings.active ? 'page' : undefined"
        :title="settings.label"
      >
        <UIcon :name="settings.icon" />
      </NuxtLink>
    </nav>

    <footer class="ac-app-rail__footer">
      <slot name="account" />
    </footer>
  </aside>
</template>

<style scoped>
.ac-app-rail {
  display: flex;
  min-height: 0;
  align-items: center;
  flex-direction: column;
  border-right: 1px solid var(--ac-boardroom-ink-100);
  background: var(--ac-boardroom-sidebar);
  padding: 16px 0 14px;
}

.ac-app-rail__brand,
.ac-app-rail__item {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  place-items: center;
  border-radius: var(--ac-boardroom-radius-md);
  transition: background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-standard), box-shadow var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard);
}

.ac-app-rail__brand {
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-accent-strong);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-app-rail__brand svg {
  width: 30px;
  height: 30px;
}

.ac-app-rail__navigation {
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1;
  align-items: center;
  flex-direction: column;
  gap: 3px;
  margin-top: 16px;
  overflow-y: auto;
  padding-block: 2px;
  scrollbar-width: none;
}

.ac-app-rail__navigation::-webkit-scrollbar {
  display: none;
}

.ac-app-rail__item {
  position: relative;
  color: var(--ac-boardroom-ink-500);
}

.ac-app-rail__settings {
  margin-top: auto;
}

.ac-app-rail__item > svg {
  width: 22px;
  height: 22px;
}

.ac-app-rail__item--active {
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-accent-strong);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-app-rail__item--active::before {
  position: absolute;
  left: -14px;
  width: 3px;
  height: 24px;
  border-radius: 0 var(--ac-boardroom-radius-pill) var(--ac-boardroom-radius-pill) 0;
  background: var(--ac-boardroom-accent);
  content: "";
}

.ac-app-rail__brand:active,
.ac-app-rail__item:active {
  transform: scale(0.96);
}

.ac-app-rail__badge {
  position: absolute;
  top: 3px;
  right: 0;
  display: grid;
  min-width: 17px;
  height: 17px;
  place-items: center;
  border: 2px solid var(--ac-boardroom-sidebar);
  border-radius: var(--ac-boardroom-radius-pill);
  background: var(--ac-boardroom-danger);
  padding-inline: 3px;
  color: white;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}

.ac-app-rail__footer {
  display: flex;
  flex: none;
  align-items: center;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

@media (hover: hover) {
  .ac-app-rail__brand:hover {
    box-shadow: 0 5px 14px -5px rgb(10 27 46 / 0.22);
  }

  .ac-app-rail__item:hover {
    background: var(--ac-boardroom-cloud);
    color: var(--ac-boardroom-ink-900);
  }

  .ac-app-rail__item--active:hover {
    color: var(--ac-boardroom-accent-strong);
  }
}

@media (max-width: 1023px) {
  .ac-app-rail {
    display: none;
  }
}
</style>
