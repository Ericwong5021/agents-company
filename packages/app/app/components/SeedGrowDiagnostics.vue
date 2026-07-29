<script setup lang="ts">
import type {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import type { CompanyProjectDetail } from "../../modules/agent-company/runtime/shared/company-contract"
import {
  graphDecisionLabels,
  graphStatusLabels,
  sourceRefLabel,
  validationStatusLabels,
} from "../../modules/agent-company/runtime/shared/seed-grow-view"

const props = defineProps<{
  graph?: GraphChangeSummary
  validation?: ValidationSummary
  organization?: OrganizationProjection
  detail?: CompanyProjectDetail
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
const assignments = computed(() =>
  props.organization?.availability === "available"
    ? props.organization.assignments.filter((assignment) => assignment.availability === "available")
    : [],
)
const diagnosticsFactCount = computed(() =>
  changes.value.length +
  props.discoveries.length +
  gates.value.length +
  assignments.value.length +
  (props.detail?.recruitment.selections.length ?? 0) +
  (props.detail?.workAttempts.length ?? 0) +
  (props.detail?.workReceipts.length ?? 0) +
  (props.detail?.agentRuns.length ?? 0) +
  (props.detail?.usage ? 1 : 0) +
  props.diagnostics.length,
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
            <li v-for="source in gate.evidenceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceRefLabel(source) }}
            </li>
          </ul>
        </details>
        <details class="ac-source-trace">
          <summary>{{ gate.sourceRefs.length }} 条 Gate 来源</summary>
          <ul>
            <li v-for="source in gate.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceRefLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="assignments.length" class="ac-seed-diagnostics__group" aria-labelledby="assignment-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Assignment</p>
        <h3 id="assignment-heading">责任分配</h3>
      </div>
      <article v-for="assignment in assignments" :key="assignment.assignmentId" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ assignment.agent.name ?? assignment.agent.id }}</h4>
          <span>{{ assignment.status }}</span>
        </div>
        <p>{{ assignment.temporaryRole }} · {{ assignment.responsibility }}</p>
        <details class="ac-source-trace">
          <summary>{{ assignment.sourceRefs.length }} 条 Assignment 来源</summary>
          <ul>
            <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceRefLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section
      v-if="detail?.recruitment.selections.length"
      class="ac-seed-diagnostics__group"
      aria-labelledby="selection-heading"
    >
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Selection</p>
        <h3 id="selection-heading">人员选择</h3>
      </div>
      <article
        v-for="selection in detail.recruitment.selections"
        :key="selection.id"
        class="ac-seed-diagnostics__item"
      >
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ selection.agentID }}</h4>
          <span>{{ selection.decision }}</span>
        </div>
        <p>{{ selection.reason }}</p>
      </article>
    </section>

    <section
      v-if="detail?.workAttempts.length || detail?.workReceipts.length"
      class="ac-seed-diagnostics__group"
      aria-labelledby="attempt-heading"
    >
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Attempt and Receipt</p>
        <h3 id="attempt-heading">执行尝试与回执</h3>
      </div>
      <article v-for="attempt in detail?.workAttempts ?? []" :key="attempt.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>Attempt {{ attempt.ordinal }} · {{ attempt.workItemID }}</h4>
          <span>{{ attempt.status }}</span>
        </div>
        <p v-if="attempt.summary">{{ attempt.summary }}</p>
        <p v-if="attempt.failureKind">失败分类：{{ attempt.failureKind }}</p>
      </article>
      <article v-for="receipt in detail?.workReceipts ?? []" :key="receipt.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>Receipt · {{ receipt.id }}</h4>
          <span>{{ receipt.outcome }} · {{ receipt.processingStatus }}</span>
        </div>
        <p>{{ receipt.summary }}</p>
        <details class="ac-source-trace">
          <summary>{{ receipt.evidenceRefs.length }} 条 Receipt 证据</summary>
          <ul>
            <li v-for="source in receipt.evidenceRefs" :key="`${source.kind}:${source.id}`">
              {{ source.kind }} · {{ source.id }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="detail?.agentRuns.length" class="ac-seed-diagnostics__group" aria-labelledby="agent-run-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Runtime and Skill</p>
        <h3 id="agent-run-heading">运行时与能力证据</h3>
      </div>
      <article v-for="run in detail.agentRuns" :key="run.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ run.agentID }} · {{ run.runtime }}</h4>
          <span>{{ run.state }}</span>
        </div>
        <p>
          {{ run.model ?? "模型未记录" }} · {{ run.permissionMode }}
          <template v-if="run.runtimeVersion"> · {{ run.runtimeVersion }}</template>
        </p>
        <p v-if="run.capabilityChecksum">Skill checksum · {{ run.capabilityChecksum }}</p>
        <p v-if="run.safeErrorSummary" class="ac-seed-diagnostics__failure">{{ run.safeErrorSummary }}</p>
      </article>
    </section>

    <section v-if="detail?.usage" class="ac-seed-diagnostics__group" aria-labelledby="usage-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">Usage</p>
        <h3 id="usage-heading">资源使用</h3>
      </div>
      <dl class="ac-receipt-facts">
        <div>
          <dt>Run</dt>
          <dd>{{ detail.usage.runCount }}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>{{ detail.usage.total }}</dd>
        </div>
        <div>
          <dt>Input / Output</dt>
          <dd>{{ detail.usage.input }} / {{ detail.usage.output }}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{{ detail.usage.cost }}</dd>
        </div>
      </dl>
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
      v-if="!pending && !failed && !diagnosticsFactCount"
      class="ac-brief-state"
    >
      当前没有持久化诊断事实。
    </p>
  </div>
</template>
