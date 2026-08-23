import type {
  FounderAdvisorConvergence,
  FounderBoardGovernanceProjection,
  FounderShadowComparison,
  FounderShadowDecision,
} from "@agents-company/sdk/v2/founder-os"
import { computed, onMounted, ref, watch } from "vue"
import type {
  CompanyBoardThread,
  CompanyProjectMessage,
} from "../../../shared/company-contract"
import {
  dedupeBoardroomTimeline,
  emptyBoardroomGovernance,
  toBoardroomGovernance,
  toBoardroomMessages,
  toBoardroomParticipants,
  toBoardroomProjectMessages,
  toBoardroomRoom,
} from "../../adapters/boardroom-message.adapter"
import type {
  BoardroomComparisonInput,
  BoardroomConvergenceInput,
  BoardroomEventVM,
  BoardroomInterventionInput,
  BoardroomPane,
  BoardroomPollInput,
  BoardroomProjection,
  BoardroomSendInput,
  BoardroomSendResult,
  BoardroomShadowInput,
} from "../../types/boardroom"
import { sendFailureText } from "../../../shared/company-composer"

type MessageAccepted = {
  intent?: "casual" | "question" | "task" | "goal" | "intervention" | "approval"
  autoProjected?: boolean
  needsIntentConfirmation?: boolean
}

type BoardroomLoadResult = [
  PromiseSettledResult<FounderBoardGovernanceProjection>,
  PromiseSettledResult<CompanyBoardThread | null>,
]

let sharedBoardLoad: { key: string; promise: Promise<BoardroomLoadResult> } | undefined

function errorStatus(error: unknown) {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return
  return typeof error.statusCode === "number" ? error.statusCode : undefined
}

function errorText(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null) {
    if ("statusMessage" in error && typeof error.statusMessage === "string") return error.statusMessage
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return fallback
}

export function useBoardroomPresenter() {
  const route = useRoute()
  const { data: snapshot, refresh, signalVersion } = useCompanySnapshot()
  const board = ref<FounderBoardGovernanceProjection | null>(null)
  const boardThread = ref<CompanyBoardThread | null>(null)
  const projectMessages = ref<CompanyProjectMessage[]>([])
  const projectMessagesLoading = ref(false)
  const boardLoading = ref(false)
  const loading = ref(false)
  const error = ref("")
  const notice = ref("")
  const governanceError = ref("")
  const actionMessage = ref("")
  const pane = ref<BoardroomPane>({ kind: "closed" })
  const sendResult = ref<BoardroomSendResult>()
  const optimisticEvents = ref<BoardroomEventVM[]>([])
  const pendingMessages = ref(new Map<string, BoardroomSendInput>())
  const promotionMessages = ref(new Map<string, BoardroomSendInput>())
  const mounted = ref(false)
  const loadedRoomKey = ref("")

  const projectID = computed(() => typeof route.query.project === "string" ? route.query.project : "")
  const roomLoadKey = computed(() => `${snapshot.value.company.id}:${projectID.value}:${signalVersion.value}`)
  const project = computed(() => snapshot.value.projects.find(item => item.id === projectID.value))
  const room = computed(() => toBoardroomRoom(project.value))
  const companyMessages = computed(() => projectID.value ? [] : snapshot.value.messages)
  const participants = computed(() => toBoardroomParticipants(snapshot.value.agents, snapshot.value.messages))
  const baseTimeline = computed(() => projectID.value
    ? toBoardroomProjectMessages(projectMessages.value, snapshot.value.agents)
    : toBoardroomMessages(companyMessages.value, snapshot.value.agents))
  const timeline = computed(() => dedupeBoardroomTimeline([...baseTimeline.value, ...optimisticEvents.value]))
  const responding = computed(() => participants.value.filter(participant => participant.status === "thinking"))
  const governance = computed(() => ({
    ...(board.value
      ? toBoardroomGovernance(board.value, projectID.value || undefined)
      : emptyBoardroomGovernance()),
    error: governanceError.value,
  }))
  const boardThreadID = computed(() => {
    if (projectID.value) return projectMessages.value.findLast(message => message.sourceThreadID)?.sourceThreadID
    return snapshot.value.messages.findLast(message => message.threadID)?.threadID
  })
  const projection = computed<BoardroomProjection>(() => ({
    room: room.value,
    participants: participants.value,
    timeline: timeline.value,
    governance: governance.value,
    responding: responding.value,
    connection: snapshot.value.connection,
    error: error.value,
    notice: notice.value,
  }))
  const selectedThread = computed(() => {
    const currentPane = pane.value
    if (currentPane.kind !== "thread") return
    const message = timeline.value.find(item => item.id === currentPane.messageID)
    if (!message) return
    return {
      original: message,
      replies: timeline.value.filter(item => item.replyToID === message.id),
    }
  })
  const selectedDecision = computed(() => {
    const currentPane = pane.value
    if (currentPane.kind !== "decision") return
    return governance.value.decisions.find(decision => decision.id === currentPane.decisionID)
  })
  const selectedArtifact = computed(() => {
    const currentPane = pane.value
    if (currentPane.kind !== "artifact") return
    return governance.value.artifacts.find(artifact => artifact.id === currentPane.artifactID && artifact.version === currentPane.version)
  })
  const governanceOptions = computed(() => ({
    roomProjectID: projectID.value || undefined,
    companyGoal: snapshot.value.company.setupGoal,
    projects: snapshot.value.projects.map(item => ({ id: item.id, title: item.title, status: item.status })),
    agents: snapshot.value.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      role: agent.role ?? agent.department ?? "Agent",
    })),
    messages: timeline.value
      .filter(message => !message.id.startsWith("optimistic:"))
      .map(message => ({ id: message.id, author: message.author, body: message.body })),
  }))

  async function loadProjectMessages() {
    if (!projectID.value) {
      projectMessages.value = []
      return
    }
    projectMessagesLoading.value = true
    error.value = ""
    try {
      projectMessages.value = await $fetch<CompanyProjectMessage[]>(
        `/api/agent-company/projects/${encodeURIComponent(projectID.value)}/messages`,
      )
    } catch (reason) {
      projectMessages.value = []
      error.value = errorText(reason, "项目讨论暂时不可用。")
    } finally {
      projectMessagesLoading.value = false
    }
  }

  async function loadBoard() {
    if (!snapshot.value.company.id || boardLoading.value) return
    boardLoading.value = true
    governanceError.value = ""
    const loadKey = `${snapshot.value.company.id}:${boardThreadID.value ?? ""}`
    const operation = sharedBoardLoad?.key === loadKey
      ? sharedBoardLoad.promise
      : Promise.allSettled([
          $fetch<FounderBoardGovernanceProjection>("/api/agent-company/founder-board", {
            query: { companyId: snapshot.value.company.id },
          }),
          boardThreadID.value
            ? $fetch<CompanyBoardThread>("/api/agent-company/board", {
                query: { thread_id: boardThreadID.value },
              })
            : Promise.resolve(null),
        ] as const)
    sharedBoardLoad = { key: loadKey, promise: operation }
    const requests = await operation
    if (sharedBoardLoad?.promise === operation) sharedBoardLoad = undefined
    const projectionResult = requests[0]
    const threadResult = requests[1]
    if (projectionResult.status === "fulfilled") board.value = projectionResult.value
    else {
      board.value = null
      const detail = errorText(projectionResult.reason, "董事会治理投影暂时不可用。")
      governanceError.value = /HTTP 404|Not Found/i.test(detail)
        ? "当前 Control Plane 未提供 Founder OS 治理投影，群聊仍可继续。"
        : detail
    }
    if (threadResult.status === "fulfilled") boardThread.value = threadResult.value
    else {
      boardThread.value = null
      governanceError.value ||= errorText(threadResult.reason, "董事会线程暂时不可用。")
    }
    boardLoading.value = false
  }

  async function refreshRoom() {
    await refresh()
    await Promise.all([loadBoard(), loadProjectMessages()])
  }

  function optimisticEvent(input: BoardroomSendInput): BoardroomEventVM {
    return {
      id: `optimistic:${input.requestID}`,
      sequence: (timeline.value.at(-1)?.sequence ?? 0) + 1,
      createdAt: Date.now(),
      authorID: "local_user",
      author: "你",
      role: "创始人",
      time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(Date.now()),
      body: input.body,
      kind: "human",
      type: "message",
      replyToID: input.replyToID,
      reply: input.replyToID
        ? timeline.value.find(message => message.id === input.replyToID)
          ? {
              id: input.replyToID,
              author: timeline.value.find(message => message.id === input.replyToID)?.author ?? "",
              body: timeline.value.find(message => message.id === input.replyToID)?.body ?? "",
            }
          : undefined
        : undefined,
      mentions: input.mentions.map(id => snapshot.value.agents.find(agent => agent.id === id)?.name ?? id),
      resources: input.resources.map(resource => ({
        kind: resource.kind,
        label: resource.kind === "url" ? resource.label || resource.url : resource.kind === "path" ? resource.label || resource.path : resource.name,
      })),
      reactions: [],
      activity: "正在发送…",
      deliveryStatus: "sending",
    }
  }

  async function sendMessage(input: BoardroomSendInput) {
    if (!input.body.trim() || pendingMessages.value.has(input.requestID)) return
    pendingMessages.value = new Map(pendingMessages.value).set(input.requestID, input)
    optimisticEvents.value = [
      ...optimisticEvents.value.filter(message => message.id !== `optimistic:${input.requestID}`),
      optimisticEvent(input),
    ]
    sendResult.value = undefined
    try {
      const accepted = await $fetch<MessageAccepted>("/api/agent-company/messages", {
        method: "POST",
        body: {
          request_id: input.requestID,
          body: input.body.trim(),
          target: room.value.kind === "company"
            ? { kind: "board" }
            : { kind: "project", project_id: room.value.projectID },
          mentions: [
            ...input.mentions.map(agentID => ({ kind: "agent" as const, agent_id: agentID })),
            ...input.roles.map(role => ({ kind: "role" as const, role })),
          ],
          resources: input.resources,
          ...(input.replyToID ? { reply_to: input.replyToID } : {}),
          ...(room.value.kind === "company" && input.intent !== "auto" ? { intent_override: input.intent } : {}),
        },
      })
      await refreshRoom()
      optimisticEvents.value = optimisticEvents.value.filter(message => message.id !== `optimistic:${input.requestID}`)
      const nextPending = new Map(pendingMessages.value)
      nextPending.delete(input.requestID)
      pendingMessages.value = nextPending
      if (accepted.needsIntentConfirmation)
        promotionMessages.value = new Map(promotionMessages.value).set(input.requestID, input)
      const feedback = accepted.autoProjected
        ? "已识别为可执行目标并进入工作流。"
        : accepted.needsIntentConfirmation
          ? "已保留为讨论；如果这是明确目标，可以使用 /goal 再次发送。"
          : "已按讨论消息保存。"
      sendResult.value = {
        requestID: input.requestID,
        status: "accepted",
        feedback,
        canPromote: accepted.needsIntentConfirmation,
      }
    } catch (reason) {
      optimisticEvents.value = optimisticEvents.value.map(message =>
        message.id === `optimistic:${input.requestID}`
          ? { ...message, deliveryStatus: "failed", activity: sendFailureText(errorStatus(reason)) }
          : message)
      sendResult.value = {
        requestID: input.requestID,
        status: "failed",
        feedback: sendFailureText(errorStatus(reason)),
      }
    }
  }

  async function retryMessage(messageID: string) {
    const requestID = messageID.replace(/^optimistic:/, "")
    const input = pendingMessages.value.get(requestID)
    if (!input) return
    const nextPending = new Map(pendingMessages.value)
    nextPending.delete(requestID)
    pendingMessages.value = nextPending
    await sendMessage(input)
  }

  async function promoteMessage(requestID: string) {
    const input = promotionMessages.value.get(requestID)
    if (!input || room.value.kind !== "company") return
    try {
      await $fetch<MessageAccepted>("/api/agent-company/messages", {
        method: "POST",
        body: {
          request_id: input.requestID,
          body: input.body.trim(),
          target: { kind: "board" },
          mentions: [
            ...input.mentions.map(agentID => ({ kind: "agent" as const, agent_id: agentID })),
            ...input.roles.map(role => ({ kind: "role" as const, role })),
          ],
          resources: input.resources,
          ...(input.replyToID ? { reply_to: input.replyToID } : {}),
          intent_override: "execute",
        },
      })
      const nextPromotions = new Map(promotionMessages.value)
      nextPromotions.delete(requestID)
      promotionMessages.value = nextPromotions
      sendResult.value = {
        requestID,
        status: "accepted",
        feedback: "已按你的纠正转为可执行目标并进入工作流。",
      }
      await refreshRoom()
    } catch (reason) {
      sendResult.value = {
        requestID,
        status: "failed",
        feedback: sendFailureText(errorStatus(reason)),
        canPromote: true,
      }
    }
  }

  async function react(messageID: string, emoji: string) {
    await $fetch("/api/agent-company/board-action", {
      method: "POST",
      body: { kind: "reaction", message_id: messageID, emoji },
    })
    await refresh()
  }

  async function vote(messageID: string, optionID: string) {
    await $fetch("/api/agent-company/board-action", {
      method: "POST",
      body: { kind: "vote", message_id: messageID, option_id: optionID },
    })
    await refresh()
  }

  async function createPoll(input: BoardroomPollInput) {
    const options = input.options.map(option => option.trim()).filter(Boolean)
    if (!input.question.trim() || options.length < 2 || loading.value) return
    loading.value = true
    actionMessage.value = ""
    try {
      await $fetch("/api/agent-company/board-action", {
        method: "POST",
        body: {
          kind: "poll",
          request_id: crypto.randomUUID(),
          question: input.question.trim(),
          options,
          multiple: input.multiple,
        },
      })
      await refreshRoom()
    } catch (reason) {
      actionMessage.value = errorText(reason, "投票未能发布。")
    } finally {
      loading.value = false
    }
  }

  async function markRead(sequence: number) {
    if (import.meta.client) localStorage.setItem(`agent-company:board-read:${room.value.id}`, String(sequence))
    if (room.value.kind !== "company") return
    try {
      await $fetch("/api/agent-company/board-action", {
        method: "POST",
        body: { kind: "read", sequence },
      })
    } catch (reason) {
      const detail = errorText(reason, "已读状态未能同步。")
      notice.value = /HTTP 404|Not Found/i.test(detail)
        ? "当前 Control Plane 未提供已读游标同步，消息内容不受影响。"
        : detail
    }
  }

  async function intervene(input: BoardroomInterventionInput) {
    if (!boardThreadID.value || !input.reason.trim() || loading.value) return
    loading.value = true
    actionMessage.value = ""
    try {
      await $fetch("/api/agent-company/founder-board/intervene", {
        method: "POST",
        body: {
          companyId: snapshot.value.company.id,
          idempotencyKey: crypto.randomUUID(),
          kind: input.kind,
          boardThreadId: boardThreadID.value,
          ...(input.projectID ? { projectId: input.projectID } : {}),
          reason: input.reason,
          ...(input.kind === "redefine_goal" ? { newGoal: input.newGoal } : {}),
          actorKind: "human",
          actorId: "local_user",
        },
      })
      actionMessage.value = "接管记录与停止请求已写入治理审计链。"
      await refreshRoom()
    } catch (reason) {
      actionMessage.value = errorText(reason, "接管记录未完成。")
    } finally {
      loading.value = false
    }
  }

  async function runShadow(input: BoardroomShadowInput) {
    if (!input.currentGoal.trim() || loading.value) return
    if (!input.projectID && snapshot.value.projects.length && !input.companyScopeConfirmed) {
      actionMessage.value = "请先选择一项工作；若确需综合多项工作，请明确确认公司范围。"
      return
    }
    loading.value = true
    actionMessage.value = ""
    const source = [...timeline.value].reverse().find(message => message.kind === "human") ?? timeline.value.at(-1)
    try {
      const result = await $fetch<FounderShadowDecision>("/api/agent-company/founder-shadow/run", {
        method: "POST",
        body: {
          context: {
            companyId: snapshot.value.company.id,
            scope: input.projectID ? { kind: "project", ref: input.projectID } : { kind: "company" },
            currentGoal: input.currentGoal,
            discussion: timeline.value.map(message => `${message.author}: ${message.body}`).join("\n") || "当前董事会尚无可用讨论记录。",
            authorizationBoundary: "影子模式只生成建议，不发言、不创建审批、不执行。",
            currentFacts: [
              `模型服务：${snapshot.value.company.provider}`,
              `审批策略：${snapshot.value.company.approvalPolicy}`,
            ],
            evidenceRefs: source ? [{ kind: "conversation", id: source.id, validity: "verified" }] : [],
          },
          createdBy: "local_user",
        },
      })
      actionMessage.value = result.status === "suggested"
        ? "影子建议已写入只读记录。"
        : `影子建议保持阻断：${result.blockReasons.join("、")}`
      await loadBoard()
    } catch (reason) {
      actionMessage.value = errorText(reason, "影子建议未写入。")
    } finally {
      loading.value = false
    }
  }

  async function compareShadow(input: BoardroomComparisonInput) {
    if (!input.shadowDecisionID || !input.actualDecisionID || !input.actualDecision.trim() || !input.rationale.trim() || loading.value) return
    loading.value = true
    actionMessage.value = ""
    try {
      await $fetch<FounderShadowComparison>("/api/agent-company/founder-shadow/compare", {
        method: "POST",
        body: {
          companyId: snapshot.value.company.id,
          shadowDecisionId: input.shadowDecisionID,
          actualDecision: input.actualDecision,
          actualDecisionRef: { kind: "decision", id: input.actualDecisionID, validity: "verified" },
          alignment: input.alignment,
          rationale: input.rationale,
          comparedBy: "local_user",
        },
      })
      actionMessage.value = "影子建议对照已写入，未冒充人工确认样本。"
      await loadBoard()
    } catch (reason) {
      actionMessage.value = errorText(reason, "影子建议对照未写入。")
    } finally {
      loading.value = false
    }
  }

  async function convergeAdvisor(input: BoardroomConvergenceInput) {
    if (!boardThreadID.value || !input.channelMessageID || !input.shadowDecisionID || !input.driAgentID || !input.subject.trim() || !input.context.trim() || loading.value) return
    loading.value = true
    actionMessage.value = ""
    try {
      const result = await $fetch<FounderAdvisorConvergence>("/api/agent-company/founder-board/converge", {
        method: "POST",
        body: {
          companyId: snapshot.value.company.id,
          idempotencyKey: crypto.randomUUID(),
          source: {
            boardThreadId: boardThreadID.value,
            ...(boardThread.value?.run?.id ? { boardRunId: boardThread.value.run.id } : {}),
            channelMessageId: input.channelMessageID,
            shadowDecisionId: input.shadowDecisionID,
          },
          subject: input.subject,
          context: input.context,
          driAgentId: input.driAgentID,
          timeoutAt: Date.now() + input.timeoutMinutes * 60_000,
          dissent: [],
        },
      })
      actionMessage.value = result.status === "intent_recorded"
        ? "顾问代理的决策意图已写入决策台账，未创建执行。"
        : `顾问代理保持未执行：${result.events.at(-1)?.reason ?? result.authority.reason}`
      await loadBoard()
    } catch (reason) {
      actionMessage.value = errorText(reason, "顾问代理未能形成决策意图。")
    } finally {
      loading.value = false
    }
  }

  function openPane(next: BoardroomPane) {
    pane.value = next
  }

  function closePane() {
    pane.value = { kind: "closed" }
  }

  function loadActiveRoom() {
    if (!mounted.value || !snapshot.value.company.id || loadedRoomKey.value === roomLoadKey.value) return
    loadedRoomKey.value = roomLoadKey.value
    void Promise.all([loadBoard(), loadProjectMessages()])
  }

  watch(projectID, () => {
    pane.value = { kind: "closed" }
    optimisticEvents.value = []
    pendingMessages.value = new Map()
    promotionMessages.value = new Map()
  })
  watch(roomLoadKey, loadActiveRoom, { flush: "post" })
  onMounted(() => {
    mounted.value = true
    loadActiveRoom()
  })

  return {
    snapshot,
    projection,
    pane,
    selectedThread,
    selectedDecision,
    selectedArtifact,
    governanceOptions,
    boardThreadID,
    projectMessagesLoading,
    loading: computed(() => loading.value || boardLoading.value),
    actionMessage,
    sendResult,
    loadBoard,
    refreshRoom,
    sendMessage,
    retryMessage,
    promoteMessage,
    react,
    vote,
    createPoll,
    markRead,
    intervene,
    runShadow,
    compareShadow,
    convergeAdvisor,
    openPane,
    closePane,
  }
}
