<script setup lang="ts">
// TRUST-04 — 引导入口页：承载首次选择与显式演示，并在无需引导时回到 Inbox。
import { computed, onMounted, ref } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"
import {
  chooseDemo,
  chooseReal,
  exitDemo,
  onboardingStage,
  onboardingStorageKey,
  parseOnboardingState,
  serializeOnboardingState,
  skipOnboarding,
  type OnboardingState,
} from "../../../shared/onboarding"

const { data: snapshot } = useCompanySnapshot()
const state = ref<OnboardingState>(parseOnboardingState(null))
const hydrated = ref(false)

const view = computed(() => ({
  connected: ["ready", "degraded"].includes(snapshot.value.connection),
  providerConfigured: snapshot.value.company.providerConfigured !== false,
  hasWork: snapshot.value.work.length > 0,
}))
const stage = computed(() => onboardingStage(state.value, view.value))

function persist(next: OnboardingState) {
  state.value = next
  if (import.meta.client) window.localStorage.setItem(onboardingStorageKey, serializeOnboardingState(next))
}

function goReal() {
  persist(chooseReal(state.value, new Date().toISOString()))
  navigateTo(view.value.providerConfigured ? "/inbox" : "/settings")
}

function goDemo() {
  persist(chooseDemo(state.value, new Date().toISOString()))
}

function skip() {
  persist(skipOnboarding(state.value, new Date().toISOString()))
  navigateTo("/inbox")
}

function leaveDemo() {
  persist(exitDemo(state.value, new Date().toISOString()))
  navigateTo("/inbox")
}

onMounted(() => {
  state.value = parseOnboardingState(window.localStorage.getItem(onboardingStorageKey))
  hydrated.value = true
  if (onboardingStage(state.value, view.value) === "normal") navigateTo("/inbox", { replace: true })
})
</script>

<template>
  <UDashboardPanel id="agent-company-welcome" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="ac-workspace-page">
        <DemoWorkspace v-if="hydrated && stage === 'demo'" @connect="goReal" @exit="leaveDemo" />
        <OnboardingChoice
          v-else-if="hydrated && stage === 'welcome'"
          :provider-configured="view.providerConfigured"
          @real="goReal"
          @demo="goDemo"
          @skip="skip"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
