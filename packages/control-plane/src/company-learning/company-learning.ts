import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import z from "zod"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { CompanyTable } from "@/company/company.sql"
import { AgentRunTable, SkillSnapshotTable } from "@/agent-run/agent-run.sql"
import { CompanyCommonsSourceTable } from "@/company-commons/company-commons.sql"
import { CompanyInterpretationTable } from "@/company-reading/company-reading.sql"
import {
  CompanyArtifactTable,
  CompanyOutcomeSignalTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import * as FounderAuthority from "@/founder-os/authority"
import * as FounderOSMode from "@/founder-os/mode"
import {
  DecisionCurrentProjectionTable,
  DecisionRecordTable,
  DelegationPolicyTable,
} from "@/founder-os/decision-ledger.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyBeliefEvidenceTable,
  CompanyBeliefInterpretationTable,
  CompanyBeliefTable,
  CompanyExperimentOutcomeTable,
  CompanyExperimentTable,
  CompanyLearningPatchTable,
  CompanyPatchBenchmarkTable,
  CompanyPatchCanaryTable,
  CompanyPatchEventTable,
  CompanyPatchTargetVersionTable,
  CompanySkillCandidateSnapshotTable,
  CompanyWorkReceiptLearningTargetRefTable,
} from "./company-learning.sql"
import {
  activateRealTarget,
  resolveRealTargetPayload,
  rollbackRealTarget,
  validateRealTarget,
} from "./target-adapters"
import {
  Belief,
  BeliefAdoptionInput,
  BeliefCandidateInput,
  BeliefComparison,
  BeliefEvidence,
  BeliefEvidenceAppendInput,
  Experiment,
  ExperimentActionInput,
  ExperimentProposalInput,
  ActiveLearningTarget,
  LearningEvidencePackage,
  LearningPatch,
  LearningPatchActionInput,
  LearningPatchProposalInput,
  PatchBenchmark,
  PatchCanary,
  type Belief as BeliefValue,
  type BeliefAdoptionInput as BeliefAdoptionInputValue,
  type BeliefCandidateInput as BeliefCandidateInputValue,
  type BeliefComparison as BeliefComparisonValue,
  type BeliefEvidenceAppendInput as BeliefEvidenceAppendInputValue,
  type Experiment as ExperimentValue,
  type ExperimentActionInput as ExperimentActionInputValue,
  type ExperimentProposalInput as ExperimentProposalInputValue,
  type ActiveLearningTarget as ActiveLearningTargetValue,
  type LearningEvidencePackage as LearningEvidencePackageValue,
  type LearningPatch as LearningPatchValue,
  type LearningPatchActionInput as LearningPatchActionInputValue,
  type LearningPatchProposalInput as LearningPatchProposalInputValue,
  type LearningPatchTargetType,
} from "./schema"

const json = <A>(value: string) => JSON.parse(value) as A

function evidenceFromRow(row: typeof CompanyBeliefEvidenceTable.$inferSelect) {
  return BeliefEvidence.parse(row)
}

function benchmarkFromRow(row: typeof CompanyPatchBenchmarkTable.$inferSelect) {
  return PatchBenchmark.parse({
    ...row,
    holdout_manifest: json(row.holdout_manifest_json),
    evidence_refs: json(row.evidence_refs_json),
  })
}

function canaryFromRow(row: typeof CompanyPatchCanaryTable.$inferSelect) {
  return PatchCanary.parse({
    ...row,
    metric_evidence_refs: json(row.metric_evidence_refs_json),
  })
}

function beliefFromRow(db: TxOrDb, row: typeof CompanyBeliefTable.$inferSelect) {
  return Belief.parse({
    ...row,
    scope: json(row.scope_json),
    applicable_scopes: json(row.applicable_scopes_json),
    inapplicable_scopes: json(row.inapplicable_scopes_json),
    action_implications: json(row.action_implications_json),
    interpretation_refs: db
      .select()
      .from(CompanyBeliefInterpretationTable)
      .where(eq(CompanyBeliefInterpretationTable.belief_id, row.id))
      .orderBy(asc(CompanyBeliefInterpretationTable.interpretation_id))
      .all(),
    evidence: db
      .select()
      .from(CompanyBeliefEvidenceTable)
      .where(eq(CompanyBeliefEvidenceTable.belief_id, row.id))
      .orderBy(asc(CompanyBeliefEvidenceTable.created_at), asc(CompanyBeliefEvidenceTable.id))
      .all()
      .map(evidenceFromRow),
    experiment_ids: db
      .select({ id: CompanyExperimentTable.id })
      .from(CompanyExperimentTable)
      .where(eq(CompanyExperimentTable.belief_id, row.id))
      .orderBy(asc(CompanyExperimentTable.created_at), asc(CompanyExperimentTable.id))
      .all()
      .map((item) => item.id),
  })
}

function experimentFromRow(db: TxOrDb, row: typeof CompanyExperimentTable.$inferSelect) {
  return Experiment.parse({
    ...row,
    decision_intent: json(row.decision_intent_json),
    success_criteria: json(row.success_criteria_json),
    failure_criteria: json(row.failure_criteria_json),
    outcome_signal_ids: db
      .select({ id: CompanyExperimentOutcomeTable.outcome_signal_id })
      .from(CompanyExperimentOutcomeTable)
      .where(eq(CompanyExperimentOutcomeTable.experiment_id, row.id))
      .orderBy(asc(CompanyExperimentOutcomeTable.linked_at))
      .all()
      .map((item) => item.id),
  })
}

function patchFromRow(db: TxOrDb, row: typeof CompanyLearningPatchTable.$inferSelect) {
  return LearningPatch.parse({
    ...row,
    proposed_diff: json(row.proposed_diff_json),
    evidence: json(row.evidence_json),
    benchmarks: db
      .select()
      .from(CompanyPatchBenchmarkTable)
      .where(eq(CompanyPatchBenchmarkTable.patch_id, row.id))
      .orderBy(asc(CompanyPatchBenchmarkTable.version))
      .all()
      .map(benchmarkFromRow),
    canaries: db
      .select()
      .from(CompanyPatchCanaryTable)
      .where(eq(CompanyPatchCanaryTable.patch_id, row.id))
      .orderBy(asc(CompanyPatchCanaryTable.started_at))
      .all()
      .map(canaryFromRow),
  })
}

function requireCompany(db: TxOrDb, company_id: string) {
  const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, company_id)).get()
  if (!company) throw new Error("Company was not found")
  return company
}

function requireBeliefLoopMode(db: TxOrDb, company_id: string) {
  const company = requireCompany(db, company_id)
  const mode = FounderOSMode.resolve({
    founderTwinMode: company.founder_twin_mode,
    companyCommonsMode: company.company_commons_mode,
  }).effective.companyCommonsMode
  if (mode !== "belief-loop")
    throw new Error(`Company Commons effective mode ${mode} does not allow Belief Loop writes`)
}

function persistedEvidenceRef(db: TxOrDb, ref: string, company_id: string) {
  const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, ref)).get()
  if (decision) return decision.company_id === company_id
  const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, ref)).get()
  if (artifact?.company_id) return artifact.company_id === company_id && artifact.scope_type !== "private"
  const project_id =
    db.select({ project_id: CompanyOutcomeSignalTable.project_id }).from(CompanyOutcomeSignalTable)
      .innerJoin(
        CompanyOutcomeSignalCurrentTable,
        eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
      )
      .where(and(
        eq(CompanyOutcomeSignalTable.id, ref),
        eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
      )).get()?.project_id ??
    artifact?.project_id ??
    db.select({ project_id: CompanyValidationGateTable.project_id }).from(CompanyValidationGateTable)
      .where(eq(CompanyValidationGateTable.id, ref)).get()?.project_id ??
    db.select({ project_id: CompanyWorkReceiptTable.project_id }).from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.id, ref)).get()?.project_id
  if (!project_id) return false
  return db.select().from(CompanyProjectTable).where(and(
    eq(CompanyProjectTable.id, project_id),
    eq(CompanyProjectTable.company_id, company_id),
  )).get() !== undefined
}

function validateBeliefEvidenceRef(
  db: TxOrDb,
  belief: typeof CompanyBeliefTable.$inferSelect,
  input: BeliefEvidenceAppendInputValue,
) {
  if (input.source_kind === "external") return
  if (input.source_kind === "interpretation") {
    const interpretation = db.select().from(CompanyInterpretationTable)
      .where(eq(CompanyInterpretationTable.id, input.source_ref)).get()
    if (!interpretation || interpretation.source_id !== belief.source_id)
      throw new Error("Belief Interpretation evidence must resolve to the same source")
    return
  }
  if (input.source_kind === "decision") {
    const decision = db.select().from(DecisionRecordTable)
      .where(eq(DecisionRecordTable.id, input.source_ref)).get()
    if (!decision || decision.company_id !== belief.company_id)
      throw new Error("Belief Decision evidence must belong to the same company")
    return
  }
  if (!persistedEvidenceRef(db, input.source_ref, belief.company_id))
    throw new Error("Belief evidence reference was not found in persisted execution facts")
}

function validatePatchAdapter(
  db: TxOrDb,
  company_id: string,
  target_type: LearningPatchTargetType,
  target_id: string,
  proposed_diff: Record<string, unknown>,
) {
  if (["governance_asset", "benchmark", "agent_interest", "workflow"].includes(target_type))
    return validateRealTarget(db, company_id, target_type, target_id, proposed_diff)
  if (target_type === "delegation_policy") {
    const current = db
      .select()
      .from(DelegationPolicyTable)
      .where(eq(DelegationPolicyTable.id, target_id))
      .get()
    if (!current) throw new Error("Delegation Policy target was not found")
    const latest = db.select().from(DelegationPolicyTable).where(and(
      eq(DelegationPolicyTable.company_id, current.company_id),
      eq(DelegationPolicyTable.action_type, current.action_type),
      eq(DelegationPolicyTable.scope_key, current.scope_key),
    )).orderBy(desc(DelegationPolicyTable.version)).get()!
    const allowedMode = z.enum(["advisor", "green_delegated", "yellow_delegated", "none"]).parse(proposed_diff.allowed_mode)
    const rank = { none: -1, advisor: -1, green_delegated: 0, yellow_delegated: 1 } as const
    if (rank[allowedMode] > rank[latest.allowed_mode as keyof typeof rank])
      throw new Error("Delegation Policy Patch cannot expand the current mode cap")
    return { allowed_mode: allowedMode, current_policy_id: latest.id }
  }
  if (target_type === "skill") {
    return {
      candidate_content: z.string().trim().min(1).max(200_000).parse(proposed_diff.candidate_content),
    }
  }
  return proposed_diff
}

function targetAuthority(target_type: LearningPatchTargetType, proposed_diff: Record<string, unknown>) {
  if (target_type === "governance_asset" || target_type === "delegation_policy") return "red" as const
  if (target_type === "benchmark" && proposed_diff.affects_authority_or_release_gate === true) return "red" as const
  return "yellow" as const
}

function patchEvent(
  db: TxOrDb,
  patch_id: string,
  type: string,
  actor_id: string,
  data: Record<string, unknown> = {},
) {
  db.insert(CompanyPatchEventTable).values({
    id: Identifier.ascending("patchEvent"),
    patch_id,
    type,
    actor_id,
    data_json: JSON.stringify(data),
    created_at: Date.now(),
  }).run()
}

function appendDelegationPolicyVersion(
  db: TxOrDb,
  patch: typeof CompanyLearningPatchTable.$inferSelect,
) {
  const current = db.select().from(DelegationPolicyTable).where(eq(DelegationPolicyTable.id, patch.target_id)).get()
  if (!current) throw new Error("Delegation Policy target was not found")
  const proposed = json<Record<string, unknown>>(patch.proposed_diff_json)
  const allowed_mode = z.enum(["advisor", "green_delegated", "yellow_delegated", "none"]).parse(proposed.allowed_mode)
  const latest = db
    .select()
    .from(DelegationPolicyTable)
    .where(and(
      eq(DelegationPolicyTable.company_id, current.company_id),
      eq(DelegationPolicyTable.action_type, current.action_type),
      eq(DelegationPolicyTable.scope_key, current.scope_key),
    ))
    .orderBy(desc(DelegationPolicyTable.version))
    .get()!
  const rank = { none: -1, advisor: -1, green_delegated: 0, yellow_delegated: 1 } as const
  if (rank[allowed_mode] > rank[latest.allowed_mode as keyof typeof rank])
    throw new Error("Delegation Policy Patch cannot expand the current mode cap")
  db.insert(DelegationPolicyTable).values({
    ...latest,
    id: `fpol_${patch.id}_v${latest.version + 1}`,
    allowed_mode,
    requires_approval: allowed_mode === "none" || latest.requires_approval,
    version: latest.version + 1,
    created_at: Date.now(),
  }).run()
}

function rollbackDelegationPolicy(
  db: TxOrDb,
  patch: typeof CompanyLearningPatchTable.$inferSelect,
) {
  const current = db
    .select()
    .from(DelegationPolicyTable)
    .where(eq(DelegationPolicyTable.id, `fpol_${patch.id}_v${db
      .select()
      .from(DelegationPolicyTable)
      .where(eq(DelegationPolicyTable.company_id, patch.company_id))
      .orderBy(desc(DelegationPolicyTable.version))
      .get()?.version ?? 0}`))
    .get()
  const applied = current ?? db
    .select()
    .from(DelegationPolicyTable)
    .where(eq(DelegationPolicyTable.company_id, patch.company_id))
    .orderBy(desc(DelegationPolicyTable.version))
    .all()
    .find((item) => item.id.startsWith(`fpol_${patch.id}_v`))
  if (!applied) return
  const previous = db
    .select()
    .from(DelegationPolicyTable)
    .where(and(
      eq(DelegationPolicyTable.company_id, applied.company_id),
      eq(DelegationPolicyTable.action_type, applied.action_type),
      eq(DelegationPolicyTable.scope_key, applied.scope_key),
    ))
    .orderBy(desc(DelegationPolicyTable.version))
    .all()
    .find((item) => item.version < applied.version)
  if (!previous) throw new Error("Delegation Policy rollback source version was not found")
  const latest = db
    .select()
    .from(DelegationPolicyTable)
    .where(and(
      eq(DelegationPolicyTable.company_id, applied.company_id),
      eq(DelegationPolicyTable.action_type, applied.action_type),
      eq(DelegationPolicyTable.scope_key, applied.scope_key),
    ))
    .orderBy(desc(DelegationPolicyTable.version))
    .get()!
  db.insert(DelegationPolicyTable).values({
    ...previous,
    id: `fpol_${patch.id}_rollback_v${latest.version + 1}`,
    version: latest.version + 1,
    created_at: Date.now(),
  }).run()
}

export interface Interface {
  readonly compareInterpretations: (source_id: string, interpretation_ids: string[]) => Effect.Effect<BeliefComparisonValue>
  readonly createCandidate: (input: BeliefCandidateInputValue) => Effect.Effect<BeliefValue>
  readonly listBeliefs: (company_id: string) => Effect.Effect<BeliefValue[]>
  readonly appendEvidence: (belief_id: string, input: BeliefEvidenceAppendInputValue) => Effect.Effect<BeliefValue>
  readonly adoptBelief: (belief_id: string, input: BeliefAdoptionInputValue) => Effect.Effect<BeliefValue>
  readonly proposeExperiment: (input: ExperimentProposalInputValue) => Effect.Effect<ExperimentValue>
  readonly listExperiments: (company_id: string) => Effect.Effect<ExperimentValue[]>
  readonly actOnExperiment: (experiment_id: string, input: ExperimentActionInputValue) => Effect.Effect<ExperimentValue>
  readonly proposePatch: (input: LearningPatchProposalInputValue) => Effect.Effect<LearningPatchValue>
  readonly listPatches: (company_id: string) => Effect.Effect<LearningPatchValue[]>
  readonly actOnPatch: (patch_id: string, input: LearningPatchActionInputValue) => Effect.Effect<LearningPatchValue>
  readonly evidencePackage: (company_id: string) => Effect.Effect<LearningEvidencePackageValue>
  readonly resolveTarget: (
    company_id: string,
    target_type: LearningPatchTargetType,
    target_id: string,
  ) => Effect.Effect<ActiveLearningTargetValue | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyLearning") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const governance = yield* FounderAuthority.GovernanceService

    const compareInterpretations = Effect.fn("CompanyLearning.compareInterpretations")(function* (
      source_id: string,
      interpretation_ids: string[],
    ) {
      const ids = z.array(z.string().trim().min(1)).min(2).max(100).parse(interpretation_ids)
      const rows = Database.use((db) =>
        db.select().from(CompanyInterpretationTable).where(inArray(CompanyInterpretationTable.id, ids)).all(),
      )
      if (rows.length !== new Set(ids).size || rows.some((row) => row.source_id !== source_id))
        throw new Error("Comparison requires existing Interpretations from the same source")
      const interpretation_refs = rows.map((row) => ({
        interpretation_id: row.id,
        position:
          row.agreement === "conflicted" || row.disposition === "reject"
            ? "counter" as const
            : row.agreement === "aligned" && row.disposition === "candidate"
              ? "supporting" as const
              : "context" as const,
      }))
      return BeliefComparison.parse({
        source_id,
        interpretation_refs,
        supporting_count: interpretation_refs.filter((item) => item.position === "supporting").length,
        counter_count: interpretation_refs.filter((item) => item.position === "counter").length,
        context_count: interpretation_refs.filter((item) => item.position === "context").length,
        candidate_only: true,
        adoption_requires_board_decision: true,
        automatic_verdict: null,
      })
    })

    const createCandidate = Effect.fn("CompanyLearning.createCandidate")(function* (raw: BeliefCandidateInputValue) {
      const input = BeliefCandidateInput.parse(raw)
      return Database.transaction((db) => {
        requireBeliefLoopMode(db, input.company_id)
        const source = db.select().from(CompanyCommonsSourceTable).where(eq(CompanyCommonsSourceTable.id, input.source_id)).get()
        if (!source || source.company_id !== input.company_id) throw new Error("Belief source does not belong to the company")
        const interpretations = db
          .select()
          .from(CompanyInterpretationTable)
          .where(inArray(CompanyInterpretationTable.id, input.interpretation_refs.map((item) => item.interpretation_id)))
          .all()
        if (interpretations.length !== input.interpretation_refs.length || interpretations.some((item) => item.source_id !== input.source_id))
          throw new Error("Candidate Belief requires same-source Interpretations")
        const positions = new Map(interpretations.map((row) => [
          row.id,
          row.agreement === "conflicted" || row.disposition === "reject"
            ? "counter"
            : row.agreement === "aligned" && row.disposition === "candidate"
              ? "supporting"
              : "context",
        ]))
        if (input.interpretation_refs.some((item) => positions.get(item.interpretation_id) !== item.position))
          throw new Error("Candidate Belief positions must match the Comparison Service")
        const now = Date.now()
        const id = Identifier.ascending("belief")
        db.insert(CompanyBeliefTable).values({
          id,
          company_id: input.company_id,
          source_id: input.source_id,
          statement: input.statement,
          scope_json: JSON.stringify([...new Set(input.scope)].sort()),
          applicable_scopes_json: JSON.stringify([...new Set(input.applicable_scopes)].sort()),
          inapplicable_scopes_json: JSON.stringify([...new Set(input.inapplicable_scopes)].sort()),
          confidence: input.confidence,
          status: "candidate",
          action_implications_json: JSON.stringify(input.action_implications),
          created_by: input.created_by,
          approved_by: null,
          board_decision_id: null,
          review_at: input.review_at ?? null,
          created_at: now,
          approved_at: null,
          updated_at: now,
        }).run()
        db.insert(CompanyBeliefInterpretationTable).values(
          input.interpretation_refs.map((item) => ({ belief_id: id, ...item })),
        ).run()
        const row = db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, id)).get()!
        return beliefFromRow(db, row)
      }, { behavior: "immediate" })
    })

    const listBeliefs = Effect.fn("CompanyLearning.listBeliefs")(function* (company_id: string) {
      return Database.use((db) =>
        db.select().from(CompanyBeliefTable)
          .where(eq(CompanyBeliefTable.company_id, company_id))
          .orderBy(desc(CompanyBeliefTable.updated_at), desc(CompanyBeliefTable.id))
          .all()
          .map((row) => beliefFromRow(db, row)),
      )
    })

    const appendEvidence = Effect.fn("CompanyLearning.appendEvidence")(function* (
      belief_id: string,
      raw: BeliefEvidenceAppendInputValue,
    ) {
      const input = BeliefEvidenceAppendInput.parse(raw)
      return Database.transaction((db) => {
        const belief = db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, belief_id)).get()
        if (!belief) throw new Error("Belief was not found")
        requireBeliefLoopMode(db, belief.company_id)
        validateBeliefEvidenceRef(db, belief, input)
        const existing = db.select().from(CompanyBeliefEvidenceTable).where(and(
          eq(CompanyBeliefEvidenceTable.belief_id, belief_id),
          eq(CompanyBeliefEvidenceTable.position, input.position),
          eq(CompanyBeliefEvidenceTable.source_kind, input.source_kind),
          eq(CompanyBeliefEvidenceTable.source_ref, input.source_ref),
        )).get()
        if (existing && (existing.summary !== input.summary || existing.created_by !== input.created_by))
          throw new Error("Belief evidence reference already exists with different facts")
        if (!existing)
          db.insert(CompanyBeliefEvidenceTable).values({
            id: Identifier.ascending("beliefEvidence"),
            belief_id,
            ...input,
            created_at: Date.now(),
          }).run()
        db.update(CompanyBeliefTable).set({
          status: input.position === "counter" && belief.status !== "adopted" ? "contested" : belief.status,
          updated_at: Date.now(),
        }).where(eq(CompanyBeliefTable.id, belief_id)).run()
        return beliefFromRow(db, db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, belief_id)).get()!)
      }, { behavior: "immediate" })
    })

    const adoptBelief = Effect.fn("CompanyLearning.adoptBelief")(function* (
      belief_id: string,
      raw: BeliefAdoptionInputValue,
    ) {
      const input = BeliefAdoptionInput.parse(raw)
      return Database.transaction((db) => {
        const belief = db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, belief_id)).get()
        const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, input.board_decision_id)).get()
        const projection = db.select().from(DecisionCurrentProjectionTable)
          .where(eq(DecisionCurrentProjectionTable.decision_id, input.board_decision_id)).get()
        if (!belief) throw new Error("Belief was not found")
        requireBeliefLoopMode(db, belief.company_id)
        if (
          !decision ||
          decision.company_id !== belief.company_id ||
          decision.record_origin !== "live" ||
          decision.decision_maker !== "board" ||
          decision.decision_maker_id !== input.approved_by
        )
          throw new Error("Belief adoption requires a Board DecisionRecord from the same company")
        if (
          !projection ||
          !["accepted", "executed"].includes(projection.current_status) ||
          projection.final_decision !== belief.statement
        )
          throw new Error("Belief adoption requires an accepted Board decision for the exact belief statement")
        const now = Date.now()
        db.update(CompanyBeliefTable).set({
          status: "adopted",
          approved_by: input.approved_by,
          board_decision_id: input.board_decision_id,
          approved_at: now,
          updated_at: now,
        }).where(eq(CompanyBeliefTable.id, belief_id)).run()
        return beliefFromRow(db, db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, belief_id)).get()!)
      }, { behavior: "immediate" })
    })

    const proposeExperiment = Effect.fn("CompanyLearning.proposeExperiment")(function* (
      raw: ExperimentProposalInputValue,
    ) {
      const input = ExperimentProposalInput.parse(raw)
      const facts = Database.use((db) => {
        requireBeliefLoopMode(db, input.company_id)
        const belief = db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, input.belief_id)).get()
        const project = db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, input.project_id)).get()
        const decision = db.select().from(DecisionRecordTable)
          .where(eq(DecisionRecordTable.id, input.decision_intent.decisionId)).get()
        if (!belief || belief.company_id !== input.company_id) throw new Error("Experiment Belief was not found")
        if (!project || project.company_id !== input.company_id) throw new Error("Experiment project was not found")
        if (!decision || decision.company_id !== input.company_id) throw new Error("Experiment DecisionIntent was not persisted")
        if (
          decision.recommendation !== input.decision_intent.recommendation ||
          decision.authority_class !== input.decision_intent.authorityClass ||
          decision.confidence !== input.decision_intent.confidence ||
          JSON.stringify(json<unknown[]>(decision.evidence_refs_json ?? "[]")) !== JSON.stringify(input.decision_intent.evidenceRefs)
        )
          throw new Error("Experiment DecisionIntent does not match the DecisionRecord")
        return { existing: db.select().from(CompanyExperimentTable).where(and(
          eq(CompanyExperimentTable.company_id, input.company_id),
          eq(CompanyExperimentTable.idempotency_key, input.idempotency_key),
        )).get() }
      })
      if (facts.existing) {
        if (
          facts.existing.belief_id !== input.belief_id ||
          facts.existing.project_id !== input.project_id ||
          facts.existing.decision_id !== input.decision_intent.decisionId ||
          facts.existing.hypothesis !== input.hypothesis ||
          facts.existing.decision_intent_json !== JSON.stringify(input.decision_intent)
        )
          throw new Error("Experiment idempotency key has different proposal facts")
        return Database.use((db) => experimentFromRow(db, facts.existing!))
      }
      const authority = yield* governance.submit({
        schemaVersion: 1,
        idempotencyKey: input.idempotency_key,
        decisionId: input.decision_intent.decisionId,
        actionType: "experiment.run.propose",
        proposedAuthorityClass: input.decision_intent.authorityClass,
        evidenceSufficient: input.decision_intent.evidenceRefs.length > 0,
        requestedBy: { kind: "agent", id: input.proposed_by },
      })
      return Database.transaction((db) => {
        const now = Date.now()
        const id = Identifier.ascending("experiment")
        db.insert(CompanyExperimentTable).values({
          id,
          company_id: input.company_id,
          belief_id: input.belief_id,
          project_id: input.project_id,
          decision_id: input.decision_intent.decisionId,
          idempotency_key: input.idempotency_key,
          decision_intent_json: JSON.stringify(input.decision_intent),
          hypothesis: input.hypothesis,
          success_criteria_json: JSON.stringify(input.success_criteria),
          failure_criteria_json: JSON.stringify(input.failure_criteria),
          rollback_plan: input.rollback_plan,
          status: authority.dispatchAllowed ? "authorized" : "proposed",
          verdict: "pending",
          authority_class: authority.authority.authorityClass,
          approval_gate_id: authority.gate?.id ?? null,
          proposed_by: input.proposed_by,
          created_at: now,
          updated_at: now,
          completed_at: null,
          evaluated_at: null,
        }).run()
        db.update(CompanyBeliefTable).set({ status: "experiment_pending", updated_at: now })
          .where(eq(CompanyBeliefTable.id, input.belief_id)).run()
        return experimentFromRow(db, db.select().from(CompanyExperimentTable).where(eq(CompanyExperimentTable.id, id)).get()!)
      }, { behavior: "immediate" })
    })

    const listExperiments = Effect.fn("CompanyLearning.listExperiments")(function* (company_id: string) {
      return Database.use((db) =>
        db.select().from(CompanyExperimentTable)
          .where(eq(CompanyExperimentTable.company_id, company_id))
          .orderBy(desc(CompanyExperimentTable.updated_at), desc(CompanyExperimentTable.id))
          .all()
          .map((row) => experimentFromRow(db, row)),
      )
    })

    const actOnExperiment = Effect.fn("CompanyLearning.actOnExperiment")(function* (
      experiment_id: string,
      raw: ExperimentActionInputValue,
    ) {
      const input = ExperimentActionInput.parse(raw)
      if (input.action === "refresh_authority") {
        const experiment = Database.use((db) =>
          db.select().from(CompanyExperimentTable).where(eq(CompanyExperimentTable.id, experiment_id)).get(),
        )
        if (!experiment) throw new Error("Experiment was not found")
        Database.use((db) => requireBeliefLoopMode(db, experiment.company_id))
        const intent = json<ExperimentProposalInputValue["decision_intent"]>(experiment.decision_intent_json)
        const authority = yield* governance.submit({
          schemaVersion: 1,
          idempotencyKey: input.idempotency_key,
          decisionId: experiment.decision_id,
          actionType: "experiment.run.propose",
          proposedAuthorityClass: intent.authorityClass,
          evidenceSufficient: intent.evidenceRefs.length > 0,
          requestedBy: { kind: "agent", id: input.actor_id },
        })
        Database.use((db) =>
          db.update(CompanyExperimentTable).set({
            status: authority.dispatchAllowed ? "authorized" : experiment.status,
            approval_gate_id: authority.gate?.id ?? experiment.approval_gate_id,
            authority_class: authority.authority.authorityClass,
            updated_at: Date.now(),
          }).where(eq(CompanyExperimentTable.id, experiment_id)).run(),
        )
      } else {
        Database.transaction((db) => {
          const experiment = db.select().from(CompanyExperimentTable).where(eq(CompanyExperimentTable.id, experiment_id)).get()
          if (!experiment) throw new Error("Experiment was not found")
          requireBeliefLoopMode(db, experiment.company_id)
          if (input.action === "start") {
            if (experiment.status !== "authorized") throw new Error("Experiment cannot start before Authority and Governance authorization")
            db.update(CompanyExperimentTable).set({ status: "running", updated_at: Date.now() })
              .where(eq(CompanyExperimentTable.id, experiment_id)).run()
            return
          }
          if (input.action === "complete") {
            if (experiment.status !== "running") throw new Error("Only a running Experiment can complete")
            const now = Date.now()
            db.update(CompanyExperimentTable).set({
              status: "completed",
              verdict: "pending",
              completed_at: now,
              updated_at: now,
            }).where(eq(CompanyExperimentTable.id, experiment_id)).run()
            return
          }
          if (input.action === "stop") {
            if (!["authorized", "running"].includes(experiment.status)) throw new Error("Experiment cannot be stopped from its current state")
            db.update(CompanyExperimentTable).set({ status: "stopped", updated_at: Date.now() })
              .where(eq(CompanyExperimentTable.id, experiment_id)).run()
            return
          }
          if (experiment.status !== "completed") throw new Error("Experiment completion is not an Outcome Signal")
          const outcome = db.select().from(CompanyOutcomeSignalTable)
            .innerJoin(
              CompanyOutcomeSignalCurrentTable,
              eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
            )
            .where(and(
              eq(CompanyOutcomeSignalTable.id, input.outcome_signal_id),
              eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
            )).get()?.company_outcome_signal
          if (!outcome || outcome.project_id !== experiment.project_id || outcome.decision_id !== experiment.decision_id)
            throw new Error("Outcome Signal must be real, project-matched, and linked to the Experiment decision")
          db.insert(CompanyExperimentOutcomeTable).values({
            experiment_id,
            outcome_signal_id: outcome.id,
            linked_by: input.actor_id,
            linked_at: Date.now(),
          }).onConflictDoNothing().run()
          const now = Date.now()
          db.update(CompanyExperimentTable).set({
            status: "evaluated",
            verdict: outcome.result === "succeeded" ? "supported" : outcome.result === "failed" ? "refuted" : "inconclusive",
            evaluated_at: now,
            updated_at: now,
          }).where(eq(CompanyExperimentTable.id, experiment_id)).run()
          db.update(CompanyBeliefTable).set({
            status: outcome.result === "inconclusive" ? "contested" : "validated",
            updated_at: now,
          }).where(eq(CompanyBeliefTable.id, experiment.belief_id)).run()
        }, { behavior: "immediate" })
      }
      return Database.use((db) => {
        const row = db.select().from(CompanyExperimentTable).where(eq(CompanyExperimentTable.id, experiment_id)).get()
        if (!row) throw new Error("Experiment was not found")
        return experimentFromRow(db, row)
      })
    })

    const proposePatch = Effect.fn("CompanyLearning.proposePatch")(function* (raw: LearningPatchProposalInputValue) {
      const input = LearningPatchProposalInput.parse(raw)
      return Database.transaction((db) => {
        requireBeliefLoopMode(db, input.company_id)
        const experiment = db.select().from(CompanyExperimentTable)
          .where(eq(CompanyExperimentTable.id, input.source_experiment_id)).get()
        const outcome = db.select().from(CompanyOutcomeSignalTable)
          .innerJoin(
            CompanyOutcomeSignalCurrentTable,
            eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
          )
          .where(and(
            eq(CompanyOutcomeSignalTable.id, input.source_outcome_id),
            eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
          )).get()?.company_outcome_signal
        const linked = db.select().from(CompanyExperimentOutcomeTable).where(and(
          eq(CompanyExperimentOutcomeTable.experiment_id, input.source_experiment_id),
          eq(CompanyExperimentOutcomeTable.outcome_signal_id, input.source_outcome_id),
        )).get()
        if (!experiment || experiment.company_id !== input.company_id || experiment.status !== "evaluated")
          throw new Error("Learning Patch requires an evaluated Experiment")
        if (!outcome || !linked || outcome.decision_id !== input.source_decision_id)
          throw new Error("Learning Patch requires the real Outcome Signal linked to its source Decision")
        if (!input.evidence.includes(input.source_outcome_id))
          throw new Error("Learning Patch evidence must include its source Outcome Signal")
        if (input.evidence.some((ref) => !persistedEvidenceRef(db, ref, input.company_id)))
          throw new Error("Learning Patch evidence must resolve to persisted execution facts")
        validatePatchAdapter(db, input.company_id, input.target_type, input.target_id, input.proposed_diff)
        const now = Date.now()
        const id = Identifier.ascending("learningPatch")
        db.insert(CompanyLearningPatchTable).values({
          id,
          company_id: input.company_id,
          source_decision_id: input.source_decision_id,
          source_experiment_id: input.source_experiment_id,
          source_outcome_id: input.source_outcome_id,
          target_type: input.target_type,
          target_id: input.target_id,
          proposed_diff_json: JSON.stringify(input.proposed_diff),
          evidence_json: JSON.stringify([...new Set(input.evidence)]),
          expected_impact: input.expected_impact,
          benchmark_plan: input.benchmark_plan,
          rollback_plan: input.rollback_plan,
          status: "proposed",
          authority_class: targetAuthority(input.target_type, input.proposed_diff),
          approval_gate_id: null,
          created_by: input.created_by,
          approved_by: null,
          created_at: now,
          updated_at: now,
        }).run()
        patchEvent(db, id, "proposed", input.created_by, { target_type: input.target_type })
        return patchFromRow(db, db.select().from(CompanyLearningPatchTable).where(eq(CompanyLearningPatchTable.id, id)).get()!)
      }, { behavior: "immediate" })
    })

    const listPatches = Effect.fn("CompanyLearning.listPatches")(function* (company_id: string) {
      return Database.use((db) =>
        db.select().from(CompanyLearningPatchTable)
          .where(eq(CompanyLearningPatchTable.company_id, company_id))
          .orderBy(desc(CompanyLearningPatchTable.updated_at), desc(CompanyLearningPatchTable.id))
          .all()
          .map((row) => patchFromRow(db, row)),
      )
    })

    const actOnPatch = Effect.fn("CompanyLearning.actOnPatch")(function* (
      patch_id: string,
      raw: LearningPatchActionInputValue,
    ) {
      const input = LearningPatchActionInput.parse(raw)
      if (input.action === "approve") {
        const patch = Database.use((db) => {
          const row = db.select().from(CompanyLearningPatchTable).where(eq(CompanyLearningPatchTable.id, patch_id)).get()
          if (!row) throw new Error("Learning Patch was not found")
          requireBeliefLoopMode(db, row.company_id)
          const diff = json<Record<string, unknown>>(row.proposed_diff_json)
          validatePatchAdapter(db, row.company_id, row.target_type as LearningPatchTargetType, row.target_id, diff)
          const decision = db.select().from(DecisionRecordTable).where(eq(DecisionRecordTable.id, input.decision_id)).get()
          const projection = db.select().from(DecisionCurrentProjectionTable)
            .where(eq(DecisionCurrentProjectionTable.decision_id, input.decision_id)).get()
          if (
            !decision ||
            decision.company_id !== row.company_id ||
            decision.record_origin !== "live" ||
            decision.subject !== `learning_patch:${patch_id}` ||
            decision.decision_maker_id !== input.actor_id ||
            (input.actor_kind === "human" && decision.decision_maker !== "human") ||
            (input.actor_kind === "system" && decision.decision_maker !== "policy_engine") ||
            (input.actor_kind === "agent" && !["ai_founder", "board"].includes(decision.decision_maker)) ||
            !projection ||
            !["accepted", "executed"].includes(projection.current_status) ||
            projection.final_decision !== `approve_learning_patch:${patch_id}`
          )
            throw new Error("Learning Patch approval requires a current accepted decision bound to the exact Patch")
          if (row.target_type === "delegation_policy" &&
            (input.actor_kind !== "human" || decision.decision_maker !== "human" || decision.decision_maker_id !== input.actor_id))
            throw new Error("Delegation Policy Patch requires the founder's own human red approval")
          if (row.target_type === "governance_asset" &&
            ["founder_profile", "founder_taste"].includes(String(diff.asset_type)) &&
            (input.actor_kind !== "human" || decision.decision_maker !== "human" || decision.decision_maker_id !== input.actor_id))
            throw new Error("Founder Profile and Founder Taste require the founder's human confirmation")
          if (row.target_type === "governance_asset" && diff.asset_type === "company_belief") {
            if (decision.decision_maker !== "board")
              throw new Error("Company Belief Patch requires a Board decision")
          }
          return row
        })
        const authority = yield* governance.submit({
          schemaVersion: 1,
          idempotencyKey: input.idempotency_key,
          decisionId: input.decision_id,
          actionType: `learning_patch.${patch.target_type}.activate`,
          proposedAuthorityClass: patch.authority_class as "yellow" | "red",
          evidenceSufficient: json<string[]>(patch.evidence_json).length > 0,
          requestedBy: { kind: input.actor_kind, id: input.actor_id },
        })
        Database.use((db) => {
          db.update(CompanyLearningPatchTable).set({
            status: authority.dispatchAllowed ? "approved" : patch.status,
            approval_gate_id: authority.gate?.id ?? patch.approval_gate_id,
            approved_by: authority.dispatchAllowed ? input.actor_id : patch.approved_by,
            updated_at: Date.now(),
          }).where(eq(CompanyLearningPatchTable.id, patch_id)).run()
          patchEvent(db, patch_id, authority.dispatchAllowed ? "approved" : "approval_requested", input.actor_id, {
            gate_id: authority.gate?.id ?? null,
            authority_class: authority.authority.authorityClass,
          })
        })
      } else {
        Database.transaction((db) => {
          const patch = db.select().from(CompanyLearningPatchTable).where(eq(CompanyLearningPatchTable.id, patch_id)).get()
          if (!patch) throw new Error("Learning Patch was not found")
          requireBeliefLoopMode(db, patch.company_id)
          if (input.action === "reject") {
            if (!["proposed", "approved"].includes(patch.status)) throw new Error("Learning Patch cannot be rejected from its current state")
            db.update(CompanyLearningPatchTable).set({ status: "rejected", updated_at: Date.now() })
              .where(eq(CompanyLearningPatchTable.id, patch_id)).run()
            patchEvent(db, patch_id, "rejected", input.actor_id)
            return
          }
          if (input.action === "record_benchmark") {
            if (!["proposed", "approved"].includes(patch.status)) throw new Error("Benchmark cannot be recorded for this Patch state")
            const subjectId = input.subject_id
              ?? (patch.target_type === "agent_interest" ? patch.target_id : undefined)
            if (
              input.reviewer_id === input.author_id
              || input.reviewer_id === patch.created_by
              || input.reviewer_id === subjectId
              || input.reviewer_id === input.report_author_id
            )
              throw new Error("Patch author or evaluated subject cannot review the Benchmark")
            const principals = db.select().from(CompanyAgentTable).where(and(
              eq(CompanyAgentTable.company_id, patch.company_id),
              inArray(CompanyAgentTable.id, [input.reviewer_id, input.report_author_id]),
            )).all()
            if (principals.length !== new Set([input.reviewer_id, input.report_author_id]).size)
              throw new Error("Benchmark reviewer and report author must be persisted company principals")
            if (!Object.keys(input.holdout_manifest).length)
              throw new Error("Benchmark holdout manifest cannot be empty")
            if (input.result === "passed" && (!input.evidence_refs.length || input.real_sample_count < 1))
              throw new Error("Benchmark cannot pass without real samples and evidence")
            if (input.evidence_refs.some((ref) => !persistedEvidenceRef(db, ref, patch.company_id)))
              throw new Error("Benchmark evidence must resolve to persisted execution facts")
            const latest = db.select().from(CompanyPatchBenchmarkTable)
              .where(eq(CompanyPatchBenchmarkTable.patch_id, patch_id))
              .orderBy(desc(CompanyPatchBenchmarkTable.version)).get()
            const holdout = JSON.stringify(input.holdout_manifest)
            db.insert(CompanyPatchBenchmarkTable).values({
              id: Identifier.ascending("patchBenchmark"),
              patch_id,
              version: (latest?.version ?? 0) + 1,
              holdout_manifest_json: holdout,
              holdout_sha256: createHash("sha256").update(holdout).digest("hex"),
              frozen_at: Date.now(),
              author_id: input.author_id,
              subject_id: subjectId ?? null,
              reviewer_id: input.reviewer_id,
              reviewer_principal_id: input.reviewer_id,
              report_author_id: input.report_author_id,
              result: input.result,
              evidence_refs_json: JSON.stringify([...new Set(input.evidence_refs)]),
              real_sample_count: input.real_sample_count,
              reviewed_at: Date.now(),
            }).run()
            patchEvent(db, patch_id, "benchmark_recorded", input.reviewer_id, { result: input.result })
            return
          }
          if (input.action === "start_canary") {
            if (patch.status !== "approved") throw new Error("Canary requires an approved Patch")
            const benchmark = db.select().from(CompanyPatchBenchmarkTable)
              .where(eq(CompanyPatchBenchmarkTable.patch_id, patch_id))
              .orderBy(desc(CompanyPatchBenchmarkTable.version)).get()
            if (!benchmark || benchmark.result !== "passed" || benchmark.real_sample_count < 1)
              throw new Error("Patch cannot enter canary without a passed real-sample Benchmark")
            validatePatchAdapter(
              db,
              patch.company_id,
              patch.target_type as LearningPatchTargetType,
              patch.target_id,
              json<Record<string, unknown>>(patch.proposed_diff_json),
            )
            const currentTarget = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.company_id, patch.company_id),
              eq(CompanyPatchTargetVersionTable.target_type, patch.target_type),
              eq(CompanyPatchTargetVersionTable.target_id, patch.target_id),
              eq(CompanyPatchTargetVersionTable.status, "active"),
            )).orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
            const latestTarget = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.company_id, patch.company_id),
              eq(CompanyPatchTargetVersionTable.target_type, patch.target_type),
              eq(CompanyPatchTargetVersionTable.target_id, patch.target_id),
            )).orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
            const expectedPreviousVersionRef = currentTarget?.id ?? `initial:${patch.target_type}:${patch.target_id}`
            const expectedCandidateVersionRef = `candidate:${patch_id}`
            if (
              input.previous_version_ref !== expectedPreviousVersionRef ||
              input.candidate_version_ref !== expectedCandidateVersionRef
            )
              throw new Error("Canary refs must identify the persisted current target and exact Patch candidate")
            db.insert(CompanyPatchTargetVersionTable).values({
              id: expectedCandidateVersionRef,
              patch_id,
              company_id: patch.company_id,
              target_type: patch.target_type,
              target_id: patch.target_id,
              version: (latestTarget?.version ?? 0) + 1,
              payload_json: patch.proposed_diff_json,
              previous_version_ref: currentTarget?.id ?? null,
              target_version_ref: null,
              status: "candidate",
              created_at: Date.now(),
            }).run()
            const id = Identifier.ascending("patchCanary")
            db.insert(CompanyPatchCanaryTable).values({
              id,
              patch_id,
              previous_version_ref: input.previous_version_ref,
              candidate_version_ref: input.candidate_version_ref,
              status: "running",
              metric_evidence_refs_json: "[]",
              started_at: Date.now(),
              finished_at: null,
            }).run()
            if (patch.target_type === "skill") {
              const payload = json<Record<string, unknown>>(patch.proposed_diff_json)
              if (!input.skill_snapshot_id) throw new Error("Skill canary requires a real runtime SkillSnapshot")
              const runtimeSnapshot = db.select().from(SkillSnapshotTable)
                .where(eq(SkillSnapshotTable.id, input.skill_snapshot_id)).get()
              const run = runtimeSnapshot ? db.select().from(AgentRunTable)
                .where(eq(AgentRunTable.id, runtimeSnapshot.agent_run_id)).get() : undefined
              const project = run?.company_project_id ? db.select().from(CompanyProjectTable)
                .where(and(
                  eq(CompanyProjectTable.id, run.company_project_id),
                  eq(CompanyProjectTable.company_id, patch.company_id),
                )).get() : undefined
              const checksum = createHash("sha256").update(String(payload.candidate_content)).digest("hex")
              if (!runtimeSnapshot || !project || runtimeSnapshot.skill_id !== patch.target_id || runtimeSnapshot.checksum !== checksum)
                throw new Error("Skill canary snapshot does not match the proposed candidate")
              const latest = db.select().from(CompanySkillCandidateSnapshotTable)
                .where(eq(CompanySkillCandidateSnapshotTable.skill_id, patch.target_id))
                .orderBy(desc(CompanySkillCandidateSnapshotTable.version)).get()
              db.insert(CompanySkillCandidateSnapshotTable).values({
                id: Identifier.ascending("skillCandidateSnapshot"),
                patch_id,
                skill_id: patch.target_id,
                runtime_snapshot_id: runtimeSnapshot.id,
                version: (latest?.version ?? 0) + 1,
                checksum,
                payload_json: JSON.stringify(payload),
                status: "canary",
                created_at: Date.now(),
              }).run()
            }
            db.update(CompanyLearningPatchTable).set({ status: "canary", updated_at: Date.now() })
              .where(eq(CompanyLearningPatchTable.id, patch_id)).run()
            patchEvent(db, patch_id, "canary_started", input.actor_id, { canary_id: id })
            return
          }
          if (input.action === "finish_canary") {
            const canary = db.select().from(CompanyPatchCanaryTable).where(and(
              eq(CompanyPatchCanaryTable.id, input.canary_id),
              eq(CompanyPatchCanaryTable.patch_id, patch_id),
            )).get()
            if (!canary || canary.status !== "running") throw new Error("Running Patch canary was not found")
            const candidate = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.id, canary.candidate_version_ref),
              eq(CompanyPatchTargetVersionTable.patch_id, patch_id),
              eq(CompanyPatchTargetVersionTable.status, "candidate"),
            )).get()
            if (!candidate || candidate.payload_json !== patch.proposed_diff_json)
              throw new Error("Running Canary is not bound to the persisted exact Patch candidate")
            if (input.result === "passed" && !input.metric_evidence_refs.length)
              throw new Error("Canary cannot pass without metric evidence")
            if (input.metric_evidence_refs.some((ref) => !persistedEvidenceRef(db, ref, patch.company_id)))
              throw new Error("Canary evidence must resolve to persisted execution facts")
            db.update(CompanyPatchCanaryTable).set({
              status: input.result,
              metric_evidence_refs_json: JSON.stringify([...new Set(input.metric_evidence_refs)]),
              finished_at: Date.now(),
            }).where(eq(CompanyPatchCanaryTable.id, canary.id)).run()
            patchEvent(db, patch_id, "canary_finished", input.actor_id, { canary_id: canary.id, result: input.result })
            return
          }
          if (input.action === "activate") {
            if (patch.status !== "canary" || !patch.approved_by)
              throw new Error("Patch activation requires approval and canary state")
            const canary = db.select().from(CompanyPatchCanaryTable)
              .where(eq(CompanyPatchCanaryTable.patch_id, patch_id))
              .orderBy(desc(CompanyPatchCanaryTable.started_at)).get()
            if (!canary || canary.status !== "passed" || !json<string[]>(canary.metric_evidence_refs_json).length)
              throw new Error("Patch activation requires a passed Canary with real metric evidence")
            const candidate = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.id, canary.candidate_version_ref),
              eq(CompanyPatchTargetVersionTable.patch_id, patch_id),
              eq(CompanyPatchTargetVersionTable.status, "candidate"),
            )).get()
            if (
              !candidate ||
              candidate.payload_json !== patch.proposed_diff_json ||
              (candidate.previous_version_ref ?? `initial:${patch.target_type}:${patch.target_id}`) !== canary.previous_version_ref
            )
              throw new Error("Patch activation requires the persisted candidate validated by this Canary")
            const realTarget = ["governance_asset", "benchmark", "agent_interest", "workflow"].includes(patch.target_type)
              ? activateRealTarget(db, patch, input.actor_id)
              : undefined
            const current = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.company_id, patch.company_id),
              eq(CompanyPatchTargetVersionTable.target_type, patch.target_type),
              eq(CompanyPatchTargetVersionTable.target_id, patch.target_id),
              eq(CompanyPatchTargetVersionTable.status, "active"),
            )).orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
            if (current)
              db.update(CompanyPatchTargetVersionTable).set({ status: "superseded" })
                .where(eq(CompanyPatchTargetVersionTable.id, current.id)).run()
            db.update(CompanyPatchTargetVersionTable).set({
              payload_json: realTarget ? JSON.stringify({ target_version_ref: realTarget.ref }) : patch.proposed_diff_json,
              previous_version_ref: current?.id ?? null,
              target_version_ref: realTarget?.ref ?? null,
              status: "active",
            }).where(eq(CompanyPatchTargetVersionTable.id, candidate.id)).run()
            if (patch.target_type === "delegation_policy") appendDelegationPolicyVersion(db, patch)
            if (patch.target_type === "skill") {
              db.update(CompanySkillCandidateSnapshotTable).set({ status: "superseded" })
                .where(eq(CompanySkillCandidateSnapshotTable.skill_id, patch.target_id)).run()
              db.update(CompanySkillCandidateSnapshotTable).set({ status: "active" })
                .where(eq(CompanySkillCandidateSnapshotTable.patch_id, patch_id)).run()
            }
            db.update(CompanyLearningPatchTable).set({ status: "active", updated_at: Date.now() })
              .where(eq(CompanyLearningPatchTable.id, patch_id)).run()
            patchEvent(db, patch_id, "activated", input.actor_id)
            return
          }
          if (input.action === "record_planning_read") {
            if (patch.status !== "active") throw new Error("Planning read evidence requires an active Patch")
            const project = db.select().from(CompanyProjectTable).where(and(
              eq(CompanyProjectTable.id, input.project_id),
              eq(CompanyProjectTable.company_id, patch.company_id),
            )).get()
            const receipt = db.select().from(CompanyWorkReceiptTable).where(and(
              eq(CompanyWorkReceiptTable.id, input.work_receipt_id),
              eq(CompanyWorkReceiptTable.project_id, input.project_id),
            )).get()
            const target = db.select().from(CompanyPatchTargetVersionTable).where(and(
              eq(CompanyPatchTargetVersionTable.id, input.target_version_id),
              eq(CompanyPatchTargetVersionTable.patch_id, patch_id),
              eq(CompanyPatchTargetVersionTable.status, "active"),
            )).get()
            const receiptTarget = db.select().from(CompanyWorkReceiptLearningTargetRefTable).where(and(
              eq(CompanyWorkReceiptLearningTargetRefTable.receipt_id, input.work_receipt_id),
              eq(CompanyWorkReceiptLearningTargetRefTable.target_version_id, input.target_version_id),
              eq(CompanyWorkReceiptLearningTargetRefTable.target_type, patch.target_type),
              eq(CompanyWorkReceiptLearningTargetRefTable.target_id, patch.target_id),
            )).get()
            if (!project || !receipt || receipt.processing_status !== "processed" || !target || !receiptTarget)
              throw new Error("WorkReceipt does not prove that planning read the active target version")
            patchEvent(db, patch_id, "planning_read_confirmed", input.actor_id, {
              project_id: input.project_id,
              work_receipt_id: input.work_receipt_id,
              target_version_id: input.target_version_id,
            })
            return
          }
          if (!["canary", "active"].includes(patch.status)) throw new Error("Patch cannot roll back from its current state")
          const currentTarget = db.select().from(CompanyPatchTargetVersionTable).where(and(
            eq(CompanyPatchTargetVersionTable.company_id, patch.company_id),
            eq(CompanyPatchTargetVersionTable.target_type, patch.target_type),
            eq(CompanyPatchTargetVersionTable.target_id, patch.target_id),
            eq(CompanyPatchTargetVersionTable.status, "active"),
          )).orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
          if (patch.status === "active" && currentTarget?.patch_id !== patch_id)
            throw new Error("A superseded Patch cannot roll back the current target")
          const appliedVersion = db.select().from(CompanyPatchTargetVersionTable)
            .where(eq(CompanyPatchTargetVersionTable.patch_id, patch_id))
            .orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
          const realTarget = ["governance_asset", "benchmark", "agent_interest", "workflow"].includes(patch.target_type)
          const realRollback = patch.status === "active" && realTarget
            ? rollbackRealTarget(db, patch, input.actor_id)
            : undefined
          db.update(CompanyPatchTargetVersionTable).set({ status: "rolled_back" })
            .where(eq(CompanyPatchTargetVersionTable.patch_id, patch_id)).run()
          if (patch.status === "active" && appliedVersion && (!realTarget || realRollback?.ref))
            db.insert(CompanyPatchTargetVersionTable).values({
              id: Identifier.ascending("patchTargetVersion"),
              patch_id,
              company_id: patch.company_id,
              target_type: patch.target_type,
              target_id: patch.target_id,
              version: appliedVersion.version + 1,
              payload_json: JSON.stringify({
                rollback_to: realTarget ? realRollback!.ref : appliedVersion.previous_version_ref,
                reason: input.reason,
              }),
              previous_version_ref: appliedVersion.id,
              target_version_ref: realTarget ? realRollback!.ref : appliedVersion.previous_version_ref,
              status: "active",
              created_at: Date.now(),
            }).run()
          db.update(CompanyPatchCanaryTable).set({ status: "rolled_back", finished_at: Date.now() })
            .where(eq(CompanyPatchCanaryTable.patch_id, patch_id)).run()
          db.update(CompanySkillCandidateSnapshotTable).set({ status: "rolled_back" })
            .where(eq(CompanySkillCandidateSnapshotTable.patch_id, patch_id)).run()
          if (patch.status === "active" && patch.target_type === "delegation_policy")
            rollbackDelegationPolicy(db, patch)
          db.update(CompanyLearningPatchTable).set({ status: "rolled_back", updated_at: Date.now() })
            .where(eq(CompanyLearningPatchTable.id, patch_id)).run()
          patchEvent(db, patch_id, "rolled_back", input.actor_id, { reason: input.reason })
        }, { behavior: "immediate" })
      }
      return Database.use((db) => {
        const row = db.select().from(CompanyLearningPatchTable).where(eq(CompanyLearningPatchTable.id, patch_id)).get()
        if (!row) throw new Error("Learning Patch was not found")
        return patchFromRow(db, row)
      })
    })

    const evidencePackage = Effect.fn("CompanyLearning.evidencePackage")(function* (company_id: string) {
      return Database.use((db) => {
        requireCompany(db, company_id)
        const patch = db.select().from(CompanyLearningPatchTable)
          .where(eq(CompanyLearningPatchTable.company_id, company_id)).orderBy(desc(CompanyLearningPatchTable.created_at)).get()
        const experiment = patch
          ? db.select().from(CompanyExperimentTable)
              .where(eq(CompanyExperimentTable.id, patch.source_experiment_id)).get()
          : db.select().from(CompanyExperimentTable)
              .where(eq(CompanyExperimentTable.company_id, company_id)).orderBy(desc(CompanyExperimentTable.created_at)).get()
        const belief = experiment
          ? db.select().from(CompanyBeliefTable).where(eq(CompanyBeliefTable.id, experiment.belief_id)).get()
          : db.select().from(CompanyBeliefTable)
              .where(eq(CompanyBeliefTable.company_id, company_id)).orderBy(desc(CompanyBeliefTable.created_at)).get()
        const benchmark = patch ? db.select().from(CompanyPatchBenchmarkTable)
          .where(eq(CompanyPatchBenchmarkTable.patch_id, patch.id)).orderBy(desc(CompanyPatchBenchmarkTable.version)).get() : undefined
        const canary = patch ? db.select().from(CompanyPatchCanaryTable)
          .where(eq(CompanyPatchCanaryTable.patch_id, patch.id)).orderBy(desc(CompanyPatchCanaryTable.started_at)).get() : undefined
        const planningRead = patch ? db.select().from(CompanyPatchEventTable).where(and(
          eq(CompanyPatchEventTable.patch_id, patch.id),
          eq(CompanyPatchEventTable.type, "planning_read_confirmed"),
        )).orderBy(desc(CompanyPatchEventTable.created_at)).get() : undefined
        const positions = belief ? db.select().from(CompanyBeliefInterpretationTable)
          .where(eq(CompanyBeliefInterpretationTable.belief_id, belief.id)).all() : []
        const outcome = experiment ? db.select().from(CompanyExperimentOutcomeTable)
          .where(patch
            ? and(
                eq(CompanyExperimentOutcomeTable.experiment_id, experiment.id),
                eq(CompanyExperimentOutcomeTable.outcome_signal_id, patch.source_outcome_id),
              )
            : eq(CompanyExperimentOutcomeTable.experiment_id, experiment.id))
          .get() : undefined
        const requirements = [
          {
            id: "same_source_interpretations",
            status: belief && positions.some((item) => item.position === "supporting") &&
              positions.some((item) => item.position === "counter") ? "present" as const : "missing" as const,
            evidence_refs: belief ? [belief.id, ...positions.map((item) => item.interpretation_id)] : [],
          },
          {
            id: "authority_governed_experiment",
            status: experiment ? "present" as const : "missing" as const,
            evidence_refs: experiment ? [experiment.id, experiment.decision_id] : [],
          },
          {
            id: "real_outcome_signal",
            status: experiment?.status === "evaluated" && outcome ? "present" as const : "not_confirmed" as const,
            evidence_refs: outcome ? [outcome.outcome_signal_id] : [],
          },
          {
            id: "learning_patch",
            status: patch?.status === "active" ? "present" as const : patch ? "not_confirmed" as const : "missing" as const,
            evidence_refs: patch ? [patch.id] : [],
          },
          {
            id: "independent_frozen_benchmark",
            status: benchmark?.result === "passed" ? "present" as const : "not_confirmed" as const,
            evidence_refs: benchmark ? [benchmark.id] : [],
          },
          {
            id: "canary_and_rollback",
            status: canary?.status === "passed" ? "present" as const : "not_confirmed" as const,
            evidence_refs: canary ? [canary.id] : [],
          },
          {
            id: "next_real_planning_read",
            status: planningRead ? "present" as const : "not_confirmed" as const,
            evidence_refs: planningRead ? [planningRead.id, ...Object.values(json<Record<string, string>>(planningRead.data_json))] : [],
          },
        ]
        const complete = belief?.status === "adopted" && requirements.every((item) => item.status === "present")
        return LearningEvidencePackage.parse({
          schema_version: 1,
          company_id,
          weak_gate: complete ? "confirmed" : "not_confirmed",
          generated_at: Date.now(),
          fixture_success_allowed: false,
          requirements,
          complete_real_chain: complete,
        })
      })
    })

    const resolveTarget = Effect.fn("CompanyLearning.resolveTarget")(function* (
      company_id: string,
      target_type: LearningPatchTargetType,
      target_id: string,
    ) {
      return Database.use((db) => {
        const row = db.select().from(CompanyPatchTargetVersionTable).where(and(
          eq(CompanyPatchTargetVersionTable.company_id, company_id),
          eq(CompanyPatchTargetVersionTable.target_type, target_type),
          eq(CompanyPatchTargetVersionTable.target_id, target_id),
          eq(CompanyPatchTargetVersionTable.status, "active"),
        )).orderBy(desc(CompanyPatchTargetVersionTable.version)).get()
        if (!row) return
        return ActiveLearningTarget.parse({
          id: row.id,
          patch_id: row.patch_id,
          company_id: row.company_id,
          target_type: row.target_type,
          target_id: row.target_id,
          version: row.version,
          payload: resolveRealTargetPayload(
            db,
            row.target_type as LearningPatchTargetType,
            row.target_version_ref,
          ) ?? json(row.payload_json),
          previous_version_ref: row.previous_version_ref,
          target_version_ref: row.target_version_ref,
          status: row.status,
          created_at: row.created_at,
        })
      })
    })

    return Service.of({
      compareInterpretations,
      createCandidate,
      listBeliefs,
      appendEvidence,
      adoptBelief,
      proposeExperiment,
      listExperiments,
      actOnExperiment,
      proposePatch,
      listPatches,
      actOnPatch,
      evidencePackage,
      resolveTarget,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FounderAuthority.governanceLayer))
