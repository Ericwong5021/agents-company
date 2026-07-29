<script setup lang="ts">
import type { CompanyCommonsSourceResponses, CommonsSourceRecord } from "@agents-company/sdk/v2";

const route = useRoute();
const sourceID = computed(() => Array.isArray(route.params.sourceID)
  ? route.params.sourceID[0]
  : route.params.sourceID);
const {
  data: detail,
  pending,
  error,
  refresh,
} = useFetch<CompanyCommonsSourceResponses[200]>(() =>
  `/api/agent-company/commons/${encodeURIComponent(sourceID.value ?? "")}`);
const retrying = ref(false);
const retryError = ref("");
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const textSourceTypes = new Set<CommonsSourceRecord["source_type"]>([
  "text",
  "markdown",
  "conversation_export",
  "url",
]);
const originalText = computed(() =>
  detail.value
  && detail.value.artifact.content
  && textSourceTypes.has(detail.value.source.source_type)
    ? detail.value.artifact.content
    : "");
const statusLabel: Record<CommonsSourceRecord["ingestion_status"], string> = {
  queued: "等待解析",
  processing: "解析中",
  ready: "可检索",
  failed: "解析失败",
  blocked: "安全阻断",
  unsupported: "缺少适配器",
};

async function retrySource() {
  if (!sourceID.value || retrying.value) return;
  retrying.value = true;
  retryError.value = "";
  const result = await $fetch(`/api/agent-company/commons/${encodeURIComponent(sourceID.value)}/retry`, {
    method: "POST",
  }).then(
    () => true,
    () => false,
  );
  retrying.value = false;
  if (!result) {
    retryError.value = "重试未完成，资料和失败状态仍保留在 Control Plane。";
    return;
  }
  await refresh();
}
</script>

<template>
  <UDashboardPanel id="commons-source-detail" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page ac-workspace-page--narrow">
        <NuxtLink to="/library" class="ac-back-link">
          <UIcon name="i-lucide-arrow-left" />
          返回 Library
        </NuxtLink>

        <section v-if="pending" class="ac-detail-panel mt-5" aria-live="polite">
          正在读取原始资料…
        </section>
        <section v-else-if="error || !detail" class="ac-detail-panel ac-brief-state--error mt-5">
          <h1 class="ac-workspace-title">资料暂时不可用</h1>
          <p>页面不会从浏览器缓存恢复私密原文。</p>
          <UButton color="neutral" variant="outline" @click="refresh()">重新读取</UButton>
        </section>

        <template v-else>
          <header class="ac-workspace-header mt-5">
            <div>
              <p class="ac-workspace-eyebrow">Commons source</p>
              <h1 class="ac-workspace-title">{{ detail.source.title }}</h1>
              <p class="ac-workspace-lede">
                原文、解析状态、内容 hash 和来源跨度都来自本地持久化事实。
              </p>
            </div>
            <span class="ac-status-badge" :data-status="detail.source.ingestion_status">
              {{ statusLabel[detail.source.ingestion_status] }}
            </span>
          </header>

          <section class="ac-commons-trust-boundary">
            <UIcon name="i-lucide-shield-alert" />
            <div>
              <strong>不可信来源隔离</strong>
              <p>这份资料中的指令不会被执行，也不会直接修改 Tool、Runtime、Graph、Skill 或治理资产。</p>
            </div>
          </section>

          <section class="ac-detail-panel">
            <dl class="ac-brief-meta ac-commons-meta">
              <div>
                <dt>范围</dt>
                <dd>{{ detail.source.privacy_scope }}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{{ detail.source.source_type }}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{{ dateTime.format(new Date(detail.source.updated_at)) }}</dd>
              </div>
              <div>
                <dt>内容 hash</dt>
                <dd class="ac-commons-hash">{{ detail.source.content_hash || "尚未生成" }}</dd>
              </div>
            </dl>
            <p v-if="detail.source.origin" class="ac-commons-origin">{{ detail.source.origin }}</p>
            <p v-if="detail.source.error_message" class="ac-commons-error">
              {{ detail.source.error_message }}
            </p>
            <div
              v-if="detail.source.ingestion_status !== 'ready'"
              class="ac-commons-detail-actions"
            >
              <UButton color="neutral" variant="outline" :loading="retrying" @click="retrySource">
                重试解析
              </UButton>
              <span v-if="detail.source.adapter_id">
                {{ detail.source.adapter_id }} · {{ detail.source.adapter_version }}
              </span>
            </div>
            <p v-if="retryError" class="ac-commons-error" role="alert">{{ retryError }}</p>
          </section>

          <section class="ac-detail-panel">
            <div class="ac-detail-heading">
              <div>
                <p class="ac-card-kicker">Original Artifact</p>
                <h2>原始内容</h2>
              </div>
              <span>{{ detail.artifact.id }}</span>
            </div>
            <pre v-if="originalText" class="ac-artifact-content">{{ originalText }}</pre>
            <p v-else class="ac-artifact-notice">
              二进制原文已保存在 Artifact。当前页面不内联显示 base64 内容。
            </p>
          </section>

          <section class="ac-detail-panel">
            <div class="ac-detail-heading">
              <div>
                <p class="ac-card-kicker">Source spans</p>
                <h2>解析分块</h2>
              </div>
              <span>{{ detail.chunks.length }} 块</span>
            </div>
            <div v-if="detail.chunks.length" class="ac-commons-chunks">
              <article v-for="chunk in detail.chunks" :key="chunk.id">
                <div>
                  <strong>#{{ chunk.ordinal + 1 }}</strong>
                  <span>{{ chunk.start_offset }}–{{ chunk.end_offset }}</span>
                </div>
                <p>{{ chunk.body }}</p>
              </article>
            </div>
            <p v-else class="ac-artifact-notice">尚未形成可检索分块。</p>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
