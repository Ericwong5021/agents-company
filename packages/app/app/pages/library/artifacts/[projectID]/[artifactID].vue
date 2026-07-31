<script setup lang="ts">
import type { ExperienceArtifactView } from "@agents-company/shared/experience";
import {
  dataUrl,
  downloadFileName,
  formatByteLength,
  isOversizedForInline,
  parseCsvPreview,
  prettyJson,
  resolveRenderMode,
} from "../../../../../modules/agent-company/runtime/shared/artifact-view";

const route = useRoute();
const projectID = computed(() => Array.isArray(route.params.projectID)
  ? route.params.projectID[0]
  : route.params.projectID);
const artifactID = computed(() => Array.isArray(route.params.artifactID)
  ? route.params.artifactID[0]
  : route.params.artifactID);
const {
  data: artifact,
  status,
  error,
  refresh,
} = useFetch<ExperienceArtifactView>(() =>
  `/api/agent-company/projects/${encodeURIComponent(projectID.value ?? "")}/artifacts/${encodeURIComponent(artifactID.value ?? "")}`);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
// DELIV-03：按 mediaType/presentation 决定安全预览方式；大文件与不支持格式一律降级为下载而非阻塞页面。
const renderMode = computed(() => artifact.value ? resolveRenderMode(artifact.value) : "download");
const oversized = computed(() => !!artifact.value && isOversizedForInline(artifact.value));
const textModes = new Set(["markdown", "code", "text"]);
const inlineText = computed(() => {
  if (!artifact.value || oversized.value) return "";
  if (renderMode.value === "json") return prettyJson(artifact.value.content);
  if (textModes.has(renderMode.value)) return artifact.value.content;
  return "";
});
type ReadableBlock = {
  kind: "heading" | "field" | "list";
  label: string;
  text?: string;
  items?: string[];
  depth: number;
};
const fieldLabels: Record<string, string> = {
  summary: "摘要",
  submission: "完整成果",
  question: "核心问题",
  content: "正文",
  dataSources: "数据来源",
  data_sources: "数据来源",
  methodology: "方法",
  findings: "主要发现",
  conclusions: "结论",
  approaches: "备选方案",
  title: "标题",
  description: "说明",
  notes: "说明",
  type: "类型",
  pros: "优点",
  cons: "注意事项",
  score: "评分",
  rationale: "推荐理由",
  recommendedId: "推荐方案",
  recommended_id: "推荐方案",
  reasoning: "详细方案",
  acceptance_criteria: "验收条件",
  acceptanceCriteria: "验收条件",
  deliverables: "交付内容",
  constraints: "约束",
  risks: "风险",
  mitigation: "应对措施",
  milestones: "里程碑",
  open_decisions: "待决定事项",
  scope: "范围",
  non_goals: "不在范围内",
  nonGoals: "不在范围内",
  openDecisions: "待决定事项",
  limitations: "限制",
  artifacts: "成果",
  sections: "章节",
  wordcount: "字数",
  word_count: "字数",
  policy: "规则",
  artifact: "成果",
  digest: "摘要校验",
  resources: "资源范围",
  tasks: "执行任务",
  dependencies: "依赖任务",
  assumptions: "前提假设",
  value: "当前目标",
};
const hiddenField = /(^|_)(path|output_dir|workspace|project_id|work_item_id|artifact_id|receipt_id|validation_gate_id|agent_id|reviewer_id|assignment_id|selection_id|run_id|.*_ids)$/i;
const technicalField = /^(id|key|parentKey|sourceTaskKey|source_task_key|kind|workType|work_type|role|capabilityPacks|capability_packs|decisionScope|decision_scope|resourceScope|resource_scope|inputs|expectedOutputs|expected_outputs|validators|disposition|modelGroup|model_group|riskLevel|risk_level|reviewStatus|review_status|suggestedAgent|suggested_agent|purpose|validationMode|validation_mode|maxAttempts|max_attempts)$/i;
const displayText = (value: string) => {
  const labels: Record<string, string> = {
    CEO: "首席执行官",
    ceo: "首席执行官",
    CTO: "技术负责人",
    cto: "技术负责人",
    "Product Lead": "产品负责人",
    product_lead: "产品负责人",
    "board-product-lead": "产品负责人",
    "project-planner": "项目规划负责人",
    blocked: "受阻",
    policy: "规则",
    equals: "等于",
    artifact: "成果",
    digest: "摘要校验",
    exists: "存在",
    exit_code: "退出状态",
  };
  return (labels[value] ?? value)
    .replace(/\s+independent reviewer\b/gi, "（独立复核）")
    .replace(/\bControl Plane Verification\b/gi, "系统核验")
    .replace(/\bDelivery v(\d+)\b/gi, "交付版本 $1")
    .replace(/\bProject Charter\b/gi, "项目章程")
    .replace(/\bCharter\b/gi, "工作章程")
    .replace(/\bDelivery\b/gi, "交付")
    .replace(/\bArtifacts?\b/gi, "成果")
    .replace(/\bSections\b/gi, "章节")
    .replace(/\bWordCount\b/gi, "字数")
    .replace(/持久化\s+成果/g, "持久化成果")
    .replace(/定义\s+工作章程\s+与任务树/g, "定义工作章程与任务树")
    .replace(/项目章程\s+与动态任务计划/g, "项目章程与动态任务计划");
};
const readableLabel = (key: string) =>
  fieldLabels[key] ?? fieldLabels[key.toLowerCase()] ?? displayText(
    key.replace(/_/g, " ").replace(/^\w/, (value) => value.toUpperCase()),
  );
const readableValue = (value: unknown) => {
  if (typeof value === "string") {
    return displayText(value)
      .replace(/\\r\\n|\\n/g, "\n")
      .replace(/[{}]/g, "\\$&");
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null) return "无";
  return "";
};
const readableJsonBlocks = (content: string) => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const referencedTitles = new Map<string, string>();
  const collectReferencedTitles = (current: unknown) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(collectReferencedTitles);
      return;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.title === "string") {
      referencedTitles.set(record.id, record.title);
    }
    Object.values(record).forEach(collectReferencedTitles);
  };
  collectReferencedTitles(value);
  const readableBlockValue = (current: unknown) => {
    if (typeof current === "string") return readableValue(referencedTitles.get(current) ?? current);
    return readableValue(current);
  };
  const blocks: ReadableBlock[] = [];
  const visit = (current: unknown, key: string, depth: number) => {
    if (hiddenField.test(key) || technicalField.test(key)) return;
    const label = readableLabel(key);
    if (Array.isArray(current)) {
      if (current.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
        blocks.push({ kind: "list", label, items: current.map(readableBlockValue), depth });
        return;
      }
      if (key) blocks.push({ kind: "heading", label, depth });
      current.forEach((item, index) => {
        if (item && typeof item === "object") {
          const itemTitle = "title" in item && typeof item.title === "string"
            ? item.title
            : `${label} ${index + 1}`;
          blocks.push({ kind: "heading", label: itemTitle, depth: depth + 1 });
          Object.entries(item).forEach(([itemKey, itemValue]) => {
            if (itemKey !== "title") visit(itemValue, itemKey, depth + 2);
          });
        } else {
          blocks.push({ kind: "field", label, text: readableBlockValue(item), depth: depth + 1 });
        }
      });
      return;
    }
    if (current && typeof current === "object") {
      if (key) blocks.push({ kind: "heading", label, depth });
      Object.entries(current).forEach(([itemKey, itemValue]) => visit(itemValue, itemKey, depth + (key ? 1 : 0)));
      return;
    }
    blocks.push({ kind: "field", label, text: readableBlockValue(current), depth });
  };
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => visit(item, key, 0));
  return blocks.length ? blocks : undefined;
};
const readableBlocks = computed(() =>
  artifact.value && !oversized.value ? readableJsonBlocks(artifact.value.content) : undefined);
const csv = computed(() => artifact.value && renderMode.value === "csv" && !oversized.value
  ? parseCsvPreview(artifact.value.content)
  : undefined);
const artifactURL = computed(() => artifact.value ? dataUrl(artifact.value) : undefined);
const downloadName = computed(() => artifact.value ? downloadFileName(artifact.value) : "");
const mediaTypeLabel = (value: string) => ({
  "application/json": "结构化文档",
  "text/markdown": "Markdown 文档",
  "text/plain": "文本文档",
  "text/csv": "表格",
} as Record<string, string>)[value] ?? value;
const copied = ref(false);
const copyLink = async () => {
  await navigator.clipboard.writeText(new URL(route.fullPath, location.origin).href);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
};
</script>

<template>
  <UDashboardPanel id="artifact-detail" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <NuxtLink :to="`/work/${encodeURIComponent(projectID ?? '')}`" class="ac-back-link">
          <UIcon name="i-lucide-arrow-left" />
          返回工作详情
        </NuxtLink>

        <section v-if="status === 'pending'" class="ac-detail-panel mt-5" aria-live="polite">
          正在读取成果…
        </section>

        <section v-else-if="error || !artifact" class="ac-detail-panel ac-brief-state--error mt-5">
          <h1 class="ac-workspace-title">成果暂时不可用</h1>
          <p>未能从本地服务读取经过验证的成果内容，页面不会展示猜测或过期副本。</p>
          <UButton color="neutral" variant="outline" @click="refresh()">
            重新读取
          </UButton>
        </section>

        <template v-else>
          <header class="ac-workspace-header mt-5">
            <div>
              <p class="ac-workspace-eyebrow">交付成果</p>
              <h1 class="ac-workspace-title">{{ displayText(artifact.title) }}</h1>
              <p class="ac-workspace-lede">
                这是本地服务返回的只读成果，不会在查看时改变交付状态。
              </p>
            </div>
            <span class="ac-status-badge">只读</span>
          </header>

          <div class="ac-artifact-actions">
            <a class="ac-artifact-action" :href="artifactURL" :download="downloadName">
              <UIcon name="i-lucide-download" />
              下载成果
            </a>
            <button type="button" class="ac-artifact-action" @click="copyLink">
              <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-link'" />
              {{ copied ? "链接已复制" : "复制链接" }}
            </button>
          </div>

          <section class="ac-detail-panel">
            <dl class="ac-brief-meta ac-artifact-meta">
              <div>
                <dt>类型</dt>
                <dd>{{ mediaTypeLabel(artifact.mediaType) }}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{{ formatByteLength(artifact.byteLength) }}</dd>
              </div>
              <div>
                <dt>形成时间</dt>
                <dd>{{ dateTime.format(new Date(artifact.createdAt)) }}</dd>
              </div>
            </dl>

            <p v-if="oversized" class="ac-artifact-notice">
              成果较大（{{ formatByteLength(artifact.byteLength) }}），为避免阻塞页面不做内联预览，请下载后查看完整内容。
            </p>

            <template v-else>
              <div v-if="readableBlocks" class="ac-readable-artifact">
                <template v-for="(block, index) in readableBlocks" :key="`${block.label}-${index}`">
                  <h2
                    v-if="block.kind === 'heading'"
                    class="ac-readable-artifact__heading"
                    :style="{ marginLeft: `${Math.min(block.depth, 3) * 1.25}rem` }"
                  >
                    {{ block.label }}
                  </h2>
                  <div
                    v-else
                    class="ac-readable-artifact__block"
                    :style="{ marginLeft: `${Math.min(block.depth, 3) * 1.25}rem` }"
                  >
                    <strong>{{ block.label }}</strong>
                    <div v-if="block.kind === 'field'" class="min-w-0 overflow-x-auto">
                      <ChatComark :markdown="block.text ?? ''" :streaming="false" />
                    </div>
                    <ul v-else>
                      <li v-for="(item, itemIndex) in block.items" :key="itemIndex" class="min-w-0 overflow-x-auto">
                        <ChatComark :markdown="item" :streaming="false" />
                      </li>
                    </ul>
                  </div>
                </template>
                <details class="ac-readable-artifact__raw">
                  <summary>查看原始数据</summary>
                  <pre class="ac-artifact-content" :data-mode="renderMode">{{ inlineText }}</pre>
                </details>
              </div>
              <div
                v-else-if="inlineText && renderMode === 'markdown'"
                class="ac-readable-artifact min-w-0 overflow-x-auto"
              >
                <ChatComark :markdown="inlineText" :streaming="false" />
              </div>
              <pre
                v-else-if="inlineText"
                class="ac-artifact-content"
                :data-mode="renderMode"
              >{{ inlineText }}</pre>
              <div v-else-if="csv" class="ac-artifact-table-wrap">
                <table class="ac-artifact-table">
                  <thead>
                    <tr>
                      <th v-for="(head, index) in csv.headers" :key="index">{{ head }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, rowIndex) in csv.rows" :key="rowIndex">
                      <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="csv.truncated" class="ac-artifact-notice">仅预览前若干行，完整数据请下载查看。</p>
              </div>
              <img
                v-else-if="renderMode === 'image'"
                class="ac-artifact-media"
                :src="artifactURL"
                :alt="artifact.title"
              >
              <iframe
                v-else-if="renderMode === 'pdf'"
                class="ac-artifact-pdf"
                :src="artifactURL"
                :title="artifact.title"
              />
              <a
                v-else
                class="ac-artifact-download"
                :href="artifactURL"
                :download="downloadName"
              >
                <UIcon name="i-lucide-download" />
                该格式不支持内联预览，下载成果文件
              </a>
            </template>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>

<style scoped>
.ac-readable-artifact {
  display: grid;
  gap: 1rem;
}

.ac-readable-artifact__heading {
  color: var(--ui-text-highlighted);
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.5;
}

.ac-readable-artifact__block {
  display: grid;
  gap: 0.4rem;
}

.ac-readable-artifact__block strong {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
  letter-spacing: 0.04em;
}

.ac-readable-artifact__block p,
.ac-readable-artifact__block li {
  line-height: 1.75;
  white-space: pre-wrap;
}

.ac-readable-artifact__block ul {
  display: grid;
  gap: 0.35rem;
  list-style: disc;
  padding-left: 1.25rem;
}

.ac-readable-artifact__raw {
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  margin-top: 0.5rem;
  padding-top: 1rem;
}

.ac-readable-artifact__raw summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 0.75rem;
}
</style>
