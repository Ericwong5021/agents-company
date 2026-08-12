<script setup lang="ts">
import { Background } from "@vue-flow/background"
import { Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core"
import ELK from "elkjs/lib/elk.bundled"
import {
  organizationActivityLabel,
  organizationGraphProjection,
  type OrganizationGraphAgent,
  type OrganizationGraphAssignment,
  type OrganizationGraphMode,
  type OrganizationGraphNode,
} from "../../modules/agent-company/runtime/shared/organization-graph"
import "@vue-flow/core/dist/style.css"
import "@vue-flow/core/dist/theme-default.css"

const props = defineProps<{
  companyName: string
  agents: OrganizationGraphAgent[]
  assignments: OrganizationGraphAssignment[]
  selectedId?: string
}>()

const emit = defineEmits<{
  select: [node: OrganizationGraphNode]
}>()

const mode = ref<OrganizationGraphMode>("structure")
const activeOnly = ref(false)
const nodes = shallowRef<Node<OrganizationGraphNode>[]>([])
const edges = shallowRef<Edge[]>([])
const layoutPending = ref(true)
const { fitView, setCenter, zoomIn, zoomOut } = useVueFlow("agent-company-organization-flow")
const modeLabels: { id: OrganizationGraphMode; label: string }[] = [
  { id: "structure", label: "组织结构" },
  { id: "responsibility", label: "项目责任" },
]

function nodeSize(node: OrganizationGraphNode) {
  if (node.kind === "company") return { width: 228, height: 112 }
  if (node.kind === "department") return { width: 218, height: 108 }
  if (node.kind === "responsibility") return { width: 250, height: 138 }
  return { width: 232, height: 132 }
}

async function layout() {
  layoutPending.value = true
  const projection = organizationGraphProjection({
    companyName: props.companyName,
    agents: props.agents,
    assignments: props.assignments,
    mode: mode.value,
    activeOnly: activeOnly.value,
  })
  if (props.selectedId && !projection.nodes.some(node => node.id === props.selectedId))
    emit("select", projection.nodes[0]!)
  const result = await new ELK().layout({
    id: "organization-flow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "44",
      "elk.layered.spacing.nodeNodeBetweenLayers": "92",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.padding": "[top=86,left=44,bottom=86,right=44]",
    },
    children: projection.nodes.map(node => ({ id: node.id, ...nodeSize(node) })),
    edges: projection.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  })
  const positions = new Map(result.children?.map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  nodes.value = projection.nodes.map(node => ({
    id: node.id,
    type: node.kind,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    connectable: false,
    deletable: false,
    selectable: true,
    focusable: true,
    ariaLabel: node.kind === "agent" ? node.name : node.kind === "responsibility" ? node.role : node.title,
    data: node,
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
    class: `ac-organization-flow__edge ac-organization-flow__edge--${edge.state}`,
  }))
  layoutPending.value = false
  await nextTick()
  const focus = positions.get(props.selectedId ?? "company")
  if (projection.nodes.length > 7 && focus) {
    const size = nodeSize(projection.nodes.find(node => node.id === (props.selectedId ?? "company")) ?? projection.nodes[0]!)
    await setCenter(focus.x + size.width / 2, focus.y + size.height / 2, { zoom: 0.84, duration: 240 })
    return
  }
  await fitView({ padding: 0.12, duration: 240, minZoom: 0.58, maxZoom: 1 })
}

function selectNode(id: string) {
  const node = nodes.value.find(item => item.id === id)?.data
  if (node) emit("select", node)
}

watch(
  [() => props.companyName, () => props.agents, () => props.assignments, mode, activeOnly],
  () => void layout(),
  { immediate: true, deep: true },
)
</script>

<template>
  <section class="ac-organization-flow" aria-labelledby="organization-flow-title">
    <header class="ac-organization-flow__header">
      <div>
        <p class="ac-card-kicker">动态组织</p>
        <h2 id="organization-flow-title">公司组织图</h2>
        <p>组织单元来自真实部门记录，Agent 与责任关系来自当前活动和项目分配。</p>
      </div>
      <span>{{ agents.length }} 名可见成员 · {{ assignments.length }} 项责任</span>
    </header>

    <div class="ac-organization-flow__toolbar">
      <div role="tablist" aria-label="组织图模式">
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
        class="ac-organization-flow__filter"
        :aria-pressed="activeOnly"
        :data-active="activeOnly"
        @click="activeOnly = !activeOnly"
      >
        <UIcon name="i-lucide-filter" />
        仅看在岗成员
      </button>
    </div>

    <div class="ac-organization-flow__canvas" :data-pending="layoutPending">
      <div class="ac-organization-flow__bands" aria-hidden="true">
        <span>公司</span>
        <span>组织单元</span>
        <span>Agent</span>
        <span>当前责任</span>
      </div>
      <VueFlow
        id="agent-company-organization-flow"
        v-model:nodes="nodes"
        v-model:edges="edges"
        :min-zoom="0.38"
        :max-zoom="1.4"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="true"
        :delete-key-code="null"
        :pan-on-drag="true"
        :zoom-on-double-click="false"
        @node-click="selectNode($event.node.id)"
      >
        <Background pattern-color="#d9d6cf" :gap="18" :size="1" />

        <template #node-company="{ data }">
          <article class="ac-organization-node ac-organization-node--company" :data-selected="selectedId === data.id">
            <div class="ac-organization-node__icon"><UIcon name="i-lucide-building-2" /></div>
            <div><small>本地 Agent 公司</small><h3>{{ data.title }}</h3></div>
            <p>{{ data.employeeCount }} 名正式员工 · {{ data.temporaryCount }} 名临时成员</p>
            <Handle type="source" :position="Position.Right" class="ac-organization-node__handle" />
          </article>
        </template>

        <template #node-department="{ data }">
          <article class="ac-organization-node" :data-selected="selectedId === data.id">
            <Handle type="target" :position="Position.Left" class="ac-organization-node__handle" />
            <div class="ac-organization-node__heading">
              <span class="ac-organization-node__icon"><UIcon name="i-lucide-network" /></span>
              <div><small>组织单元</small><h3>{{ data.title }}</h3></div>
            </div>
            <p>{{ data.memberCount }} 名成员 · {{ data.activeCount }} 名执行中</p>
            <Handle type="source" :position="Position.Right" class="ac-organization-node__handle" />
          </article>
        </template>

        <template #node-agent="{ data }">
          <article class="ac-organization-node" :data-state="data.activity" :data-selected="selectedId === data.id">
            <Handle type="target" :position="Position.Left" class="ac-organization-node__handle" />
            <div class="ac-organization-node__heading">
              <span class="ac-organization-node__avatar">{{ data.name.slice(0, 1) }}</span>
              <div><small>{{ data.employment === "employee" ? "正式员工" : "项目临时成员" }}</small><h3>{{ data.name }}</h3></div>
            </div>
            <p>{{ data.role || "未记录角色" }}</p>
            <footer><span>{{ organizationActivityLabel(data.activity) }}</span><span>{{ data.workload.active }} 项进行中</span></footer>
            <Handle type="source" :position="Position.Right" class="ac-organization-node__handle" />
          </article>
        </template>

        <template #node-responsibility="{ data }">
          <article class="ac-organization-node ac-organization-node--responsibility" :data-status="data.status" :data-selected="selectedId === data.id">
            <Handle type="target" :position="Position.Left" class="ac-organization-node__handle" />
            <div class="ac-organization-node__heading">
              <span class="ac-organization-node__icon"><UIcon name="i-lucide-badge-check" /></span>
              <div><small>项目责任</small><h3>{{ data.role }}</h3></div>
            </div>
            <p>{{ data.responsibility }}</p>
            <footer><span>{{ data.agentName }}</span><span>{{ data.status === "released" ? "已结束" : "在岗" }}</span></footer>
          </article>
        </template>
      </VueFlow>
      <div v-if="layoutPending" class="ac-organization-flow__loading" role="status">正在整理组织关系…</div>
      <div class="ac-organization-flow__zoom" aria-label="画布缩放">
        <button type="button" aria-label="放大" @click="zoomIn({ duration: 160 })"><UIcon name="i-lucide-plus" /></button>
        <button type="button" aria-label="缩小" @click="zoomOut({ duration: 160 })"><UIcon name="i-lucide-minus" /></button>
        <button type="button" aria-label="适应画布" @click="fitView({ padding: 0.14, duration: 220 })"><UIcon name="i-lucide-maximize" /></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ac-organization-flow { display: grid; min-width: 0; }
.ac-organization-flow__header { display: flex; min-height: 88px; align-items: end; justify-content: space-between; gap: 20px; padding-bottom: 16px; }
.ac-organization-flow__header h2 { margin-top: 4px; color: var(--ac-ink); font-size: 22px; font-weight: 680; letter-spacing: -.025em; }
.ac-organization-flow__header div > p:last-child, .ac-organization-flow__header > span { color: var(--ac-ink-muted); font-size: var(--ac-text-caption); }
.ac-organization-flow__toolbar { display: flex; min-height: 52px; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid var(--ac-line); border-bottom: 0; border-radius: var(--ac-radius-panel) var(--ac-radius-panel) 0 0; background: var(--ac-surface); padding: 7px 10px; }
.ac-organization-flow__toolbar > div { display: flex; gap: 3px; border: 1px solid var(--ac-line); border-radius: var(--ac-radius-control); background: var(--ac-canvas); padding: 3px; }
.ac-organization-flow__toolbar button { display: inline-flex; min-height: 34px; align-items: center; gap: 6px; border-radius: 6px; padding: 6px 14px; color: var(--ac-ink-muted); font-size: var(--ac-text-caption); font-weight: 590; }
.ac-organization-flow__toolbar button[data-active="true"] { background: var(--ac-surface-raised); color: var(--ac-ink); box-shadow: 0 1px 2px rgb(39 31 24 / 9%); }
.ac-organization-flow__canvas { position: relative; height: min(640px, 66vh); min-height: 500px; overflow: hidden; border: 1px solid var(--ac-line); border-radius: 0 0 var(--ac-radius-panel) var(--ac-radius-panel); background: color-mix(in srgb, var(--ac-surface) 88%, var(--ac-canvas)); }
.ac-organization-flow__bands { position: absolute; z-index: 2; inset: 0 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); pointer-events: none; }
.ac-organization-flow__bands span { min-height: 58px; border-right: 1px solid color-mix(in srgb, var(--ac-line) 55%, transparent); padding: 22px 24px 0; color: var(--ac-ink-dimmed); font-size: var(--ac-text-min); font-weight: 620; }
.ac-organization-node { width: 100%; height: 100%; overflow: hidden; border: 1px solid var(--ac-line-strong); border-radius: 12px; background: var(--ac-surface-raised); padding: 14px; color: var(--ac-ink); box-shadow: 0 2px 8px rgb(39 31 24 / 6%); transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease; }
.ac-organization-node:hover { transform: translateY(-1px); box-shadow: 0 5px 16px rgb(39 31 24 / 9%); }
.ac-organization-node[data-selected="true"] { border-color: #52745b; box-shadow: 0 0 0 2px color-mix(in srgb, #52745b 17%, transparent), 0 5px 16px rgb(39 31 24 / 8%); }
.ac-organization-node[data-state="failed"], .ac-organization-node[data-status="released"] { border-style: dashed; }
.ac-organization-node--responsibility[data-status="active"], .ac-organization-node--responsibility[data-status="assigned"] { border-color: #52745b; }
.ac-organization-node__heading, .ac-organization-node--company > div:nth-child(2) { display: flex; align-items: center; gap: 9px; }
.ac-organization-node__heading > div, .ac-organization-node--company > div:nth-child(2) { min-width: 0; }
.ac-organization-node__icon, .ac-organization-node__avatar { display: grid; width: 30px; height: 30px; flex: none; place-items: center; border-radius: 50%; background: var(--ac-sidebar); color: var(--ac-ink); font-weight: 680; }
.ac-organization-node--company > .ac-organization-node__icon { margin-bottom: 8px; background: var(--ac-ink); color: var(--ac-canvas); }
.ac-organization-node__icon svg { width: 14px; height: 14px; }
.ac-organization-node small { color: var(--ac-ink-dimmed); font-size: var(--ac-text-min); }
.ac-organization-node h3 { overflow: hidden; color: var(--ac-ink); font-size: var(--ac-text-body); font-weight: 670; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.ac-organization-node > p { display: -webkit-box; margin-top: 11px; overflow: hidden; color: var(--ac-ink-muted); font-size: var(--ac-text-min); line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.ac-organization-node footer { display: flex; justify-content: space-between; gap: 10px; margin-top: 12px; color: var(--ac-ink-dimmed); font-size: var(--ac-text-min); }
.ac-organization-node__handle { width: 7px; height: 7px; border: 1px solid var(--ac-line-strong); background: var(--ac-surface-raised); opacity: 0; }
.ac-organization-flow__zoom { position: absolute; z-index: 4; bottom: 18px; left: 18px; display: flex; gap: 6px; }
.ac-organization-flow__zoom button { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid var(--ac-line); border-radius: var(--ac-radius-control); background: color-mix(in srgb, var(--ac-surface-raised) 94%, transparent); color: var(--ac-ink-muted); box-shadow: 0 2px 8px rgb(39 31 24 / 8%); }
.ac-organization-flow__zoom svg { width: 15px; height: 15px; }
.ac-organization-flow__loading { position: absolute; z-index: 5; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--ac-surface) 82%, transparent); color: var(--ac-ink-muted); font-size: var(--ac-text-caption); }
:deep(.vue-flow__edge-path) { stroke-width: 1.8; }
:deep(.ac-organization-flow__edge--active .vue-flow__edge-path) { stroke: #52745b; stroke-width: 2.3; }
:deep(.ac-organization-flow__edge--blocked .vue-flow__edge-path) { stroke: #8a6a32; stroke-dasharray: 7 5; }
:deep(.ac-organization-flow__edge--released .vue-flow__edge-path) { stroke: #918d85; stroke-dasharray: 7 6; }
:deep(.ac-organization-flow__edge--stable .vue-flow__edge-path) { stroke: #77736d; }
@media (max-width: 720px) { .ac-organization-flow__header, .ac-organization-flow__toolbar { align-items: flex-start; flex-direction: column; } .ac-organization-flow__canvas { height: 540px; } .ac-organization-flow__bands { display: none; } }
</style>
