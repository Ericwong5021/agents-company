<script setup lang="ts">
import BoardroomWorkspace from "../../../modules/agent-company/runtime/app/components/boardroom/BoardroomWorkspace.vue"
import { useBoardroomPresenter } from "../../../modules/agent-company/runtime/app/composables/boardroom/useBoardroomPresenter"

const boardroom = useBoardroomPresenter()
</script>

<template>
  <BoardroomWorkspace
    :projection="boardroom.projection.value"
    :pane="boardroom.pane.value"
    :thread="boardroom.selectedThread.value"
    :decision="boardroom.selectedDecision.value"
    :artifact="boardroom.selectedArtifact.value"
    :governance-options="boardroom.governanceOptions.value"
    :board-thread-i-d="boardroom.boardThreadID.value"
    :loading="boardroom.loading.value"
    :project-messages-loading="boardroom.projectMessagesLoading.value"
    :action-message="boardroom.actionMessage.value"
    :send-result="boardroom.sendResult.value"
    @refresh="boardroom.refreshRoom"
    @send="boardroom.sendMessage"
    @retry="boardroom.retryMessage"
    @promote="boardroom.promoteMessage"
    @react="boardroom.react"
    @vote="boardroom.vote"
    @poll="boardroom.createPoll"
    @read="boardroom.markRead"
    @pane="boardroom.openPane"
    @intervene="boardroom.intervene"
    @shadow="boardroom.runShadow"
    @compare="boardroom.compareShadow"
    @converge="boardroom.convergeAdvisor"
  />
</template>
