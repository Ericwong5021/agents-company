<script setup lang="ts">
defineProps<{
  label: string;
  description?: string;
  hint?: string;
  inline?: boolean;
}>();
</script>

<template>
  <div
    class="px-1 py-4 sm:px-2"
    :class="inline ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6' : undefined"
  >
    <div
      class="min-w-0"
      :class="inline ? 'flex-1' : 'mb-3'"
    >
      <p class="text-sm text-highlighted">
        {{ label }}
      </p>
      <p
        v-if="description"
        class="mt-0.5 text-xs text-muted"
      >
        {{ description }}
      </p>
    </div>

    <div
      v-if="$slots.default"
      class="min-w-0"
      :class="inline ? 'w-full sm:w-auto sm:shrink-0' : 'w-full'"
    >
      <slot />
      <p
        v-if="hint"
        class="mt-1.5 text-xs text-dimmed"
      >
        {{ hint }}
      </p>
    </div>

    <slot
      v-else
      name="control"
    />
  </div>
</template>
