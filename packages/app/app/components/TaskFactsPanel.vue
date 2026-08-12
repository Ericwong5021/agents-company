<script setup lang="ts">
import type { CompanyProjectDetail } from "../../modules/agent-company/runtime/shared/company-contract"
import {
  taskFlowPurposeLabel,
  taskFlowStatusLabel,
} from "../../modules/agent-company/runtime/shared/task-flow-graph"

defineProps<{
  item: CompanyProjectDetail["workItems"][number]
  dependencies: CompanyProjectDetail["workItems"]
  artifacts: CompanyProjectDetail["artifacts"]
  ownerName: string
  whyNow: string
  latestEvidence: string
  attemptCount: number
  receiptCount: number
}>()

defineEmits<{
  openThread: []
  openDiagnostics: []
}>()
</script>

<template>
  <article class="ac-task-facts">
    <header>
      <div>
        <p class="ac-card-kicker">任务事实</p>
        <h2>{{ item.title }}</h2>
      </div>
      <span class="ac-status-badge" :data-status="item.status">{{ taskFlowStatusLabel(item.status) }}</span>
    </header>

    <p v-if="item.description" class="ac-task-facts__description">{{ item.description }}</p>

    <dl class="ac-task-facts__summary">
      <div>
        <dt>当前责任</dt>
        <dd>
          <span class="ac-task-facts__avatar" aria-hidden="true">{{ ownerName.slice(0, 1) }}</span>
          <span><strong>{{ ownerName }}</strong><small>{{ item.role || taskFlowPurposeLabel(item.purpose) }}</small></span>
        </dd>
      </div>
      <div>
        <dt>为什么现在</dt>
        <dd>{{ whyNow }}</dd>
      </div>
      <div>
        <dt>验证方式</dt>
        <dd>{{ item.validationMode || item.reviewStatus || "尚未声明" }}</dd>
      </div>
    </dl>

    <section v-if="dependencies.length">
      <h3>依赖</h3>
      <ul>
        <li v-for="dependency in dependencies" :key="dependency.id">
          <UIcon :name="dependency.status === 'completed' ? 'i-lucide-check' : 'i-lucide-clock-3'" />
          <span>{{ dependency.title }}</span>
        </li>
      </ul>
    </section>

    <section v-if="item.inputs.length">
      <h3>输入</h3>
      <ul>
        <li v-for="input in item.inputs" :key="input"><UIcon name="i-lucide-corner-down-right" /><span>{{ input }}</span></li>
      </ul>
    </section>

    <section v-if="item.expectedOutputs.length">
      <h3>预期结果</h3>
      <ul>
        <li v-for="output in item.expectedOutputs" :key="output"><UIcon name="i-lucide-circle-check" /><span>{{ output }}</span></li>
      </ul>
    </section>

    <section>
      <h3>最新证据</h3>
      <p>{{ latestEvidence }}</p>
      <small>{{ attemptCount }} 次尝试 · {{ receiptCount }} 条回执 · {{ artifacts.length }} 项成果</small>
    </section>

    <section v-if="artifacts.length">
      <h3>关联成果</h3>
      <ul>
        <li v-for="artifact in artifacts.slice(0, 4)" :key="artifact.id">
          <UIcon name="i-lucide-file-check-2" />
          <span>{{ artifact.title }}</span>
        </li>
      </ul>
    </section>

    <footer>
      <button type="button" @click="$emit('openThread')"><UIcon name="i-lucide-message-square-text" />打开讨论</button>
      <button type="button" @click="$emit('openDiagnostics')"><UIcon name="i-lucide-activity" />查看诊断</button>
    </footer>
  </article>
</template>

<style scoped>
.ac-task-facts {
  display: grid;
  gap: 24px;
}

.ac-task-facts > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.ac-task-facts h2 {
  margin-top: 6px;
  color: var(--ac-ink);
  font-size: 20px;
  font-weight: 690;
  line-height: 1.35;
  letter-spacing: -.02em;
}

.ac-task-facts__description,
.ac-task-facts section > p {
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-caption);
  line-height: 1.65;
}

.ac-task-facts__summary {
  display: grid;
  gap: 0;
  border-top: 1px solid var(--ac-line);
}

.ac-task-facts__summary > div {
  display: grid;
  gap: 9px;
  border-bottom: 1px solid var(--ac-line);
  padding: 16px 0;
}

.ac-task-facts dt,
.ac-task-facts h3 {
  color: var(--ac-ink-dimmed);
  font-size: var(--ac-text-min);
  font-weight: 650;
  letter-spacing: .04em;
}

.ac-task-facts dd {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ac-ink);
  font-size: var(--ac-text-caption);
  line-height: 1.55;
}

.ac-task-facts dd span:last-child {
  display: grid;
}

.ac-task-facts dd small,
.ac-task-facts section > small {
  color: var(--ac-ink-dimmed);
  font-size: var(--ac-text-min);
}

.ac-task-facts__avatar {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: var(--ac-sidebar);
  color: var(--ac-ink);
  font-weight: 680;
}

.ac-task-facts section {
  display: grid;
  gap: 10px;
}

.ac-task-facts ul {
  display: grid;
  gap: 8px;
}

.ac-task-facts li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-caption);
  line-height: 1.5;
}

.ac-task-facts li svg {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 3px;
  color: #52745b;
}

.ac-task-facts footer {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  border-top: 1px solid var(--ac-line);
  padding-top: 16px;
}

.ac-task-facts footer button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--ac-line);
  border-radius: var(--ac-radius-control);
  background: var(--ac-surface-raised);
  color: var(--ac-ink-muted);
  font-size: var(--ac-text-min);
  font-weight: 620;
}

.ac-task-facts footer button:hover {
  border-color: var(--ac-line-strong);
  color: var(--ac-ink);
}

.ac-task-facts footer svg {
  width: 14px;
  height: 14px;
}
</style>
