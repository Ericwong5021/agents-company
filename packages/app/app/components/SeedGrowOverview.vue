<script setup lang="ts">
import type {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import {
  assignmentStatusLabels,
  availableAssignments,
  graphDecisionLabels,
  graphStatusLabels,
  sourceRefLabel,
  validationStatusLabels,
} from "../../modules/agent-company/runtime/shared/seed-grow-view"

const props = defineProps<{
  mode?: string
  organization?: OrganizationProjection
  graph?: GraphChangeSummary
  validation?: ValidationSummary
  discoveries: DiscoverySummary[]
  workItems: {
    id: string
    title: string
    status: string
    purpose?: string
    role?: string
    ownerAgentID?: string
  }[]
  pending: boolean
  failed: boolean
}>()

const assignments = computed(() => availableAssignments(props.organization))
const wayfinder = computed(() =>
  props.workItems.find((item) => item.purpose === "discovery" && item.role === "project-wayfinder"),
)
const firstSlice = computed(() => props.workItems.find((item) => item.purpose === "first_slice"))
const changes = computed(() =>
  props.graph?.availability === "available" ? props.graph.changes.toReversed() : [],
)
const gates = computed(() =>
  props.validation?.availability === "available" ? props.validation.gates : [],
)
const unavailable = computed(() =>
  [props.organization, props.graph, props.validation].filter(
    (projection) => projection?.availability === "unavailable",
  ),
)

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function discoveryFor(
  receiptID: string,
): Extract<DiscoverySummary, { availability: "available" }> | undefined {
  return props.discoveries.find(
    (
      discovery,
    ): discovery is Extract<DiscoverySummary, { availability: "available" }> =>
      discovery.availability === "available" && discovery.receiptId === receiptID,
  )
}

function workStatus(status?: string) {
  const labels: Record<string, string> = {
    pending: "待开始",
    queued: "排队中",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    blocked: "受阻",
    superseded: "已替代",
    cancelled: "已取消",
  }
  return status ? (labels[status] ?? status) : "尚未建立"
}

function seedMode(mode?: string) {
  const labels: Record<string, string> = {
    seed_pair: "双 Agent 起步",
    discovery_first: "先确认现实边界",
    direct_single: "单 Agent 直接切片",
  }
  return mode ? (labels[mode] ?? mode) : "Seed-and-Grow"
}
</script>

<template>
  <section class="ac-seed-flow" aria-labelledby="seed-grow-title">
    <div class="ac-seed-flow__heading">
      <div>
        <p class="ac-card-kicker">Seed and grow</p>
        <h2 id="seed-grow-title">动态组织进展</h2>
        <p>从最小团队开始，只在 Receipt 证据要求时增长工作图。</p>
      </div>
      <span class="ac-seed-flow__mode">{{ seedMode(mode) }}</span>
    </div>

    <p v-if="pending" class="ac-seed-flow__state" role="status">正在读取组织与 Graph 事实…</p>
    <p v-else-if="failed" class="ac-seed-flow__state ac-seed-flow__state--error" role="alert">
      无法读取动态组织投影，现有项目状态仍可查看。
    </p>

    <div v-if="!pending && !failed" class="ac-seed-flow__seed">
      <article>
        <span class="ac-seed-flow__step">01</span>
        <div>
          <p>Wayfinder</p>
          <h3>{{ wayfinder?.title ?? "现实边界尚未建立" }}</h3>
          <span>{{ workStatus(wayfinder?.status) }}</span>
        </div>
      </article>
      <article>
        <span class="ac-seed-flow__step">02</span>
        <div>
          <p>First slice</p>
          <h3>{{ firstSlice?.title ?? "第一切片尚未建立" }}</h3>
          <span>{{ workStatus(firstSlice?.status) }}</span>
        </div>
      </article>
    </div>

    <div v-if="!pending && !failed" class="ac-seed-flow__section">
      <div class="ac-seed-flow__section-head">
        <div>
          <p class="ac-card-kicker">Seed team</p>
          <h3>当前责任</h3>
        </div>
        <strong>{{ organization?.availability === "available" ? organization.activeAssignmentCount : "不可用" }}</strong>
      </div>
      <div v-if="assignments.length" class="ac-assignment-rail">
        <article v-for="assignment in assignments" :key="assignment.assignmentId" class="ac-assignment-row">
          <span class="ac-team-avatar" aria-hidden="true">{{ (assignment.agent.name ?? assignment.agent.id).slice(0, 1) }}</span>
          <div class="ac-assignment-row__identity">
            <h4>{{ assignment.agent.name ?? assignment.agent.id }}</h4>
            <p>{{ assignment.temporaryRole }}</p>
          </div>
          <p class="ac-assignment-row__responsibility">{{ assignment.responsibility }}</p>
          <span class="ac-status-badge" :data-status="assignment.status">
            {{ assignmentStatusLabels[assignment.status] }}
          </span>
          <details class="ac-source-trace">
            <summary>加入依据</summary>
            <p>{{ assignment.selectionReason }}</p>
            <ul>
              <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
                {{ sourceRefLabel(source) }}
              </li>
            </ul>
          </details>
        </article>
      </div>
      <p v-else class="ac-seed-flow__empty">当前没有可验证的 Assignment。</p>
    </div>

    <div v-if="!pending && !failed" class="ac-seed-flow__section">
      <div class="ac-seed-flow__section-head">
        <div>
          <p class="ac-card-kicker">Discover, adjust, continue</p>
          <h3>发现与调整</h3>
        </div>
        <strong>{{ changes.length }}</strong>
      </div>
      <div v-if="changes.length" class="ac-seed-timeline">
        <article v-for="change in changes" :key="change.mutationId" class="ac-seed-timeline__event">
          <span class="ac-seed-timeline__marker" :data-status="change.status" aria-hidden="true" />
          <div class="ac-seed-timeline__body">
            <div class="ac-seed-timeline__title">
              <div>
                <span>{{ graphDecisionLabels[change.decision] }}</span>
                <h4>{{ change.rationale }}</h4>
              </div>
              <time :datetime="change.appliedAt ?? change.createdAt">
                {{ dateTime.format(new Date(change.appliedAt ?? change.createdAt)) }}
              </time>
            </div>
            <div class="ac-seed-timeline__meta">
              <span>{{ graphStatusLabels[change.status] }}</span>
              <span>Graph {{ change.expectedRevision }} → {{ change.appliedRevision ?? "待定" }}</span>
            </div>
            <template v-if="discoveryFor(change.triggerReceiptId)?.availability === 'available'">
              <p class="ac-seed-timeline__summary">{{ discoveryFor(change.triggerReceiptId)?.summary }}</p>
              <ul
                v-if="discoveryFor(change.triggerReceiptId)?.unknowns.length"
                class="ac-seed-timeline__signals"
              >
                <li
                  v-for="unknown in discoveryFor(change.triggerReceiptId)?.unknowns"
                  :key="unknown"
                >
                  未知项：{{ unknown }}
                </li>
              </ul>
            </template>
            <details class="ac-source-trace">
              <summary>查看证据来源</summary>
              <ul>
                <li v-for="source in change.sourceRefs" :key="`${source.kind}:${source.id}`">
                  {{ sourceRefLabel(source) }}
                </li>
              </ul>
            </details>
          </div>
        </article>
      </div>
      <p v-else class="ac-seed-flow__empty">还没有基于 Receipt 的 Graph 调整。</p>
    </div>

    <div v-if="!pending && !failed" class="ac-seed-flow__section">
      <div class="ac-seed-flow__section-head">
        <div>
          <p class="ac-card-kicker">Validation</p>
          <h3>阻断 Gate</h3>
        </div>
        <strong>{{ validation?.availability === "available" ? validation.blockingGateCount : "不可用" }}</strong>
      </div>
      <div v-if="gates.length" class="ac-validation-rail">
        <article v-for="gate in gates" :key="gate.gateId">
          <div>
            <h4>{{ gate.criteria[0]?.statement ?? gate.kind }}</h4>
            <p>{{ gate.criteria.length }} 条确定性判据</p>
          </div>
          <span class="ac-status-badge" :data-status="gate.status">
            {{ validationStatusLabels[gate.status] }}
          </span>
        </article>
      </div>
      <p v-else class="ac-seed-flow__empty">当前没有 Validation Gate。</p>
    </div>

    <div v-if="unavailable.length" class="ac-resource-notice" role="status">
      {{ unavailable.length }} 类持久化事实无法解析，对应区域已显示为不可用，不按空结果处理。
    </div>
  </section>
</template>
