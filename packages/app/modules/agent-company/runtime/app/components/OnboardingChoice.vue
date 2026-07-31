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
      <h2 id="ac-onboarding-title">把一个目标交给会自己组队的 Agent 公司</h2>
      <p>
        Agent 会按目标发现所需角色、临时组队、拆分工作并交付成果。你保留方向调整、外部动作授权和最终验收权。
      </p>
    </div>

    <div class="ac-onboarding__choices" role="group" aria-label="选择开始方式">
      <button type="button" class="ac-onboarding__choice" data-variant="real" @click="$emit('real')">
        <span class="ac-onboarding__choice-icon" aria-hidden="true"><UIcon name="i-lucide-plug" /></span>
        <span class="ac-onboarding__choice-title">
          {{ providerConfigured ? "创建真实工作" : "连接模型服务" }}
        </span>
        <span class="ac-onboarding__choice-desc">
          {{
            providerConfigured
              ? "目标会发送给当前模型服务；开始后，团队将围绕这项工作动态形成。"
              : "先完成模型连接，再输入目标并让团队动态形成。"
          }}
        </span>
        <span class="ac-onboarding__choice-cta">
          {{ providerConfigured ? "开始写目标" : "去连接模型服务" }}
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
