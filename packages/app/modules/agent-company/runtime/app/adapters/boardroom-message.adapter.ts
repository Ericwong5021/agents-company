import type { FounderBoardGovernanceProjection } from "@agents-company/sdk/v2/founder-os"
import type {
  CompanyAgent,
  CompanyMessage,
  CompanyProject,
  CompanyProjectMessage,
} from "../../shared/company-contract"
import type {
  BoardroomArtifactVM,
  BoardroomDecisionVM,
  BoardroomEventVM,
  BoardroomGovernanceVM,
  BoardroomParticipantVM,
  BoardroomRoomVM,
  BoardroomShadowDecisionVM,
} from "../types/boardroom"

const people: Record<string, string> = {
  CEO: "首席执行官",
  ceo: "首席执行官",
  CTO: "技术负责人",
  cto: "技术负责人",
  "Product Lead": "产品负责人",
  product_lead: "产品负责人",
  "board-product-lead": "产品负责人",
  "project-planner": "项目规划负责人",
}

const decisionStatuses: Record<string, string> = {
  suggested: "已生成建议",
  blocked: "已阻断",
  proposed: "已提出",
  awaiting_approval: "等待批准",
  accepted: "已接受",
  executed: "已执行",
  overridden: "已被人工推翻",
  failed: "执行失败",
  rolled_back: "已回滚",
  unknown: "状态未知",
}

const authorityLabels: Record<string, string> = {
  green: "绿色权限",
  yellow: "黄色权限",
  red: "红色权限",
}

const blockReasons: Record<string, string> = {
  snapshot_missing: "缺少创始人偏好快照",
  snapshot_checksum_invalid: "创始人偏好快照校验失败",
  context_insufficient: "当前上下文不足",
  asset_reference_missing: "缺少治理依据",
  asset_scope_forbidden: "治理依据超出可用范围",
  evidence_reference_invalid: "证据引用无效",
  model_unavailable: "模型服务不可用",
  model_timeout: "模型响应超时",
  model_output_missing: "模型没有返回建议",
  model_output_invalid: "模型建议格式无法识别",
}

export function boardroomPersonLabel(value?: string | null) {
  if (!value) return ""
  return people[value]
    ?? value
      .replace(/\s+independent reviewer\b/gi, "（独立复核）")
      .replace(/\bProject Charter\b/gi, "项目章程")
      .replace(/\bCharter\b/gi, "工作章程")
}

export function boardroomDecisionStatus(value?: string | null) {
  return decisionStatuses[value ?? "unknown"] ?? "状态未知"
}

export function boardroomAuthority(value?: string | null) {
  return authorityLabels[value ?? "unknown"] ?? "权限未判定"
}

export function boardroomBlockReason(value: string) {
  return blockReasons[value] ?? "治理条件未满足"
}

function participantStatus(agent: CompanyAgent, responding: Set<string>): BoardroomParticipantVM["status"] {
  if (agent.activity === "failed" || agent.attention === "urgent" || agent.interruptibility === "needs_intervention") return "waiting"
  if (responding.has(agent.id) || agent.activity === "recovering") return "thinking"
  if (agent.activity === "waiting") return "waiting"
  if (agent.activity === "working") return "working"
  if (agent.presence === "online") return "available"
  if (agent.activity === "interrupted") return "resting"
  return "offline"
}

function participantStatusLabel(agent: CompanyAgent, responding: Set<string>) {
  if (agent.activity === "failed") return agent.risk || "执行失败"
  if (agent.activity === "interrupted") return "执行已中断"
  if (agent.interruptibility === "needs_intervention") return agent.risk || "需要人工介入"
  if (agent.attention === "urgent") return agent.risk || "需要立即关注"
  if (responding.has(agent.id)) return "正在组织回复"
  if (agent.activity === "recovering") return "正在恢复"
  if (agent.activity === "waiting") return "等待继续"
  if (agent.activity === "working") return agent.subject || "正在处理工作"
  if (agent.presence === "online") return "在线"
  return "离线"
}

export function toBoardroomParticipants(agents: CompanyAgent[], messages: CompanyMessage[]) {
  const responding = new Set(messages.flatMap(message => message.deliveries
    .filter(delivery => ["pending", "triaging", "running", "held"].includes(delivery.status))
    .map(delivery => delivery.agentID)))
  const boardAgents = agents.filter(agent =>
    agent.id.startsWith("board-") || ["ceo", "cto", "product_lead", "CEO", "CTO", "Product Lead"].includes(agent.role ?? ""))
  return (boardAgents.length ? boardAgents : agents.slice(0, 3)).map((agent, index): BoardroomParticipantVM => ({
    id: agent.id,
    name: boardroomPersonLabel(agent.name),
    role: boardroomPersonLabel(agent.role) || "董事",
    initials: Array.from(agent.name)[0] ?? "?",
    tone: (["sky", "gold", "coral", "ink"] as const)[index % 4] ?? "sky",
    status: participantStatus(agent, responding),
    statusLabel: participantStatusLabel(agent, responding),
  }))
}

function deliveryActivity(message: CompanyMessage, agents: CompanyAgent[]) {
  const active = message.deliveries.filter(delivery => ["pending", "triaging", "running", "held"].includes(delivery.status))
  if (!active.length) return ""
  const names = active.map(delivery => agents.find(agent => agent.id === delivery.agentID)?.name ?? delivery.agentID)
  if (active.some(delivery => delivery.reason === "rate_limit_cooldown")) return `${names.join("、")} 遇到限流，保留未读并等待恢复…`
  if (active.some(delivery => delivery.status === "running")) return `${names.join("、")} 正在回复…`
  if (active.some(delivery => delivery.status === "held")) return `${names.join("、")} 正在重新阅读新消息…`
  return `${names.join("、")} 正在判断是否需要回应…`
}

export function toBoardroomMessages(messages: CompanyMessage[], agents: CompanyAgent[]): BoardroomEventVM[] {
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence)
  const byID = new Map(ordered.map(message => [message.id, message]))
  return ordered.map(message => {
    const reply = message.replyToID ? byID.get(message.replyToID) : undefined
    const base = {
      id: message.id,
      sequence: message.sequence,
      authorID: message.authorID,
      author: message.kind === "user" ? "你" : boardroomPersonLabel(message.author),
      role: message.kind === "user" ? "创始人" : boardroomPersonLabel(message.role),
      time: message.time,
      body: message.body,
      kind: message.kind === "user" ? "human" as const : message.kind,
      replyToID: message.replyToID,
      reply: reply ? { id: reply.id, author: boardroomPersonLabel(reply.author), body: reply.body } : undefined,
      mentions: message.mentions.map(mention =>
        agents.find(agent => agent.id === mention.value)?.name ?? boardroomPersonLabel(mention.value)),
      resources: message.resources,
      reactions: message.reactions,
      activity: deliveryActivity(message, agents),
    }
    if (message.messageKind === "poll" && message.poll) return {
      ...base,
      type: "poll" as const,
      poll: {
        question: message.poll.question,
        multiple: message.poll.multiple,
        closed: message.poll.closedAt !== undefined,
        options: message.poll.options.map(option => {
          const votes = message.pollVotes.find(vote => vote.optionID === option.id)
          return { id: option.id, label: option.label, count: votes?.count ?? 0, selected: votes?.selected ?? false }
        }),
      },
    }
    if (message.messageKind === "system" || message.kind === "system") return { ...base, type: "system" as const }
    return { ...base, type: "message" as const }
  })
}

export function toBoardroomProjectMessages(messages: CompanyProjectMessage[], agents: CompanyAgent[]): BoardroomEventVM[] {
  const agentByID = new Map(agents.map(agent => [agent.id, agent]))
  return [...messages]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((message, index) => {
      const agent = agentByID.get(message.author)
      const system = message.author === "系统" || Boolean(message.signalType)
      const base = {
        id: message.id,
        sequence: index + 1,
        createdAt: message.createdAt,
        authorID: agent?.id ?? message.author,
        author: agent ? boardroomPersonLabel(agent.name) : boardroomPersonLabel(message.author),
        role: agent ? boardroomPersonLabel(agent.role) : system ? "项目事件" : "项目成员",
        time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(message.createdAt),
        body: message.body,
        kind: system ? "system" as const : message.author === "你" ? "human" as const : "agent" as const,
        mentions: [],
        resources: [],
        reactions: [],
        activity: "",
      }
      if (system) return { ...base, type: "system" as const, signalType: message.signalType, detail: message.detail }
      return { ...base, type: "message" as const }
    })
}

export function dedupeBoardroomTimeline(events: BoardroomEventVM[]) {
  const byID = new Map<string, BoardroomEventVM>()
  events.forEach(event => byID.set(event.id, event))
  return [...byID.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

export function toBoardroomRoom(project?: CompanyProject): BoardroomRoomVM {
  if (!project) return {
    id: "company:board",
    kind: "company",
    title: "董事会群聊",
    topic: "目标、战略、重大升级与创始人决策",
    status: "进行中",
  }
  return {
    id: `project:${project.id}`,
    kind: "project",
    projectID: project.id,
    title: project.title,
    topic: "项目目标、协作、风险与交付",
    status: project.status,
  }
}

export function emptyBoardroomGovernance(): BoardroomGovernanceVM {
  return {
    error: "",
    principal: "AI 大东 · 创始人代理",
    advisorCanSpeak: false,
    mode: "状态不可用",
    authorization: "状态不可用",
    decisions: [],
    shadowDecisions: [],
    artifacts: [],
  }
}

export function toBoardroomGovernance(
  board: FounderBoardGovernanceProjection | null,
  projectID?: string,
): BoardroomGovernanceVM {
  if (!board) return emptyBoardroomGovernance()
  const decisions: BoardroomDecisionVM[] = board.decisions
    .filter(decision => !projectID || decision.scope.type === "project" && decision.scope.projectId === projectID)
    .map(decision => ({
      id: decision.id,
      title: decision.subject || "未命名治理决定",
      summary: decision.recommendation || decision.finalDecision || "暂无建议正文",
      status: boardroomDecisionStatus(decision.currentStatus),
      authority: boardroomAuthority(decision.authorityClass),
      confidence: decision.confidence ?? undefined,
      principleRefs: (decision.principleRefs ?? []).map(reference => `${reference.assetId} v${reference.version}`),
      evidenceRefs: (decision.evidenceRefs ?? []).map(reference => `${reference.kind} · ${reference.id}`),
      caseRefs: (decision.decisionCaseRefs ?? []).map(reference => `${reference.assetId} v${reference.version}`),
    }))
  const shadowDecisions: BoardroomShadowDecisionVM[] = board.shadow.decisions
    .filter(decision => !projectID || decision.scope.kind === "project" && decision.scope.ref === projectID)
    .map(decision => ({
      id: decision.id,
      title: decision.recommendation || "影子建议已被阻断",
      status: boardroomDecisionStatus(decision.status),
      authority: boardroomAuthority(decision.authorityClass),
      confidence: decision.confidence,
      blockReasons: decision.blockReasons.map(boardroomBlockReason),
      principleRefs: decision.principleRefs.map(reference => `${reference.assetId} v${reference.version}`),
      evidenceRefs: decision.evidenceRefs.map(reference => `${reference.kind} · ${reference.id} · ${reference.validity}`),
      missingInformation: decision.missingInformation,
    }))
  const artifacts: BoardroomArtifactVM[] = board.assets
    .filter(asset => !projectID || asset.scope.kind === "company" || asset.scope.kind === "project" && asset.scope.ref === projectID)
    .map(asset => ({
      id: asset.id,
      version: asset.version,
      title: asset.type,
      meta: `${asset.authority} · ${asset.status} · v${asset.version}`,
      content: asset.content,
    }))
  const modes: Record<string, string> = {
    off: "关闭",
    shadow: "影子建议",
    advisor: "顾问建议",
    "green-delegated": "绿色委托",
    "yellow-delegated": "黄色委托",
  }
  const authorizations: Record<string, string> = {
    authorized: "已授权",
    not_confirmed: "未确认授权",
    unavailable: "状态不可用",
  }
  return {
    error: "",
    principal: board.principal.displayName || "AI 大东 · 创始人代理",
    advisorCanSpeak: board.advisorCanSpeak,
    mode: modes[board.mode.effective.founderTwinMode ?? "off"] ?? board.mode.effective.founderTwinMode ?? "关闭",
    authorization: authorizations[board.authorization.status ?? "unavailable"] ?? board.authorization.status ?? "状态不可用",
    decisions,
    shadowDecisions,
    artifacts,
  }
}
