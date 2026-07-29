import { and, desc, eq } from "drizzle-orm"
import z from "zod"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyID } from "@/company/schema"
import { CompanyAgentInterestProfileTable } from "@/company-reading/company-reading.sql"
import { AgentInterestProfileInput } from "@/company-reading/schema"
import {
  CompanyProjectTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import {
  GovernanceAssetSelectionTable,
  GovernanceAssetTable,
} from "@/founder-os/asset.sql"
import { GovernanceAssetScope, GovernanceAssetSourceRef, GovernanceAssetType } from "@agents-company/shared/founder-os"
import { Identifier } from "@/id/id"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyLearningBenchmarkTargetSelectionTable,
  CompanyLearningBenchmarkTargetVersionTable,
  CompanyLearningInterestTargetSelectionTable,
  CompanyLearningInterestTargetVersionTable,
  CompanyLearningPatchTable,
  CompanyLearningWorkflowTargetSelectionTable,
  CompanyLearningWorkflowTargetVersionTable,
  CompanyPatchTargetVersionTable,
  CompanyWorkReceiptLearningTargetRefTable,
} from "./company-learning.sql"
import type { LearningPatchTargetType } from "./schema"

const GovernanceTarget = z.object({
  asset_type: z.enum(["founder_profile", "founder_taste", "company_constitution", "company_belief"]),
  governance_type: GovernanceAssetType,
  scope: GovernanceAssetScope,
  content: z.string().trim().min(1).max(20_000),
  rationale: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(1_000)).max(100),
  source_refs: z.array(GovernanceAssetSourceRef).max(100),
  base_version: z.number().int().positive().optional(),
}).strict()

export const BenchmarkTarget = z.object({
  benchmark_type: z.enum(["founder_decision", "taste"]),
  dataset_version: z.string().trim().min(1).max(240),
  minimum_sample_count: z.number().int().positive(),
  minimum_agreement_rate: z.number().min(0).max(1),
  minimum_traceability_rate: z.number().min(0).max(1),
  required_red_recall: z.number().min(0).max(1).nullable(),
  affects_authority_or_release_gate: z.boolean(),
}).strict()

const InterestTarget = AgentInterestProfileInput.omit({ company_id: true, agent_id: true })

export const WorkflowTarget = z.object({
  validator_ref: z.string().trim().min(1).max(240),
  rule: z.string().trim().min(1).max(20_000),
  required_evidence_kinds: z.array(z.enum(["agent_run", "artifact", "project_event"])).max(3),
}).strict()

function latestSelection(
  db: TxOrDb,
  targetType: "benchmark" | "agent_interest" | "workflow",
  companyId: string,
  targetId: string,
) {
  if (targetType === "benchmark")
    return db.select().from(CompanyLearningBenchmarkTargetSelectionTable)
      .where(and(
        eq(CompanyLearningBenchmarkTargetSelectionTable.company_id, companyId),
        eq(CompanyLearningBenchmarkTargetSelectionTable.target_id, targetId),
      ))
      .orderBy(desc(CompanyLearningBenchmarkTargetSelectionTable.selected_at)).get()
  if (targetType === "agent_interest")
    return db.select().from(CompanyLearningInterestTargetSelectionTable)
      .where(and(
        eq(CompanyLearningInterestTargetSelectionTable.company_id, companyId),
        eq(CompanyLearningInterestTargetSelectionTable.agent_id, targetId),
      ))
      .orderBy(desc(CompanyLearningInterestTargetSelectionTable.selected_at)).get()
  return db.select().from(CompanyLearningWorkflowTargetSelectionTable)
    .where(and(
      eq(CompanyLearningWorkflowTargetSelectionTable.company_id, companyId),
      eq(CompanyLearningWorkflowTargetSelectionTable.target_id, targetId),
    ))
    .orderBy(desc(CompanyLearningWorkflowTargetSelectionTable.selected_at)).get()
}

export function validateRealTarget(
  db: TxOrDb,
  companyId: string,
  targetType: LearningPatchTargetType,
  targetId: string,
  proposedDiff: Record<string, unknown>,
) {
  if (targetType === "governance_asset") {
    const value = GovernanceTarget.parse(proposedDiff)
    const latest = db.select().from(GovernanceAssetTable)
      .where(and(eq(GovernanceAssetTable.company_id, companyId), eq(GovernanceAssetTable.id, targetId)))
      .orderBy(desc(GovernanceAssetTable.version)).get()
    if ((latest?.version ?? undefined) !== value.base_version)
      throw new Error("Governance Asset Patch base version is stale or missing")
    return value
  }
  if (targetType === "benchmark") {
    const value = BenchmarkTarget.parse(proposedDiff)
    if (value.dataset_version !== targetId) throw new Error("Benchmark Patch target must equal its dataset version")
    return value
  }
  if (targetType === "agent_interest") {
    const value = InterestTarget.parse(proposedDiff)
    const agent = db.select().from(CompanyAgentTable)
      .where(and(
        eq(CompanyAgentTable.id, targetId),
        eq(CompanyAgentTable.company_id, CompanyID.parse(companyId)),
      )).get()
    if (!agent) throw new Error("Agent Interest Patch target was not found in the company")
    return value
  }
  if (targetType === "workflow") return WorkflowTarget.parse(proposedDiff)
  return proposedDiff
}

export function activateRealTarget(
  db: TxOrDb,
  patch: typeof CompanyLearningPatchTable.$inferSelect,
  actorId: string,
) {
  const payload = validateRealTarget(
    db,
    patch.company_id,
    patch.target_type as LearningPatchTargetType,
    patch.target_id,
    JSON.parse(patch.proposed_diff_json),
  )
  const now = Date.now()
  if (patch.target_type === "governance_asset") {
    const value = GovernanceTarget.parse(payload)
    const assetVersion = (value.base_version ?? 0) + 1
    db.insert(GovernanceAssetTable).values({
      id: patch.target_id,
      company_id: patch.company_id,
      type: value.governance_type,
      scope_kind: value.scope.kind,
      scope_ref: value.scope.ref ?? null,
      content: value.content,
      rationale: value.rationale,
      tags_json: JSON.stringify(value.tags),
      authority: value.asset_type === "company_belief" ? "board_confirmed" : "human_confirmed",
      status: "active",
      source_refs_json: JSON.stringify([
        ...value.source_refs,
        { kind: "decision", id: patch.source_decision_id },
        { kind: "outcome", id: patch.source_outcome_id },
      ].filter((item, index, items) =>
        items.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index
      )),
      supersedes_version: value.base_version ?? null,
      version: assetVersion,
      created_by: patch.created_by,
      approved_by: patch.approved_by,
      approved_at: now,
      confirmation_event_id: patch.approval_gate_id,
      created_at: now,
    }).run()
    db.insert(GovernanceAssetSelectionTable).values({
      id: Identifier.create("gasel", "ascending"),
      company_id: patch.company_id,
      asset_id: patch.target_id,
      asset_version: assetVersion,
      previous_version: value.base_version ?? null,
      selected_by: actorId,
      created_at: now,
    }).run()
    return { ref: `${patch.target_id}:${assetVersion}`, version: assetVersion, payload: value }
  }
  if (patch.target_type === "benchmark") {
    const value = BenchmarkTarget.parse(payload)
    const targetVersion = (db.select({ version: CompanyLearningBenchmarkTargetVersionTable.version })
      .from(CompanyLearningBenchmarkTargetVersionTable)
      .where(and(
        eq(CompanyLearningBenchmarkTargetVersionTable.company_id, patch.company_id),
        eq(CompanyLearningBenchmarkTargetVersionTable.target_id, patch.target_id),
      ))
      .orderBy(desc(CompanyLearningBenchmarkTargetVersionTable.version)).get()?.version ?? 0) + 1
    const id = Identifier.ascending("learningBenchmarkTarget")
    const previous = latestSelection(db, "benchmark", patch.company_id, patch.target_id)
    db.insert(CompanyLearningBenchmarkTargetVersionTable).values({
      id,
      patch_id: patch.id,
      company_id: patch.company_id,
      target_id: patch.target_id,
      version: targetVersion,
      payload_json: JSON.stringify(value),
      created_by: actorId,
      created_at: now,
    }).run()
    db.insert(CompanyLearningBenchmarkTargetSelectionTable).values({
      id: Identifier.ascending("learningBenchmarkSelection"),
      company_id: patch.company_id,
      target_id: patch.target_id,
      version_id: id,
      previous_version_id: previous?.version_id ?? null,
      selected_by: actorId,
      selected_at: now,
    }).run()
    return { ref: id, version: targetVersion, payload: value }
  }
  if (patch.target_type === "agent_interest") {
    const value = InterestTarget.parse(payload)
    const nextVersion = (db.select({ version: CompanyLearningInterestTargetVersionTable.version })
      .from(CompanyLearningInterestTargetVersionTable)
      .where(and(
        eq(CompanyLearningInterestTargetVersionTable.company_id, patch.company_id),
        eq(CompanyLearningInterestTargetVersionTable.agent_id, patch.target_id),
      ))
      .orderBy(desc(CompanyLearningInterestTargetVersionTable.version)).get()?.version ?? 0) + 1
    const previous = latestSelection(db, "agent_interest", patch.company_id, patch.target_id)
    const current = !previous ? db.select().from(CompanyAgentInterestProfileTable).where(and(
      eq(CompanyAgentInterestProfileTable.agent_id, patch.target_id),
      eq(CompanyAgentInterestProfileTable.company_id, patch.company_id),
    )).get() : undefined
    const baselineId = current ? Identifier.ascending("learningInterestTarget") : undefined
    if (current)
      db.insert(CompanyLearningInterestTargetVersionTable).values({
        id: baselineId!,
        patch_id: patch.id,
        company_id: patch.company_id,
        agent_id: patch.target_id,
        version: nextVersion,
        payload_json: JSON.stringify(InterestTarget.parse({
          topics: JSON.parse(current.topics_json),
          preferred_lenses: JSON.parse(current.preferred_lenses_json),
          excluded_topics: JSON.parse(current.excluded_topics_json),
          novelty_threshold: current.novelty_threshold,
          weekly_reading_budget: current.weekly_reading_budget,
          max_concurrency: current.max_concurrency,
          privacy_scopes: JSON.parse(current.privacy_scopes_json),
        })),
        created_by: actorId,
        created_at: now,
      }).run()
    const targetVersion = nextVersion + (current ? 1 : 0)
    const id = Identifier.ascending("learningInterestTarget")
    db.insert(CompanyLearningInterestTargetVersionTable).values({
      id,
      patch_id: patch.id,
      company_id: patch.company_id,
      agent_id: patch.target_id,
      version: targetVersion,
      payload_json: JSON.stringify(value),
      created_by: actorId,
      created_at: now,
    }).run()
    db.insert(CompanyLearningInterestTargetSelectionTable).values({
      id: Identifier.ascending("learningInterestSelection"),
      company_id: patch.company_id,
      agent_id: patch.target_id,
      version_id: id,
      previous_version_id: previous?.version_id ?? baselineId ?? null,
      selected_by: actorId,
      selected_at: now,
    }).run()
    db.insert(CompanyAgentInterestProfileTable).values({
      agent_id: patch.target_id,
      company_id: patch.company_id,
      topics_json: JSON.stringify(value.topics),
      preferred_lenses_json: JSON.stringify(value.preferred_lenses),
      excluded_topics_json: JSON.stringify(value.excluded_topics),
      novelty_threshold: value.novelty_threshold,
      weekly_reading_budget: value.weekly_reading_budget,
      max_concurrency: value.max_concurrency,
      privacy_scopes_json: JSON.stringify(value.privacy_scopes),
      updated_at: now,
    }).onConflictDoUpdate({
      target: CompanyAgentInterestProfileTable.agent_id,
      set: {
        topics_json: JSON.stringify(value.topics),
        preferred_lenses_json: JSON.stringify(value.preferred_lenses),
        excluded_topics_json: JSON.stringify(value.excluded_topics),
        novelty_threshold: value.novelty_threshold,
        weekly_reading_budget: value.weekly_reading_budget,
        max_concurrency: value.max_concurrency,
        privacy_scopes_json: JSON.stringify(value.privacy_scopes),
        updated_at: now,
      },
    }).run()
    return { ref: id, version: targetVersion, payload: value }
  }
  if (patch.target_type !== "workflow") return
  const value = WorkflowTarget.parse(payload)
  const targetVersion = (db.select({ version: CompanyLearningWorkflowTargetVersionTable.version })
    .from(CompanyLearningWorkflowTargetVersionTable)
    .where(and(
      eq(CompanyLearningWorkflowTargetVersionTable.company_id, patch.company_id),
      eq(CompanyLearningWorkflowTargetVersionTable.target_id, patch.target_id),
    ))
    .orderBy(desc(CompanyLearningWorkflowTargetVersionTable.version)).get()?.version ?? 0) + 1
  const id = Identifier.ascending("learningWorkflowTarget")
  const previous = latestSelection(db, "workflow", patch.company_id, patch.target_id)
  db.insert(CompanyLearningWorkflowTargetVersionTable).values({
    id,
    patch_id: patch.id,
    company_id: patch.company_id,
    target_id: patch.target_id,
    version: targetVersion,
    payload_json: JSON.stringify(value),
    created_by: actorId,
    created_at: now,
  }).run()
  db.insert(CompanyLearningWorkflowTargetSelectionTable).values({
    id: Identifier.ascending("learningWorkflowSelection"),
    company_id: patch.company_id,
    target_id: patch.target_id,
    version_id: id,
    previous_version_id: previous?.version_id ?? null,
    selected_by: actorId,
    selected_at: now,
  }).run()
  return { ref: id, version: targetVersion, payload: value }
}

export function activeBenchmarkTarget(db: TxOrDb, companyId: string, targetId: string) {
  const selection = latestSelection(db, "benchmark", companyId, targetId)
  if (!selection?.version_id) return
  const row = db.select().from(CompanyLearningBenchmarkTargetVersionTable)
    .where(eq(CompanyLearningBenchmarkTargetVersionTable.id, selection.version_id)).get()
  return row ? { ...row, payload: BenchmarkTarget.parse(JSON.parse(row.payload_json)) } : undefined
}

export function attachPlanningTargetRefs(db: TxOrDb, receiptId: string) {
  const receipt = db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, receiptId)).get()
  if (!receipt) return
  const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, receipt.project_id)).get()
  if (!project?.company_id) return
  const refs = z.array(z.object({ kind: z.string(), id: z.string() }).catchall(z.unknown()))
    .parse(JSON.parse(receipt.evidence_refs_json))
  const existingKinds = new Set(refs.map((reference) => reference.kind))
  const targets = db.select().from(CompanyPatchTargetVersionTable)
    .where(and(
      eq(CompanyPatchTargetVersionTable.company_id, project.company_id),
      eq(CompanyPatchTargetVersionTable.status, "active"),
    ))
    .orderBy(desc(CompanyPatchTargetVersionTable.version)).all()
    .filter((item, index, items) =>
      items.findIndex((candidate) =>
        candidate.target_type === item.target_type && candidate.target_id === item.target_id
      ) === index
    )
  const referencedTargets = targets.filter((target) => refs.some((reference) =>
    reference.kind === "learning_target_version"
    && reference.id === target.id
    && reference.target_type === target.target_type
    && reference.target_id === target.target_id
    && reference.version === target.version
  ))
  referencedTargets.filter((target) => target.target_type === "workflow").forEach((target) => {
    const payload = WorkflowTarget.parse(resolveRealTargetPayload(db, "workflow", target.target_version_ref))
    if (
      !refs.some((reference) => reference.id === payload.validator_ref)
      || payload.required_evidence_kinds.some((kind) => !existingKinds.has(kind))
    )
      throw new Error(`Workflow rule ${payload.rule} requires missing persisted validator evidence`)
  })
  referencedTargets.forEach((target) =>
    db.insert(CompanyWorkReceiptLearningTargetRefTable).values({
      receipt_id: receipt.id,
      target_version_id: target.id,
      target_type: target.target_type,
      target_id: target.target_id,
      version: target.version,
      created_at: Date.now(),
    }).onConflictDoNothing().run()
  )
}

export function resolveRealTargetPayload(
  db: TxOrDb,
  targetType: LearningPatchTargetType,
  targetVersionRef: string | null,
) {
  if (!targetVersionRef) return
  if (targetType === "governance_asset") {
    const [id, rawVersion] = targetVersionRef.split(":")
    const row = db.select().from(GovernanceAssetTable).where(and(
      eq(GovernanceAssetTable.id, id!),
      eq(GovernanceAssetTable.version, Number(rawVersion)),
    )).get()
    return row
      ? {
          content: row.content,
          rationale: row.rationale,
          tags: JSON.parse(row.tags_json),
          authority: row.authority,
          status: row.status,
        }
      : undefined
  }
  if (targetType === "benchmark") {
    const row = db.select().from(CompanyLearningBenchmarkTargetVersionTable)
      .where(eq(CompanyLearningBenchmarkTargetVersionTable.id, targetVersionRef)).get()
    if (!row) throw new Error("Benchmark target version was not found")
    return JSON.parse(row.payload_json)
  }
  if (targetType === "agent_interest") {
    const row = db.select().from(CompanyLearningInterestTargetVersionTable)
      .where(eq(CompanyLearningInterestTargetVersionTable.id, targetVersionRef)).get()
    if (!row) throw new Error("Agent Interest target version was not found")
    return JSON.parse(row.payload_json)
  }
  if (targetType === "workflow") {
    const row = db.select().from(CompanyLearningWorkflowTargetVersionTable)
      .where(eq(CompanyLearningWorkflowTargetVersionTable.id, targetVersionRef)).get()
    if (!row) throw new Error("Workflow target version was not found")
    return JSON.parse(row.payload_json)
  }
  return
}

export function rollbackRealTarget(
  db: TxOrDb,
  patch: typeof CompanyLearningPatchTable.$inferSelect,
  actorId: string,
) {
  const applied = db.select().from(CompanyPatchTargetVersionTable)
    .where(eq(CompanyPatchTargetVersionTable.patch_id, patch.id))
    .orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
  if (!applied?.target_version_ref) return
  const now = Date.now()
  if (patch.target_type === "governance_asset") {
    const [assetId, rawVersion] = applied.target_version_ref.split(":")
    const version = Number(rawVersion)
    const current = db.select().from(GovernanceAssetTable).where(and(
      eq(GovernanceAssetTable.id, assetId!),
      eq(GovernanceAssetTable.version, version),
    )).get()
    if (!current) throw new Error("Activated Governance Asset version was not found")
    if (current.supersedes_version) {
      const previous = db.select().from(GovernanceAssetTable).where(and(
        eq(GovernanceAssetTable.id, assetId!),
        eq(GovernanceAssetTable.version, current.supersedes_version),
      )).get()
      if (!previous) throw new Error("Previous Governance Asset version was not found")
      db.insert(GovernanceAssetTable).values({
        ...previous,
        version: version + 1,
        supersedes_version: version,
        created_by: actorId,
        approved_by: actorId,
        approved_at: now,
        created_at: now,
      }).run()
      db.insert(GovernanceAssetSelectionTable).values({
        id: Identifier.create("gasel", "ascending"),
        company_id: patch.company_id,
        asset_id: assetId!,
        asset_version: version + 1,
        previous_version: version,
        selected_by: actorId,
        created_at: now,
      }).run()
      return { ref: `${assetId}:${version + 1}`, version: version + 1 }
    }
    db.insert(GovernanceAssetTable).values({
      ...current,
      version: version + 1,
      status: "deprecated",
      supersedes_version: version,
      created_by: actorId,
      approved_by: actorId,
      approved_at: now,
      created_at: now,
    }).run()
    db.insert(GovernanceAssetSelectionTable).values({
      id: Identifier.create("gasel", "ascending"),
      company_id: patch.company_id,
      asset_id: assetId!,
      asset_version: version + 1,
      previous_version: version,
      selected_by: actorId,
      created_at: now,
    }).run()
    return { ref: null, version: version + 1 }
  }
  const targetType = patch.target_type as "benchmark" | "agent_interest" | "workflow"
  const selection = latestSelection(db, targetType, patch.company_id, patch.target_id)
  if (!selection) throw new Error("Learning target selection was not found")
  if (targetType === "benchmark") {
    db.insert(CompanyLearningBenchmarkTargetSelectionTable).values({
      id: Identifier.ascending("learningBenchmarkSelection"),
      company_id: patch.company_id,
      target_id: patch.target_id,
      version_id: selection.previous_version_id,
      previous_version_id: selection.version_id,
      selected_by: actorId,
      selected_at: now,
    }).run()
    if (!selection.previous_version_id) return { ref: null, version: 0 }
    const previous = db.select().from(CompanyLearningBenchmarkTargetVersionTable)
      .where(eq(CompanyLearningBenchmarkTargetVersionTable.id, selection.previous_version_id)).get()
    if (!previous) throw new Error("Previous Benchmark target version was not found")
    return { ref: previous.id, version: previous.version }
  }
  if (targetType === "workflow") {
    db.insert(CompanyLearningWorkflowTargetSelectionTable).values({
      id: Identifier.ascending("learningWorkflowSelection"),
      company_id: patch.company_id,
      target_id: patch.target_id,
      version_id: selection.previous_version_id,
      previous_version_id: selection.version_id,
      selected_by: actorId,
      selected_at: now,
    }).run()
    if (!selection.previous_version_id) return { ref: null, version: 0 }
    const previous = db.select().from(CompanyLearningWorkflowTargetVersionTable)
      .where(eq(CompanyLearningWorkflowTargetVersionTable.id, selection.previous_version_id)).get()
    if (!previous) throw new Error("Previous Workflow target version was not found")
    return { ref: previous.id, version: previous.version }
  }
  if (!selection.previous_version_id) {
    db.insert(CompanyLearningInterestTargetSelectionTable).values({
      id: Identifier.ascending("learningInterestSelection"),
      company_id: patch.company_id,
      agent_id: patch.target_id,
      version_id: null,
      previous_version_id: selection.version_id,
      selected_by: actorId,
      selected_at: now,
    }).run()
    db.delete(CompanyAgentInterestProfileTable).where(and(
      eq(CompanyAgentInterestProfileTable.agent_id, patch.target_id),
      eq(CompanyAgentInterestProfileTable.company_id, patch.company_id),
    )).run()
    return { ref: null, version: 0 }
  }
  const previous = db.select().from(CompanyLearningInterestTargetVersionTable)
    .where(eq(CompanyLearningInterestTargetVersionTable.id, selection.previous_version_id)).get()
  if (!previous) throw new Error("Previous Agent Interest target version was not found")
  const payload = InterestTarget.parse(JSON.parse(previous.payload_json))
  db.insert(CompanyLearningInterestTargetSelectionTable).values({
    id: Identifier.ascending("learningInterestSelection"),
    company_id: patch.company_id,
    agent_id: patch.target_id,
    version_id: previous.id,
    previous_version_id: selection.version_id,
    selected_by: actorId,
    selected_at: now,
  }).run()
  db.update(CompanyAgentInterestProfileTable).set({
    topics_json: JSON.stringify(payload.topics),
    preferred_lenses_json: JSON.stringify(payload.preferred_lenses),
    excluded_topics_json: JSON.stringify(payload.excluded_topics),
    novelty_threshold: payload.novelty_threshold,
    weekly_reading_budget: payload.weekly_reading_budget,
    max_concurrency: payload.max_concurrency,
    privacy_scopes_json: JSON.stringify(payload.privacy_scopes),
    updated_at: now,
  }).where(and(
    eq(CompanyAgentInterestProfileTable.agent_id, patch.target_id),
    eq(CompanyAgentInterestProfileTable.company_id, patch.company_id),
  )).run()
  return { ref: previous.id, version: previous.version }
}
