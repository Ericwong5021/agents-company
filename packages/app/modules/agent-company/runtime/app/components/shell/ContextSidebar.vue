<!-- Adapted from yetone/cumora@5dbbdee under the MIT License. Reimplemented for Vue/Nuxt and AgentCompany domain models. -->
<script setup lang="ts">
import type { AppShellContextItem, AppShellContextSection } from "../../types/app-shell"

const props = withDefaults(defineProps<{
  title: string
  subtitle: string
  sections: AppShellContextSection[]
  searchable?: boolean
  searchLabel?: string
  open?: boolean
  connection: string
  connectionLabel: string
}>(), {
  searchable: true,
  searchLabel: "搜索当前模块",
  open: false,
})

defineEmits<{
  close: []
}>()

const search = ref("")
const normalizedSearch = computed(() => search.value.trim().toLocaleLowerCase())
const visibleSections = computed(() => props.sections.map(section => ({
  ...section,
  items: normalizedSearch.value
    ? section.items.filter(item => [item.label, item.description, item.meta]
        .some(value => value?.toLocaleLowerCase().includes(normalizedSearch.value)))
    : section.items,
})))

function itemAriaLabel(item: AppShellContextItem) {
  return [item.label, item.description, item.meta].filter(Boolean).join("，")
}
</script>

<template>
  <aside class="ac-context-sidebar" :data-open="open" aria-label="当前模块导航">
    <header class="ac-context-sidebar__header">
      <div>
        <strong>{{ title }}</strong>
        <small>{{ subtitle }}</small>
      </div>
      <button type="button" aria-label="关闭当前模块导航" @click="$emit('close')">
        <UIcon name="i-lucide-x" />
      </button>
    </header>

    <label v-if="searchable" class="ac-context-sidebar__search">
      <UIcon name="i-lucide-search" aria-hidden="true" />
      <input v-model="search" type="search" :placeholder="searchLabel" :aria-label="searchLabel">
      <button v-if="search" type="button" aria-label="清除搜索" @click="search = ''">
        <UIcon name="i-lucide-x" />
      </button>
    </label>

    <AppScrollArea class="ac-context-sidebar__scroll" aria-label="当前模块内容">
      <div class="ac-context-sidebar__sections">
        <section v-for="section in visibleSections" :key="section.id" class="ac-context-sidebar__section">
          <h2>{{ section.label }}</h2>
          <div v-if="section.items.length" class="ac-context-sidebar__items">
            <NuxtLink
              v-for="item in section.items"
              :key="item.id"
              :to="item.to"
              class="ac-context-sidebar__item"
              :class="{ 'ac-context-sidebar__item--active': item.active }"
              :data-tone="item.tone ?? 'muted'"
              :aria-label="itemAriaLabel(item)"
              :aria-current="item.active ? 'page' : undefined"
            >
              <span v-if="item.initials" class="ac-context-sidebar__avatar">{{ item.initials }}</span>
              <span v-else class="ac-context-sidebar__icon"><UIcon :name="item.icon ?? 'i-lucide-circle'" /></span>
              <span class="ac-context-sidebar__copy">
                <span>
                  <strong>{{ item.label }}</strong>
                  <small v-if="item.meta">{{ item.meta }}</small>
                </span>
                <small v-if="item.description">{{ item.description }}</small>
              </span>
              <span v-if="item.badge" class="ac-context-sidebar__badge">
                {{ item.badge > 99 ? "99+" : item.badge }}
              </span>
            </NuxtLink>
          </div>
          <p v-else class="ac-context-sidebar__empty">
            {{ normalizedSearch ? "没有匹配结果" : section.emptyLabel ?? "暂无内容" }}
          </p>
        </section>
      </div>
    </AppScrollArea>

    <footer class="ac-context-sidebar__footer" :data-connection="connection">
      <span aria-hidden="true" />
      <span>
        <strong>{{ connectionLabel }}</strong>
        <small>Control Plane</small>
      </span>
    </footer>
  </aside>
</template>

<style scoped>
.ac-context-sidebar {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--ac-boardroom-ink-100);
  background: var(--ac-boardroom-paper);
}

.ac-context-sidebar__header {
  display: flex;
  min-height: 70px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px 10px;
}

.ac-context-sidebar__header > div,
.ac-context-sidebar__footer > span:last-child {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ac-context-sidebar__header strong {
  overflow: hidden;
  color: var(--ac-boardroom-ink-900);
  font-size: 17px;
  font-weight: 760;
  letter-spacing: -0.012em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-context-sidebar__header small,
.ac-context-sidebar__footer small {
  overflow: hidden;
  color: var(--ac-boardroom-ink-500);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-context-sidebar__header button,
.ac-context-sidebar__search button {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: var(--ac-boardroom-radius-sm);
  color: var(--ac-boardroom-ink-500);
  transition: background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-standard);
}

.ac-context-sidebar__header button {
  display: none;
}

.ac-context-sidebar__header button:active,
.ac-context-sidebar__search button:active,
.ac-context-sidebar__item:active {
  transform: scale(0.96);
}

.ac-context-sidebar__search {
  display: grid;
  min-height: 40px;
  flex: none;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin: 0 12px 10px;
  border-radius: var(--ac-boardroom-radius-md);
  background: var(--ac-boardroom-sidebar);
  padding: 0 10px;
  color: var(--ac-boardroom-ink-300);
  box-shadow: inset 0 0 0 1px var(--ac-boardroom-ink-100);
}

.ac-context-sidebar__search > svg {
  width: 16px;
  height: 16px;
}

.ac-context-sidebar__search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ac-boardroom-ink-900);
  font: inherit;
  font-size: 12.5px;
}

.ac-context-sidebar__search input::placeholder {
  color: var(--ac-boardroom-ink-300);
}

.ac-context-sidebar__search button {
  width: 32px;
  height: 32px;
  margin-right: -6px;
}

.ac-context-sidebar__search button svg {
  width: 14px;
  height: 14px;
}

.ac-context-sidebar__scroll {
  min-height: 0;
  flex: 1;
}

.ac-context-sidebar__sections {
  display: grid;
  gap: 20px;
  padding: 4px 10px 20px;
}

.ac-context-sidebar__section h2 {
  margin: 0 10px 7px;
  color: var(--ac-boardroom-ink-300);
  font-size: 10px;
  font-weight: 780;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ac-context-sidebar__items {
  display: grid;
  gap: 2px;
}

.ac-context-sidebar__item {
  display: grid;
  min-height: 58px;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border-radius: var(--ac-boardroom-radius-md);
  padding: 7px 9px;
  color: var(--ac-boardroom-ink-700);
  transition: background-color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), color var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard), transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-standard), box-shadow var(--ac-boardroom-motion-base) var(--ac-boardroom-ease-standard);
}

.ac-context-sidebar__item--active {
  background: var(--ac-boardroom-accent-50);
  color: var(--ac-boardroom-accent-strong);
  box-shadow: inset 0 0 0 1px var(--ac-boardroom-accent-200);
}

.ac-context-sidebar__icon,
.ac-context-sidebar__avatar {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: var(--ac-boardroom-radius-md);
  background: var(--ac-boardroom-cloud);
  color: var(--ac-boardroom-ink-500);
  box-shadow: var(--ac-boardroom-shadow-control);
}

.ac-context-sidebar__avatar {
  font-size: 13px;
  font-weight: 800;
}

.ac-context-sidebar__icon svg {
  width: 18px;
  height: 18px;
}

.ac-context-sidebar__item[data-tone="accent"] .ac-context-sidebar__icon,
.ac-context-sidebar__item[data-tone="accent"] .ac-context-sidebar__avatar {
  color: var(--ac-boardroom-accent-strong);
}

.ac-context-sidebar__item[data-tone="success"] .ac-context-sidebar__icon,
.ac-context-sidebar__item[data-tone="success"] .ac-context-sidebar__avatar {
  color: var(--ac-boardroom-success);
}

.ac-context-sidebar__item[data-tone="warning"] .ac-context-sidebar__icon,
.ac-context-sidebar__item[data-tone="warning"] .ac-context-sidebar__avatar {
  color: var(--ac-boardroom-warning);
}

.ac-context-sidebar__item[data-tone="danger"] .ac-context-sidebar__icon,
.ac-context-sidebar__item[data-tone="danger"] .ac-context-sidebar__avatar {
  color: var(--ac-boardroom-danger);
}

.ac-context-sidebar__copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.ac-context-sidebar__copy > span {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ac-context-sidebar__copy strong,
.ac-context-sidebar__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-context-sidebar__copy strong {
  color: var(--ac-boardroom-ink-900);
  font-size: 13px;
  font-weight: 680;
}

.ac-context-sidebar__copy small {
  color: var(--ac-boardroom-ink-500);
  font-size: 10.5px;
}

.ac-context-sidebar__copy > span small {
  flex: none;
  color: var(--ac-boardroom-ink-300);
  font-variant-numeric: tabular-nums;
}

.ac-context-sidebar__badge {
  display: grid;
  min-width: 19px;
  height: 19px;
  place-items: center;
  border-radius: var(--ac-boardroom-radius-pill);
  background: var(--ac-boardroom-danger);
  padding-inline: 5px;
  color: white;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}

.ac-context-sidebar__empty {
  margin: 0;
  padding: 10px;
  color: var(--ac-boardroom-ink-300);
  font-size: 11.5px;
}

.ac-context-sidebar__footer {
  display: flex;
  min-height: 58px;
  flex: none;
  align-items: center;
  gap: 9px;
  border-top: 1px solid var(--ac-boardroom-ink-100);
  padding: 10px 18px;
}

.ac-context-sidebar__footer > span:first-child {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--ac-boardroom-resting);
}

.ac-context-sidebar__footer[data-connection="ready"] > span:first-child {
  background: var(--ac-boardroom-success);
}

.ac-context-sidebar__footer[data-connection="degraded"] > span:first-child,
.ac-context-sidebar__footer[data-connection="recovering"] > span:first-child {
  background: var(--ac-boardroom-warning);
}

.ac-context-sidebar__footer[data-connection="disconnected"] > span:first-child {
  background: var(--ac-boardroom-danger);
}

.ac-context-sidebar__footer strong {
  color: var(--ac-boardroom-ink-700);
  font-size: 11.5px;
  font-weight: 680;
}

@media (hover: hover) {
  .ac-context-sidebar__header button:hover,
  .ac-context-sidebar__search button:hover {
    background: var(--ac-boardroom-cloud);
    color: var(--ac-boardroom-ink-900);
  }

  .ac-context-sidebar__item:hover {
    background: var(--ac-boardroom-sidebar);
  }

  .ac-context-sidebar__item--active:hover {
    background: var(--ac-boardroom-accent-50);
  }
}

@media (max-width: 1023px) {
  .ac-context-sidebar__header button {
    display: grid;
  }
}
</style>
