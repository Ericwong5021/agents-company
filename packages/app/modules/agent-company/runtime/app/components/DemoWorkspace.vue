<script setup lang="ts">
// TRUST-04 — 显式 Demo Workspace：全程不可忽略的演示标识 + 与真实数据完全隔离的脚本化示例。
// 数据来自 demoScenario()（纯本地静态），从不经由真实快照/Provider/项目接口。
import { ref } from "vue"
import { demoScenario } from "../../shared/onboarding"

defineEmits<{
  connect: []
  exit: []
}>()

const scenario = ref(demoScenario())

const presenceLabel = { online: "在线", busy: "忙碌", offline: "离线" } as const

// 重置演示：重新载入初始脚本化场景，清除本次演示中的任何本地改动。
function resetScenario() {
  scenario.value = demoScenario()
}
</script>

<template>
  <div class="ac-demo">
    <div class="ac-demo__banner" role="note" aria-label="演示环境标识">
      <UIcon name="i-lucide-flask-conical" aria-hidden="true" />
      <div>
        <strong>演示环境</strong>
        <span>{{ scenario.note }}</span>
      </div>
    </div>

    <header class="ac-demo__header">
      <div>
        <p class="ac-demo__eyebrow">Demo workspace</p>
        <h1>{{ scenario.companyName }}</h1>
        <p class="ac-demo__goal">演示目标：{{ scenario.goal }}</p>
      </div>
    </header>

    <section class="ac-demo__section" aria-label="演示员工">
      <h2>团队（示例）</h2>
      <div class="ac-demo__employees">
        <article v-for="employee in scenario.employees" :key="employee.id" class="ac-demo__employee">
          <div class="ac-demo__employee-top">
            <span class="ac-demo__employee-name">{{ employee.name }}</span>
            <span class="ac-demo__presence" :data-presence="employee.presence">{{ presenceLabel[employee.presence] }}</span>
          </div>
          <span class="ac-demo__employee-role">{{ employee.role }}</span>
          <p class="ac-demo__employee-focus">{{ employee.focus }}</p>
        </article>
      </div>
    </section>

    <section class="ac-demo__section" aria-label="演示工作">
      <h2>进行中的工作（示例）</h2>
      <article v-for="item in scenario.work" :key="item.id" class="ac-demo__work">
        <div class="ac-demo__work-top">
          <h3>{{ item.title }}</h3>
          <span class="ac-demo__work-status">{{ item.status }}</span>
        </div>
        <div class="ac-demo__progress" role="progressbar" :aria-valuenow="item.progress" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${item.progress}%` }" />
        </div>
        <p class="ac-demo__work-meta">负责人：{{ item.owner }} · {{ item.progress }}%</p>
        <p class="ac-demo__work-update">{{ item.latestUpdate }}</p>
      </article>
    </section>

    <section class="ac-demo__section" aria-label="演示制品">
      <h2>已产出制品（示例）</h2>
      <article v-for="artifact in scenario.artifacts" :key="artifact.id" class="ac-demo__artifact">
        <div class="ac-demo__artifact-top">
          <h3>{{ artifact.title }}</h3>
          <span class="ac-demo__artifact-kind">{{ artifact.kind }}</span>
        </div>
        <p>{{ artifact.summary }}</p>
      </article>
    </section>

    <footer class="ac-demo__actions">
      <UButton color="neutral" @click="$emit('connect')">连接真实工作区</UButton>
      <UButton color="neutral" variant="outline" @click="$emit('exit')">退出演示</UButton>
      <UButton color="neutral" variant="ghost" @click="resetScenario">重置演示</UButton>
    </footer>
  </div>
</template>
