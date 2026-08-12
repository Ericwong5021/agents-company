<script setup lang="ts">
import { Background } from "@vue-flow/background"
import { Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core"
import ELK from "elkjs/lib/elk.bundled"
import type { CompanyProjectDetail } from "../../modules/agent-company/runtime/shared/company-contract"
import {
  taskFlowProjection,
  taskFlowPurposeLabel,
  taskFlowStatusLabel,
  type TaskFlowMode,
  type TaskFlowNode,
} from "../../modules/agent-company/runtime/shared/task-flow-graph"
import "@vue-flow/core/dist/style.css"
import "@vue-flow/core/dist/theme-default.css"

const props = defineProps<{
  detail: CompanyProjectDetail
  workItems: CompanyProjectDetail["workItems"]
  ownerNames: Record<string, string>
  selectedId?: string
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const mode = ref<TaskFlowMode>("flow")
const activeOnly = ref(false)
const nodes = shallowRef<Node<TaskFlowNode>[]>([])
const edges = shallowRef<Edge[]>([])
const layoutPending = ref(true)
const { fitView, setCenter, zoomIn, zoomOut } = useVueFlow("agent-company-task-flow")
const modeLabels: { id: TaskFlowMode; label: string }[] = [
  { id: "flow", label: "任务流" },
  { id: "responsibility", label: "责任" },
  { id: "change", label: "变更" },
]

async function layout() {
  layoutPending.value = true
  const projection = taskFlowProjection(props.detail, props.workItems, props.ownerNames, activeOnly.value)
  const result = await new ELK().layout({
    id: "task-flow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "46",
      "elk.layered.spacing.nodeNodeBetweenLayers": "84",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.padding": "[top=88,left=42,bottom=88,right=42]",
    },
    children: projection.nodes.map(item => ({ id: item.id, width: 232, height: 132 })),
    edges: projection.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  })
  const positions = new Map(result.children?.map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  nodes.value = projection.nodes.map(item => ({
    id: item.id,
    type: "task",
    position: positions.get(item.id) ?? { x: 0, y: 0 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    connectable: false,
    deletable: false,
    selectable: true,
    focusable: true,
    ariaLabel: `${item.title}，${taskFlowStatusLabel(item.status)}，负责人 ${item.ownerName}`,
    data: item,
  }))
  edges.value = projection.edges.map(edge => ({
    ...edge,
    type: "smoothstep",
    animated: edge.state === "active",
    selectable: false,
    focusable: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.state === "active" ? "#52745b" : edge.state === "blocked" ? "#8a6a32" : "#918d85",
      width: 18,
      height: 18,
    },
    class: `ac-task-flow__edge ac-task-flow__edge--${edge.state}`,
  }))
  layoutPending.value = false
  await nextTick()
  const focus = positions.get(
    props.selectedId
    ?? projection.nodes.find(item => ["running", "blocked", "failed"].includes(item.status))?.id
    ?? projection.nodes[0]?.id
    ?? "",
  )
  if (projection.nodes.length > 6 && focus) {
    await setCenter(focus.x + 116, focus.y + 66, { zoom: 0.82, duration: 240 })
    return
  }
  await fitView({ padding: 0.1, duration: 240, minZoom: 0.56, maxZoom: 1 })
}

function runningDuration(startedAt?: number) {
  if (!startedAt) return "正在执行"
  const minutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60_000))
  return `已运行 ${minutes} 分钟`
}

function changeLabel(item: TaskFlowNode) {
  if (item.originKind === "graph_mutation") return "执行后新增"
  if (item.originKind === "receipt") return "回执触发"
  if (item.originKind === "user") return "用户调整"
  if (item.status === "superseded") return "已被替代"
  return `结构版本 ${item.planVersion ?? props.detail.project.graphRevision ?? 0}`
}

function nodeMeta(item: TaskFlowNode) {
  if (mode.value === "responsibility") return item.role || taskFlowPurposeLabel(item.purpose)
  if (mode.value === "change") return changeLabel(item)
  if (item.gateCount) return `${item.gateCount} 项验证条件待处理`
  if (item.status === "running") return runningDuration(item.runStartedAt)
  if (item.artifactCount) return `${item.artifactCount} 项成果`
  return taskFlowPurposeLabel(item.purpose)
}

watch(
  [() => props.detail, () => props.workItems, () => props.ownerNames, activeOnly],
  () => void layout(),
  { immediate: true, deep: true },
)
</script>

<template>
  <section class="ac-task-flow" aria-labelledby="task-flow-title">
    <header class="ac-task-flow__header">
      <div>
        <p class="ac-card-kicker">组织调度</p>
        <h2 id="task-flow-title">任务调度图</h2>
        <p>任务是主节点，依赖是流转关系，Agent 只表示当前责任。</p>
      </div>
      <span>结构版本 {{ detail.project.graphRevision ?? detail.project.activePlanVersion ?? "未知" }}</span>
    </header>

    <div class="ac-task-flow__toolbar">
      <div role="tablist" aria-label="调度图模式">
        <button
          v-for="item in modeLabels"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="mode === item.id"
          :data-active="mode === item.id"
          @click="mode = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <button
        type="button"
        class="ac-task-flow__filter"
        :aria-pressed="activeOnly"
        :data-active="activeOnly"
        @click="activeOnly = !activeOnly"
      >
        <UIcon name="i-lucide-filter" />
        仅看活跃链路
      </button>
    </div>

    <div class="ac-task-flow__canvas" :data-pending="layoutPending">
      <div class="ac-task-flow__bands" aria-hidden="true">
        <span>已确认</span>
        <span>当前执行</span>
        <span>等待前置</span>
        <span>验证</span>
      </div>
      <VueFlow
        id="agent-company-task-flow"
        v-model:nodes="nodes"
        v-model:edges="edges"
        :min-zoom="0.35"
        :max-zoom="1.4"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="true"
        :delete-key-code="null"
        :pan-on-drag="true"
        :zoom-on-double-click="false"
        @node-click="emit('select', $event.node.id)"
      >
        <Background pattern-color="#d9d6cf" :gap="18" :size="1" />
        <template #node-task="{ data }">
          <article
            class="ac-task-node"
            :data-status="data.status"
            :data-selected="selectedId === data.id"
            :data-mode="mode"
          >
            <Handle type="target" :position="Position.Left" class="ac-task-node__handle" />
            <div class="ac-task-node__heading">
              <span class="ac-task-node__status" aria-hidden="true">
                <UIcon
                  :name="data.status === 'completed'
                    ? 'i-lucide-check'
                    : data.status === 'blocked' || data.status === 'failed'
                      ? 'i-lucide-triangle-alert'
                      : data.status === 'running'
                        ? 'i-lucide-circle'
                        : 'i-lucide-clock-3'"
                />
              </span>
              <h3>{{ data.title }}</h3>
            </div>
            <p>{{ taskFlowPurposeLabel(data.purpose) }}</p>
            <footer>
              <span class="ac-task-node__avatar" aria-hidden="true">{{ data.ownerName.slice(0, 1) }}</span>
              <span class="ac-task-node__owner">{{ data.ownerName }}</span>
              <span class="ac-task-node__meta">{{ nodeMeta(data) }}</span>
            </footer>
            <Handle type="source" :position="Position.Right" class="ac-task-node__handle" />
          </article>
        </template>
      </VueFlow>
      <div v-if="layoutPending" class="ac-task-flow__loading" role="status">正在整理任务关系…</div>
      <div class="ac-task-flow__zoom" aria-label="画布缩放">
        <button type="button" aria-label="放大" @click="zoomIn({ duration: 160 })"><UIcon name="i-lucide-plus" /></button>
        <button type="button" aria-label="缩小" @click="zoomOut({ duration: 160 })"><UIcon name="i-lucide-minus" /></button>
        <button type="button" aria-label="适应画布" @click="fitView({ padding: 0.18, duration: 220 })">
          <UIcon name="i-lucide-maximize" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ac-task-flow {
  display: grid;
  gap: 0;
  margin-bottom: 28px;
}

.ac-task-flow__header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 16px;
}

.ac-task-flow__header h2 {
  margin-top: 4px;
  color: var(--ac-ink);
  font-size: 22px;
  font-weight: 680;
  letter-spacing: -.025em;
}

.ac-task-flow__header div > p:last-child,
.ac-task-flow__header > span {
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-caption);
}

.ac-task-flow__toolbar {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--ac-line);
  border-bottom: 0;
  border-radius: var(--ac-radius-panel) var(--ac-radius-panel) 0 0;
  background: var(--ac-surface);
  padding: 7px 10px;
}

.ac-task-flow__toolbar > div {
  display: flex;
  gap: 3px;
  border: 1px solid var(--ac-line);
  border-radius: var(--ac-radius-control);
  background: var(--ac-canvas);
  padding: 3px;
}

.ac-task-flow__toolbar button {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  padding: 6px 14px;
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-caption);
  font-weight: 590;
}

.ac-task-flow__toolbar button[data-active="true"] {
  background: var(--ac-surface-raised);
  color: var(--ac-ink);
  box-shadow: 0 1px 2px rgb(39 31 24 / 9%);
}

.ac-task-flow__filter svg {
  width: 14px;
  height: 14px;
}

.ac-task-flow__canvas {
  position: relative;
  height: min(610px, 62vh);
  min-height: 480px;
  overflow: hidden;
  border: 1px solid var(--ac-line);
  border-radius: 0 0 var(--ac-radius-panel) var(--ac-radius-panel);
  background: color-mix(in srgb, var(--ac-surface) 88%, var(--ac-canvas));
}

.ac-task-flow__bands {
  position: absolute;
  z-index: 2;
  inset: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  pointer-events: none;
}

.ac-task-flow__bands span {
  min-height: 58px;
  border-right: 1px solid color-mix(in srgb, var(--ac-line) 55%, transparent);
  padding: 22px 24px 0;
  color: var(--ac-ink-dimmed);
  font-size: var(--ac-text-min);
  font-weight: 620;
}

.ac-task-node {
  width: 232px;
  min-height: 132px;
  overflow: hidden;
  border: 1px solid var(--ac-line-strong);
  border-radius: 12px;
  background: var(--ac-surface-raised);
  padding: 14px;
  color: var(--ac-ink);
  box-shadow: 0 2px 8px rgb(39 31 24 / 6%);
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}

.ac-task-node:hover {
  transform: translateY(-1px);
  box-shadow: 0 5px 16px rgb(39 31 24 / 9%);
}

.ac-task-node[data-selected="true"] {
  border-color: #52745b;
  box-shadow: 0 0 0 2px color-mix(in srgb, #52745b 17%, transparent), 0 5px 16px rgb(39 31 24 / 8%);
}

.ac-task-node[data-status="blocked"],
.ac-task-node[data-status="failed"] {
  border-color: #b28b4d;
}

.ac-task-node__heading {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.ac-task-node__status {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: var(--ac-canvas);
  color: var(--ac-ink-muted);
}

.ac-task-node[data-status="completed"] .ac-task-node__status {
  background: #52745b;
  color: white;
}

.ac-task-node[data-status="running"] .ac-task-node__status {
  color: #52745b;
}

.ac-task-node[data-status="blocked"] .ac-task-node__status,
.ac-task-node[data-status="failed"] .ac-task-node__status {
  color: #8a6a32;
}

.ac-task-node__status svg {
  width: 13px;
  height: 13px;
}

.ac-task-node h3 {
  min-height: 38px;
  flex: 1;
  color: var(--ac-ink);
  font-size: var(--ac-text-body);
  font-weight: 670;
  line-height: 1.45;
}

.ac-task-node > p {
  margin: 6px 0 13px 30px;
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-min);
}

.ac-task-node footer {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-min);
}

.ac-task-node__avatar {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--ac-sidebar);
  color: var(--ac-ink);
  font-weight: 680;
}

.ac-task-node__owner {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-task-node__meta {
  max-width: 90px;
  overflow: hidden;
  color: var(--ac-ink-dimmed);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-task-node[data-status="blocked"] .ac-task-node__meta,
.ac-task-node[data-status="failed"] .ac-task-node__meta {
  color: #8a6a32;
}

.ac-task-node__handle {
  width: 7px;
  height: 7px;
  border: 1px solid var(--ac-line-strong);
  background: var(--ac-surface-raised);
  opacity: 0;
}

.ac-task-flow__zoom {
  position: absolute;
  z-index: 4;
  bottom: 18px;
  left: 18px;
  display: flex;
  gap: 6px;
}

.ac-task-flow__zoom button {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--ac-line);
  border-radius: var(--ac-radius-control);
  background: color-mix(in srgb, var(--ac-surface-raised) 94%, transparent);
  color: var(--ac-ink-muted);
  box-shadow: 0 2px 8px rgb(39 31 24 / 8%);
}

.ac-task-flow__zoom svg {
  width: 15px;
  height: 15px;
}

.ac-task-flow__loading {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--ac-surface) 82%, transparent);
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-caption);
}

:deep(.vue-flow__edge-path) {
  stroke-width: 1.8;
}

:deep(.ac-task-flow__edge--completed .vue-flow__edge-path) {
  stroke: #6c6963;
}

:deep(.ac-task-flow__edge--active .vue-flow__edge-path) {
  stroke: #52745b;
  stroke-width: 2.4;
}

:deep(.ac-task-flow__edge--blocked .vue-flow__edge-path) {
  stroke: #8a6a32;
  stroke-dasharray: 7 5;
}

:deep(.ac-task-flow__edge--pending .vue-flow__edge-path) {
  stroke: #918d85;
  stroke-dasharray: 7 6;
}

:deep(.vue-flow__node.selected .ac-task-node) {
  border-color: #52745b;
}

@media (max-width: 720px) {
  .ac-task-flow__header,
  .ac-task-flow__toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .ac-task-flow__toolbar {
    padding: 10px;
  }

  .ac-task-flow__canvas {
    height: 520px;
  }

  .ac-task-flow__bands {
    display: none;
  }
}
</style>
