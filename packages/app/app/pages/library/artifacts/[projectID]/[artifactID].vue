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
const directionPalettes = [
  [
    { label: "奶油白", value: "#FAF7F0" },
    { label: "深可可", value: "#302822" },
    { label: "杏橙", value: "#E99159" },
    { label: "雾蓝", value: "#AFC5CF" },
  ],
  [
    { label: "雾白", value: "#F2F4F3" },
    { label: "石墨灰", value: "#26303A" },
    { label: "深靛蓝", value: "#2E4F72" },
    { label: "青绿色", value: "#4F9E96" },
  ],
];
const directionPart = (section: string, labels: string[]) => {
  const match = labels.flatMap((label) => {
    const current = section.match(
      new RegExp(`(?:^|\\n)(?:#{1,4}\\s*)?(?:\\d+[.、]\\s*)?${label}\\s*(?:\\n|$)`, "m"),
    );
    return current?.index === undefined ? [] : [{ index: current.index, length: current[0].length }];
  }).toSorted((left, right) => left.index - right.index)[0];
  if (!match) return "";
  const tail = section.slice(match.index + match.length);
  const next = tail.search(/\n(?:#{1,4}\s*)?\d+[.、]\s*[^\n]+/);
  return tail.slice(0, next < 0 ? tail.length : next).trim();
};
const directionPalette = (section: string, index: number) => {
  const explicit = [...section.matchAll(/[-*]\s*([^：:\n]{1,24})[：:][^#\n]*(#[0-9a-f]{6})/gi)]
    .map(match => ({ label: match[1]!.trim(), value: match[2]!.toUpperCase() }));
  if (explicit.length >= 3) return explicit.slice(0, 4);
  if (/奶油|燕麦|浅杏|豆沙|暖|温和|亲子/.test(section)) return directionPalettes[0]!;
  if (/石墨|冷灰|靛蓝|青绿|理性|科技|网格|克制/.test(section)) return directionPalettes[1]!;
  return directionPalettes[index % directionPalettes.length] ?? directionPalettes[0]!;
};
const artifactDescriptions = computed(() => {
  if (!artifact.value || oversized.value) return [];
  let value: unknown;
  try {
    value = JSON.parse(artifact.value.content);
  } catch {
    return [artifact.value.content];
  }
  if (!value || typeof value !== "object") return [];
  const submission = (value as Record<string, unknown>).submission;
  if (!submission || typeof submission !== "object") return [];
  const submissionArtifacts = (submission as Record<string, unknown>).artifacts;
  if (!Array.isArray(submissionArtifacts)) return [];
  return submissionArtifacts.flatMap((item) =>
    item
    && typeof item === "object"
    && typeof (item as Record<string, unknown>).description === "string"
      ? [(item as Record<string, unknown>).description as string]
      : [],
  );
});
const embeddedSvgMarkup = computed(() => {
  const source = artifactDescriptions.value
    .map(description => description.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0])
    .find(Boolean);
  if (!source) return "";
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#)[^"']*\1/gi, "")
    .replace(/url\(\s*(?!#)[^)]+\)/gi, "none");
});
const embeddedSvgURL = computed(() =>
  embeddedSvgMarkup.value
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(embeddedSvgMarkup.value)}`
    : undefined);
const visualDirections = computed(() => {
  const descriptions = artifactDescriptions.value;
  if (!descriptions.length) return [];
  const source = descriptions.join("\n");
  const directionHeading = [
    /(?:^|\n)(?:#{1,4}\s*)?方向([一二三四])\s*[｜|:：-]\s*([^\n]+)/g,
    /[“"]方向([一二三四])\s*[｜|:：-]\s*([^”"\n]+)[”"]/g,
  ].find(pattern =>
    [...source.matchAll(new RegExp(pattern.source, pattern.flags))].length >= 2);
  if (!directionHeading) return [];
  const headings = [...source.matchAll(new RegExp(directionHeading.source, directionHeading.flags))];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const next = headings[index + 1]?.index ?? source.length;
    const body = source.slice(start, next);
    const ending = body.search(/\n(?:并置比较|内部复核)/);
    const section = body.slice(0, ending < 0 ? body.length : ending);
    const concept = directionPart(section, ["视觉概念", "情绪基调"])
      || section
        .split(/[。；]/)
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join("；")
      || "";
    const keywordText = concept.match(/关键词[：:]([^\n]+)/)?.[1];
    return {
      key: heading[1],
      title: heading[2]!.trim(),
      scene: /客厅|共同观看|一起靠近|亲子信任|共读/.test(`${heading[2]}\n${section}`)
        ? "together"
        : /庭院|自然|柔软/.test(`${heading[2]}\n${section}`)
          ? "organic"
          : "structured",
      concept: concept.split("\n\n")[0] ?? "",
      keywords: keywordText
        ? keywordText.split(/[、，,]/).map(item => item.trim()).filter(Boolean)
        : [...new Set(concept.match(/温暖|尊重|安定|亲近|清晰|克制|安静|探索|理性|可信赖/g) ?? [])].slice(0, 4),
      palette: directionPalette(`${heading[2]}\n${directionPart(section, ["色彩倾向", "色彩"])}`, index),
      layout: directionPart(section, ["首屏版式", "版式"]).split("\n\n")[0]
        || section.split(/[。；]/).find(item => /构图|版式/.test(item))?.trim()
        || "",
    };
  });
});
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
              <h1 class="ac-workspace-title">
                {{
                  embeddedSvgURL
                    ? "同屏视觉方向画板"
                    : visualDirections.length
                      ? "双视觉方向概念画布"
                      : displayText(artifact.title)
                }}
              </h1>
              <p class="ac-workspace-lede">
                {{
                  embeddedSvgURL || visualDirections.length
                    ? displayText(artifact.title)
                    : "这是本地服务返回的只读成果，不会在查看时改变交付状态。"
                }}
              </p>
            </div>
            <span class="ac-status-badge">只读</span>
          </header>

          <section v-if="embeddedSvgURL" class="ac-visual-directions ac-embedded-visual" aria-labelledby="embedded-visual-title">
            <header>
              <div>
                <p class="ac-workspace-eyebrow">可视比较</p>
                <h2 id="embedded-visual-title">两个方向在同一画布中并置</h2>
              </div>
              <span>静态 SVG 预览</span>
            </header>
            <div class="ac-embedded-visual__frame">
              <img :src="embeddedSvgURL" :alt="displayText(artifact.title)">
            </div>
            <p class="ac-visual-directions__notice">
              此处以隔离图片方式呈现成果内自包含的 SVG，不执行其中的脚本或外部资源。
              正式品牌、产品与主张仍以人工验收结果为准。
            </p>
          </section>

          <section v-else-if="visualDirections.length" class="ac-visual-directions" aria-labelledby="visual-directions-title">
            <header>
              <div>
                <p class="ac-workspace-eyebrow">可视比较</p>
                <h2 id="visual-directions-title">两条方向，构图与气质都不同</h2>
              </div>
              <span>概念级预览</span>
            </header>
            <div class="ac-visual-directions__grid">
              <article
                v-for="(direction, index) in visualDirections"
                :key="direction.key"
                class="ac-visual-direction"
                :data-direction="direction.key"
                :data-scene="direction.scene"
                :style="`
                  --direction-bg: ${direction.palette[0]?.value};
                  --direction-ink: ${direction.palette[1]?.value};
                  --direction-accent: ${direction.palette[2]?.value};
                  --direction-secondary: ${direction.palette[3]?.value ?? direction.palette[2]?.value};
                `"
              >
                <div class="ac-visual-direction__canvas">
                  <div class="ac-visual-direction__nav">
                    <strong>[品牌名称]</strong>
                    <span>方向 {{ index + 1 }}</span>
                  </div>
                  <div class="ac-visual-direction__copy">
                    <small>{{ direction.title }}</small>
                    <strong>[一句话定位标题待确认]</strong>
                    <p>[辅助说明待确认]</p>
                    <span>继续了解</span>
                  </div>
                  <div class="ac-visual-direction__geometry" aria-hidden="true">
                    <i v-for="item in 5" :key="item" />
                  </div>
                </div>
                <div class="ac-visual-direction__body">
                  <div>
                    <p class="ac-card-kicker">视觉概念</p>
                    <h3>{{ direction.title }}</h3>
                  </div>
                  <p>{{ direction.concept }}</p>
                  <ul class="ac-visual-direction__keywords">
                    <li v-for="keyword in direction.keywords" :key="keyword">{{ keyword }}</li>
                  </ul>
                  <ul class="ac-visual-direction__palette" aria-label="方向色板">
                    <li v-for="color in direction.palette" :key="color.value">
                      <i :style="{ backgroundColor: color.value }" aria-hidden="true" />
                      <span>{{ color.label }}</span>
                      <code>{{ color.value }}</code>
                    </li>
                  </ul>
                  <details>
                    <summary>查看版式依据</summary>
                    <p>{{ direction.layout }}</p>
                  </details>
                </div>
              </article>
            </div>
            <p class="ac-visual-directions__notice">
              此画布只把当前 D3 文本中的色彩、层级和构图确定性地转为可比较预览，不是客户最终稿。
              品牌、产品、文案和正式资产仍保持待确认。
            </p>
          </section>

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
                <dd>
                  {{
                    embeddedSvgURL
                      ? "可视静态画板（附结构化说明）"
                      : visualDirections.length
                        ? "可视概念画布（附结构化说明）"
                        : mediaTypeLabel(artifact.mediaType)
                  }}
                </dd>
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

.ac-visual-directions {
  display: grid;
  gap: 16px;
  margin-bottom: 28px;
}

.ac-visual-directions > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
}

.ac-visual-directions > header h2 {
  margin-top: 5px;
  color: var(--ac-ink);
  font-size: 20px;
  font-weight: 690;
  letter-spacing: -0.02em;
}

.ac-visual-directions > header > span {
  color: var(--ac-ink-muted);
  font-size: 12px;
}

.ac-visual-directions__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.ac-visual-direction {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--ac-radius-panel);
  background: var(--ac-surface-raised);
  box-shadow: 0 2px 12px rgb(39 31 24 / 10%);
}

.ac-visual-direction__canvas {
  position: relative;
  min-height: 300px;
  overflow: hidden;
  background: var(--direction-bg);
  color: var(--direction-ink);
  padding: 20px;
}

.ac-visual-direction__nav {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
}

.ac-visual-direction__nav strong {
  font-size: 11px;
  letter-spacing: 0.02em;
}

.ac-visual-direction__copy {
  position: relative;
  z-index: 2;
  display: grid;
  width: 56%;
  gap: 10px;
  margin-top: 58px;
}

.ac-visual-direction__copy small {
  color: var(--direction-accent);
  font-size: 9px;
  font-weight: 700;
}

.ac-visual-direction__copy > strong {
  font-size: clamp(20px, 2.4vw, 30px);
  letter-spacing: -0.025em;
  line-height: 1.06;
}

.ac-visual-direction__copy p {
  opacity: 0.72;
  font-size: 10px;
}

.ac-visual-direction__copy > span {
  width: max-content;
  min-height: 32px;
  border-radius: var(--ac-radius-control);
  background: var(--direction-accent);
  padding: 8px 12px;
  color: var(--direction-bg);
  font-size: 10px;
  font-weight: 700;
}

.ac-visual-direction__geometry {
  position: absolute;
  inset: 52px 14px 12px 48%;
}

.ac-visual-direction__geometry i {
  position: absolute;
  display: block;
  background: var(--direction-secondary);
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i {
  border-radius: 22px;
  opacity: 0.72;
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i:nth-child(1) {
  inset: 10% 8% 38% 20%;
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i:nth-child(2) {
  width: 54px;
  height: 54px;
  top: 0;
  left: 0;
  background: var(--direction-accent);
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i:nth-child(3) {
  width: 74px;
  height: 34px;
  right: 0;
  bottom: 18%;
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i:nth-child(4) {
  width: 14px;
  height: 14px;
  right: 12%;
  top: 12%;
  border-radius: 50%;
  background: var(--direction-accent);
}

.ac-visual-direction[data-direction="一"] .ac-visual-direction__geometry i:nth-child(5) {
  width: 46px;
  height: 18px;
  left: 0;
  bottom: 8%;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__copy {
  width: 62%;
  margin-top: 42px;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry {
  inset: 46px 10px 8px 44%;
  border-radius: 45% 45% 18px 18px;
  background: color-mix(in srgb, var(--direction-secondary) 28%, transparent);
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(1) {
  inset: 18% 9% 32%;
  border-radius: 18px;
  background: color-mix(in srgb, var(--direction-bg) 78%, white);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--direction-ink) 12%, transparent);
  opacity: 1;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(2),
.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(3) {
  width: 68px;
  height: 68px;
  top: auto;
  bottom: 4%;
  border-radius: 50% 50% 22px 22px;
  background: var(--direction-accent);
  opacity: 0.86;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(2) {
  left: 4%;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(3) {
  right: 4%;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(4) {
  width: 18px;
  height: 18px;
  top: 10%;
  right: 22%;
}

.ac-visual-direction[data-scene="together"] .ac-visual-direction__geometry i:nth-child(5) {
  width: 40%;
  height: 8px;
  bottom: 28%;
  left: 30%;
  border-radius: 999px;
  background: var(--direction-secondary);
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__canvas {
  background-image:
    linear-gradient(color-mix(in srgb, var(--direction-ink) 10%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--direction-ink) 10%, transparent) 1px, transparent 1px);
  background-size: 24px 24px;
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry {
  border: 1px solid color-mix(in srgb, var(--direction-accent) 48%, transparent);
  border-radius: 50%;
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry::before,
.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry::after {
  position: absolute;
  inset: 18%;
  border: 1px solid color-mix(in srgb, var(--direction-accent) 42%, transparent);
  border-radius: 50%;
  content: "";
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry::after {
  inset: 38%;
  background: var(--direction-accent);
  box-shadow: 0 0 24px color-mix(in srgb, var(--direction-accent) 48%, transparent);
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i:nth-child(1) {
  top: 8%;
  left: 48%;
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i:nth-child(2) {
  top: 38%;
  right: 8%;
  background: var(--direction-accent);
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i:nth-child(3) {
  bottom: 12%;
  left: 34%;
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i:nth-child(4) {
  top: 48%;
  left: 4%;
  background: var(--direction-accent);
}

.ac-visual-direction[data-direction="二"] .ac-visual-direction__geometry i:nth-child(5) {
  right: 18%;
  bottom: 14%;
}

.ac-visual-direction__body {
  display: grid;
  gap: 12px;
  padding: 18px;
}

.ac-visual-direction__body h3 {
  margin-top: 4px;
  color: var(--ac-ink);
  font-size: 16px;
  font-weight: 680;
}

.ac-visual-direction__body > p,
.ac-visual-direction__body details p {
  color: var(--ac-ink-muted);
  font-size: 12px;
  line-height: 1.7;
}

.ac-visual-direction__keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ac-visual-direction__keywords li {
  border-radius: 999px;
  background: var(--ac-canvas);
  padding: 4px 8px;
  color: var(--ac-ink-muted);
  font-size: 10px;
}

.ac-visual-direction__palette {
  display: grid;
  gap: 7px;
}

.ac-visual-direction__palette li {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: var(--ac-ink-muted);
  font-size: 10px;
}

.ac-visual-direction__palette i {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  outline: 1px solid rgb(17 17 15 / 12%);
  outline-offset: -1px;
}

.ac-visual-direction__palette code {
  color: var(--ac-ink-dimmed);
  font-size: 9px;
}

.ac-visual-direction__body details {
  color: var(--ac-ink-muted);
  font-size: 11px;
}

.ac-visual-direction__body summary {
  min-height: 40px;
  cursor: pointer;
  padding-block: 10px;
  font-weight: 620;
}

.ac-embedded-visual__frame {
  overflow: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ac-radius-panel);
  background: #d7d2c8;
  box-shadow: 0 2px 12px rgb(39 31 24 / 10%);
}

.ac-embedded-visual__frame img {
  display: block;
  width: 100%;
  height: auto;
}

.ac-visual-directions__notice {
  color: var(--ac-ink-dimmed);
  font-size: 11px;
  line-height: 1.65;
}

@media (max-width: 720px) {
  .ac-visual-directions > header > span {
    display: none;
  }

  .ac-visual-directions__grid {
    grid-template-columns: 1fr;
  }

  .ac-visual-direction__canvas {
    min-height: 280px;
  }
}
</style>
