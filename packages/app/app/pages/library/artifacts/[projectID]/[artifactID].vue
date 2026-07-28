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
const csv = computed(() => artifact.value && renderMode.value === "csv" && !oversized.value
  ? parseCsvPreview(artifact.value.content)
  : undefined);
const artifactURL = computed(() => artifact.value ? dataUrl(artifact.value) : undefined);
const downloadName = computed(() => artifact.value ? downloadFileName(artifact.value) : "");
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
              <h1 class="ac-workspace-title">{{ artifact.title }}</h1>
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
                <dd>{{ artifact.mediaType }}</dd>
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
              <pre
                v-if="inlineText"
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
