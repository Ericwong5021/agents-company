import type { ComposerResource } from "../../shared/company-composer"

export type BoardroomRoomVM = {
  id: string
  kind: "company" | "project"
  title: string
  topic: string
  status: string
  projectID?: string
}

export type BoardroomParticipantVM = {
  id: string
  name: string
  role: string
  initials: string
  tone: "sky" | "coral" | "gold" | "ink"
  status: "available" | "working" | "thinking" | "waiting" | "resting" | "offline"
  statusLabel: string
}

export type BoardroomReactionVM = {
  emoji: string
  count: number
  reacted: boolean
}

export type BoardroomReplyVM = {
  id: string
  author: string
  body: string
}

export type BoardroomEventBaseVM = {
  id: string
  sequence: number
  createdAt?: number
  authorID: string
  author: string
  role: string
  time: string
  body: string
  kind: "agent" | "human" | "system"
  replyToID?: string
  reply?: BoardroomReplyVM
  mentions: string[]
  resources: { kind: string; label: string }[]
  reactions: BoardroomReactionVM[]
  activity: string
  deliveryStatus?: "sending" | "failed"
}

export type BoardroomTextEventVM = BoardroomEventBaseVM & {
  type: "message"
}

export type BoardroomSystemEventVM = BoardroomEventBaseVM & {
  type: "system"
  signalType?: string
  detail?: string
}

export type BoardroomPollEventVM = BoardroomEventBaseVM & {
  type: "poll"
  poll: {
    question: string
    multiple: boolean
    closed: boolean
    options: { id: string; label: string; count: number; selected: boolean }[]
  }
}

export type BoardroomEventVM = BoardroomTextEventVM | BoardroomSystemEventVM | BoardroomPollEventVM

export type BoardroomDecisionVM = {
  id: string
  title: string
  summary: string
  status: string
  authority: string
  confidence?: number
  principleRefs: string[]
  evidenceRefs: string[]
  caseRefs: string[]
}

export type BoardroomShadowDecisionVM = {
  id: string
  title: string
  status: string
  authority: string
  confidence?: number
  blockReasons: string[]
  principleRefs: string[]
  evidenceRefs: string[]
  missingInformation: string[]
}

export type BoardroomArtifactVM = {
  id: string
  version: number
  title: string
  meta: string
  content: string
}

export type BoardroomGovernanceVM = {
  error: string
  principal: string
  advisorCanSpeak: boolean
  mode: string
  authorization: string
  decisions: BoardroomDecisionVM[]
  shadowDecisions: BoardroomShadowDecisionVM[]
  artifacts: BoardroomArtifactVM[]
}

export type BoardroomProjection = {
  room: BoardroomRoomVM
  participants: BoardroomParticipantVM[]
  timeline: BoardroomEventVM[]
  governance: BoardroomGovernanceVM
  responding: BoardroomParticipantVM[]
  connection: string
  error: string
  notice: string
}

export type BoardroomPane =
  | { kind: "closed" }
  | { kind: "info" }
  | { kind: "thread"; messageID: string }
  | { kind: "governance"; section?: "shadow" | "intervention" }
  | { kind: "decision"; decisionID: string }
  | { kind: "artifact"; artifactID: string; version: number }

export type BoardroomSendInput = {
  requestID: string
  body: string
  mentions: string[]
  roles: ("ceo" | "cto" | "product_lead")[]
  resources: ComposerResource[]
  intent: "auto" | "execute" | "discuss"
  replyToID?: string
}

export type BoardroomSendResult = {
  requestID: string
  status: "accepted" | "failed"
  feedback: string
  canPromote?: boolean
}

export type BoardroomPollInput = {
  question: string
  options: string[]
  multiple: boolean
}

export type BoardroomInterventionInput = {
  kind: "takeover" | "pause" | "correct" | "reject" | "redefine_goal"
  projectID?: string
  reason: string
  newGoal?: string
}

export type BoardroomShadowInput = {
  projectID?: string
  currentGoal: string
  companyScopeConfirmed: boolean
}

export type BoardroomComparisonInput = {
  shadowDecisionID: string
  actualDecisionID: string
  actualDecision: string
  alignment: "match" | "partial" | "mismatch"
  rationale: string
}

export type BoardroomConvergenceInput = {
  shadowDecisionID: string
  channelMessageID: string
  driAgentID: string
  subject: string
  context: string
  timeoutMinutes: number
}
