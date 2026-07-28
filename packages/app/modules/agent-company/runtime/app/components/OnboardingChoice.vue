<script setup lang="ts">
// TRUST-04 — 首次进入的两个清晰选项：连接真实工作区 或 查看演示；并允许跳过。
// 纯展示，选择结果由父级持久化到本地引导状态。
defineProps<{
  providerConfigured?: boolean
}>()

defineEmits<{
  real: []
  demo: []
  skip: []
}>()
</script>

<template>
  <section class="ac-onboarding" aria-labelledby="ac-onboarding-title">
    <div class="ac-onboarding__intro">
      <span class="ac-onboarding__eyebrow">开始使用</span>
      <h2 id="ac-onboarding-title">用本地 AI 团队交付第一个目标</h2>
      <p>
        选择连接你的真实本地工作区开始正式使用，或先查看一个明确标注的演示，了解团队如何组织与交付。
      </p>
    </div>

    <div class="ac-onboarding__choices" role="group" aria-label="选择开始方式">
      <button type="button" class="ac-onboarding__choice" data-variant="real" @click="$emit('real')">
        <span class="ac-onboarding__choice-icon" aria-hidden="true"><UIcon name="i-lucide-plug" /></span>
        <span class="ac-onboarding__choice-title">连接真实工作区</span>
        <span class="ac-onboarding__choice-desc">
          {{
            providerConfigured
              ? "Provider 已就绪，直接描述你的第一个目标。"
              : "先连接模型 Provider，完成后直接进入目标输入。"
          }}
        </span>
        <span class="ac-onboarding__choice-cta">
          {{ providerConfigured ? "开始写目标" : "去连接 Provider" }}
          <UIcon name="i-lucide-arrow-right" />
        </span>
      </button>

      <button type="button" class="ac-onboarding__choice" data-variant="demo" @click="$emit('demo')">
        <span class="ac-onboarding__choice-icon" aria-hidden="true"><UIcon name="i-lucide-flask-conical" /></span>
        <span class="ac-onboarding__choice-title">查看演示</span>
        <span class="ac-onboarding__choice-desc">
          全程明确标注为演示；数据与执行均为示例，不连接真实模型、项目或数据库，也不会产生费用。
        </span>
        <span class="ac-onboarding__choice-cta">
          进入演示
          <UIcon name="i-lucide-arrow-right" />
        </span>
      </button>
    </div>

    <button type="button" class="ac-onboarding__skip" @click="$emit('skip')">跳过引导，直接进入空工作区</button>
  </section>
</template>
