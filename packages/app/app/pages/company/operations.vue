<script setup lang="ts">
import OperationsWorkspace from "../../../modules/agent-company/runtime/app/components/operations/OperationsWorkspace.vue"
import { useOperationsPresenter } from "../../../modules/agent-company/runtime/app/composables/operations/useOperationsPresenter"

const operations = useOperationsPresenter()
</script>

<template>
  <OperationsWorkspace
    :projection="operations.projection.value"
    :pane="operations.pane.value"
    @refresh="operations.load"
    @load-more="operations.loadMore"
    @detail="operations.openDetail"
    @filters="operations.openFilters"
    @update-filter="operations.updateFilters"
    @close="operations.closePane"
  />
</template>
