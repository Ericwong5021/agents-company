<script setup lang="ts">
import { operationCategoryLabels, operationImportanceLabels, operationSeverityLabels } from "../../adapters/operations.adapter"
import type { OperationsFilterVM, OperationsPane, OperationsProjection } from "../../types/operations"

const props = defineProps<{ projection: OperationsProjection, pane: OperationsPane }>()
const emit = defineEmits<{ refresh: [], loadMore: [], detail: [string], filters: [], updateFilter: [Partial<OperationsFilterVM>], close: [] }>()
const paneTitle = computed(() => props.pane.kind === "filters" ? "筛选运营记录" : "运行详情")
const paneSubtitle = computed(() => props.pane.kind === "filters" ? "按真实运行上下文收敛时间线" : props.pane.kind === "detail" ? props.pane.item?.contextLabel ?? "正在读取持久化事实" : "")

function update<Key extends keyof OperationsFilterVM>(key: Key, event: Event) {
  emit("updateFilter", { [key]: (event.target as HTMLSelectElement).value as OperationsFilterVM[Key] })
}
</script>

<template>
  <div class="ac-boardroom ac-operations-workspace">
    <main class="ac-operations-stage">
      <header class="ac-operations-header">
        <div><p class="ac-operations-kicker">Operations</p><h1>运营中心</h1><p>从公司运行事实中定位异常、恢复与交付，不把低层状态混进协作会话。</p></div>
        <div class="ac-operations-actions">
          <span class="ac-operations-stream" :data-state="projection.streamStatus"><span />{{ projection.streamStatus === "live" ? "实时连接" : projection.streamStatus === "connecting" ? "正在连接" : "连接不稳定" }}</span>
          <AppButton variant="ghost" aria-label="打开运营筛选" @click="emit('filters')"><template #leading><UIcon name="i-lucide-sliders-horizontal" /></template>筛选</AppButton>
        </div>
      </header>

      <button v-if="projection.newRecordsAvailable" class="ac-operations-new" type="button" @click="emit('refresh')"><UIcon name="i-lucide-arrow-up" />有新记录，刷新时间线</button>

      <section class="ac-operations-summary" aria-label="近 24 小时运营摘要">
        <div><span>全部记录</span><strong>{{ projection.summary.total }}</strong></div>
        <div data-tone="error"><span>异常</span><strong>{{ projection.summary.errors }}</strong></div>
        <div data-tone="warning"><span>注意</span><strong>{{ projection.summary.warnings }}</strong></div>
        <div data-tone="positive"><span>恢复与完成</span><strong>{{ projection.summary.recoveries }}</strong></div>
      </section>

      <section class="ac-operations-toolbar" aria-label="常用筛选">
        <label><span>时间</span><select :value="projection.filters.timeRange" @change="update('timeRange', $event)"><option value="24h">近 24 小时</option><option value="7d">近 7 天</option><option value="all">全部时间</option></select></label>
        <label><span>类别</span><select :value="projection.filters.category" @change="update('category', $event)"><option value="">全部类别</option><option v-for="(label, value) in operationCategoryLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <label><span>级别</span><select :value="projection.filters.severity" @change="update('severity', $event)"><option value="">全部级别</option><option v-for="(label, value) in operationSeverityLabels" :key="value" :value="value">{{ label }}</option></select></label>
      </section>

      <section class="ac-operations-feed" aria-live="polite">
        <div v-if="projection.status === 'pending'" class="ac-operations-state"><UIcon name="i-lucide-loader-circle" class="animate-spin" />正在读取运营记录</div>
        <div v-else-if="projection.status === 'error'" class="ac-operations-state" data-tone="error"><UIcon name="i-lucide-circle-alert" /><div><strong>运营记录读取失败</strong><p>{{ projection.error }}</p></div><AppButton variant="ghost" @click="emit('refresh')">重试</AppButton></div>
        <div v-else-if="!projection.groups.length" class="ac-operations-state"><UIcon name="i-lucide-list-filter" />当前筛选条件下没有运营记录</div>
        <div v-for="group in projection.groups" v-else :key="group.date" class="ac-operations-day">
          <div class="ac-operations-day__label">{{ group.date }}</div>
          <div class="ac-operations-day__items">
            <button v-for="item in group.items" :key="item.id" class="ac-operations-row" :data-severity="item.severity" type="button" @click="emit('detail', item.id)">
              <span class="ac-operations-row__marker" /><span class="ac-operations-row__time">{{ item.time }}</span>
              <span class="ac-operations-row__body"><span class="ac-operations-row__meta"><span>{{ item.categoryLabel }}</span><span>{{ item.importanceLabel }}</span><span>{{ item.contextLabel }}</span></span><strong>{{ item.title }}</strong><small>{{ item.summary }}</small></span>
              <UIcon name="i-lucide-chevron-right" />
            </button>
          </div>
        </div>
      </section>

      <footer v-if="projection.status === 'success' && projection.groups.length" class="ac-operations-footer">
        <p v-if="projection.error">{{ projection.error }}</p><AppButton v-if="projection.hasMore" variant="ghost" :loading="projection.loadingMore" @click="emit('loadMore')">加载更早记录</AppButton><span v-else>已显示当前筛选范围内的全部记录</span>
      </footer>
    </main>

    <ContextPane :open="pane.kind !== 'closed'" :title="paneTitle" :subtitle="paneSubtitle" @close="emit('close')">
      <div v-if="pane.kind === 'filters'" class="ac-operations-pane">
        <label><span>重要性</span><select :value="projection.filters.importance" @change="update('importance', $event)"><option value="">全部重要性</option><option v-for="(label, value) in operationImportanceLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <label><span>项目</span><select :value="projection.filters.projectID" @change="update('projectID', $event)"><option value="">全部项目</option><option v-for="project in projection.projects" :key="project.id" :value="project.id">{{ project.title }}</option></select></label>
        <label><span>Agent</span><select :value="projection.filters.agentID" @change="update('agentID', $event)"><option value="">全部 Agent</option><option v-for="agent in projection.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
      </div>
      <div v-else-if="pane.kind === 'detail'" class="ac-operations-pane">
        <div v-if="pane.loading" class="ac-operations-pane__state"><UIcon name="i-lucide-loader-circle" class="animate-spin" />正在读取完整记录</div>
        <div v-else-if="pane.error" class="ac-operations-pane__state" data-tone="error"><UIcon name="i-lucide-circle-alert" />{{ pane.error }}</div>
        <template v-else-if="pane.item">
          <div class="ac-operations-detail__identity"><span :data-severity="pane.item.severity">{{ pane.item.severityLabel }}</span><span>{{ pane.item.categoryLabel }}</span><span>{{ pane.item.importanceLabel }}</span></div>
          <div class="ac-operations-detail__summary"><strong>{{ pane.item.title }}</strong><p>{{ pane.item.summary }}</p></div>
          <dl v-if="pane.item.details.length" class="ac-operations-detail__facts"><div v-for="detail in pane.item.details" :key="`${detail.label}:${detail.value}`"><dt>{{ detail.label }}</dt><dd>{{ detail.value }}</dd></div></dl>
          <NuxtLink class="ac-operations-detail__link" :to="pane.item.href">打开相关工作<UIcon name="i-lucide-arrow-up-right" /></NuxtLink>
        </template>
      </div>
    </ContextPane>
  </div>
</template>

<style scoped>
.ac-operations-workspace { display: grid; grid-template-columns: minmax(0, 1fr) auto; height: 100%; min-height: 0; background: var(--ac-boardroom-canvas); color: var(--ac-boardroom-ink-900); }
.ac-operations-stage { min-width: 0; overflow: auto; padding: 34px clamp(22px, 4vw, 56px) 48px; }
.ac-operations-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; max-width: 960px; margin: 0 auto 26px; }
.ac-operations-kicker { margin: 0 0 6px; color: var(--ac-boardroom-accent-strong); font-size: 11px; font-weight: 760; letter-spacing: .14em; text-transform: uppercase; }
.ac-operations-header h1 { margin: 0; font-size: clamp(26px, 3vw, 38px); line-height: 1.08; letter-spacing: -.035em; }
.ac-operations-header p:not(.ac-operations-kicker) { max-width: 620px; margin: 10px 0 0; color: var(--ac-boardroom-ink-500); font-size: 14px; line-height: 1.7; }
.ac-operations-actions, .ac-operations-stream, .ac-operations-new, .ac-operations-row__meta, .ac-operations-detail__identity, .ac-operations-detail__link { display: flex; align-items: center; }
.ac-operations-actions { gap: 10px; flex: 0 0 auto; }
.ac-operations-stream { gap: 7px; min-height: 40px; padding: 0 12px; border-radius: var(--ac-boardroom-radius-sm); background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-500); box-shadow: var(--ac-boardroom-shadow-control); font-size: 12px; font-weight: 680; }
.ac-operations-stream > span { width: 7px; height: 7px; border-radius: 50%; background: var(--ac-boardroom-warning); }
.ac-operations-stream[data-state="live"] > span { background: var(--ac-boardroom-success); }
.ac-operations-stream[data-state="degraded"] > span { background: var(--ac-boardroom-danger); }
.ac-operations-new { justify-content: center; gap: 8px; width: min(100%, 960px); min-height: 40px; margin: 0 auto 14px; border: 1px solid var(--ac-boardroom-accent-200); border-radius: var(--ac-boardroom-radius-sm); background: var(--ac-boardroom-accent-50); color: var(--ac-boardroom-accent-strong); font-size: 13px; font-weight: 720; }
.ac-operations-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); max-width: 960px; margin: 0 auto; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-lg); background: var(--ac-boardroom-paper); box-shadow: var(--ac-boardroom-shadow-control); overflow: hidden; }
.ac-operations-summary > div { min-width: 0; padding: 18px 20px; border-right: 1px solid var(--ac-boardroom-ink-100); }
.ac-operations-summary > div:last-child { border-right: 0; }
.ac-operations-summary span { display: block; color: var(--ac-boardroom-ink-500); font-size: 11px; font-weight: 680; }
.ac-operations-summary strong { display: block; margin-top: 6px; font-size: 25px; line-height: 1; font-variant-numeric: tabular-nums; }
.ac-operations-summary [data-tone="error"] strong { color: var(--ac-boardroom-danger); }
.ac-operations-summary [data-tone="warning"] strong { color: var(--ac-boardroom-warning); }
.ac-operations-summary [data-tone="positive"] strong { color: var(--ac-boardroom-success); }
.ac-operations-toolbar { display: flex; gap: 10px; max-width: 960px; margin: 14px auto 22px; }
.ac-operations-toolbar label, .ac-operations-pane label { display: grid; gap: 6px; color: var(--ac-boardroom-ink-500); font-size: 11px; font-weight: 680; }
.ac-operations-toolbar label { flex: 1 1 0; }
.ac-operations-toolbar select, .ac-operations-pane select { min-width: 0; height: 40px; padding: 0 34px 0 12px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); background: var(--ac-boardroom-cloud); color: var(--ac-boardroom-ink-900); font: inherit; font-size: 13px; }
.ac-operations-feed { max-width: 960px; margin: 0 auto; }
.ac-operations-day { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 18px; margin-top: 22px; }
.ac-operations-day__label { position: sticky; top: 0; align-self: start; padding-top: 13px; color: var(--ac-boardroom-ink-300); font-size: 12px; font-weight: 720; }
.ac-operations-day__items { border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-lg); background: var(--ac-boardroom-paper); box-shadow: var(--ac-boardroom-shadow-control); overflow: hidden; }
.ac-operations-row { display: grid; grid-template-columns: 4px 62px minmax(0, 1fr) 18px; align-items: center; gap: 14px; width: 100%; min-height: 84px; padding: 12px 16px 12px 0; border: 0; border-bottom: 1px solid var(--ac-boardroom-ink-100); background: transparent; color: inherit; text-align: left; transition: background-color var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-out), transform var(--ac-boardroom-motion-fast) var(--ac-boardroom-ease-out); }
.ac-operations-row:last-child { border-bottom: 0; }
.ac-operations-row:active { transform: scale(.995); }
.ac-operations-row__marker { align-self: stretch; border-radius: 0 999px 999px 0; background: var(--ac-boardroom-ink-200); }
.ac-operations-row[data-severity="warning"] .ac-operations-row__marker { background: var(--ac-boardroom-warning); }
.ac-operations-row[data-severity="error"] .ac-operations-row__marker { background: var(--ac-boardroom-danger); }
.ac-operations-row__time { color: var(--ac-boardroom-ink-300); font-size: 12px; font-variant-numeric: tabular-nums; }
.ac-operations-row__body { display: grid; min-width: 0; gap: 5px; }
.ac-operations-row__meta { gap: 9px; color: var(--ac-boardroom-ink-300); font-size: 10px; font-weight: 680; }
.ac-operations-row__meta span + span::before { content: "·"; margin-right: 9px; }
.ac-operations-row__body strong, .ac-operations-row__body small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-operations-row__body strong { font-size: 14px; }
.ac-operations-row__body small { color: var(--ac-boardroom-ink-500); font-size: 12px; }
.ac-operations-row > svg { color: var(--ac-boardroom-ink-300); }
.ac-operations-state { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 240px; padding: 24px; border: 1px dashed var(--ac-boardroom-ink-200); border-radius: var(--ac-boardroom-radius-lg); color: var(--ac-boardroom-ink-500); }
.ac-operations-state strong { color: var(--ac-boardroom-ink-900); }
.ac-operations-state p { margin: 4px 0 0; font-size: 12px; }
.ac-operations-state[data-tone="error"] > svg { color: var(--ac-boardroom-danger); }
.ac-operations-footer { display: flex; min-height: 68px; align-items: center; justify-content: center; max-width: 960px; margin: 12px auto 0; color: var(--ac-boardroom-ink-300); font-size: 12px; }
.ac-operations-footer p { margin-right: auto; color: var(--ac-boardroom-danger); }
.ac-operations-pane { display: grid; gap: 18px; padding: 20px; }
.ac-operations-pane__state { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 160px; color: var(--ac-boardroom-ink-500); }
.ac-operations-pane__state[data-tone="error"] { color: var(--ac-boardroom-danger); }
.ac-operations-detail__identity { flex-wrap: wrap; gap: 7px; }
.ac-operations-detail__identity span { padding: 5px 8px; border-radius: var(--ac-boardroom-radius-pill); background: var(--ac-boardroom-sidebar); color: var(--ac-boardroom-ink-500); font-size: 11px; font-weight: 700; }
.ac-operations-detail__identity [data-severity="error"] { color: var(--ac-boardroom-danger); }
.ac-operations-detail__identity [data-severity="warning"] { color: var(--ac-boardroom-warning); }
.ac-operations-detail__summary { padding: 16px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-md); background: var(--ac-boardroom-sidebar); }
.ac-operations-detail__summary p { margin: 8px 0 0; color: var(--ac-boardroom-ink-500); font-size: 13px; line-height: 1.65; }
.ac-operations-detail__facts { display: grid; margin: 0; }
.ac-operations-detail__facts div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--ac-boardroom-ink-100); }
.ac-operations-detail__facts dt { color: var(--ac-boardroom-ink-300); font-size: 11px; }
.ac-operations-detail__facts dd { margin: 0; overflow-wrap: anywhere; color: var(--ac-boardroom-ink-500); font-size: 12px; line-height: 1.55; }
.ac-operations-detail__link { justify-content: space-between; min-height: 44px; padding: 0 13px; border: 1px solid var(--ac-boardroom-ink-100); border-radius: var(--ac-boardroom-radius-sm); color: var(--ac-boardroom-accent-strong); font-size: 13px; font-weight: 720; }
@media (hover: hover) { .ac-operations-row:hover { background: var(--ac-boardroom-cloud); } .ac-operations-new:hover { background: var(--ac-boardroom-accent-100); } }
@media (max-width: 760px) { .ac-operations-stage { padding: 22px 14px 36px; } .ac-operations-header { display: grid; } .ac-operations-actions { justify-content: space-between; } .ac-operations-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ac-operations-summary > div:nth-child(2) { border-right: 0; } .ac-operations-summary > div:nth-child(-n + 2) { border-bottom: 1px solid var(--ac-boardroom-ink-100); } .ac-operations-toolbar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .ac-operations-toolbar label:last-child { grid-column: 1 / -1; } .ac-operations-day { display: block; } .ac-operations-day__label { position: static; padding: 0 2px 8px; } .ac-operations-row { grid-template-columns: 4px 52px minmax(0, 1fr) 16px; gap: 10px; } .ac-operations-row__meta span:last-child { display: none; } }
</style>
