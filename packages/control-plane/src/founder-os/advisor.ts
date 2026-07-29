import { createHash } from "node:crypto"
import { and, asc, desc, eq, lte } from "drizzle-orm"
import {
  classifyFounderRequestedAction,
  DecisionIntent,
  FounderAdvisorAuthorityResult,
  FounderAdvisorConvergence,
  FounderAdvisorConvergenceInput,
  FounderAdvisorPrincipal,
  FounderBoardGovernanceProjection,
  FounderControlCenterProjection,
  FounderIntervention,
  FounderInterventionEffect,
  FounderInterventionInput,
  FounderShadowEvidenceRef,
  type DecisionRecord,
  type FounderAdvisorConvergenceInput as FounderAdvisorConvergenceInputValue,
  type FounderBoardShadowProjection,
  type FounderInterventionInput as FounderInterventionInputValue,
  type FounderOSModeState,
  type FounderStudioProjection,
} from "@agents-company/shared/founder-os"
import { CompanyTable } from "@/company/company.sql"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyID } from "@/company/schema"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadTable,
} from "@/conversation/conversation.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import { submitGovernanceInTransaction } from "./authority"
import { FounderTwinSnapshotTable } from "./asset.sql"
import {
  appendDecisionInTransaction,
  appendDecisionTransitionInTransaction,
} from "./decision-ledger"
import { DecisionCurrentProjectionTable, FounderCorrectionTable } from "./decision-ledger.sql"
import {
  FounderAdvisorConvergenceEventTable,
  FounderAdvisorConvergenceTable,
  FounderAdvisorReadinessTable,
  FounderInterventionEffectTable,
  FounderInterventionFenceTable,
  FounderInterventionTable,
} from "./advisor.sql"
import {
  FounderCalibrationResponseTable,
  FounderShadowComparisonTable,
  FounderShadowDecisionTable,
} from "./shadow.sql"
import { calibrationItems } from "./taste"
import { yellowSummaryFromRow } from "./yellow-projection"
import { FounderYellowRunTable } from "./yellow.sql"
import * as FounderAdvisorReadiness from "./advisor-readiness"
import * as FounderOSMode from "./mode"

export const principal = FounderAdvisorPrincipal.parse({
  principalId: "board-ceo",
  displayName: "AI 大东 · 创始人代理",
  principalKind: "agent",
  projectionKind: "founder_governance",
  humanAuthoritySource: "local_user",
  isAdditionalEmployee: false,
})

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]),
  )
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex")
}

function modes(companyId: string) {
  const company = Database.use((db) =>
    db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(companyId))).get(),
  )
  if (!company) throw new Error("Company was not found")
  return FounderOSMode.resolve({
    founderTwinMode: company.founder_twin_mode,
    companyCommonsMode: company.company_commons_mode,
  })
}

export function isFenced(companyId: string, boardThreadId: string) {
  return Boolean(Database.use((db) =>
    db
      .select({ id: FounderInterventionFenceTable.id })
      .from(FounderInterventionFenceTable)
      .where(and(
        eq(FounderInterventionFenceTable.company_id, companyId),
        eq(FounderInterventionFenceTable.board_thread_id, boardThreadId),
      ))
      .get(),
  ))
}

function evidenceReference(reference: FounderShadowEvidenceRef) {
  return {
    kind: reference.kind === "fact" ? "source" as const : reference.kind,
    id: reference.id,
    ...(reference.version ? { version: reference.version } : {}),
  }
}

function convergenceFromRow(db: TxOrDb, row: typeof FounderAdvisorConvergenceTable.$inferSelect) {
  const events = db
    .select()
    .from(FounderAdvisorConvergenceEventTable)
    .where(eq(FounderAdvisorConvergenceEventTable.convergence_id, row.id))
    .orderBy(asc(FounderAdvisorConvergenceEventTable.sequence))
    .all()
  return FounderAdvisorConvergence.parse({
    id: row.id,
    companyId: row.company_id,
    idempotencyKey: row.idempotency_key,
    source: {
      boardThreadId: row.board_thread_id,
      ...(row.board_run_id ? { boardRunId: row.board_run_id } : {}),
      channelMessageId: row.channel_message_id,
      shadowDecisionId: row.shadow_decision_id,
    },
    currentRequestKey: row.current_request_key,
    principal,
    status: events.at(-1)!.status,
    events: events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      status: event.status,
      reason: event.reason,
      createdAt: event.created_at,
    })),
    ...(row.decision_intent_json ? { decisionIntent: JSON.parse(row.decision_intent_json) } : {}),
    ...(row.ledger_decision_id ? { ledgerDecisionId: row.ledger_decision_id } : {}),
    authority: {
      status: row.authority_status,
      reason: row.authority_reason,
      ...(row.governance_ref ? { governanceRef: row.governance_ref } : {}),
      ...(row.reversible === null ? {} : { reversible: row.reversible }),
      ...(row.external_impact === null ? {} : { externalImpact: row.external_impact }),
      ...(row.risk_level ? { riskLevel: row.risk_level } : {}),
    },
    driAgentId: row.dri_agent_id,
    timeoutAt: row.timeout_at,
    dissent: JSON.parse(row.dissent_json),
    workItemCreated: false,
    executionCreated: false,
    createdAt: row.created_at,
  })
}

function effectFromRow(row: typeof FounderInterventionEffectTable.$inferSelect) {
  return FounderInterventionEffect.parse({
    id: row.id,
    interventionId: row.intervention_id,
    kind: row.kind,
    status: row.status,
    detail: row.detail,
    createdAt: row.created_at,
  })
}

function interventionFromRow(row: typeof FounderInterventionTable.$inferSelect) {
  return FounderIntervention.parse({
    id: row.id,
    companyId: row.company_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    boardThreadId: row.board_thread_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ledgerDecisionId: row.ledger_decision_id,
    reason: row.reason,
    ...(row.new_goal ? { newGoal: row.new_goal } : {}),
    actorId: row.actor_id,
    fenceActive: isFenced(row.company_id, row.board_thread_id),
    effects: Database.use((db) =>
      db
        .select()
        .from(FounderInterventionEffectTable)
        .where(eq(FounderInterventionEffectTable.intervention_id, row.id))
        .orderBy(asc(FounderInterventionEffectTable.created_at), asc(FounderInterventionEffectTable.id))
        .all(),
    ).map(effectFromRow),
    createdAt: row.created_at,
  })
}

function appendConvergenceEvent(
  db: TxOrDb,
  input: {
    convergenceId: string
    sequence: number
    idempotencyKey: string
    status: "intent_recorded" | "blocked" | "timed_out"
    reason: string
    createdAt: number
  },
) {
  db.insert(FounderAdvisorConvergenceEventTable)
    .values({
      id: Identifier.create("fadve", "ascending"),
      convergence_id: input.convergenceId,
      sequence: input.sequence,
      idempotency_key: input.idempotencyKey,
      status: input.status,
      reason: input.reason,
      created_at: input.createdAt,
    })
    .run()
}

function blockedCurrentRequestKey(input: FounderAdvisorConvergenceInputValue) {
  return `frequest_${digest({
    companyId: input.companyId,
    boardThreadId: input.source.boardThreadId,
  }).slice(0, 32)}`
}

function saveBlocked(
  db: TxOrDb,
  input: FounderAdvisorConvergenceInputValue,
  inputSha256: string,
  currentRequestKey: string,
  authority: { status: "blocked" | "unavailable"; reason: string },
) {
  const id = Identifier.create("fadv", "ascending")
  const createdAt = Date.now()
  db.insert(FounderAdvisorConvergenceTable)
    .values({
      id,
      company_id: input.companyId,
      idempotency_key: input.idempotencyKey,
      input_sha256: inputSha256,
      board_thread_id: input.source.boardThreadId,
      board_run_id: input.source.boardRunId ?? null,
      channel_message_id: input.source.channelMessageId,
      shadow_decision_id: input.source.shadowDecisionId,
      current_request_key: currentRequestKey,
      status: "blocked",
      decision_intent_json: null,
      ledger_decision_id: null,
      authority_status: authority.status,
      authority_reason: authority.reason,
      governance_ref: null,
      reversible: null,
      external_impact: null,
      risk_level: null,
      dri_agent_id: input.driAgentId,
      timeout_at: input.timeoutAt,
      dissent_json: JSON.stringify(input.dissent),
      created_at: createdAt,
    })
    .run()
  appendConvergenceEvent(db, {
    convergenceId: id,
    sequence: 1,
    idempotencyKey: "blocked",
    status: "blocked",
    reason: authority.reason,
    createdAt,
  })
  return convergenceFromRow(
    db,
    db.select().from(FounderAdvisorConvergenceTable).where(eq(FounderAdvisorConvergenceTable.id, id)).get()!,
  )
}

export function converge(raw: FounderAdvisorConvergenceInputValue) {
  const input = FounderAdvisorConvergenceInput.parse(raw)
  const inputSha256 = digest(input)
  return Database.transaction((db) => {
    const existing = db
      .select()
      .from(FounderAdvisorConvergenceTable)
      .where(and(
        eq(FounderAdvisorConvergenceTable.company_id, input.companyId),
        eq(FounderAdvisorConvergenceTable.idempotency_key, input.idempotencyKey),
      ))
      .get()
    if (existing) {
      if (existing.input_sha256 !== inputSha256)
        throw new Error("Advisor convergence idempotency key has different facts")
      if (existing.status !== "blocked") return convergenceFromRow(db, existing)
    }
    const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, input.companyId)).get()
    if (!company) throw new Error("Company was not found")
    const thread = db
      .select()
      .from(ConversationThreadTable)
      .where(eq(ConversationThreadTable.id, input.source.boardThreadId))
      .get()
    const channel = thread
      ? db.select().from(ChannelTable).where(eq(ChannelTable.id, thread.channel_id)).get()
      : undefined
    const message = db
      .select()
      .from(ChannelMessageTable)
      .where(eq(ChannelMessageTable.id, input.source.channelMessageId))
      .get()
    const run = input.source.boardRunId
      ? db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, input.source.boardRunId)).get()
      : undefined
    const shadow = db
      .select()
      .from(FounderShadowDecisionTable)
      .where(eq(FounderShadowDecisionTable.id, input.source.shadowDecisionId))
      .get()
    const dri = db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, input.driAgentId)).get()
    const sourceReason = [
      !thread || thread.company_id !== input.companyId
        ? "Board Thread must belong to the requested Company."
        : undefined,
      !channel || channel.company_id !== input.companyId || channel.kind !== "board"
        ? "Board Thread must belong to the Company's Board Channel."
        : undefined,
      !message
      || message.channel_id !== channel?.id
      || message.source_thread_id !== thread?.id
      || !message.request_id
        ? "Channel Message must be the current request in the verified Board Thread."
        : undefined,
      !run
      || run.conversation_thread_id !== thread?.id
      || run.channel_message_id !== message?.id
        ? "Conversation Run must reference the verified Board Thread and Channel Message."
        : undefined,
      !shadow || shadow.company_id !== input.companyId || shadow.status !== "suggested"
        ? "A traceable suggested Shadow decision from the same Company is required."
        : undefined,
      thread?.project_scope_id && (
        shadow?.scope_kind !== "project"
        || shadow.scope_ref !== thread.project_scope_id
      )
        ? "Shadow scope must match the Board Thread project scope."
        : undefined,
      thread && !thread.project_scope_id && (
        shadow?.scope_kind !== "company"
        || shadow.scope_ref !== null
      )
        ? "Company Board Threads require a company-scoped Shadow decision."
        : undefined,
      !dri || dri.company_id !== input.companyId || dri.lifecycle !== "employee"
        ? "DRI must be an employee Agent of the same Company."
        : undefined,
    ].find((reason): reason is string => reason !== undefined)
    const currentRequestKey = message?.request_id
      && thread?.company_id === input.companyId
      && channel?.company_id === input.companyId
      && channel.kind === "board"
      && message.channel_id === channel.id
      && message.source_thread_id === thread.id
      && run?.conversation_thread_id === thread.id
      && run.channel_message_id === message.id
      ? message.request_id
      : blockedCurrentRequestKey(input)
    const current = db
      .select()
      .from(FounderAdvisorConvergenceTable)
      .where(and(
        eq(FounderAdvisorConvergenceTable.company_id, input.companyId),
        eq(FounderAdvisorConvergenceTable.board_thread_id, input.source.boardThreadId),
        eq(FounderAdvisorConvergenceTable.current_request_key, currentRequestKey),
      ))
      .get()
    if (current && current.status !== "blocked") return convergenceFromRow(db, current)
    if (sourceReason) throw new Error(sourceReason)
    const block = (authority: FounderAdvisorAuthorityResult) => current
      ? convergenceFromRow(db, current)
      : saveBlocked(db, input, inputSha256, currentRequestKey, authority)
    if (input.timeoutAt <= Date.now())
      return block({
        status: "blocked",
        reason: "Advisor convergence timeoutAt must be in the future.",
      })
    if (db
      .select({ id: FounderInterventionFenceTable.id })
      .from(FounderInterventionFenceTable)
      .where(and(
        eq(FounderInterventionFenceTable.company_id, input.companyId),
        eq(FounderInterventionFenceTable.board_thread_id, input.source.boardThreadId),
      ))
      .get())
      return block({
        status: "blocked",
        reason: "Human intervention fence is active; the Founder proxy cannot speak.",
      })
    const currentMode = FounderOSMode.resolve({
      founderTwinMode: company.founder_twin_mode,
      companyCommonsMode: company.company_commons_mode,
    })
    if (!["advisor", "green-delegated", "yellow-delegated"].includes(currentMode.effective.founderTwinMode))
      return block({
        status: "blocked",
        reason: "Effective Founder Twin mode cannot produce Advisor intents.",
      })
    if (!db
      .select({ id: FounderAdvisorReadinessTable.id })
      .from(FounderAdvisorReadinessTable)
      .where(eq(FounderAdvisorReadinessTable.company_id, input.companyId))
      .orderBy(desc(FounderAdvisorReadinessTable.created_at), desc(FounderAdvisorReadinessTable.id))
      .get())
      return block({
        status: "blocked",
        reason: "Advisor readiness is not confirmed.",
      })
    const verifiedShadow = shadow!
    const snapshot = db
      .select()
      .from(FounderTwinSnapshotTable)
      .where(and(
        eq(FounderTwinSnapshotTable.id, verifiedShadow.snapshot_id!),
        eq(FounderTwinSnapshotTable.company_id, input.companyId),
      ))
      .get()
    if (!snapshot)
      return block({
        status: "blocked",
        reason: "Founder Twin Snapshot reference is unavailable.",
      })
    const decisionId = Identifier.ascending("founderDecision")
    const intent = DecisionIntent.parse({
      schemaVersion: 1,
      decisionId,
      recommendation: verifiedShadow.recommendation,
      alternatives: JSON.parse(verifiedShadow.alternatives_json),
      authorityClass: verifiedShadow.authority_class,
      confidence: verifiedShadow.confidence! / 1_000_000,
      principlesApplied: JSON.parse(verifiedShadow.principle_refs_json),
      evidenceRefs: FounderShadowEvidenceRef.array()
        .parse(JSON.parse(verifiedShadow.evidence_refs_json))
        .map(evidenceReference),
      dissent: input.dissent,
      missingInformation: JSON.parse(verifiedShadow.missing_information_json),
      ...(input.requestedAction ? { requestedAction: input.requestedAction } : {}),
    })
    const requestedAction = input.requestedAction ?? {
      schemaVersion: 1 as const,
      idempotencyKey: `farev_${inputSha256}`,
      type: "governance.review.request" as const,
      payload: {
        subject: input.subject.slice(0, 1_000),
        question: input.context,
      },
    }
    const policyFacts = classifyFounderRequestedAction(requestedAction)
    const riskLevel = intent.authorityClass === "red"
      ? "high"
      : intent.authorityClass === "yellow" && policyFacts.riskLevel === "low"
        ? "medium"
        : policyFacts.riskLevel
    const id = Identifier.create("fadv", "ascending")
    const createdAt = Date.now()
    appendDecisionInTransaction(db, {
      id: decisionId,
      idempotencyKey: `advisor:${input.idempotencyKey}`,
      recordOrigin: "live",
      scope: verifiedShadow.scope_kind === "project" && verifiedShadow.scope_ref
        ? { type: "project", companyId: input.companyId, projectId: verifiedShadow.scope_ref }
        : { type: "company", companyId: input.companyId },
      source: {
        channelMessageId: input.source.channelMessageId,
        boardThreadId: input.source.boardThreadId,
        boardRunId: input.source.boardRunId ?? null,
        runtimeId: null,
        sourceCompleteness: "complete",
      },
      founderTwinSnapshot: { id: snapshot.id, version: snapshot.version },
      subject: input.subject,
      context: input.context,
      options: intent.alternatives,
      recommendation: intent.recommendation,
      finalDecision: null,
      decisionMaker: "ai_founder",
      decisionMakerId: "board-ceo",
      authorityClass: intent.authorityClass,
      operatingMode: currentMode.effective.founderTwinMode === "green-delegated"
        ? "green_delegated"
        : currentMode.effective.founderTwinMode === "yellow-delegated"
          ? "yellow_delegated"
          : "advisor",
      confidence: intent.confidence,
      reversible: policyFacts.reversible,
      externalImpact: policyFacts.externalImpact,
      riskLevel,
      evidenceRefs: intent.evidenceRefs,
      principleRefs: intent.principlesApplied,
      decisionCaseRefs: JSON.parse(verifiedShadow.decision_case_refs_json),
      initialStatus: "proposed",
      initialTransitionKind: "created",
      initialReason: "Advisor DecisionIntent recorded without execution.",
      overrideOf: null,
      createdAt,
      decidedAt: null,
    })
    const governance = submitGovernanceInTransaction(db, {
      schemaVersion: 1,
      idempotencyKey: `fagov_${inputSha256}`,
      decisionId,
      actionType: requestedAction.type,
      proposedAuthorityClass: intent.authorityClass,
      evidenceSufficient: Boolean(intent.evidenceRefs.length && !intent.missingInformation?.length),
      requestedBy: { kind: "ai_founder", id: "board-ceo" },
    })
    const governanceRef = governance.gate?.id ?? governance.authority.policyId
    if (!governanceRef) throw new Error("Governance evaluation did not produce an auditable reference")
    const authority = FounderAdvisorAuthorityResult.parse({
      status: "authorized",
      reason: governance.gate
        ? `Governance classified the intent as red; ApprovalGate ${governance.gate.status}.`
        : `Governance evaluated the intent; dispatchAllowed=${governance.dispatchAllowed}.`,
      governanceRef,
      reversible: policyFacts.reversible,
      externalImpact: policyFacts.externalImpact,
      riskLevel,
    })
    const row = {
        id,
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        board_thread_id: input.source.boardThreadId,
        board_run_id: input.source.boardRunId ?? null,
        channel_message_id: input.source.channelMessageId,
        shadow_decision_id: input.source.shadowDecisionId,
        current_request_key: currentRequestKey,
        status: "intent_recorded",
        decision_intent_json: JSON.stringify(intent),
        ledger_decision_id: decisionId,
        authority_status: authority.status,
        authority_reason: authority.reason,
        governance_ref: authority.governanceRef!,
        reversible: authority.reversible!,
        external_impact: authority.externalImpact!,
        risk_level: authority.riskLevel!,
        dri_agent_id: input.driAgentId,
        timeout_at: input.timeoutAt,
        dissent_json: JSON.stringify(input.dissent),
        created_at: createdAt,
      }
    if (current)
      db.update(FounderAdvisorConvergenceTable).set({
        idempotency_key: row.idempotency_key,
        input_sha256: row.input_sha256,
        board_run_id: row.board_run_id,
        channel_message_id: row.channel_message_id,
        shadow_decision_id: row.shadow_decision_id,
        status: row.status,
        decision_intent_json: row.decision_intent_json,
        ledger_decision_id: row.ledger_decision_id,
        authority_status: row.authority_status,
        authority_reason: row.authority_reason,
        governance_ref: row.governance_ref,
        reversible: row.reversible,
        external_impact: row.external_impact,
        risk_level: row.risk_level,
        dri_agent_id: row.dri_agent_id,
        timeout_at: row.timeout_at,
        dissent_json: row.dissent_json,
      }).where(eq(FounderAdvisorConvergenceTable.id, current.id)).run()
    if (!current) db.insert(FounderAdvisorConvergenceTable).values(row).run()
    const convergenceId = current?.id ?? id
    const sequence = (db.select({ sequence: FounderAdvisorConvergenceEventTable.sequence })
      .from(FounderAdvisorConvergenceEventTable)
      .where(eq(FounderAdvisorConvergenceEventTable.convergence_id, convergenceId))
      .orderBy(desc(FounderAdvisorConvergenceEventTable.sequence))
      .get()?.sequence ?? 0) + 1
    appendConvergenceEvent(db, {
      convergenceId,
      sequence,
      idempotencyKey: "intent-recorded",
      status: "intent_recorded",
      reason: "Advisor DecisionIntent recorded without execution.",
      createdAt,
    })
    return convergenceFromRow(
      db,
      db.select().from(FounderAdvisorConvergenceTable).where(eq(FounderAdvisorConvergenceTable.id, convergenceId)).get()!,
    )
  }, { behavior: "immediate" })
}

export function beginIntervention(raw: FounderInterventionInputValue) {
  const input = FounderInterventionInput.parse(raw)
  const inputSha256 = digest(input)
  const existing = Database.use((db) =>
    db
      .select()
      .from(FounderInterventionTable)
      .where(and(
        eq(FounderInterventionTable.company_id, input.companyId),
        eq(FounderInterventionTable.idempotency_key, input.idempotencyKey),
      ))
      .get(),
  )
  if (existing) {
    if (existing.input_sha256 !== inputSha256)
      throw new Error("Founder intervention idempotency key has different facts")
    return interventionFromRow(existing)
  }
  const id = Identifier.create("fint", "ascending")
  const ledgerDecisionId = Identifier.ascending("founderDecision")
  const now = Date.now()
  Database.transaction((db) => {
    appendDecisionInTransaction(db, {
      id: ledgerDecisionId,
      idempotencyKey: `intervention:${input.idempotencyKey}`,
      recordOrigin: "live",
      scope: input.projectId
        ? { type: "project", companyId: input.companyId, projectId: input.projectId }
        : { type: "company", companyId: input.companyId },
      source: {
        channelMessageId: null,
        boardThreadId: input.boardThreadId,
        boardRunId: null,
        runtimeId: null,
        sourceCompleteness: "complete",
      },
      founderTwinSnapshot: null,
      subject: `Founder intervention: ${input.kind}`,
      context: input.reason,
      options: input.newGoal ? [input.newGoal] : [],
      recommendation: input.reason,
      finalDecision: input.newGoal ?? input.reason,
      decisionMaker: "human",
      decisionMakerId: input.actorId,
      authorityClass: "red",
      operatingMode: "advisor",
      confidence: 1,
      reversible: input.kind === "pause" || input.kind === "redefine_goal",
      externalImpact: false,
      riskLevel: "critical",
      evidenceRefs: input.decisionId ? [{ kind: "decision", id: input.decisionId }] : [],
      principleRefs: [],
      decisionCaseRefs: [],
      initialStatus: "accepted",
      initialTransitionKind: "accepted",
      initialReason: "Human intervention accepted and fenced before stop effects.",
      overrideOf: input.decisionId ?? null,
      createdAt: now,
      decidedAt: now,
    })
    db.insert(FounderInterventionTable)
      .values({
        id,
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        kind: input.kind,
        board_thread_id: input.boardThreadId,
        project_id: input.projectId ?? null,
        decision_id: input.decisionId ?? null,
        ledger_decision_id: ledgerDecisionId,
        reason: input.reason,
        new_goal: input.newGoal ?? null,
        actor_id: input.actorId,
        creates_fence: true,
        created_at: now,
      })
      .run()
    db.insert(FounderInterventionFenceTable)
      .values({
        id: Identifier.create("ffence", "ascending"),
        company_id: input.companyId,
        board_thread_id: input.boardThreadId,
        intervention_id: id,
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
  }, { behavior: "immediate" })
  return interventionFromRow(Database.use((db) =>
    db.select().from(FounderInterventionTable).where(eq(FounderInterventionTable.id, id)).get()!,
  ))
}

export function recordInterventionEffect(
  interventionId: string,
  kind: FounderInterventionEffect["kind"],
  status: FounderInterventionEffect["status"],
  detail: string,
) {
  const id = Identifier.create("finteff", "ascending")
  Database.transaction((db) =>
    db.insert(FounderInterventionEffectTable)
      .values({
        id,
        intervention_id: interventionId,
        kind,
        status,
        detail,
        created_at: Date.now(),
      })
      .run(),
  )
  return effectFromRow(Database.use((db) =>
    db.select().from(FounderInterventionEffectTable).where(eq(FounderInterventionEffectTable.id, id)).get()!,
  ))
}

export function interventions(companyId: string) {
  return Database.use((db) =>
    db
      .select()
      .from(FounderInterventionTable)
      .where(eq(FounderInterventionTable.company_id, companyId))
      .orderBy(desc(FounderInterventionTable.created_at), desc(FounderInterventionTable.id))
      .limit(100)
      .all(),
  ).map(interventionFromRow)
}

export function recover() {
  const now = Date.now()
  return Database.transaction((db) =>
    db
      .select()
      .from(FounderAdvisorConvergenceTable)
      .where(and(
        eq(FounderAdvisorConvergenceTable.status, "intent_recorded"),
        lte(FounderAdvisorConvergenceTable.timeout_at, now),
      ))
      .all()
      .filter((row) => db
        .select()
        .from(FounderAdvisorConvergenceEventTable)
        .where(eq(FounderAdvisorConvergenceEventTable.convergence_id, row.id))
        .orderBy(desc(FounderAdvisorConvergenceEventTable.sequence))
        .get()
        ?.status === "intent_recorded")
      .map((row) => {
        const projection = row.ledger_decision_id
          ? db
            .select()
            .from(DecisionCurrentProjectionTable)
            .where(eq(DecisionCurrentProjectionTable.decision_id, row.ledger_decision_id))
            .get()
          : undefined
        if (
          row.ledger_decision_id
          && projection
          && ["proposed", "awaiting_approval", "accepted", "executed"].includes(projection.current_status)
        )
          appendDecisionTransitionInTransaction(db, row.ledger_decision_id, {
            schemaVersion: 1,
            idempotencyKey: `advisor-timeout:${row.id}`,
            toStatus: "failed",
            kind: "failed",
            reason: "Advisor convergence timed out before a human-confirmed outcome.",
            actorId: "board-ceo",
            finalDecision:
              projection.final_decision ??
              "Advisor convergence timed out before a human-confirmed outcome.",
            decidedAt: projection.decided_at ?? now,
          })
        appendConvergenceEvent(db, {
          convergenceId: row.id,
          sequence: 2,
          idempotencyKey: "timeout",
          status: "timed_out",
          reason: "Advisor convergence timed out and failed closed.",
          createdAt: now,
        })
        return row.id
      }),
  )
}

export function convergences(companyId: string) {
  recover()
  return Database.use((db) => db
      .select()
      .from(FounderAdvisorConvergenceTable)
      .where(eq(FounderAdvisorConvergenceTable.company_id, companyId))
      .orderBy(desc(FounderAdvisorConvergenceTable.created_at), desc(FounderAdvisorConvergenceTable.id))
      .limit(100)
      .all()
      .map((row) => convergenceFromRow(db, row)))
}

export function boardProjection(input: {
  companyId: string
  modes: FounderOSModeState
  decisions: DecisionRecord[]
  shadow: FounderBoardShadowProjection
  studio: FounderStudioProjection
}) {
  const events = interventions(input.companyId)
  const advisorMode = ["advisor", "green-delegated", "yellow-delegated"].includes(
    input.modes.effective.founderTwinMode,
  ) && FounderAdvisorReadiness.readiness(input.companyId).status === "ready"
  return FounderBoardGovernanceProjection.parse({
    schemaVersion: 1,
    companyId: input.companyId,
    principal,
    mode: input.modes,
    advisorCanSpeak: advisorMode && !events.some((event) => event.fenceActive),
    authorization: {
      status: advisorMode ? "authorized" : "not_confirmed",
      canRaiseModeFromUI: false,
    },
    convergences: convergences(input.companyId),
    interventions: events,
    decisions: input.decisions.toReversed().slice(0, 100),
    shadow: input.shadow,
    assets: input.studio.assets,
    readOnlyEvidence: true,
  })
}

export function controlCenter(input: {
  companyId: string
  modes: FounderOSModeState
  decisions: DecisionRecord[]
}) {
  const events = interventions(input.companyId)
  const recentDecisions = input.decisions.toReversed()
  const advisorMode = ["advisor", "green-delegated", "yellow-delegated"].includes(
    input.modes.effective.founderTwinMode,
  ) && FounderAdvisorReadiness.readiness(input.companyId).status === "ready"
  const failedStops = events.flatMap((event) => event.effects)
    .filter((effect) => effect.kind === "stop_failed").length
  const shadowComparisons = Database.use((db) =>
    db
      .select({
        alignment: FounderShadowComparisonTable.alignment,
        verificationStatus: FounderShadowComparisonTable.verification_status,
      })
      .from(FounderShadowComparisonTable)
      .where(eq(FounderShadowComparisonTable.company_id, input.companyId))
      .all(),
  )
  const yellowSummaries = Database.use((db) =>
    db
      .select()
      .from(FounderYellowRunTable)
      .where(eq(FounderYellowRunTable.company_id, input.companyId))
      .orderBy(desc(FounderYellowRunTable.created_at), desc(FounderYellowRunTable.id))
      .limit(20)
      .all()
      .map((row) => yellowSummaryFromRow(db, row)),
  )
  const overrideRecords = Database.use((db) =>
    db
      .select()
      .from(FounderCorrectionTable)
      .where(and(
        eq(FounderCorrectionTable.company_id, input.companyId),
        eq(FounderCorrectionTable.kind, "override"),
      ))
      .orderBy(desc(FounderCorrectionTable.created_at), desc(FounderCorrectionTable.id))
      .limit(20)
      .all()
      .map((row) => ({
        schemaVersion: 1,
        id: row.id,
        decisionId: row.decision_id,
        kind: row.kind,
        originalDecision: row.original_decision,
        humanDecision: row.human_decision,
        reason: row.reason,
        proposedAssetUpdates: JSON.parse(row.proposed_asset_updates_json),
        actorKind: "human",
        actorId: row.actor_id,
        createdAt: row.created_at,
      })),
  )
  const calibrations = calibrationItems(input.companyId)
  const todayStartedAt = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
  const redPendingDecisions = recentDecisions.filter((decision) =>
    decision.authorityClass === "red"
    && (decision.currentStatus === "proposed" || decision.currentStatus === "awaiting_approval"),
  ).slice(0, 100)
  return FounderControlCenterProjection.parse({
    schemaVersion: 1,
    companyId: input.companyId,
    principal,
    mode: input.modes,
    authorization: {
      status: advisorMode ? "authorized" : "not_confirmed",
      canRaiseModeFromUI: false,
    },
    pending: {
      proposedDecisions: input.decisions.filter((decision) => decision.currentStatus === "proposed").length,
      redDecisions: input.decisions.filter((decision) =>
        decision.authorityClass === "red"
        && (decision.currentStatus === "proposed" || decision.currentStatus === "awaiting_approval"),
      ).length,
      failedStops,
    },
    trends: {
      shadowComparisons: shadowComparisons.filter((comparison) =>
        comparison.verificationStatus === "human_confirmed"
      ).length,
      shadowOverrides: shadowComparisons.filter((comparison) =>
        comparison.verificationStatus === "human_confirmed" && comparison.alignment === "mismatch"
      ).length,
      confirmedCalibrations: Database.use((db) =>
        db
          .select({ id: FounderCalibrationResponseTable.id })
          .from(FounderCalibrationResponseTable)
          .where(eq(FounderCalibrationResponseTable.company_id, input.companyId))
          .all(),
      ).length,
      takeoverEvents: events.filter((event) => event.kind === "takeover").length,
    },
    todayDelegatedDecisions: recentDecisions.filter((decision) =>
      decision.recordOrigin === "live"
      && decision.decisionMaker === "ai_founder"
      && decision.createdAt >= todayStartedAt
    ).slice(0, 100),
    yellowSummaries,
    redPendingDecisions,
    overrideRecords,
    calibrationTrend: {
      pending: calibrations.filter((item) => item.status === "pending").length,
      responded: calibrations.filter((item) => item.status === "responded").length,
      accepted: calibrations.filter((item) => item.response === "accept").length,
      rejected: calibrations.filter((item) => item.response === "reject").length,
      preferences: calibrations.filter((item) =>
        item.response === "prefer_first" || item.response === "prefer_second"
      ).length,
    },
    recentInterventions: events.slice(0, 20),
    recentDecisions: recentDecisions.slice(0, 20),
  })
}
