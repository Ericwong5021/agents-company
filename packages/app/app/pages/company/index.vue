<script setup lang="ts">
const appConfig = useAppConfig()
const { data: snapshot, pending, refresh } = useCompanySnapshot()
const companyAvailable = computed(() => ["ready", "degraded"].includes(snapshot.value.connection))
const connectionLabel = computed(() => {
  if (snapshot.value.connection === "ready") return "本地运行服务已连接"
  if (snapshot.value.connection === "degraded") return "部分数据暂时不可用"
  if (snapshot.value.connection === "recovering") return "正在重新连接"
  if (snapshot.value.connection === "connecting") return "正在连接"
  return "本地运行服务未连接"
})
const currentWork = computed(() =>
  snapshot.value.work.flatMap(item =>
    item.availability === "available"
    && !["accepted", "failed", "cancelled", "archived"].includes(item.summary.userStatus)
      ? [{
          id: item.summary.workId,
          title: item.summary.title,
          status: item.summary.userStatus,
          progress: item.progress.percent,
        }]
      : []),
)
</script>

<template>
  <UDashboardPanel id="company-overview" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="刷新公司总览"
          :loading="pending"
          @click="refresh()"
        />
      </Navbar>
    </template>

    <template #body>
      <div class="company-page company-page--overview">
        <header class="company-page__header">
          <div>
            <p class="company-eyebrow">公司总览</p>
            <h1>{{ snapshot.company.name }}</h1>
            <p class="company-page__lede">查看本地团队、当前工作和运行边界，再进入需要处理的具体页面。</p>
          </div>
          <span class="company-connection" :data-state="snapshot.connection">{{ connectionLabel }}</span>
        </header>

        <CompanyConnectionState
          v-if="!companyAvailable"
          :connection="snapshot.connection"
          :issue="snapshot.issue"
          :pending="pending"
          show-settings
          @retry="refresh()"
        />

        <template v-else>
          <p v-if="snapshot.notice" class="company-notice">{{ snapshot.notice }}</p>

          <section class="company-stat-grid" aria-label="公司状态">
            <article class="company-stat">
              <span>常驻团队成员在线</span>
              <strong>{{ snapshot.stats.online ?? 0 }}</strong>
            </article>
            <article class="company-stat">
              <span>当前工作</span>
              <strong>{{ currentWork.length }}</strong>
            </article>
            <article class="company-stat">
              <span>董事会消息</span>
              <strong>{{ snapshot.stats.boardMessages ?? 0 }}</strong>
            </article>
          </section>

          <div class="company-overview-grid">
            <section class="company-section">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">当前工作</p>
                  <h2>正在推进</h2>
                </div>
                <NuxtLink to="/work" class="company-text-link">查看全部工作</NuxtLink>
              </div>
              <div class="company-list">
                <NuxtLink
                  v-for="item in currentWork"
                  :key="item.id"
                  :to="`/work/${encodeURIComponent(item.id)}`"
                  class="company-project"
                >
                  <div>
                    <strong>{{ item.title }}</strong>
                    <span>{{ appConfig.experience.statusLabels[item.status] }}</span>
                  </div>
                  <div
                    v-if="item.progress !== undefined"
                    class="company-progress"
                    :aria-label="`已完成 ${item.progress}%`"
                  >
                    <span :style="{ width: `${item.progress}%` }" />
                  </div>
                </NuxtLink>
                <div v-if="!currentWork.length" class="company-empty">
                  <p>当前没有进行中的工作。</p>
                  <NuxtLink to="/inbox?newGoal=1" class="company-text-link">创建新目标</NuxtLink>
                </div>
              </div>
            </section>

            <section class="company-section">
              <div class="company-section__heading">
                <div>
                  <p class="company-eyebrow">运行边界</p>
                  <h2>本地团队设置</h2>
                </div>
                <NuxtLink to="/settings" class="company-text-link">打开设置</NuxtLink>
              </div>
              <dl class="company-definition-list">
                <div>
                  <dt>模型服务</dt>
                  <dd>{{ snapshot.company.provider }}</dd>
                </div>
                <div>
                  <dt>审批策略</dt>
                  <dd>{{ snapshot.company.approvalPolicy }}</dd>
                </div>
                <div>
                  <dt>公司数据</dt>
                  <dd>保存在本地工作区</dd>
                </div>
                <div>
                  <dt>模型请求</dt>
                  <dd>生成与执行内容会发送给已连接的模型服务</dd>
                </div>
              </dl>
            </section>
          </div>

          <section class="company-section">
            <div class="company-section__heading">
              <div>
                <p class="company-eyebrow">快速入口</p>
                <h2>进入工作区域</h2>
              </div>
            </div>
            <div class="ac-work3__actions">
              <NuxtLink class="ac-work3__action" to="/inbox">收件箱</NuxtLink>
              <NuxtLink class="ac-work3__action" to="/company/board">董事会</NuxtLink>
              <NuxtLink class="ac-work3__action" to="/company/operations">运营记录</NuxtLink>
              <NuxtLink class="ac-work3__action" to="/team">团队</NuxtLink>
              <NuxtLink class="ac-work3__action" to="/library">成果库</NuxtLink>
            </div>
          </section>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
