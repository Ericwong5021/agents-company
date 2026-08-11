import { existsSync, readFileSync } from "node:fs"
import { Context, Effect, Layer } from "effect"
import { and, asc, eq, inArray, or } from "drizzle-orm"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import type { TxOrDb } from "@/storage/db"
import {
  CompanyAcceptanceCriterionTable,
  CompanyAcceptanceFactTable,
  CompanyArtifactTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptAcceptanceFactTable,
  CompanyWorkReceiptTable,
} from "./company-project.sql"
import {
  AcceptanceContractVersion,
  AcceptanceCoverage,
  AcceptanceCriterion,
  AcceptanceCriterionCreate,
  AcceptanceEvidenceRef,
  AcceptanceFact,
  AcceptanceFactCreate,
  AcceptanceReceiptLink,
  type AcceptanceAuthority as AcceptanceAuthorityType,
  type AcceptanceCoverage as AcceptanceCoverageType,
  type AcceptanceCriterion as AcceptanceCriterionType,
  type AcceptanceCriterionCreate as AcceptanceCriterionCreateType,
  type AcceptanceCriterionKind as AcceptanceCriterionKindType,
  type AcceptanceEvidenceRef as AcceptanceEvidenceRefType,
  type AcceptanceFact as AcceptanceFactType,
  type AcceptanceFactCreate as AcceptanceFactCreateType,
  type AcceptanceReceiptLink as AcceptanceReceiptLinkType,
  type AcceptanceRequiredAuthority as AcceptanceRequiredAuthorityType,
} from "./schema"

export type AcceptanceTuple = {
  project_id: string
  work_item_id: string
  attempt_id: string
  artifact_id: string
}

export type AcceptanceFactListInput = Partial<AcceptanceTuple> & { criterion_id?: string; gate_id?: string }

export type CreateCriterionResult = { criterion: AcceptanceCriterionType; replayed: boolean }
export type RecordFactResult = { fact: AcceptanceFactType; replayed: boolean }

export function acceptanceCriterionVerification(statement: string) {
  if (statement === "artifact_exists" || /^artifact_sha256:[a-f0-9]{64}$/i.test(statement))
    return { verification_kind: "deterministic" as const, evaluator: "artifact_digest_v1" }
  if (statement === "review_results_cover_target_criteria")
    return { verification_kind: "deterministic" as const, evaluator: "review_contract_v2" }
  if (/^标题以[“"][^”"]+[”"]开头[。.]?$/.test(statement.trim()))
    return { verification_kind: "deterministic" as const, evaluator: "literal_acceptance_v1" }
  return { verification_kind: "semantic_review" as const }
}

const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

const criterionFromRow = (row: typeof CompanyAcceptanceCriterionTable.$inferSelect) =>
  AcceptanceCriterion.parse({
    id: row.id,
    project_id: row.project_id,
    plan_id: row.plan_id,
    work_item_id: row.work_item_id,
    ordinal: row.ordinal,
    statement: row.statement,
    statement_sha256: row.statement_sha256,
    verification_kind: row.verification_kind,
    required_authority: row.required_authority ?? undefined,
    evaluator: row.evaluator ?? undefined,
    required: row.required,
    created_at: row.created_at,
  })

const factFromRow = (row: typeof CompanyAcceptanceFactTable.$inferSelect) =>
  AcceptanceFact.parse({
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    attempt_id: row.attempt_id,
    artifact_id: row.artifact_id,
    artifact_integrity_sha256: row.artifact_integrity_sha256,
    criterion_id: row.criterion_id,
    gate_id: row.gate_id ?? undefined,
    verdict: row.verdict,
    authority: row.authority,
    evaluator: row.evaluator,
    observation: JSON.parse(row.observation_json),
    evidence_refs: JSON.parse(row.evidence_refs_json),
    evidence_sha256: row.evidence_sha256,
    input_sha256: row.input_sha256,
    idempotency_key: row.idempotency_key,
    supersedes_fact_id: row.supersedes_fact_id ?? undefined,
    created_at: row.created_at,
  })

const requiredAuthority = (kind: AcceptanceCriterionKindType): AcceptanceRequiredAuthorityType | undefined => {
  if (kind === "deterministic") return "control_plane"
  if (kind === "semantic_review") return "independent_reviewer"
  if (kind === "human") return "human"
  return undefined
}

const authoritySatisfies = (
  kind: AcceptanceCriterionKindType,
  authority: AcceptanceAuthorityType,
) => {
  if (kind === "deterministic") return authority === "control_plane"
  if (kind === "semantic_review") return authority === "independent_reviewer" || authority === "human"
  if (kind === "human") return authority === "human"
  return false
}

function registeredFactEvaluator(
  criterion: { statement: string; verification_kind: string; evaluator?: string | null },
) {
  if (criterion.verification_kind === "deterministic") {
    const registered = acceptanceCriterionVerification(criterion.statement)
    if (registered.verification_kind !== "deterministic" || criterion.evaluator !== registered.evaluator) return
    return registered.evaluator
  }
  if (criterion.verification_kind === "semantic_review")
    return criterion.evaluator === undefined ||
      criterion.evaluator === null ||
      criterion.evaluator === "independent_review_v2"
      ? "independent_review_v2"
      : undefined
  if (criterion.verification_kind === "human")
    return criterion.evaluator === undefined ||
      criterion.evaluator === null ||
      criterion.evaluator === "human_acceptance_v1"
      ? "human_acceptance_v1"
      : undefined
}

function acceptanceFactAuthorityValid(
  db: TxOrDb,
  input: Pick<AcceptanceFactCreateType, "project_id" | "work_item_id" | "artifact_id" | "authority" | "evaluator" | "evidence_refs">,
  criterion: { statement: string; verification_kind: string; evaluator?: string | null },
) {
  const evaluator = registeredFactEvaluator(criterion)
  if (!evaluator || input.evaluator !== evaluator) return false
  if (!input.evidence_refs.some((reference) => reference.kind === "artifact" && reference.id === input.artifact_id))
    return false
  if (criterion.verification_kind === "deterministic") return input.authority === "control_plane"
  if (criterion.verification_kind === "human") return false
  if (criterion.verification_kind !== "semantic_review" || input.authority !== "independent_reviewer") return false
  const target = db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.work_item_id)).get()
  const reviewers = db
    .select()
    .from(CompanyWorkItemTable)
    .where(
      and(
        eq(CompanyWorkItemTable.project_id, input.project_id),
        eq(CompanyWorkItemTable.kind, "reviewer"),
        eq(CompanyWorkItemTable.reviews_work_item_id, input.work_item_id),
      ),
    )
    .all()
    .filter((candidate) => !["superseded", "cancelled"].includes(candidate.status))
  const reviewer = reviewers.length === 1 ? reviewers[0] : undefined
  const runReferences = input.evidence_refs.filter((reference) => reference.kind === "agent_run")
  if (
    !target ||
    target.project_id !== input.project_id ||
    target.kind !== "worker" ||
    target.validation_contract_version !== 2 ||
    !reviewer ||
    reviewer.plan_id !== target.plan_id ||
    reviewer.validation_contract_version !== 2 ||
    !target.owner_agent_id ||
    !reviewer.owner_agent_id ||
    target.owner_agent_id === reviewer.owner_agent_id ||
    runReferences.length !== 1
  )
    return false
  const run = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, runReferences[0]!.id)).get()
  return Boolean(
    run &&
      run.company_project_id === input.project_id &&
      run.work_item_id === reviewer.id &&
      run.agent_id === reviewer.owner_agent_id &&
      run.workflow_run_id !== null &&
      run.workflow_run_id === reviewer.workflow_run_id &&
      run.state === "completed" &&
      run.exit_code === 0 &&
      run.time_finished !== null,
  )
}

function insertEvent(db: TxOrDb, project_id: string, type: string, data: Record<string, unknown>) {
  db.insert(CompanyProjectEventTable)
    .values({
      id: Identifier.ascending("event"),
      project_id,
      type,
      actor_id: null,
      data_json: JSON.stringify(data),
      created_at: Date.now(),
    })
    .run()
}

function evidenceReferenceExists(db: TxOrDb, project_id: string, reference: AcceptanceEvidenceRefType) {
  if (reference.kind === "artifact")
    return (
      db
        .select({ project_id: CompanyArtifactTable.project_id })
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.id, reference.id))
        .get()?.project_id === project_id
    )
  if (reference.kind === "agent_run")
    return (
      db
        .select({ project_id: AgentRunTable.company_project_id })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, reference.id))
        .get()?.project_id === project_id
    )
  return (
    db
      .select({ project_id: CompanyProjectEventTable.project_id })
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.id, reference.id))
      .get()?.project_id === project_id
  )
}

export function createCriterionWithDatabase(
  db: TxOrDb,
  raw: AcceptanceCriterionCreateType,
): CreateCriterionResult {
  const input = AcceptanceCriterionCreate.parse(raw)
  const item = db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.work_item_id)).get()
  const plan = db.select().from(CompanyPlanTable).where(eq(CompanyPlanTable.id, input.plan_id)).get()
  if (!item || item.project_id !== input.project_id || item.plan_id !== input.plan_id)
    throw new Error("Acceptance Criterion references an unavailable Work Item")
  if (!plan || plan.project_id !== input.project_id)
    throw new Error("Acceptance Criterion references an unavailable Plan")
  const registered = acceptanceCriterionVerification(input.statement)
  if (
    (input.verification_kind === "deterministic" &&
      (registered.verification_kind !== "deterministic" || input.evaluator !== registered.evaluator)) ||
    (input.verification_kind === "semantic_review" &&
      (registered.verification_kind !== "semantic_review" ||
        (input.evaluator !== undefined && input.evaluator !== "independent_review_v2"))) ||
    (input.verification_kind === "human" &&
      input.evaluator !== undefined &&
      input.evaluator !== "human_acceptance_v1") ||
    input.verification_kind === "legacy_unscoped"
  )
    throw new Error("Acceptance Criterion evaluator is not registered for its verification kind and statement")
  const statement_sha256 = digest(input.statement)
  const existing = db
    .select()
    .from(CompanyAcceptanceCriterionTable)
    .where(
      or(
        eq(CompanyAcceptanceCriterionTable.work_item_id, input.work_item_id),
        ...(input.id ? [eq(CompanyAcceptanceCriterionTable.id, input.id)] : []),
      ),
    )
    .orderBy(asc(CompanyAcceptanceCriterionTable.ordinal))
    .all()
    .find((candidate) => candidate.ordinal === input.ordinal || candidate.id === input.id)
  if (existing) {
    if (
      (input.id && existing.id !== input.id) ||
      existing.project_id !== input.project_id ||
      existing.plan_id !== input.plan_id ||
      existing.work_item_id !== input.work_item_id ||
      existing.ordinal !== input.ordinal ||
      existing.statement_sha256 !== statement_sha256 ||
      existing.verification_kind !== input.verification_kind ||
      existing.required_authority !== (requiredAuthority(input.verification_kind) ?? null) ||
      existing.evaluator !== (input.evaluator ?? null) ||
      existing.required !== input.required
    )
      throw new Error("Acceptance Criterion conflicts with persisted facts")
    return { criterion: criterionFromRow(existing), replayed: true }
  }
  const now = Date.now()
  const row = {
    id: input.id ?? Identifier.ascending("acceptanceCriterion"),
    project_id: input.project_id,
    plan_id: input.plan_id,
    work_item_id: input.work_item_id,
    ordinal: input.ordinal,
    statement: input.statement,
    statement_sha256,
    verification_kind: input.verification_kind,
    required_authority: requiredAuthority(input.verification_kind) ?? null,
    evaluator: input.evaluator ?? null,
    required: input.required,
    created_at: now,
  }
  db.insert(CompanyAcceptanceCriterionTable).values(row).run()
  insertEvent(db, input.project_id, "acceptance_criterion.created", {
    criterion_id: row.id,
    work_item_id: row.work_item_id,
    ordinal: row.ordinal,
    verification_kind: row.verification_kind,
    statement_sha256,
  })
  return { criterion: criterionFromRow(row), replayed: false }
}

export function listCriteriaWithDatabase(db: TxOrDb, work_item_id: string) {
  return db
    .select()
    .from(CompanyAcceptanceCriterionTable)
    .where(eq(CompanyAcceptanceCriterionTable.work_item_id, work_item_id))
    .orderBy(asc(CompanyAcceptanceCriterionTable.ordinal), asc(CompanyAcceptanceCriterionTable.id))
    .all()
    .map(criterionFromRow)
}

export function recordWithDatabase(db: TxOrDb, raw: AcceptanceFactCreateType): RecordFactResult {
  const input = AcceptanceFactCreate.parse(raw)
  if (new Set(input.evidence_refs.map((reference) => `${reference.kind}:${reference.id}`)).size !== input.evidence_refs.length)
    throw new Error("Acceptance Fact evidence references must be unique")
  const attempt = db.select().from(CompanyWorkAttemptTable).where(eq(CompanyWorkAttemptTable.id, input.attempt_id)).get()
  if (!attempt || attempt.project_id !== input.project_id || attempt.work_item_id !== input.work_item_id)
    throw new Error("Acceptance Fact references an unavailable Work Attempt")
  const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, input.artifact_id)).get()
  if (
    !artifact ||
    artifact.project_id !== input.project_id ||
    artifact.work_item_id !== input.work_item_id ||
    artifact.attempt_id !== input.attempt_id ||
    !artifact.integrity_sha256 ||
    !/^[a-f0-9]{64}$/.test(artifact.integrity_sha256)
  )
    throw new Error("Acceptance Fact requires an Attempt-scoped Artifact with an integrity digest")
  const criterion = db
    .select()
    .from(CompanyAcceptanceCriterionTable)
    .where(eq(CompanyAcceptanceCriterionTable.id, input.criterion_id))
    .get()
  if (!criterion || criterion.project_id !== input.project_id || criterion.work_item_id !== input.work_item_id)
    throw new Error("Acceptance Fact references an unavailable Criterion")
  if (!acceptanceFactAuthorityValid(db, input, criterion))
    throw new Error("Acceptance Fact authority or evaluator is not backed by registered evidence")
  const gate = input.gate_id
    ? db.select().from(CompanyValidationGateTable).where(eq(CompanyValidationGateTable.id, input.gate_id)).get()
    : undefined
  if (
    input.gate_id &&
    (!gate ||
      gate.project_id !== input.project_id ||
      gate.work_item_id !== input.work_item_id ||
      (gate.attempt_id !== null && gate.attempt_id !== input.attempt_id) ||
      (gate.artifact_id !== null && gate.artifact_id !== input.artifact_id))
  )
    throw new Error("Acceptance Fact references an incompatible Validation Gate")
  if (input.evidence_refs.some((reference) => !evidenceReferenceExists(db, input.project_id, reference)))
    throw new Error("Acceptance Fact references unavailable evidence")
  const superseded = input.supersedes_fact_id
    ? db
        .select()
        .from(CompanyAcceptanceFactTable)
        .where(eq(CompanyAcceptanceFactTable.id, input.supersedes_fact_id))
        .get()
    : undefined
  if (
    input.supersedes_fact_id &&
    (!superseded ||
      superseded.project_id !== input.project_id ||
      superseded.work_item_id !== input.work_item_id ||
      superseded.attempt_id !== input.attempt_id ||
      superseded.artifact_id !== input.artifact_id ||
      superseded.criterion_id !== input.criterion_id ||
      superseded.authority !== input.authority ||
      superseded.evaluator !== input.evaluator)
  )
    throw new Error("Acceptance Fact can only supersede the same tuple, authority, and evaluator")
  if (
    superseded &&
    db
      .select({ id: CompanyAcceptanceFactTable.id })
      .from(CompanyAcceptanceFactTable)
      .where(eq(CompanyAcceptanceFactTable.supersedes_fact_id, superseded.id))
      .get()
  )
    throw new Error("Acceptance Fact is already superseded")
  const evidence_refs = AcceptanceEvidenceRef.array().parse(input.evidence_refs)
  const evidence_sha256 = digest(evidence_refs)
  const input_sha256 = digest({ ...input, artifact_integrity_sha256: artifact.integrity_sha256, evidence_sha256 })
  const existing = db
    .select()
    .from(CompanyAcceptanceFactTable)
    .where(
      and(
        eq(CompanyAcceptanceFactTable.project_id, input.project_id),
        eq(CompanyAcceptanceFactTable.idempotency_key, input.idempotency_key),
      ),
    )
    .get()
  if (existing) {
    if (existing.input_sha256 !== input_sha256) throw new Error("Acceptance Fact idempotency key conflicts")
    return { fact: factFromRow(existing), replayed: true }
  }
  const now = Date.now()
  const row = {
    id: input.id ?? Identifier.ascending("acceptanceFact"),
    project_id: input.project_id,
    work_item_id: input.work_item_id,
    attempt_id: input.attempt_id,
    artifact_id: input.artifact_id,
    artifact_integrity_sha256: artifact.integrity_sha256,
    criterion_id: input.criterion_id,
    gate_id: input.gate_id ?? null,
    verdict: input.verdict,
    authority: input.authority,
    evaluator: input.evaluator,
    observation_json: JSON.stringify(input.observation),
    evidence_refs_json: JSON.stringify(evidence_refs),
    evidence_sha256,
    input_sha256,
    idempotency_key: input.idempotency_key,
    supersedes_fact_id: input.supersedes_fact_id ?? null,
    created_at: now,
  }
  db.insert(CompanyAcceptanceFactTable).values(row).run()
  insertEvent(db, input.project_id, "acceptance_fact.recorded", {
    fact_id: row.id,
    work_item_id: row.work_item_id,
    attempt_id: row.attempt_id,
    artifact_id: row.artifact_id,
    artifact_integrity_sha256: row.artifact_integrity_sha256,
    criterion_id: row.criterion_id,
    gate_id: row.gate_id,
    verdict: row.verdict,
    authority: row.authority,
  })
  return { fact: factFromRow(row), replayed: false }
}

export function listFactsWithDatabase(db: TxOrDb, input: AcceptanceFactListInput) {
  const filters = [
    input.project_id ? eq(CompanyAcceptanceFactTable.project_id, input.project_id) : undefined,
    input.work_item_id ? eq(CompanyAcceptanceFactTable.work_item_id, input.work_item_id) : undefined,
    input.attempt_id ? eq(CompanyAcceptanceFactTable.attempt_id, input.attempt_id) : undefined,
    input.artifact_id ? eq(CompanyAcceptanceFactTable.artifact_id, input.artifact_id) : undefined,
    input.criterion_id ? eq(CompanyAcceptanceFactTable.criterion_id, input.criterion_id) : undefined,
    input.gate_id ? eq(CompanyAcceptanceFactTable.gate_id, input.gate_id) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => filter !== undefined)
  if (!filters.length) throw new Error("Acceptance Fact list requires at least one scope")
  return db
    .select()
    .from(CompanyAcceptanceFactTable)
    .where(and(...filters))
    .orderBy(asc(CompanyAcceptanceFactTable.created_at), asc(CompanyAcceptanceFactTable.id))
    .all()
    .map(factFromRow)
}

export function currentCoverageWithDatabase(db: TxOrDb, input: AcceptanceTuple): AcceptanceCoverageType {
  const item = db.select().from(CompanyWorkItemTable).where(eq(CompanyWorkItemTable.id, input.work_item_id)).get()
  const attempt = db.select().from(CompanyWorkAttemptTable).where(eq(CompanyWorkAttemptTable.id, input.attempt_id)).get()
  const artifact = db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, input.artifact_id)).get()
  if (
    !item ||
    item.project_id !== input.project_id ||
    !attempt ||
    attempt.project_id !== input.project_id ||
    attempt.work_item_id !== input.work_item_id ||
    !artifact ||
    artifact.project_id !== input.project_id ||
    artifact.work_item_id !== input.work_item_id
  )
    throw new Error("Acceptance coverage tuple is unavailable")
  const criteria = listCriteriaWithDatabase(db, input.work_item_id)
  const facts = listFactsWithDatabase(db, input)
  const superseded = new Set(facts.flatMap((fact) => (fact.supersedes_fact_id ? [fact.supersedes_fact_id] : [])))
  const activeFacts = facts.filter((fact) => !superseded.has(fact.id))
  const observedContentSha256 =
    artifact.content === null ? null : new Bun.CryptoHasher("sha256").update(artifact.content).digest("hex")
  const observedMaterializedSha256 = artifact.path === null
    ? null
    : existsSync(artifact.path)
      ? new Bun.CryptoHasher("sha256").update(readFileSync(artifact.path)).digest("hex")
      : undefined
  const observedIntegritySha256 =
    observedContentSha256 || observedMaterializedSha256
      ? new Bun.CryptoHasher("sha256")
          .update(
            JSON.stringify({
              content_sha256: observedContentSha256 ?? undefined,
              materialized_sha256: observedMaterializedSha256 ?? undefined,
            }),
          )
          .digest("hex")
      : null
  const lineageFresh =
    artifact.attempt_id === input.attempt_id &&
    artifact.integrity_sha256 !== null &&
    /^[a-f0-9]{64}$/.test(artifact.integrity_sha256) &&
    artifact.content_sha256 === observedContentSha256 &&
    artifact.materialized_sha256 === observedMaterializedSha256 &&
    artifact.integrity_sha256 === observedIntegritySha256
  const coverage = criteria.map((criterion) => {
    const candidates = activeFacts
      .filter((fact) => fact.criterion_id === criterion.id)
      .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id))
    const fact =
      candidates.find(
        (candidate) =>
          authoritySatisfies(criterion.verification_kind, candidate.authority) &&
          acceptanceFactAuthorityValid(db, candidate, criterion),
      ) ?? candidates[0]
    const fresh = lineageFresh && fact?.artifact_integrity_sha256 === artifact.integrity_sha256
    const authoritative = fact
      ? authoritySatisfies(criterion.verification_kind, fact.authority) &&
        acceptanceFactAuthorityValid(db, fact, criterion)
      : false
    return {
      criterion_id: criterion.id,
      statement: criterion.statement,
      verification_kind: criterion.verification_kind,
      required_authority: criterion.required_authority,
      required: criterion.required,
      state: !fact
        ? ("missing" as const)
        : !fresh
          ? ("stale" as const)
          : !authoritative
            ? ("inconclusive" as const)
            : fact.verdict,
      fact_id: fact?.id,
      authority: fact?.authority,
      evidence_refs: fact?.evidence_refs ?? [],
    }
  })
  const required = coverage.filter((criterion) => criterion.required)
  const contract_version = AcceptanceContractVersion.parse(item.validation_contract_version)
  const state =
    contract_version === 1
      ? ("legacy_unverified" as const)
      : !lineageFresh || required.some((criterion) => criterion.state === "stale")
        ? ("stale" as const)
        : required.some((criterion) => criterion.state === "failed")
          ? ("failed" as const)
          : required.length > 0 && required.every((criterion) => criterion.state === "passed")
            ? ("verified" as const)
            : ("pending" as const)
  return AcceptanceCoverage.parse({ ...input, contract_version, state, criteria: coverage })
}

export function assertCompletableWithDatabase(db: TxOrDb, input: AcceptanceTuple) {
  const coverage = currentCoverageWithDatabase(db, input)
  if (coverage.state !== "verified")
    throw new Error(`Acceptance tuple is not completable: ${coverage.state}`)
  return coverage
}

export function linkReceiptWithDatabase(db: TxOrDb, raw: AcceptanceReceiptLinkType) {
  const input = AcceptanceReceiptLink.parse(raw)
  if (new Set(input.fact_ids).size !== input.fact_ids.length)
    throw new Error("Receipt Acceptance Fact IDs must be unique")
  const receipt = db.select().from(CompanyWorkReceiptTable).where(eq(CompanyWorkReceiptTable.id, input.receipt_id)).get()
  if (!receipt || receipt.outcome !== "completed") throw new Error("Acceptance Facts require a completed Work Receipt")
  const facts = db
    .select()
    .from(CompanyAcceptanceFactTable)
    .where(inArray(CompanyAcceptanceFactTable.id, input.fact_ids))
    .all()
    .map(factFromRow)
  if (
    facts.length !== input.fact_ids.length ||
    facts.some(
      (fact) =>
        fact.project_id !== receipt.project_id ||
        fact.work_item_id !== receipt.work_item_id ||
        fact.attempt_id !== receipt.attempt_id ||
        fact.artifact_id !== input.artifact_id,
    ) ||
    !(JSON.parse(receipt.artifact_ids_json) as string[]).includes(input.artifact_id)
  )
    throw new Error("Work Receipt and Acceptance Facts do not share one current tuple")
  const coverage = assertCompletableWithDatabase(db, {
    project_id: receipt.project_id,
    work_item_id: receipt.work_item_id,
    attempt_id: receipt.attempt_id,
    artifact_id: input.artifact_id,
  })
  const requiredFactIDs = coverage.criteria.flatMap((criterion) =>
    criterion.required && criterion.fact_id ? [criterion.fact_id] : [],
  )
  if (requiredFactIDs.some((id) => !input.fact_ids.includes(id)))
    throw new Error("Work Receipt does not close over every required Acceptance Fact")
  if (input.fact_ids.some((id) => !coverage.criteria.some((criterion) => criterion.fact_id === id)))
    throw new Error("Work Receipt cannot link stale or superseded Acceptance Facts")
  const existingFactIDs = db
    .select({ fact_id: CompanyWorkReceiptAcceptanceFactTable.fact_id })
    .from(CompanyWorkReceiptAcceptanceFactTable)
    .where(eq(CompanyWorkReceiptAcceptanceFactTable.receipt_id, input.receipt_id))
    .all()
    .map((row) => row.fact_id)
  if (existingFactIDs.length) {
    if (
      existingFactIDs.length !== input.fact_ids.length ||
      existingFactIDs.some((id) => !input.fact_ids.includes(id))
    )
      throw new Error("Work Receipt is already linked to a different Acceptance Fact set")
    return facts
  }
  const now = Date.now()
  db.insert(CompanyWorkReceiptAcceptanceFactTable)
    .values(input.fact_ids.map((fact_id) => ({ receipt_id: input.receipt_id, fact_id, created_at: now })))
    .onConflictDoNothing()
    .run()
  insertEvent(db, receipt.project_id, "work_receipt.acceptance_linked", {
    receipt_id: receipt.id,
    attempt_id: receipt.attempt_id,
    artifact_id: input.artifact_id,
    fact_ids: [...input.fact_ids].sort(),
  })
  return facts
}

export function listReceiptFactsWithDatabase(db: TxOrDb, receipt_id: string) {
  const ids = db
    .select({ fact_id: CompanyWorkReceiptAcceptanceFactTable.fact_id })
    .from(CompanyWorkReceiptAcceptanceFactTable)
    .where(eq(CompanyWorkReceiptAcceptanceFactTable.receipt_id, receipt_id))
    .orderBy(asc(CompanyWorkReceiptAcceptanceFactTable.created_at), asc(CompanyWorkReceiptAcceptanceFactTable.fact_id))
    .all()
    .map((row) => row.fact_id)
  if (!ids.length) return []
  return db
    .select()
    .from(CompanyAcceptanceFactTable)
    .where(inArray(CompanyAcceptanceFactTable.id, ids))
    .orderBy(asc(CompanyAcceptanceFactTable.created_at), asc(CompanyAcceptanceFactTable.id))
    .all()
    .map(factFromRow)
}

const materializedArtifactFresh = async (artifact_id: string) => {
  const artifact = Database.use((db) =>
    db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, artifact_id)).get(),
  )
  if (!artifact) return false
  if (!artifact.path) return artifact.materialized_sha256 === null
  if (!artifact.materialized_sha256 || !(await Bun.file(artifact.path).exists())) return false
  return (
    new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(await Bun.file(artifact.path).arrayBuffer()))
      .digest("hex") === artifact.materialized_sha256
  )
}

const currentCoverageWithMaterializedIntegrity = (input: AcceptanceTuple) =>
  Effect.gen(function* () {
    const coverage = yield* Effect.sync(() => Database.use((db) => currentCoverageWithDatabase(db, input)))
    if (yield* Effect.promise(() => materializedArtifactFresh(input.artifact_id))) return coverage
    return AcceptanceCoverage.parse({
      ...coverage,
      state: "stale",
      criteria: coverage.criteria.map((criterion) =>
        criterion.required ? { ...criterion, state: "stale" as const } : criterion,
      ),
    })
  })

export interface Interface {
  readonly createCriterion: (input: AcceptanceCriterionCreateType) => Effect.Effect<CreateCriterionResult>
  readonly listCriteria: (work_item_id: string) => Effect.Effect<AcceptanceCriterionType[]>
  readonly record: (input: AcceptanceFactCreateType) => Effect.Effect<RecordFactResult>
  readonly listFacts: (input: AcceptanceFactListInput) => Effect.Effect<AcceptanceFactType[]>
  readonly currentCoverage: (input: AcceptanceTuple) => Effect.Effect<AcceptanceCoverageType>
  readonly assertCompletable: (input: AcceptanceTuple) => Effect.Effect<AcceptanceCoverageType>
  readonly linkReceipt: (input: AcceptanceReceiptLinkType) => Effect.Effect<AcceptanceFactType[]>
  readonly listReceiptFacts: (receipt_id: string) => Effect.Effect<AcceptanceFactType[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyAcceptanceFact") {}

export const defaultLayer = Layer.succeed(
  Service,
  Service.of({
    createCriterion: (input) =>
      Effect.sync(() => Database.transaction((db) => createCriterionWithDatabase(db, input), { behavior: "immediate" })),
    listCriteria: (work_item_id) => Effect.sync(() => Database.use((db) => listCriteriaWithDatabase(db, work_item_id))),
    record: (input) =>
      Effect.sync(() => Database.transaction((db) => recordWithDatabase(db, input), { behavior: "immediate" })),
    listFacts: (input) => Effect.sync(() => Database.use((db) => listFactsWithDatabase(db, input))),
    currentCoverage: currentCoverageWithMaterializedIntegrity,
    assertCompletable: (input) =>
      currentCoverageWithMaterializedIntegrity(input).pipe(
        Effect.flatMap((coverage) =>
          coverage.state === "verified"
            ? Effect.succeed(coverage)
            : Effect.sync(() => {
                throw new Error(`Acceptance tuple is not completable: ${coverage.state}`)
              }),
        ),
      ),
    linkReceipt: (input) =>
      Effect.sync(() => Database.transaction((db) => linkReceiptWithDatabase(db, input), { behavior: "immediate" })),
    listReceiptFacts: (receipt_id) =>
      Effect.sync(() => Database.use((db) => listReceiptFactsWithDatabase(db, receipt_id))),
  }),
)

export * as CompanyAcceptanceFact from "./acceptance-fact"
