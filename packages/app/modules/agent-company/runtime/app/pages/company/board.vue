<script setup lang="ts">
import { ref } from "vue"
import { useCompanySnapshot } from "../../composables/useCompanySnapshot"

const { data: snapshot } = useCompanySnapshot()
const draft = ref("")

function submit() {
  if (!draft.value.trim()) return
  draft.value = ""
}
</script>

<template>
  <UDashboardPanel id="agent-company-board" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div class="company-page company-page--board">
        <header class="company-page__header company-page__header--compact">
          <div>
            <p class="company-eyebrow">Board channel</p>
            <h1>Roundtable</h1>
            <p class="company-page__lede">High-signal group collaboration with visible roles and decisions.</p>
          </div>
          <div class="company-avatar-stack" aria-label="Board participants">
            <span v-for="agent in snapshot.agents.slice(0, 3)" :key="agent.id">
              {{ agent.name.slice(0, 1) }}
            </span>
          </div>
        </header>

        <CompanyModuleNav />

        <section class="company-board-feed" aria-label="Board messages">
          <article
            v-for="message in snapshot.messages"
            :key="message.id"
            class="company-message"
            :class="`company-message--${message.kind}`"
          >
            <div class="company-message__meta">
              <strong>{{ message.author }}</strong>
              <span>{{ message.role }}</span>
              <time>{{ message.time }}</time>
            </div>
            <p>{{ message.body }}</p>
          </article>
        </section>

        <form class="company-composer" @submit.prevent="submit">
          <textarea v-model="draft" rows="3" placeholder="Send a goal to the board…" />
          <div class="company-composer__footer">
            <span>Company Board</span>
            <UButton
              type="submit"
              color="neutral"
              icon="i-lucide-arrow-up"
              square
              aria-label="Send to board"
              :disabled="!draft.trim()"
            />
          </div>
        </form>
      </div>
    </template>
  </UDashboardPanel>
</template>
