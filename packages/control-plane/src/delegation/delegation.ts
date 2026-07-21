import { Context, Effect, Deferred, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { spawnRef } from "@/actor/spawn-ref"
import { AgentMessage } from "@/agent-message/agent-message"
import * as Admission from "@/admission/admission"
import { CompanyAgent } from "@/company-agent/company-agent"
import * as Reputation from "@/reputation/reputation"
import { TaskRegistry } from "@/task/registry"
import { Identifier } from "@/id/id"
import { AuditEvent } from "@/audit-event/audit-event"
import { TrustDial } from "@/trust-dial/trust-dial"
import { stringifyFrontMatter } from "@/workspace/front-matter"
import { workspaceRoot } from "@/workspace/workspace"
import { canDelegate, parseOrgLayer, OrgLayer, MAX_DELEGATION_DEPTH } from "./primitives"
import type { SubTask, DelegationResult, AdmissionResult } from "./schema"
import type { AdmissionResult as GradedAdmissionResult, Submission } from "@/admission/schema"
import type { ReputationInfo } from "@/reputation/schema"
import type { SessionID } from "@/session/schema"
import type { Task } from "@/task/schema"
import { Log } from "@/util"

const log = Log.create({ service: "delegation" })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum fundamentally different approaches before escalation is mandatory. */
export const MAX_APPROACH_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// JSON schemas for structured LLM output
// ---------------------------------------------------------------------------

const DECOMPOSE_SCHEMA = {
  type: "object" as const,
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          parentKey: { type: "string" },
          summary: { type: "string" },
          acceptanceCriteria: { type: "string" },
          suggestedAgent: { type: "string" },
          workType: { type: "string", enum: ["coding", "decision", "research", "writing", "design", "analysis"] },
          role: { type: "string" },
          capabilityPacks: { type: "array", items: { type: "string" } },
          decisionScope: { type: "array", items: { type: "string" } },
          resourceScope: { type: "array", items: { type: "string" } },
          modelGroup: { type: "string", enum: ["standard", "lite"] },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "acceptanceCriteria"],
      },
    },
  },
  required: ["subtasks"],
}

const ADMIT_SCHEMA = {
  type: "object" as const,
  properties: {
    accepted: { type: "boolean" },
    findings: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["accepted", "findings"],
}

const BOARD_DECISION_SCHEMA = {
  type: "object" as const,
  properties: {
    decision: {
      type: "string",
      enum: ["accept_with_limitations", "relax_standards", "supply_context", "terminal_failure"],
    },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
}

// ---------------------------------------------------------------------------
// Orchestration input types
// ---------------------------------------------------------------------------

export interface DecomposeInput {
  /** The high-level goal to decompose into sub-tasks. */
  readonly goal: string
  /** Optional context (constraints, background, prior work). */
  readonly context?: string
  /** Session in which to spawn the decomposition actor. */
  readonly sessionID: string
  /** The agent performing the decomposition. */
  readonly delegatorAgentID: string
  /** Session Agent template used to execute the decomposition actor. */
  readonly actorAgentType?: string
}

export interface DelegateSubtasksInput {
  /** Sub-tasks produced by decompose. */
  readonly subTasks: readonly SubTask[]
  /** The agent delegating the work. */
  readonly delegatorAgentID: string
  /** Session for spawning child actors. */
  readonly sessionID: string
  /** Root need ID threading the delegation chain. */
  readonly rootNeedID: string
  /** Current delegation depth. */
  readonly depth: number
  /** Optional thread ID for the conversation. */
  readonly threadID?: string
}

export interface AdmitResultInput {
  /** The original delegation request message. */
  readonly delegationMessage: AgentMessage.Info
  /** The result produced by the delegated actor. */
  readonly result: string
  /** Session for spawning the evaluation actor. */
  readonly sessionID: string
}

export interface SubmitForAdmissionInput {
  /** The original delegation request message. */
  readonly delegationMessage: AgentMessage.Info
  /** Structured submission from the assignee. */
  readonly submission: Submission
}

export interface SubmitForAdmissionResult {
  readonly accepted: boolean
  readonly admission: GradedAdmissionResult
  readonly reply: AgentMessage.Info
  readonly reputation: ReputationInfo
  readonly trust: TrustDial.Decision
}

export interface ResolveProposalInput {
  readonly proposalMessage: AgentMessage.Info
  readonly resolverAgentID: string
  readonly decision: "adopt" | "shelve" | "reject"
  readonly reason: string
  readonly sessionID: SessionID
  readonly taskSummary?: string
  readonly parentTaskID?: string
}

export interface ResolveProposalResult {
  readonly decision: "adopt" | "shelve" | "reject"
  readonly reply: AgentMessage.Info
  readonly task?: Task
}

export interface DecisionOption {
  readonly id: string
  readonly title: string
}

export interface AdvisoryVoteInput {
  readonly agentID: string
  readonly optionID: string
  readonly rationale?: string
}

export interface WeightedAdvisoryVote {
  readonly agentID: string
  readonly agentName: string
  readonly optionID: string
  readonly rationale?: string
  readonly reputationScore: number
  readonly weight: number
}

export interface RecordDecisionInput {
  readonly domain: string
  readonly question: string
  readonly driAgentID: string
  readonly selectedOptionID: string
  readonly options: readonly DecisionOption[]
  readonly rationale: string
  readonly votes?: readonly AdvisoryVoteInput[]
  readonly rootNeedID?: string
  readonly currentRound?: number
  readonly maxRounds?: number
}

export interface RecordDecisionResult {
  readonly decisionID: string
  readonly selectedOptionID: string
  readonly minutesPath: string
  readonly advisoryTotals: Readonly<Record<string, number>>
  readonly weightedVotes: readonly WeightedAdvisoryVote[]
  readonly dissent: readonly WeightedAdvisoryVote[]
}

export interface EscalateInput {
  /** The original delegation request message. */
  readonly originalMessage: AgentMessage.Info
  /** The failure result or error. */
  readonly result: string
  /** How many fundamentally different approaches have been tried. */
  readonly attemptCount: number
  /** Record of each approach attempted. */
  readonly approaches: readonly ApproachAttempt[]
  /** Session for spawning actors. */
  readonly sessionID: string
}

export type EscalateResult =
  | { readonly action: "retry"; readonly actorID: string; readonly messageID: string }
  | {
      readonly action: "escalated"
      readonly escalationMessageId: string
      readonly superiorId: string
      readonly superiorName: string
    }
  | { readonly action: "failed_project"; readonly reason: string }

// ---------------------------------------------------------------------------
// Existing types
// ---------------------------------------------------------------------------

/**
 * Record of a single approach attempted by an agent to solve a task.
 * Collected during failure escalation to inform the superior about what
 * was already tried and what was learned.
 */
export interface ApproachAttempt {
  readonly approach: string
  readonly description: string
  readonly findings: string
  readonly timestamp: number
}

export interface HandleFailureInput {
  readonly agentId: string
  readonly originalGoal: string
  readonly rootNeedID: string
  readonly originalMessageId: string
  readonly error: string
  readonly attemptCount: number
  readonly approaches: readonly ApproachAttempt[]
  readonly depth?: number
  readonly threadID?: string
}

export type HandleFailureResult =
  | {
      readonly action: "retry"
      readonly retryInstruction: string
      readonly nextAttemptCount: number
    }
  | {
      readonly action: "escalate"
      readonly escalationMessageId: string
      readonly superiorId: string
      readonly superiorName: string
    }
  | {
      readonly action: "terminal_failure"
      readonly reason: string
      readonly escalationMessageId: string
    }

export interface FailureBubbleInput {
  readonly receiverId: string
  readonly rootNeedID: string
  readonly originalMessageId: string
  readonly escalationBody: string
  readonly error: string
  readonly approaches: readonly ApproachAttempt[]
  readonly depth?: number
  readonly threadID?: string
}

export type BubbleDecision =
  | { readonly action: "accept_with_limitations"; readonly limitations: string }
  | { readonly action: "relax_standards"; readonly relaxedCriteria: string }
  | { readonly action: "supply_context"; readonly additionalContext: string }
  | { readonly action: "reassign"; readonly newAgentId: string; readonly reason: string }
  | { readonly action: "escalate_further" }
  | { readonly action: "terminal_failure"; readonly reason: string }

export interface ChainNode {
  readonly message: AgentMessage.Info
  readonly children: readonly ChainNode[]
}

export interface FullChainReport {
  readonly rootNeedID: string
  readonly generatedAt: number
  readonly maxDepth: number
  readonly totalMessages: number
  readonly uniqueAgents: number
  readonly timeline: {
    readonly started: number
    readonly ended: number
    readonly durationMs: number
  }
  readonly levels: readonly LevelSummary[]
  readonly escalations: readonly EscalationEvent[]
  readonly attempts: readonly ApproachAttempt[]
  readonly outcome: ChainOutcome
  readonly messages: readonly AgentMessage.Info[]
}

export interface LevelSummary {
  readonly depth: number
  readonly messageCount: number
  readonly agents: readonly string[]
}

export interface EscalationEvent {
  readonly fromAgent: string
  readonly toAgent: string
  readonly reason: string
  readonly timestamp: number
  readonly approaches: readonly ApproachAttempt[]
}

export type ChainOutcome =
  | { readonly status: "success"; readonly summary: string }
  | { readonly status: "partial"; readonly summary: string }
  | { readonly status: "failed"; readonly summary: string }
  | { readonly status: "in_progress" }

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildDecomposePrompt(goal: string, context?: string): string {
  const parts = [
    "You are a task decomposition specialist. Break down the following goal into clear, independently executable sub-tasks.",
    "",
    "## Goal",
    goal,
  ]
  if (context) {
    parts.push("", "## Context", context)
  }
  parts.push(
    "",
    "## Output Requirements",
    "For each sub-task, provide:",
    "- key: A unique lowercase identifier; parents and dependencies must appear earlier in the array",
    "- parentKey: (optional) The parent task key for the visible execution tree",
    "- summary: A clear, actionable description (1-2 sentences)",
    "- acceptanceCriteria: A specific, testable criterion for completion",
    "- suggestedAgent: (optional) The best agent ID or name for this task",
    "- workType: One of coding, decision, research, writing, design, analysis",
    "- role: The temporary execution role required for this task; never use a permanent fixed team title",
    "- capabilityPacks: Immutable capability references required by the role",
    "- decisionScope: Decisions this task exclusively owns",
    "- resourceScope: Files, datasets, systems, or artifact areas this task may write",
    "- modelGroup: standard for judgment-heavy work or lite for bounded deterministic work",
    "- riskLevel: low, medium, or high",
    "- dependsOn: Keys that must be independently accepted before this task starts",
    "",
    "Produce 2-6 domain-neutral sub-tasks ordered by dependency. Use at most one coding task. Do not force software delivery when the goal only needs research, analysis, design, a decision, or a document.",
  )
  return parts.join("\n")
}

function buildAdmitPrompt(taskSummary: string, result: string): string {
  return [
    "You are a quality evaluation agent in focused-attention mode.",
    "Evaluate whether the following result satisfies the original task criteria.",
    "",
    "## Original Task",
    taskSummary,
    "",
    "## Result to Evaluate",
    result,
    "",
    "## Evaluation Requirements",
    "- Determine if the result is acceptable (accepted: true/false)",
    "- If not accepted, list specific gaps or issues in findings",
    "- Be strict but fair — partial completion is not acceptance",
    "- Focus only on whether the deliverable meets the stated criteria",
  ].join("\n")
}

function buildSubtaskPrompt(subTask: SubTask): string {
  return ["## Task", subTask.summary, "", "## Acceptance Criteria", subTask.acceptanceCriteria].join("\n")
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function resolveTarget(
  suggested: string | undefined,
  delegatorId: string,
  agents: CompanyAgent.Info[],
): CompanyAgent.Info | undefined {
  if (suggested) {
    const byId = agents.find((a) => a.id === suggested)
    if (byId) return byId
    const byName = agents.find((a) => a.name.toLowerCase() === suggested.toLowerCase())
    if (byName) return byName
  }
  // Fallback: first agent at a lower org layer the delegator can reach
  const delegator = agents.find((a) => a.id === delegatorId)
  if (!delegator) return undefined
  return agents.find((a) => a.id !== delegatorId && canDelegate(delegator.org_layer, a.org_layer))
}

// ---------------------------------------------------------------------------
// Internal helpers (existing)
// ---------------------------------------------------------------------------

function buildRetryInstruction(
  originalGoal: string,
  error: string,
  approaches: readonly ApproachAttempt[],
  currentAttempt: number,
): string {
  const previousApproaches =
    approaches.length > 0 ? approaches.map((a) => `- ${a.approach}: ${a.findings}`).join("\n") : "(none recorded)"

  return [
    `## Retry Instruction (Attempt ${currentAttempt + 1} of ${MAX_APPROACH_ATTEMPTS})`,
    "",
    `**Original goal**: ${originalGoal}`,
    "",
    `**Previous error**: ${error}`,
    "",
    `**Approaches already tried**:\n${previousApproaches}`,
    "",
    "**Requirement**: You must try a FUNDAMENTALLY DIFFERENT approach. Do not retry the same",
    "strategy with minor variations. Consider:",
    "- A different algorithm or technique",
    "- A different decomposition of the problem",
    "- A different tool or library",
    "- A different level of abstraction",
    "- Consulting different source material",
    "",
    "After this attempt, if still blocked, the task will be escalated to your superior.",
  ].join("\n")
}

function buildEscalationBody(
  originalGoal: string,
  error: string,
  approaches: readonly ApproachAttempt[],
  failingAgentName: string,
  superiorName: string,
): string {
  const approachSummaries =
    approaches.length > 0
      ? approaches
          .map(
            (a, i) =>
              `### Approach ${i + 1}: ${a.approach}\n` +
              `**Description**: ${a.description}\n` +
              `**Findings**: ${a.findings}\n` +
              `**Timestamp**: ${new Date(a.timestamp).toISOString()}`,
          )
          .join("\n\n")
      : "(no approaches recorded)"

  return [
    `## Escalation from ${failingAgentName} to ${superiorName}`,
    "",
    `**Original goal**: ${originalGoal}`,
    "",
    `**Final error**: ${error}`,
    "",
    `**Approaches attempted (${approaches.length})**:\n${approachSummaries}`,
    "",
    "**What was learned**:",
    "- The approaches above exhausted the agent's available strategies",
    "- The error pattern suggests the problem may require broader context or different authority",
    "",
    "**Requested action**: Please review the approaches and decide whether to:",
    "1. Accept the result with known limitations",
    "2. Relax the quality/scope criteria",
    "3. Supply additional context or resources",
    "4. Reassign to a different agent",
    "5. Escalate further up the hierarchy",
  ].join("\n")
}

function parseApproachesFromBody(body: string): ApproachAttempt[] {
  const approaches: ApproachAttempt[] = []
  const sectionRegex = /### Approach \d+: (.+?)\n([\s\S]*?)(?=### Approach \d+:|$)/g
  let match

  while ((match = sectionRegex.exec(body)) !== null) {
    const approachName = match[1].trim()
    const section = match[2]

    const descMatch = section.match(/\*\*Description\*\*:\s*(.+?)(?:\n|$)/)
    const findingsMatch = section.match(/\*\*Findings\*\*:\s*(.+?)(?:\n|$)/)
    const tsMatch = section.match(/\*\*Timestamp\*\*:\s*(.+?)(?:\n|$)/)

    approaches.push({
      approach: approachName,
      description: descMatch?.[1]?.trim() ?? "(not specified)",
      findings: findingsMatch?.[1]?.trim() ?? "(not specified)",
      timestamp: tsMatch ? new Date(tsMatch[1].trim()).getTime() : Date.now(),
    })
  }

  return approaches
}

function determineOutcome(
  messages: readonly AgentMessage.Info[],
  agentMap: Map<string, CompanyAgent.Info>,
): ChainOutcome {
  const terminalFailures = messages.filter((m) => m.kind === "reply" && m.outcome === "failed")
  if (terminalFailures.length > 0) {
    const lastFailure = terminalFailures[terminalFailures.length - 1]
    return {
      status: "failed",
      summary: `Terminal failure at ${agentMap.get(lastFailure.fromAgentID)?.name ?? lastFailure.fromAgentID}: ${lastFailure.body.slice(0, 200)}`,
    }
  }

  const successReplies = messages.filter((m) => m.kind === "reply" && m.outcome === "success")
  const escalatedReplies = messages.filter((m) => m.kind === "reply" && m.outcome === "escalated")

  if (escalatedReplies.length > 0 && successReplies.length === 0) {
    return { status: "in_progress" }
  }

  if (successReplies.length > 0 && escalatedReplies.length > 0) {
    return { status: "partial", summary: `Resolved after ${escalatedReplies.length} escalation(s).` }
  }

  if (successReplies.length > 0) {
    return { status: "success", summary: `Completed with ${successReplies.length} successful reply(ies).` }
  }

  return { status: "in_progress" }
}

function formatReportAsMarkdown(report: FullChainReport): string {
  const lines: string[] = []

  lines.push(`# Delegation Chain Report`)
  lines.push("")
  lines.push(`**Root Need**: \`${report.rootNeedID}\``)
  lines.push(`**Generated**: ${new Date(report.generatedAt).toISOString()}`)
  lines.push("")

  lines.push("## Summary")
  lines.push("")
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total Messages | ${report.totalMessages} |`)
  lines.push(`| Unique Agents | ${report.uniqueAgents} |`)
  lines.push(`| Max Depth | ${report.maxDepth} |`)
  lines.push(`| Duration | ${formatDuration(report.timeline.durationMs)} |`)
  lines.push(`| Escalations | ${report.escalations.length} |`)
  lines.push(`| Approach Attempts | ${report.attempts.length} |`)
  lines.push(`| Outcome | ${report.outcome.status} |`)
  lines.push("")

  if (report.outcome.status !== "in_progress") {
    lines.push(`**Outcome Summary**: ${report.outcome.summary ?? "(none)"}`)
    lines.push("")
  }

  lines.push("## Delegation Levels")
  lines.push("")
  for (const level of report.levels) {
    lines.push(`### Depth ${level.depth}`)
    lines.push(`- **Messages**: ${level.messageCount}`)
    lines.push(`- **Agents**: ${level.agents.join(", ")}`)
    lines.push("")
  }

  if (report.escalations.length > 0) {
    lines.push("## Escalations")
    lines.push("")
    for (let i = 0; i < report.escalations.length; i++) {
      const esc = report.escalations[i]
      lines.push(`### Escalation ${i + 1}`)
      lines.push(`- **From**: ${esc.fromAgent}`)
      lines.push(`- **To**: ${esc.toAgent}`)
      lines.push(`- **Time**: ${new Date(esc.timestamp).toISOString()}`)
      lines.push(`- **Reason**: ${esc.reason.slice(0, 300)}`)
      if (esc.approaches.length > 0) {
        lines.push(`- **Approaches tried**: ${esc.approaches.map((a) => a.approach).join(", ")}`)
      }
      lines.push("")
    }
  }

  if (report.attempts.length > 0) {
    lines.push("## All Approach Attempts")
    lines.push("")
    for (let i = 0; i < report.attempts.length; i++) {
      const attempt = report.attempts[i]
      lines.push(`${i + 1}. **${attempt.approach}**: ${attempt.findings}`)
    }
    lines.push("")
  }

  lines.push("## Message Timeline")
  lines.push("")
  lines.push("| # | Time | Kind | From | To | Depth | Outcome |")
  lines.push("|---|------|------|------|----|-------|---------|")
  for (let i = 0; i < report.messages.length; i++) {
    const msg = report.messages[i]
    const time = new Date(msg.time.created).toISOString().split("T")[1].split(".")[0]
    lines.push(
      `| ${i + 1} | ${time} | ${msg.kind} | ${msg.fromAgentID} | ${msg.toAgentID} | ${msg.depth} | ${msg.outcome ?? "-"} |`,
    )
  }
  lines.push("")

  return lines.join("\n")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`
  return `${(ms / 3_600_000).toFixed(1)}hr`
}

// ---------------------------------------------------------------------------
// Internal implementations (existing logic, parameterized on services)
// ---------------------------------------------------------------------------

function handleFailureImpl(
  input: HandleFailureInput,
  companyAgentSvc: CompanyAgent.Interface,
  agentMessageSvc: AgentMessage.Interface,
): Effect.Effect<HandleFailureResult, Error> {
  return Effect.gen(function* () {
    const agents = yield* companyAgentSvc.list()
    const failingAgent = agents.find((a) => a.id === input.agentId)
    if (!failingAgent) {
      return yield* Effect.fail(new Error(`handleFailure: agent "${input.agentId}" not found`))
    }

    if (input.attemptCount < MAX_APPROACH_ATTEMPTS) {
      const retryInstruction = buildRetryInstruction(
        input.originalGoal,
        input.error,
        input.approaches,
        input.attemptCount,
      )
      return { action: "retry" as const, retryInstruction, nextAttemptCount: input.attemptCount + 1 }
    }

    if (!failingAgent.reports_to) {
      const escalationBody = buildEscalationBody(
        input.originalGoal,
        input.error,
        input.approaches,
        failingAgent.name,
        "(no superior — terminal failure at top of hierarchy)",
      )
      const msg = yield* agentMessageSvc.create({
        fromAgentID: input.agentId,
        toAgentID: input.agentId,
        kind: "reply",
        body: escalationBody,
        inReplyTo: input.originalMessageId,
        threadID: input.threadID,
        rootNeedID: input.rootNeedID,
        depth: input.depth ?? 0,
        outcome: "failed",
      })
      yield* AuditEvent.record({
        rootNeedID: input.rootNeedID,
        kind: "escalation",
        action: "terminal_failure",
        actorAgentID: input.agentId,
        targetAgentID: input.agentId,
        subjectID: msg.id,
        subjectType: "agent_message",
        metadata: {
          attemptCount: input.attemptCount,
          approachCount: input.approaches.length,
          originalMessageId: input.originalMessageId,
        },
      })
      return {
        action: "terminal_failure" as const,
        reason: `Agent ${failingAgent.name} has no superior — terminal failure at top of hierarchy`,
        escalationMessageId: msg.id,
      }
    }

    const superior = agents.find((a) => a.id === failingAgent.reports_to)
    if (!superior) {
      return yield* Effect.fail(
        new Error(`handleFailure: superior agent "${failingAgent.reports_to}" not found for "${input.agentId}"`),
      )
    }

    const escalationBody = buildEscalationBody(
      input.originalGoal,
      input.error,
      input.approaches,
      failingAgent.name,
      superior.name,
    )

    const msg = yield* agentMessageSvc.create({
      fromAgentID: input.agentId,
      toAgentID: superior.id,
      kind: "reply",
      body: escalationBody,
      inReplyTo: input.originalMessageId,
      threadID: input.threadID,
      rootNeedID: input.rootNeedID,
      depth: input.depth ?? 0,
      outcome: "escalated",
    })
    yield* AuditEvent.record({
      rootNeedID: input.rootNeedID,
      kind: "escalation",
      action: "escalated",
      actorAgentID: input.agentId,
      targetAgentID: superior.id,
      subjectID: msg.id,
      subjectType: "agent_message",
      metadata: {
        attemptCount: input.attemptCount,
        approachCount: input.approaches.length,
        originalMessageId: input.originalMessageId,
      },
    })

    return {
      action: "escalate" as const,
      escalationMessageId: msg.id,
      superiorId: superior.id,
      superiorName: superior.name,
    }
  })
}

function evaluateFailureBubbleImpl(
  input: FailureBubbleInput,
  companyAgentSvc: CompanyAgent.Interface,
  _agentMessageSvc: AgentMessage.Interface,
): Effect.Effect<BubbleDecision[], Error> {
  return Effect.gen(function* () {
    const agents = yield* companyAgentSvc.list()
    const receiver = agents.find((a) => a.id === input.receiverId)
    if (!receiver) {
      return yield* Effect.fail(new Error(`evaluateFailureBubble: receiver agent "${input.receiverId}" not found`))
    }

    const receiverLayer = receiver.org_layer
      ? (parseOrgLayer(receiver.org_layer) ?? OrgLayer.execution)
      : OrgLayer.execution

    const availableDecisions: BubbleDecision[] = []

    availableDecisions.push({
      action: "accept_with_limitations",
      limitations: "Accept the partial result with documented limitations.",
    })
    availableDecisions.push({
      action: "relax_standards",
      relaxedCriteria: "Lower quality bar or scope to make the result acceptable.",
    })
    availableDecisions.push({
      action: "supply_context",
      additionalContext: "Provide additional information, resources, or constraints.",
    })

    const subordinates = agents.filter(
      (a) =>
        a.reports_to === input.receiverId && a.id !== input.receiverId && canDelegate(receiver.org_layer, a.org_layer),
    )
    if (subordinates.length > 0) {
      availableDecisions.push({
        action: "reassign",
        newAgentId: subordinates[0].id,
        reason: `Reassign to a different subordinate (e.g. ${subordinates[0].name}).`,
      })
    }

    if (receiverLayer > OrgLayer.board && receiver.reports_to) {
      availableDecisions.push({ action: "escalate_further" })
    }

    if (receiverLayer <= OrgLayer.board) {
      availableDecisions.push({
        action: "terminal_failure",
        reason: "Board-level decision: project cannot proceed with current constraints.",
      })
    }

    return availableDecisions
  })
}

function buildFullChainReportImpl(
  rootNeedID: string,
  agentMessageSvc: AgentMessage.Interface,
  companyAgentSvc: CompanyAgent.Interface,
): Effect.Effect<FullChainReport, Error> {
  return Effect.gen(function* () {
    const messages = yield* agentMessageSvc.listByRootNeed(rootNeedID)
    if (messages.length === 0) {
      return yield* Effect.fail(new Error(`buildFullChainReport: no messages found for rootNeedID "${rootNeedID}"`))
    }

    const agents = yield* companyAgentSvc.list()
    const agentMap = new Map<string, (typeof agents)[number]>(agents.map((a) => [a.id as string, a]))

    const uniqueAgentIds = new Set<string>()
    for (const msg of messages) {
      uniqueAgentIds.add(msg.fromAgentID)
      uniqueAgentIds.add(msg.toAgentID)
    }

    const timestamps = messages.map((m) => m.time.created)
    const started = timestamps.reduce((a, b) => Math.min(a, b), Infinity)
    const ended = timestamps.reduce((a, b) => Math.max(a, b), -Infinity)

    const byDepth = new Map<number, Set<string>>()
    let maxDepth = 0
    for (const msg of messages) {
      if (msg.depth > maxDepth) maxDepth = msg.depth
      if (!byDepth.has(msg.depth)) byDepth.set(msg.depth, new Set())
      byDepth.get(msg.depth)!.add(msg.fromAgentID)
      byDepth.get(msg.depth)!.add(msg.toAgentID)
    }

    const levels: LevelSummary[] = []
    for (const [depth, agentIds] of [...byDepth.entries()].sort(([a], [b]) => a - b)) {
      levels.push({
        depth,
        messageCount: messages.filter((m) => m.depth === depth).length,
        agents: [...agentIds].map((id) => agentMap.get(id)?.name ?? id),
      })
    }

    const escalations: EscalationEvent[] = []
    for (const msg of messages) {
      if (msg.kind === "reply" && msg.outcome === "escalated") {
        const fromAgent = agentMap.get(msg.fromAgentID)
        const toAgent = agentMap.get(msg.toAgentID)
        escalations.push({
          fromAgent: fromAgent?.name ?? msg.fromAgentID,
          toAgent: toAgent?.name ?? msg.toAgentID,
          reason: msg.body.slice(0, 500),
          timestamp: msg.time.created,
          approaches: parseApproachesFromBody(msg.body),
        })
      }
    }

    const attempts: ApproachAttempt[] = []
    for (const escalation of escalations) {
      attempts.push(...escalation.approaches)
    }

    const sortedByTime = [...messages].sort((a, b) => a.time.created - b.time.created)
    const outcome = determineOutcome(messages, agentMap)

    return {
      rootNeedID,
      generatedAt: Date.now(),
      maxDepth,
      totalMessages: messages.length,
      uniqueAgents: uniqueAgentIds.size,
      timeline: { started, ended, durationMs: ended - started },
      levels,
      escalations,
      attempts,
      outcome,
      messages: sortedByTime,
    }
  })
}

function saveChainReportImpl(report: FullChainReport): Effect.Effect<string> {
  return Effect.gen(function* () {
    const minutesDir = path.join(workspaceRoot(), "public", "minutes")
    yield* Effect.promise(() => fs.mkdir(minutesDir, { recursive: true }))

    const date = new Date(report.generatedAt).toISOString().split("T")[0]
    const filename = `delegation-report-${date}-${report.rootNeedID.slice(-8)}.md`
    const filePath = path.join(minutesDir, filename)

    const content = formatReportAsMarkdown(report)

    yield* Effect.promise(() =>
      Bun.write(
        filePath,
        stringifyFrontMatter(
          {
            scope: "org",
            classification: "internal",
            owner: "system",
          },
          content,
        ),
      ),
    )

    return filePath
  })
}

function safeFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function saveDecisionMinutesImpl(input: {
  decisionID: string
  decision: RecordDecisionInput
  driName: string
  selectedOptionTitle: string
  advisoryTotals: Readonly<Record<string, number>>
  weightedVotes: readonly WeightedAdvisoryVote[]
  dissent: readonly WeightedAdvisoryVote[]
}): Effect.Effect<string> {
  return Effect.gen(function* () {
    const minutesDir = path.join(workspaceRoot(), "public", "minutes")
    yield* Effect.promise(() => fs.mkdir(minutesDir, { recursive: true }))

    const date = new Date().toISOString().split("T")[0]
    const filename = `decision-${date}-${safeFilenamePart(input.decision.domain) || "general"}-${input.decisionID.slice(-8)}.md`
    const filePath = path.join(minutesDir, filename)
    const options = input.decision.options
      .map((option) => `- ${option.id}: ${option.title} (advisory weight: ${input.advisoryTotals[option.id] ?? 0})`)
      .join("\n")
    const votes =
      input.weightedVotes.length === 0
        ? "_No advisory votes recorded._"
        : input.weightedVotes
            .map(
              (vote) =>
                `- ${vote.agentName} (${vote.agentID}) -> ${vote.optionID}, weight ${vote.weight}` +
                (vote.rationale ? `; ${vote.rationale}` : ""),
            )
            .join("\n")
    const dissent =
      input.dissent.length === 0
        ? "_No dissent recorded._"
        : input.dissent
            .map(
              (vote) =>
                `- ${vote.agentName} (${vote.agentID}) supported ${vote.optionID}` +
                (vote.rationale ? `: ${vote.rationale}` : ""),
            )
            .join("\n")

    yield* Effect.promise(() =>
      Bun.write(
        filePath,
        stringifyFrontMatter(
          {
            scope: "org",
            classification: "internal",
            owner: input.decision.driAgentID,
            updatedBy: input.decision.driAgentID,
          },
          [
            `# Decision: ${input.decision.question}`,
            "",
            `- Decision ID: ${input.decisionID}`,
            `- Domain: ${input.decision.domain}`,
            `- DRI: ${input.driName} (${input.decision.driAgentID})`,
            `- Selected: ${input.decision.selectedOptionID} — ${input.selectedOptionTitle}`,
            `- Root need: ${input.decision.rootNeedID ?? "n/a"}`,
            `- Debate round: ${input.decision.currentRound ?? "n/a"} / ${input.decision.maxRounds ?? "n/a"}`,
            "",
            "## Rationale",
            "",
            input.decision.rationale,
            "",
            "## Options",
            "",
            options,
            "",
            "## Advisory Votes",
            "",
            votes,
            "",
            "## Dissent",
            "",
            dissent,
            "",
          ].join("\n"),
        ),
      ),
    )

    return filePath
  })
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Decompose a goal into sub-tasks using an LLM actor with structured output. */
  readonly decompose: (input: DecomposeInput) => Effect.Effect<SubTask[], Error>
  /** Delegate sub-tasks to target agents: create messages + spawn actors. */
  readonly delegateSubtasks: (input: DelegateSubtasksInput) => Effect.Effect<DelegationResult[], Error>
  /** Evaluate a delegated result against its acceptance criteria (focused attention). */
  readonly admitResult: (input: AdmitResultInput) => Effect.Effect<AdmissionResult, Error>
  /** Grade a structured submission and create the corresponding reply message. */
  readonly submitForAdmission: (input: SubmitForAdmissionInput) => Effect.Effect<SubmitForAdmissionResult, Error>
  /** Resolve an upward proposal; adopted proposals become executable tasks. */
  readonly resolveProposal: (input: ResolveProposalInput) => Effect.Effect<ResolveProposalResult, Error>
  /** Record a DRI decision with reputation-weighted advisory input and minutes. */
  readonly recordDecision: (input: RecordDecisionInput) => Effect.Effect<RecordDecisionResult, Error>
  /** Handle admission failure: retry with a different approach or escalate to superior. */
  readonly escalate: (input: EscalateInput) => Effect.Effect<EscalateResult, Error>
  /** Low-level failure handler: returns retry instruction or escalation decision. */
  readonly handleFailure: (input: HandleFailureInput) => Effect.Effect<HandleFailureResult, Error>
  /** Evaluate available decisions when receiving a failure bubble. */
  readonly evaluateFailureBubble: (input: FailureBubbleInput) => Effect.Effect<BubbleDecision[], Error>
  /** Build a full-chain report for a delegation tree. */
  readonly buildFullChainReport: (rootNeedID: string) => Effect.Effect<FullChainReport, Error>
  /** Persist a chain report to workspace/public/minutes/. */
  readonly saveChainReport: (report: FullChainReport) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/Delegation") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentMessageSvc = yield* AgentMessage.Service
    const companyAgentSvc = yield* CompanyAgent.Service
    const admissionSvc = yield* Admission.Service
    const reputationSvc = yield* Reputation.Service
    const trustDialSvc = yield* TrustDial.Service
    const taskRegistrySvc = yield* TaskRegistry.Service

    // ---- decompose ----

    const decompose = Effect.fn("Delegation.decompose")(function* (input: DecomposeInput) {
      const actor = spawnRef.current
      if (!actor) {
        return yield* Effect.fail(new Error("Delegation.decompose: Actor service not initialized"))
      }

      const prompt = buildDecomposePrompt(input.goal, input.context)

      const spawned = yield* actor.spawn({
        mode: "subagent",
        sessionID: input.sessionID as any,
        agentType: input.actorAgentType ?? "general",
        task: prompt,
        context: "none",
        tools: "INHERIT",
        background: true,
        format: { type: "json_schema", schema: DECOMPOSE_SCHEMA, retryCount: 2 },
      })

      log.info("decompose: spawned decomposition actor", {
        actorID: spawned.actorID,
        delegator: input.delegatorAgentID,
      })

      const outcome = yield* Deferred.await(spawned.outcome)

      if (outcome.status !== "success" || !outcome.structured) {
        return yield* Effect.fail(
          new Error(
            `Delegation.decompose: actor failed — ${outcome.status === "failure" ? outcome.error : "cancelled"}`,
          ),
        )
      }

      const parsed = outcome.structured as { subtasks: SubTask[] }
      log.info("decompose: completed", { count: parsed.subtasks.length })
      return parsed.subtasks
    })

    // ---- delegateSubtasks ----

    const delegateSubtasks = Effect.fn("Delegation.delegateSubtasks")(function* (input: DelegateSubtasksInput) {
      const agents = yield* companyAgentSvc.list()
      const delegator = agents.find((a) => a.id === input.delegatorAgentID)
      if (!delegator) {
        return yield* Effect.fail(new Error(`delegateSubtasks: delegator "${input.delegatorAgentID}" not found`))
      }

      const results: DelegationResult[] = []

      for (const subTask of input.subTasks) {
        // 1. Resolve target agent
        const target = resolveTarget(subTask.suggestedAgent, input.delegatorAgentID, agents)
        if (!target) {
          log.warn("delegateSubtasks: no target agent found", { suggested: subTask.suggestedAgent })
          results.push({ messageID: "", actorID: "", status: "failed" })
          continue
        }

        // 2. Validate delegation depth
        if (input.depth >= MAX_DELEGATION_DEPTH) {
          log.warn("delegateSubtasks: max delegation depth exceeded", { depth: input.depth })
          results.push({ messageID: "", actorID: "", status: "failed" })
          continue
        }

        // 3. Validate org layer hierarchy
        if (input.delegatorAgentID === target.id) {
          log.warn("delegateSubtasks: cannot delegate to self")
          results.push({ messageID: "", actorID: "", status: "failed" })
          continue
        }
        if (!canDelegate(delegator.org_layer, target.org_layer)) {
          log.warn("delegateSubtasks: org layer violation", {
            from: delegator.org_layer,
            to: target.org_layer,
          })
          results.push({ messageID: "", actorID: "", status: "failed" })
          continue
        }

        // 4. Ensure an actor is available before creating a request message.
        const actor = spawnRef.current
        if (!actor) {
          results.push({ messageID: "", actorID: "", status: "failed" })
          continue
        }

        // 5. Create the delegation message first so the child actor can carry its ID.
        const msgId = Identifier.ascending("message")
        const rootNeedID = input.rootNeedID || msgId

        const msg = yield* agentMessageSvc.create({
          id: msgId,
          fromAgentID: input.delegatorAgentID,
          toAgentID: target.id,
          kind: "request",
          body: subTask.summary,
          taskSummary: subTask.summary,
          threadID: input.threadID,
          rootNeedID,
          depth: input.depth,
        })

        // 6. Spawn an actor to handle the sub-task using spawnForDelegation.
        const spawned = yield* actor.spawnForDelegation({
          spawn: {
            sessionID: input.sessionID as any,
            agentType: target.id,
            task: buildSubtaskPrompt(subTask),
            context: "none",
            tools: "INHERIT",
            background: true,
            parentActorID: input.delegatorAgentID,
            delegationMessageID: msg.id,
            depth: input.depth + 1,
          },
          delegationContext: {
            depth: input.depth + 1,
            rootNeedID: input.rootNeedID,
            taskSummary: subTask.summary,
            acceptanceCriteria: subTask.acceptanceCriteria,
          },
        })

        const linkedMsg = yield* agentMessageSvc.updateSpawnedIssue(msg.id, spawned.actorID)

        log.info("delegateSubtasks: delegated sub-task", {
          messageID: linkedMsg.id,
          actorID: spawned.actorID,
          target: target.name,
        })

        results.push({
          messageID: linkedMsg.id,
          actorID: spawned.actorID,
          status: "spawned",
        })
      }

      return results
    })

    // ---- admitResult ----

    const admitResult = Effect.fn("Delegation.admitResult")(function* (input: AdmitResultInput) {
      const actor = spawnRef.current
      if (!actor) {
        return yield* Effect.fail(new Error("Delegation.admitResult: Actor service not initialized"))
      }

      const criteria = input.delegationMessage.taskSummary ?? input.delegationMessage.body
      const prompt = buildAdmitPrompt(criteria, input.result)

      const spawned = yield* actor.spawn({
        mode: "subagent",
        sessionID: input.sessionID as any,
        agentType: input.delegationMessage.toAgentID,
        task: prompt,
        context: "none",
        tools: "INHERIT",
        background: true,
        format: { type: "json_schema", schema: ADMIT_SCHEMA, retryCount: 2 },
      })

      log.info("admitResult: spawned evaluation actor", {
        actorID: spawned.actorID,
        messageID: input.delegationMessage.id,
      })

      const outcome = yield* Deferred.await(spawned.outcome)

      if (outcome.status !== "success" || !outcome.structured) {
        log.warn("admitResult: evaluation actor failed", {
          actorID: spawned.actorID,
          status: outcome.status,
        })
        return {
          accepted: false,
          findings: [`Evaluation actor failed: ${outcome.status}`],
        }
      }

      const parsed = outcome.structured as AdmissionResult
      log.info("admitResult: evaluation complete", {
        accepted: parsed.accepted,
        findingsCount: parsed.findings.length,
      })
      return parsed
    })

    // ---- submitForAdmission ----

    const submitForAdmission = Effect.fn("Delegation.submitForAdmission")(function* (input: SubmitForAdmissionInput) {
      const agents = yield* companyAgentSvc.list()
      const reviewer = agents.find((a) => a.id === input.delegationMessage.fromAgentID)
      const taskRating = admissionSvc.resolveRating(reviewer?.org_layer)
      const admission = yield* admissionSvc.grade(input.submission, taskRating)
      const accepted = admission.passed
      const reputation = yield* reputationSvc.updateFromAdmission(
        input.delegationMessage.toAgentID,
        accepted,
        admission.findings,
        admission.taskRating,
      )
      const trust = yield* trustDialSvc.evaluate({
        agentID: input.delegationMessage.toAgentID,
        taskRating: admission.taskRating,
        accepted,
        findings: admission.findings,
      })
      const body = accepted
        ? [
            "Admission passed.",
            "",
            `Task rating: ${admission.taskRating}`,
            `Submission kind: ${input.submission.kind}`,
            `Trust level: ${trust.level} (${trust.score})`,
            ...(trust.approvalRequired
              ? [
                  `Approval required: ${trust.minimumApprovals}`,
                  `Reason: ${trust.reason}`,
                ]
              : ["Auto-admitted: yes"]),
          ].join("\n")
        : admissionSvc.buildRejectionMessage(admission)
      const outcome = accepted ? (trust.approvalRequired ? "needs_approval" : "success") : "failed"

      const reply = yield* agentMessageSvc.create({
        fromAgentID: input.delegationMessage.toAgentID,
        toAgentID: input.delegationMessage.fromAgentID,
        kind: "reply",
        body,
        inReplyTo: input.delegationMessage.id,
        threadID: input.delegationMessage.threadID,
        rootNeedID: input.delegationMessage.rootNeedID,
        depth: input.delegationMessage.depth,
        outcome,
      })
      yield* AuditEvent.record({
        rootNeedID: input.delegationMessage.rootNeedID,
        kind: "admission",
        action: accepted ? (trust.approvalRequired ? "needs_approval" : "passed") : "failed",
        actorAgentID: input.delegationMessage.fromAgentID,
        targetAgentID: input.delegationMessage.toAgentID,
        subjectID: reply.id,
        subjectType: "agent_message",
        granted: accepted && !trust.approvalRequired,
        metadata: {
          taskRating: admission.taskRating,
          findingCount: admission.findings.length,
          submissionKind: input.submission.kind,
          delegationMessageID: input.delegationMessage.id,
          trustLevel: trust.level,
          approvalRequired: trust.approvalRequired,
          minimumApprovals: trust.minimumApprovals,
        },
      })

      return { accepted, admission, reply, reputation, trust }
    })

    // ---- resolveProposal ----

    const resolveProposal = Effect.fn("Delegation.resolveProposal")(function* (input: ResolveProposalInput) {
      if (input.proposalMessage.kind !== "proposal") {
        return yield* Effect.fail(new Error(`resolveProposal: message "${input.proposalMessage.id}" is not a proposal`))
      }
      if (input.proposalMessage.toAgentID !== input.resolverAgentID) {
        return yield* Effect.fail(
          new Error(
            `resolveProposal: agent "${input.resolverAgentID}" cannot resolve proposal "${input.proposalMessage.id}"`,
          ),
        )
      }

      const task =
        input.decision === "adopt"
          ? yield* taskRegistrySvc.create({
              session_id: input.sessionID,
              parent_id: input.parentTaskID,
              owner: input.proposalMessage.fromAgentID,
              summary:
                input.taskSummary ??
                input.proposalMessage.taskSummary ??
                input.proposalMessage.body.split("\n").find((line) => line.trim().length > 0) ??
                "Adopted proposal",
            })
          : undefined

      const reply = yield* agentMessageSvc.create({
        fromAgentID: input.resolverAgentID,
        toAgentID: input.proposalMessage.fromAgentID,
        kind: "reply",
        body: [
          `Proposal ${input.decision === "adopt" ? "adopted" : input.decision === "shelve" ? "shelved" : "rejected"}.`,
          "",
          `Reason: ${input.reason}`,
          ...(task ? ["", `Task: ${task.id}`, `Owner: ${task.owner ?? input.proposalMessage.fromAgentID}`] : []),
        ].join("\n"),
        inReplyTo: input.proposalMessage.id,
        threadID: input.proposalMessage.threadID,
        rootNeedID: input.proposalMessage.rootNeedID,
        depth: input.proposalMessage.depth,
        outcome: input.decision === "adopt" ? "adopted" : input.decision,
      })

      return { decision: input.decision, reply, task }
    })

    // ---- recordDecision ----

    const recordDecision = Effect.fn("Delegation.recordDecision")(function* (input: RecordDecisionInput) {
      const agents = yield* companyAgentSvc.list()
      const dri = agents.find((agent) => agent.id === input.driAgentID)
      if (!dri) return yield* Effect.fail(new Error(`recordDecision: DRI agent "${input.driAgentID}" not found`))
      if (input.options.length === 0)
        return yield* Effect.fail(new Error("recordDecision: at least one option is required"))

      const selectedOption = input.options.find((option) => option.id === input.selectedOptionID)
      if (!selectedOption) {
        return yield* Effect.fail(
          new Error(`recordDecision: selected option "${input.selectedOptionID}" is not in options`),
        )
      }

      const weightedVotes = yield* Effect.forEach(
        input.votes ?? [],
        (vote): Effect.Effect<WeightedAdvisoryVote, Error> =>
          Effect.gen(function* () {
            const voter = agents.find((agent) => agent.id === vote.agentID)
            if (!voter) return yield* Effect.fail(new Error(`recordDecision: voter "${vote.agentID}" not found`))
            if (!input.options.some((option) => option.id === vote.optionID)) {
              return yield* Effect.fail(new Error(`recordDecision: vote option "${vote.optionID}" is not in options`))
            }
            const reputation = yield* reputationSvc.get(vote.agentID)
            return {
              agentID: vote.agentID,
              agentName: voter.name,
              optionID: vote.optionID,
              rationale: vote.rationale,
              reputationScore: reputation.score,
              weight: Math.max(1, reputation.score),
            }
          }),
        { concurrency: "unbounded" },
      )
      const advisoryTotals = Object.fromEntries(
        input.options.map((option) => [
          option.id,
          weightedVotes
            .filter((vote) => vote.optionID === option.id)
            .map((vote) => vote.weight)
            .reduce((total, weight) => total + weight, 0),
        ]),
      )
      const dissent = weightedVotes.filter((vote) => vote.optionID !== input.selectedOptionID)
      const decisionID = Identifier.create("dec", "ascending")
      const minutesPath = yield* saveDecisionMinutesImpl({
        decisionID,
        decision: input,
        driName: dri.name,
        selectedOptionTitle: selectedOption.title,
        advisoryTotals,
        weightedVotes,
        dissent,
      })

      return {
        decisionID,
        selectedOptionID: input.selectedOptionID,
        minutesPath,
        advisoryTotals,
        weightedVotes,
        dissent,
      }
    })

    // ---- escalate ----

    const escalate = Effect.fn("Delegation.escalate")(function* (input: EscalateInput) {
      // Use handleFailure to determine retry vs escalate
      const failureResult = yield* handleFailureImpl(
        {
          agentId: input.originalMessage.toAgentID,
          originalGoal: input.originalMessage.body,
          rootNeedID: input.originalMessage.rootNeedID ?? "",
          originalMessageId: input.originalMessage.id,
          error: input.result,
          attemptCount: input.attemptCount,
          approaches: input.approaches,
          depth: input.originalMessage.depth,
          threadID: input.originalMessage.threadID,
        },
        companyAgentSvc,
        agentMessageSvc,
      )

      if (failureResult.action === "terminal_failure") {
        return {
          action: "failed_project" as const,
          reason: failureResult.reason,
        }
      }

      if (failureResult.action === "retry") {
        // Spawn a new actor with the fundamentally different retry instruction
        const actor = spawnRef.current
        if (!actor) {
          return yield* Effect.fail(new Error("Delegation.escalate: Actor service not initialized"))
        }

        const spawned = yield* actor.spawnForDelegation({
          spawn: {
            sessionID: input.sessionID as any,
            agentType: input.originalMessage.toAgentID,
            task: failureResult.retryInstruction,
            context: "none",
            tools: "INHERIT",
            background: true,
            delegationMessageID: input.originalMessage.id,
            depth: input.originalMessage.depth,
          },
          delegationContext: {
            depth: input.originalMessage.depth,
            rootNeedID: input.originalMessage.rootNeedID,
            taskSummary: input.originalMessage.taskSummary,
          },
        })

        log.info("escalate: spawned retry actor", {
          actorID: spawned.actorID,
          attempt: input.attemptCount + 1,
          maxAttempts: MAX_APPROACH_ATTEMPTS,
        })

        return {
          action: "retry" as const,
          actorID: spawned.actorID,
          messageID: input.originalMessage.id,
        }
      }

      // Escalated to superior — check if board level for terminal handling
      const agents = yield* companyAgentSvc.list()
      const superior = agents.find((a) => a.id === failureResult.superiorId)

      if (superior?.org_layer === "board") {
        // Board-level escalation — spawn an actor for the board to make a final decision
        const actor = spawnRef.current
        if (!actor) {
          return {
            action: "escalated" as const,
            escalationMessageId: failureResult.escalationMessageId,
            superiorId: failureResult.superiorId,
            superiorName: failureResult.superiorName,
          }
        }

        const boardPrompt = [
          "## Board-Level Escalation Review",
          "",
          "A delegation chain has exhausted all retry attempts at lower levels.",
          "You must make a final decision on this matter.",
          "",
          "## Original Task",
          input.originalMessage.body,
          "",
          "## Failure Details",
          input.result,
          "",
          "## Approaches Tried",
          ...input.approaches.map((a, i) => `${i + 1}. ${a.approach}: ${a.findings}`),
          "",
          "## Your Options",
          "1. accept_with_limitations — Accept the result with known limitations",
          "2. relax_standards — Lower quality/scope criteria to make it acceptable",
          "3. supply_context — Provide additional context or resources and retry",
          "4. terminal_failure — Mark this as a failed project",
        ].join("\n")

        const spawned = yield* actor.spawn({
          mode: "subagent",
          sessionID: input.sessionID as any,
          agentType: superior.id,
          task: boardPrompt,
          context: "none",
          tools: "INHERIT",
          background: true,
          format: { type: "json_schema", schema: BOARD_DECISION_SCHEMA, retryCount: 2 },
        })

        log.info("escalate: spawned board-level actor", {
          actorID: spawned.actorID,
          superior: superior.name,
        })

        const boardOutcome = yield* Deferred.await(spawned.outcome)

        if (boardOutcome.status !== "success" || !boardOutcome.structured) {
          log.warn("escalate: board-level actor failed", {
            superior: superior.name,
            status: boardOutcome.status,
          })
          return {
            action: "failed_project" as const,
            reason: `Board-level agent ${superior.name} failed to resolve: ${boardOutcome.status === "failure" ? boardOutcome.error : "cancelled"}`,
          }
        }

        const boardDecision = boardOutcome.structured as { decision: string; reason: string }
        log.info("escalate: board-level resolution complete", {
          superior: superior.name,
          decision: boardDecision.decision,
        })

        if (boardDecision.decision === "terminal_failure") {
          return {
            action: "failed_project" as const,
            reason: boardDecision.reason,
          }
        }

        // For non-terminal board decisions, record the decision and return escalated
        // The caller can act on the board's decision (accept/relax/supply context)
        return {
          action: "escalated" as const,
          escalationMessageId: failureResult.escalationMessageId,
          superiorId: failureResult.superiorId,
          superiorName: failureResult.superiorName,
        }
      }

      return {
        action: "escalated" as const,
        escalationMessageId: failureResult.escalationMessageId,
        superiorId: failureResult.superiorId,
        superiorName: failureResult.superiorName,
      }
    })

    // ---- assemble service ----

    return Service.of({
      decompose,
      delegateSubtasks,
      admitResult,
      submitForAdmission,
      resolveProposal,
      recordDecision,
      escalate,
      handleFailure: (input) => handleFailureImpl(input, companyAgentSvc, agentMessageSvc),
      evaluateFailureBubble: (input) => evaluateFailureBubbleImpl(input, companyAgentSvc, agentMessageSvc),
      buildFullChainReport: (rootNeedID) => buildFullChainReportImpl(rootNeedID, agentMessageSvc, companyAgentSvc),
      saveChainReport: (report) => saveChainReportImpl(report),
    })
  }),
)

// ---------------------------------------------------------------------------
// Default layer
// ---------------------------------------------------------------------------

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(AgentMessage.defaultLayer),
    Layer.provide(Admission.defaultLayer),
    Layer.provide(Reputation.defaultLayer),
    Layer.provide(TrustDial.defaultLayer),
    Layer.provide(CompanyAgent.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
  ),
)

/** Namespace re-export for test compatibility: import { Delegation } from "./delegation" */
export const Delegation = { Service, layer, defaultLayer, MAX_APPROACH_ATTEMPTS } as const
