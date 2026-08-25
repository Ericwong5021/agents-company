<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <section>
    <div class="mb-2 flex min-h-10 items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ title }}
        </h2>
        <p
          v-if="description"
          class="mt-0.5 text-xs text-muted"
        >
          {{ description }}
        </p>
      </div>

      <slot name="actions" />
    </div>

    <div class="divide-y divide-default border-y border-default">
      <slot />
    </div>
  </section>
</template>
