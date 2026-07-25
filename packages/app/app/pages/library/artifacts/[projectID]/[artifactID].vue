<script setup lang="ts">
import type { ExperienceArtifactView } from "@agents-company/shared/experience";

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
const artifactURL = computed(() => {
  if (!artifact.value) return;
  if (artifact.value.encoding === "base64") {
    return `data:${artifact.value.mediaType};base64,${artifact.value.content}`;
  }
  return `data:${artifact.value.mediaType};charset=utf-8,${encodeURIComponent(artifact.value.content)}`;
});
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

          <section class="ac-detail-panel">
            <dl class="ac-brief-meta ac-artifact-meta">
              <div>
                <dt>类型</dt>
                <dd>{{ artifact.mediaType }}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{{ artifact.byteLength.toLocaleString("zh-CN") }} 字节</dd>
              </div>
              <div>
                <dt>形成时间</dt>
                <dd>{{ dateTime.format(new Date(artifact.createdAt)) }}</dd>
              </div>
            </dl>

            <pre
              v-if="artifact.presentation === 'text'"
              class="ac-artifact-content"
            >{{ artifact.content }}</pre>
            <img
              v-else-if="artifact.presentation === 'media' && artifact.mediaType.startsWith('image/')"
              class="ac-artifact-media"
              :src="artifactURL"
              :alt="artifact.title"
            >
            <a
              v-else
              class="ac-artifact-download"
              :href="artifactURL"
              :download="artifact.title"
            >
              <UIcon name="i-lucide-download" />
              下载成果文件
            </a>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
