<script setup lang="ts">
import type {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import type { CompanyProjectDetail } from "../../modules/agent-company/runtime/shared/company-contract"
import {
  assignmentStatusLabels,
  graphDecisionLabels,
  graphStatusLabels,
  permissionModeLabels,
  validationStatusLabels,
} from "../../modules/agent-company/runtime/shared/seed-grow-view"
import { safeExecutionSummary } from "../../modules/agent-company/runtime/shared/execution-diagnostics"

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
  props.validation?.availability === "available"
    ? props.validation.gates.filter((gate) => {
        if (gate.status === "superseded") return false
        const workItem = props.detail?.workItems.find((item) => item.id === gate.workItemId)
        return !(gate.status === "passed" && workItem && workItem.status !== "completed")
      })
    : [],
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
const tokenUsageAvailable = computed(() =>
  Boolean(
    props.detail?.usage
    && (
      props.detail.usage.runCount === 0
      || props.detail.usage.total > 0
      || props.detail.usage.input > 0
      || props.detail.usage.output > 0
      || props.detail.usage.reasoning > 0
      || props.detail.usage.cacheRead > 0
      || props.detail.usage.cacheWrite > 0
    )
  ))
const costUsageAvailable = computed(() =>
  Boolean(props.detail?.usage && (props.detail.usage.runCount === 0 || props.detail.usage.cost > 0)))
const failedAttemptCount = computed(() =>
  props.detail?.workAttempts.filter(attempt => attempt.status === "failed").length ?? 0)
const blockedItems = computed(() =>
  props.detail?.workItems.filter((item) => ["blocked", "failed"].includes(item.status)) ?? [])

const operationLabels = {
  addedWorkItems: "新增工作项",
  addedDependencies: "新增依赖",
  removedDependencies: "移除依赖",
  supersededWorkItems: "替代工作项",
  addedValidationGates: "新增验证条件",
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

function humanLabel(value: string) {
  const known = {
    CEO: "首席执行官",
    ceo: "首席执行官",
    CTO: "技术负责人",
    cto: "技术负责人",
    "Product Lead": "产品负责人",
    product_lead: "产品负责人",
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
    blocked: "受阻",
    superseded: "已由新计划替代",
  } as Record<string, string>
  return (known[value] ?? value)
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/\bParent(?:\s+delivery)?\s+artifacts? bytes are persisted\b/gi, "上游交付成果已持久保存")
    .replace(/\bParent(?:\s+交付)?\s+成果 bytes are persisted\b/gi, "上游交付成果已持久保存")
    .replace(/\bSuperseded by active plan\s+cpln_[A-Za-z0-9]+\b/gi, "已由当前计划替代")
    .replace(/\bcpln_[A-Za-z0-9]+\b/g, "当前计划")
    .replace(/\bsuperseded\b/gi, "已由新计划替代")
    .replace(/本次闭环的董事会决策记录人/g, "项目规划负责人")
    .replace(/跨项目候选证据分析执行人/g, "方案分析负责人")
    .replace(/执行角色/g, "负责人")
    .replace(/执行人/g, "负责人")
    .replace(/\bAgent conflicts with the persisted independence boundary\.?/gi, "候选成员与已保存的独立性边界冲突。")
    .replace(/\bControl Plane Verification\b/gi, "系统核验")
    .replace(/\bDelivery Ready\b/gi, "交付就绪")
    .replace(/\bDelivery Accepted\b/gi, "交付验收")
    .replace(/\bDelivery Revision\b/gi, "交付返修")
    .replace(/\bdelivery\.ready\b/gi, "交付就绪")
    .replace(/\bProject Charter\b/g, "项目章程")
    .replace(/\bCharter\b/g, "工作章程")
    .replace(/\bDelivery\b/gi, "交付")
    .replace(/\bArtifacts?\b/gi, "成果")
    .replace(/\bcompleted\b/gi, "完成")
}

function validationKindLabel(kind: string) {
  return ({
    prerequisite: "前置条件",
    unit_test: "单项核验",
    integration_test: "集成核验",
    device: "设备核验",
    runtime: "运行核验",
    artifact: "成果",
    source: "来源",
    policy: "规则",
  } as Record<string, string>)[kind] ?? kind
}

function validationOperatorLabel(operator: string) {
  return ({
    exists: "存在",
    equals: "等于",
    exit_code: "退出状态",
    digest: "摘要校验",
  } as Record<string, string>)[operator] ?? operator
}

function workItemTitle(workItemID: string) {
  return humanLabel(props.detail?.workItems.find((item) => item.id === workItemID)?.title ?? "工作项")
}

function attemptStatusLabel(status: string) {
  return ({
    running: "进行中",
    completed: "已完成",
    failed: "未完成",
    interrupted: "已中断",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? status
}

function receiptStatusLabel(outcome: string, processingStatus: string) {
  const outcomeLabel = ({
    completed: "已完成",
    blocked: "未完成",
    failed: "失败",
    interrupted: "已中断",
  } as Record<string, string>)[outcome] ?? outcome
  const processingLabel = ({
    processed: "已处理",
    pending: "待处理",
    failed: "处理失败",
  } as Record<string, string>)[processingStatus] ?? processingStatus
  return `${outcomeLabel} · ${processingLabel}`
}

function failureKindLabel(kind: string) {
  return ({
    unknown: "未提供分类",
    environment: "运行环境",
    validation: "核验失败",
    permission: "权限不足",
    runtime: "运行失败",
  } as Record<string, string>)[kind] ?? kind
}

function agentName(agentID: string) {
  return humanLabel(
    props.detail?.recruitment.candidates.find((candidate) => candidate.id === agentID)?.name ?? "项目成员",
  )
}

function selectionDecisionLabel(decision: string) {
  return decision === "selected" ? "已选择" : decision === "rejected" ? "未选择" : "状态未确认"
}

function agentRunStateLabel(state: string) {
  return ({
    queued: "排队中",
    starting: "启动中",
    running: "运行中",
    completed: "已完成",
    failed: "未完成",
    stopped: "已停止",
    interrupted: "已中断",
    awaiting_recovery: "等待恢复",
  } as Record<string, string>)[state] ?? "状态未确认"
}

function runtimeLabel(runtime: string) {
  return runtime === "pi" ? "本地运行器" : runtime === "acp" ? "自动执行运行器" : "本地运行器"
}

function permissionLabel(mode: string) {
  return (permissionModeLabels as Record<string, string>)[mode] ?? "权限范围已记录"
}

function sourceTypeLabel(source: { kind: string; id: string }) {
  const label = ({
    project: "工作",
    project_event: "工作事件",
    goal_brief: "目标摘要",
    legacy_charter: "工作章程",
    work_item: "工作项",
    approval_gate: "审批",
    artifact: "成果记录",
    delivery: "交付",
    conversation: "讨论",
    goal_request: "目标请求",
    user: "用户",
    work_attempt: "执行尝试",
    work_receipt: "执行回执",
    graph_mutation: "工作调整",
    project_assignment: "责任分配",
    validation_gate: "验证",
  } as Record<string, string>)[source.kind] ?? "已记录依据"
  return `${label}（已记录）`
}
</script>

<template>
  <div class="ac-seed-diagnostics">
    <div class="ac-seed-diagnostics__revision">
      <span>计划版本</span>
      <strong>{{ detail?.project.activePlanVersion ?? "不可用" }}</strong>
    </div>

    <p v-if="pending" class="ac-brief-state" role="status">正在读取工作图与核验依据…</p>
    <p v-else-if="failed" class="ac-brief-state ac-brief-state--error" role="alert">
      结构化诊断暂时不可用。
    </p>
    <p v-if="failedAttemptCount" class="ac-brief-state">
      系统共记录 {{ failedAttemptCount }} 次未通过尝试；执行与独立复核分别计数。日常是否需要介入，以工作页当前状态为准。
    </p>

    <section v-if="blockedItems.length" class="ac-seed-diagnostics__group" aria-labelledby="current-blocker-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">需要处理</p>
        <h3 id="current-blocker-heading">当前阻塞原因</h3>
      </div>
      <article v-for="item in blockedItems" :key="item.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ humanLabel(item.title) }}</h4>
          <span>受阻</span>
        </div>
        <p>{{ safeExecutionSummary(item.error) }}</p>
        <p class="ac-brief-state">现有成果与修改要求已保留。请按上方原因修正后重试当前受阻工作项。</p>
      </article>
    </section>

    <section v-if="changes.length" class="ac-seed-diagnostics__group" aria-labelledby="graph-diff-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">工作图变更</p>
        <h3 id="graph-diff-heading">计划调整</h3>
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
            <summary>变更与回执来源</summary>
          <ul>
              <li v-for="source in change.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceTypeLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="discoveries.length" class="ac-seed-diagnostics__group" aria-labelledby="receipt-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">尝试与回执</p>
        <h3 id="receipt-heading">保留的尝试</h3>
      </div>
      <details class="ac-source-trace">
        <summary>查看 {{ discoveries.length }} 条回执概览</summary>
      <article
        v-for="discovery in discoveries"
        :key="discovery.receiptId"
        class="ac-seed-diagnostics__item"
      >
        <template v-if="discovery.availability === 'available'">
          <div class="ac-seed-diagnostics__item-title">
            <h4>第 {{ discovery.attempt.ordinal }} 次尝试</h4>
            <span>{{ attemptStatusLabel(discovery.outcome) }}</span>
          </div>
          <p>{{ safeExecutionSummary(discovery.summary) }}</p>
          <dl class="ac-receipt-facts">
            <div>
              <dt>已确认</dt>
              <dd>{{ discovery.confirmedFacts.length }}</dd>
            </div>
            <div>
              <dt>本次回执中的执行未知项</dt>
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
          <p class="ac-brief-state">这里只统计本次执行回执，不代表业务事实已经核实。</p>
          <details class="ac-source-trace">
            <summary>回执来源</summary>
            <ul>
              <li v-for="source in discovery.sourceRefs" :key="`${source.kind}:${source.id}`">
                {{ sourceTypeLabel(source) }}
              </li>
            </ul>
          </details>
        </template>
        <p v-else class="ac-brief-state ac-brief-state--error">{{ discovery.reason.message }}</p>
      </article>
      </details>
    </section>

    <section v-if="gates.length" class="ac-seed-diagnostics__group" aria-labelledby="validation-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">核验依据</p>
        <h3 id="validation-heading">确定性核验</h3>
      </div>
      <article v-for="gate in gates" :key="gate.gateId" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ validationKindLabel(gate.kind) }}</h4>
          <span>{{ validationStatusLabels[gate.status] }}</span>
        </div>
        <ul class="ac-validation-criteria">
          <li v-for="criterion in gate.criteria" :key="criterion.id">
            <span>{{ humanLabel(criterion.statement) }}</span>
            <small>{{ validationKindLabel(criterion.anchor.kind) }} · {{ validationOperatorLabel(criterion.operator) }}</small>
          </li>
        </ul>
        <p v-if="gate.failureSummary" class="ac-seed-diagnostics__failure">
          {{ safeExecutionSummary(humanLabel(gate.failureSummary)) }}
        </p>
        <details class="ac-source-trace">
          <summary>{{ gate.evidenceRefs.length }} 条证据引用</summary>
          <ul>
            <li v-for="source in gate.evidenceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceTypeLabel(source) }}
            </li>
          </ul>
        </details>
        <details class="ac-source-trace">
          <summary>{{ gate.sourceRefs.length }} 条核验来源</summary>
          <ul>
            <li v-for="source in gate.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceTypeLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
    </section>

    <section v-if="assignments.length" class="ac-seed-diagnostics__group" aria-labelledby="assignment-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">责任分配</p>
        <h3 id="assignment-heading">责任分配</h3>
      </div>
      <article v-for="assignment in assignments" :key="assignment.assignmentId" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ humanLabel(assignment.agent.name ?? assignment.agent.id) }}</h4>
          <span>{{ assignmentStatusLabels[assignment.status] }}</span>
        </div>
        <p>{{ humanLabel(assignment.temporaryRole) }} · {{ humanLabel(assignment.responsibility) }}</p>
        <details class="ac-source-trace">
          <summary>{{ assignment.sourceRefs.length }} 条责任分配来源</summary>
          <ul>
            <li v-for="source in assignment.sourceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceTypeLabel(source) }}
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
        <p class="ac-card-kicker">人员选择</p>
        <h3 id="selection-heading">人员选择</h3>
      </div>
      <details class="ac-source-trace">
        <summary>查看 {{ detail?.recruitment.selections.length ?? 0 }} 条选择依据</summary>
      <article
        v-for="selection in detail.recruitment.selections"
        :key="selection.id"
        class="ac-seed-diagnostics__item"
      >
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ agentName(selection.agentID) }}</h4>
          <span>{{ selectionDecisionLabel(selection.decision) }}</span>
        </div>
        <p>{{ humanLabel(selection.reason) }}</p>
      </article>
      </details>
    </section>

    <section
      v-if="detail?.workAttempts.length || detail?.workReceipts.length"
      class="ac-seed-diagnostics__group"
      aria-labelledby="attempt-heading"
    >
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">尝试与回执</p>
        <h3 id="attempt-heading">执行尝试与回执</h3>
      </div>
      <details class="ac-source-trace">
        <summary>查看 {{ (detail?.workAttempts.length ?? 0) + (detail?.workReceipts.length ?? 0) }} 条完整执行记录</summary>
      <article v-for="attempt in detail?.workAttempts ?? []" :key="attempt.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ workItemTitle(attempt.workItemID) }} · 第 {{ attempt.ordinal }} 次</h4>
          <span>{{ attemptStatusLabel(attempt.status) }}</span>
        </div>
        <p v-if="attempt.summary">{{ safeExecutionSummary(attempt.summary) }}</p>
        <p v-if="attempt.failureKind && attempt.failureKind !== 'unknown'">
          未完成类型：{{ failureKindLabel(attempt.failureKind) }}
        </p>
      </article>
      <article v-for="receipt in detail?.workReceipts ?? []" :key="receipt.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>执行回执</h4>
          <span>{{ receiptStatusLabel(receipt.outcome, receipt.processingStatus) }}</span>
        </div>
        <p>{{ safeExecutionSummary(receipt.summary) }}</p>
        <details class="ac-source-trace">
          <summary>{{ receipt.evidenceRefs.length }} 条回执依据</summary>
          <ul>
            <li v-for="source in receipt.evidenceRefs" :key="`${source.kind}:${source.id}`">
              {{ sourceTypeLabel(source) }}
            </li>
          </ul>
        </details>
      </article>
      </details>
    </section>

    <section v-if="detail?.agentRuns.length" class="ac-seed-diagnostics__group" aria-labelledby="agent-run-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">运行与能力</p>
        <h3 id="agent-run-heading">运行时与能力证据</h3>
      </div>
      <article v-for="run in detail.agentRuns" :key="run.id" class="ac-seed-diagnostics__item">
        <div class="ac-seed-diagnostics__item-title">
          <h4>{{ agentName(run.agentID) }} · {{ runtimeLabel(run.runtime) }}</h4>
          <span>{{ agentRunStateLabel(run.state) }}</span>
        </div>
        <p>
          {{ permissionLabel(run.permissionMode) }}
        </p>
        <p v-if="run.capabilityChecksum">能力版本已记录</p>
        <p v-if="run.safeErrorSummary" class="ac-seed-diagnostics__failure">
          {{ safeExecutionSummary(run.safeErrorSummary) }}
        </p>
      </article>
    </section>

    <section v-if="detail?.usage" class="ac-seed-diagnostics__group" aria-labelledby="usage-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">资源使用</p>
        <h3 id="usage-heading">资源使用</h3>
      </div>
      <dl class="ac-receipt-facts">
        <div>
          <dt>运行次数</dt>
          <dd>{{ detail.usage.runCount }}</dd>
        </div>
        <div>
          <dt>总模型用量</dt>
          <dd>{{ tokenUsageAvailable ? detail.usage.total : "暂不可用" }}</dd>
        </div>
        <div>
          <dt>输入 / 输出</dt>
          <dd>{{ tokenUsageAvailable ? `${detail.usage.input} / ${detail.usage.output}` : "暂不可用" }}</dd>
        </div>
        <div>
          <dt>费用</dt>
          <dd>{{ costUsageAvailable ? detail.usage.cost : "暂不可用" }}</dd>
        </div>
      </dl>
      <p v-if="!tokenUsageAvailable || !costUsageAvailable" class="ac-brief-state">
        模型服务未返回完整用量或费用明细，不能把缺失数据理解为零用量或免费；请以服务方账单为准。
      </p>
    </section>

    <section v-if="diagnostics.length" class="ac-seed-diagnostics__group" aria-labelledby="runtime-heading">
      <div class="ac-seed-diagnostics__heading">
        <p class="ac-card-kicker">运行诊断</p>
        <h3 id="runtime-heading">运行时诊断</h3>
      </div>
      <ul class="ac-diagnostic-list">
        <li v-for="diagnostic in diagnostics" :key="diagnostic.id">
          {{ safeExecutionSummary(humanLabel(diagnostic.message)) }}
        </li>
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
