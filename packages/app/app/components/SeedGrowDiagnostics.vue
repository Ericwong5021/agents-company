<script setup lang="ts">
import type {
  DiscoverySummary,
  GraphChangeSummary,
  ValidationSummary,
} from "@agents-company/shared/experience"
import {
  graphDecisionLabels,
  graphStatusLabels,
  sourceRefLabel,
  validationStatusLabels,
} from "../../modules/agent-company/runtime/shared/seed-grow-view"

const props = defineProps<{
  graph?: GraphChangeSummary
  validation?: ValidationSummary
  discoveries: DiscoverySummary[]
  diagnostics: { id: string; message: string }[]
  pending: boolean
  failed: boolean
}>()

const changes = computed(() =>
  props.graph?.availability === "available" ? props.graph.changes.toReversed() : [],
)
const gates = computed(() =>
  props.validation?.availability === "available" ? props.validation.gates : [],
)

const operationLabels = {
  addedWorkItems: "新增工作项",
  addedDependencies: "新增依赖",
  removedDependencies: "移除依赖",
  supersededWorkItems: "替代工作项",
  addedValidationGates: "新增 Gate",
  requestedCapabilities: "能力请求",
  requestedUserDecisions: "用户决定",
} as const

function operations(change: (typeof changes.value)[number]) {
  return Object.entries(change.operationCounts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      kind: kind as keyof typeof operationLabels,
      count,
    }))
}
</script>

<template>
  <div class="ac-seed-diagnostics">
    <div class="ac-seed-diagnostics__revision">
      <span>Graph revision</span>
      <strong>{{ graph?.availability === "available" ? graph.revision : "不可用" }}</strong>
    </div>

    <p v-if="pending" class="ac-brief-state" role="status">正在读取 Graph 与 Gate 证据…</p>
    <p v-else-if="failed" class="ac-brief-state ac-brief-state--error" role="alert">
      结构化诊断暂时不可用。
    </p>

    <section v-if="changes.length" class="ac-seed-diagnostics__group" aria-labelledby="graph-diff-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Graph diff</p>
        <h3 id="graph-diff-heading">Graph 调整</h3>
      </div>
      <article v-for="change in changes" :key="change.mutationId" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ graphDecisionLabels[change.decision] }}</h4>
          <span>{{ graphStatusLabels[change.status] }}</span>
        </div>
        <p>{{ change.rationale }}</p>
        <dl class="ac-operation-counts">
          <div v-for="operation in operations(change)" :key="operation.kind">
            <dt>{{ operationLabels[operation.kind] }}</dt>
            <dd>{{ operation.count }}</dd>
          </div>
        </dl>
        <p v-if="!operations(change).length" class="ac-seed-flow__empty">这次决定没有修改工作图。</p>
        <details class="ac-source-trace">
          <summary>Mutation 与 Receipt 来源</summary>
          <ul>
            <li v-for="source in change.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceRefLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="discoveries.length" class="ac-seed-diagnostics__group" aria-labelledby="receipt-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Attempt and receipt</p>
        <h3 id="receipt-heading">保留的尝试</h3>
      </div>
      <article
        v-for="discovery in discoveries"
        :key="discovery.receiptId"
        class="ac-seed-diagnostics__item"
      >
        <template v-if="discovery.availability === 'available'">
          <div class="ac-seed-diagnostics__item-title">
            <h4>Attempt {{ discovery.attempt.ordinal }}</h4>
            <span>{{ discovery.outcome }}</span>
          </div>
          <p>{{ discovery.summary }}</p>
          <dl class="ac-receipt-facts">
            <div>
              <dt>已确认</dt>
              <dd>{{ discovery.confirmedFacts.length }}</dd>
            </div>
            <div>
              <dt>未知项</dt>
              <dd>{{ discovery.unknowns.length }}</dd>
            </div>
            <div>
              <dt>阻塞</dt>
              <dd>{{ discovery.blockers.length }}</dd>
            </div>
            <div>
              <dt>能力缺口</dt>
              <dd>{{ discovery.capabilityGaps.length }}</dd>
            </div>
          </dl>
          <details class="ac-source-trace">
            <summary>Receipt 来源</summary>
            <ul>
              <li v-for="source in discovery.sourceRefs" :key="`${source.kind}:${source.id}`">
                {{ sourceRefLabel(source) }}
              </li>
            </ul>
          </details>
        </template>
        <p v-else class="ac-brief-state ac-brief-state--error">{{ discovery.reason.message }}</p>
      </article>
    </section>

    <section v-if="gates.length" class="ac-seed-diagnostics__group" aria-labelledby="validation-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Validation evidence</p>
        <h3 id="validation-heading">确定性 Gate</h3>
      </div>
      <article v-for="gate in gates" :key="gate.gateId" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ gate.kind }}</h4>
          <span>{{ validationStatusLabels[gate.status] }}</span>
        </div>
        <ul class="ac-validation-criteria">
          <li v-for="criterion in gate.criteria" :key="criterion.id">
            <span>{{ criterion.statement }}</span>
            <small>{{ criterion.anchor.kind }} · {{ criterion.operator }}</small>
          </li>
        </ul>
        <p v-if="gate.failureSummary" class="ac-seed-diagnostics__failure">{{ gate.failureSummary }}</p>
        <details class="ac-source-trace">
          <summary>{{ gate.evidenceRefs.length }} 条证据引用</summary>
          <ul>
            <li v-for="source in gate.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceRefLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="diagnostics.length" class="ac-seed-diagnostics__group" aria-labelledby="runtime-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Runtime</p>
        <h3 id="runtime-heading">运行时诊断</h3>
      </div>
      <ul class="ac-diagnostic-list">
        <li v-for="diagnostic in diagnostics" :key="diagnostic.id">{{ diagnostic.message }}</li>
      </ul>
    </section>

    <p
      v-if="!pending && !failed && !changes.length && !discoveries.length && !gates.length && !diagnostics.length"
      class="ac-brief-state"
    >
      当前没有持久化诊断事实。
    </p>
  </div>
</template>
