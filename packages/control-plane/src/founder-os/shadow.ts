import { and, desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import {
  FounderBoardShadowProjection,
  FounderContextBuildInput,
  FounderContextProjection,
  FounderShadowComparison,
  FounderShadowComparisonInput,
  FounderShadowDecision,
  FounderShadowEvidenceRef,
  FounderShadowModelOutput,
  FounderShadowRunInput,
  FounderAssetReference,
  GovernanceAsset,
  GovernanceAssetSourceRef,
  type FounderContextBuildInput as FounderContextBuildInputValue,
  type FounderShadowComparisonInput as FounderShadowComparisonInputValue,
  type FounderShadowRunInput as FounderShadowRunInputValue,
  type GovernanceAssetScope,
} from "@agents-company/shared/founder-os"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyArtifactTable,
  CompanyOutcomeSignalCurrentTable,
  CompanyOutcomeSignalTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkReceiptTable,
} from "@/company-project/company-project.sql"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationThreadTable,
} from "@/conversation/conversation.sql"
import { FounderTwinSnapshotSelectionTable, FounderTwinSnapshotTable, GovernanceAssetTable } from "./asset.sql"
import { DecisionRecordTable } from "./decision-ledger.sql"
import {
  FounderShadowComparisonTable,
  FounderShadowDecisionTable,
} from "./shadow.sql"
import { calibrationItems } from "./taste"
import { FounderModelProvider } from "./model-provider"

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
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(normalized(value))).digest("hex")
}

function projectVisible(companyId: string, scope: GovernanceAssetScope, projectId: string) {
  if (scope.kind === "project" && scope.ref !== projectId) return false
  return Boolean(Database.use((db) =>
    db
      .select({ id: CompanyProjectTable.id })
      .from(CompanyProjectTable)
      .where(and(
        eq(CompanyProjectTable.id, projectId),
        eq(CompanyProjectTable.company_id, companyId),
      ))
      .get(),
  ))
}

function evidenceExists(
  companyId: string,
  scope: GovernanceAssetScope,
  reference: FounderShadowEvidenceRef,
) {
  return Database.use((db) => {
    if (reference.kind === "artifact") {
      const artifact = db
        .select()
        .from(CompanyArtifactTable)
        .where(eq(CompanyArtifactTable.id, reference.id))
        .get()
      if (!artifact || artifact.scope_type === "private") return false
      if (artifact.scope_type === "company")
        return artifact.company_id === companyId
      return Boolean(artifact.project_id && projectVisible(companyId, scope, artifact.project_id))
    }
    if (reference.kind === "decision") {
      const decision = db
        .select()
        .from(DecisionRecordTable)
        .where(eq(DecisionRecordTable.id, reference.id))
        .get()
      if (!decision || decision.company_id !== companyId) return false
      if (decision.scope_type === "company") return true
      return decision.scope_type === "project" &&
        Boolean(decision.project_id && projectVisible(companyId, scope, decision.project_id))
    }
    if (reference.kind === "outcome") {
      const outcome = db
        .select({ projectId: CompanyOutcomeSignalTable.project_id })
        .from(CompanyOutcomeSignalTable)
        .innerJoin(
          CompanyOutcomeSignalCurrentTable,
          eq(CompanyOutcomeSignalCurrentTable.outcome_signal_id, CompanyOutcomeSignalTable.id),
        )
        .where(and(
          eq(CompanyOutcomeSignalTable.id, reference.id),
          eq(CompanyOutcomeSignalCurrentTable.current_status, "validated"),
        ))
        .get()
      return Boolean(outcome && projectVisible(companyId, scope, outcome.projectId))
    }
    if (reference.kind === "conversation") {
      const message = db
        .select({
          companyId: ChannelTable.company_id,
          projectId: ConversationThreadTable.project_scope_id,
        })
        .from(ChannelMessageTable)
        .innerJoin(ChannelTable, eq(ChannelTable.id, ChannelMessageTable.channel_id))
        .leftJoin(
          ConversationThreadTable,
          eq(ConversationThreadTable.id, ChannelMessageTable.source_thread_id),
        )
        .where(eq(ChannelMessageTable.id, reference.id))
        .get()
      if (!message || message.companyId !== companyId) return false
      if (message.projectId === null) return true
      return projectVisible(companyId, scope, message.projectId)
    }
    const receipt = db
      .select({
        projectId: CompanyWorkReceiptTable.project_id,
        status: CompanyWorkReceiptTable.processing_status,
      })
      .from(CompanyWorkReceiptTable)
      .where(eq(CompanyWorkReceiptTable.id, reference.id))
      .get()
    if (
      receipt &&
      ["processed", "rejected"].includes(receipt.status) &&
      projectVisible(companyId, scope, receipt.projectId)
    )
      return true
    const gate = db
      .select({
        projectId: CompanyValidationGateTable.project_id,
        status: CompanyValidationGateTable.status,
      })
      .from(CompanyValidationGateTable)
      .where(eq(CompanyValidationGateTable.id, reference.id))
      .get()
    if (
      gate &&
      ["passed", "failed"].includes(gate.status) &&
      projectVisible(companyId, scope, gate.projectId)
    )
      return true
    const event = db
      .select({ projectId: CompanyProjectEventTable.project_id })
      .from(CompanyProjectEventTable)
      .where(eq(CompanyProjectEventTable.id, reference.id))
      .get()
    return Boolean(event && projectVisible(companyId, scope, event.projectId))
  })
}

function visible(scope: GovernanceAssetScope, row: typeof GovernanceAssetTable.$inferSelect) {
  if (row.scope_kind === "company") return true
  return row.scope_kind === scope.kind && row.scope_ref === scope.ref
}

function assetFromRow(row: typeof GovernanceAssetTable.$inferSelect) {
  return GovernanceAsset.parse({
    id: row.id,
    companyId: row.company_id,
    type: row.type,
    scope: { kind: row.scope_kind, ...(row.scope_ref ? { ref: row.scope_ref } : {}) },
    content: row.content,
    rationale: row.rationale,
    tags: JSON.parse(row.tags_json),
    authority: row.authority,
    status: row.status,
    sourceRefs: GovernanceAssetSourceRef.array().parse(JSON.parse(row.source_refs_json)),
    ...(row.supersedes_version ? { supersedes: row.supersedes_version } : {}),
    version: row.version,
    createdBy: row.created_by,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    createdAt: row.created_at,
    current: true,
  })
}

function assetRef(asset: GovernanceAsset) {
  return FounderAssetReference.parse({ assetId: asset.id, version: asset.version })
}

function latestSnapshot(companyId: string) {
  const selection = Database.use((db) =>
    db
      .select()
      .from(FounderTwinSnapshotSelectionTable)
      .where(eq(FounderTwinSnapshotSelectionTable.company_id, companyId))
      .orderBy(desc(FounderTwinSnapshotSelectionTable.created_at), desc(FounderTwinSnapshotSelectionTable.id))
      .get(),
  )
  if (!selection) return
  return Database.use((db) =>
    db
      .select()
      .from(FounderTwinSnapshotTable)
      .where(and(
        eq(FounderTwinSnapshotTable.id, selection.snapshot_id),
        eq(FounderTwinSnapshotTable.company_id, companyId),
      ))
      .get(),
  )
}

function validSnapshotChecksum(snapshot: typeof FounderTwinSnapshotTable.$inferSelect) {
  return snapshot.checksum === digest({
    schemaVersion: 1,
    profileSummaryHash: digest(snapshot.profile_summary),
    assetRefs: JSON.parse(snapshot.asset_refs_json),
    promptTemplateVersion: snapshot.prompt_template_version,
    modelConfigRef: snapshot.model_config_ref,
    retrievalConfigRef: snapshot.retrieval_config_ref,
    permissionConfigRef: snapshot.permission_config_ref,
    compiledPromptHash: snapshot.compiled_prompt_hash,
  })
}

export function buildContext(raw: FounderContextBuildInputValue) {
  const input = FounderContextBuildInput.parse(raw)
  const snapshot = latestSnapshot(input.companyId)
  if (!snapshot)
    return FounderContextProjection.parse({
      schemaVersion: 1,
      status: "blocked",
      companyId: input.companyId,
      scope: input.scope,
      currentGoal: input.currentGoal,
      discussion: input.discussion,
      authorizationBoundary: input.authorizationBoundary,
      currentFacts: input.currentFacts,
      evidenceRefs: input.evidenceRefs,
      principles: [],
      decisionCases: [],
      tasteExamples: [],
      rubrics: [],
      missingInformation: ["Selected Founder Twin Snapshot"],
      blockReasons: ["snapshot_missing"],
    })
  if (!validSnapshotChecksum(snapshot))
    return FounderContextProjection.parse({
      schemaVersion: 1,
      status: "blocked",
      companyId: input.companyId,
      scope: input.scope,
      currentGoal: input.currentGoal,
      discussion: input.discussion,
      authorizationBoundary: input.authorizationBoundary,
      currentFacts: input.currentFacts,
      evidenceRefs: input.evidenceRefs,
      snapshotId: snapshot.id,
      snapshotChecksum: snapshot.checksum,
      principles: [],
      decisionCases: [],
      tasteExamples: [],
      rubrics: [],
      missingInformation: ["Valid Founder Twin Snapshot checksum"],
      blockReasons: ["snapshot_checksum_invalid"],
    })
  const totalLimit = input.limits.principles
    + input.limits.decisionCases
    + input.limits.tasteExamples
    + input.limits.rubrics
  const rows = FounderAssetReference.array()
    .parse(JSON.parse(snapshot.asset_refs_json))
    .slice(0, totalLimit)
    .map((reference) =>
      Database.use((db) =>
        db
          .select()
          .from(GovernanceAssetTable)
          .where(and(
            eq(GovernanceAssetTable.id, reference.assetId),
            eq(GovernanceAssetTable.version, reference.version),
            eq(GovernanceAssetTable.company_id, input.companyId),
          ))
          .get(),
      ),
    )
  const missingAsset = rows.some((row) => !row)
  const forbiddenAsset = rows.some((row) => row && !visible(input.scope, row))
  const assets = rows
    .filter((row): row is NonNullable<typeof row> => Boolean(row) && visible(input.scope, row!))
    .map(assetFromRow)
  const principles = assets
    .filter((asset) => ["constitution", "principle", "heuristic", "boundary"].includes(asset.type))
    .slice(0, input.limits.principles)
  const decisionCases = assets
    .filter((asset) => asset.type === "decision_case")
    .slice(0, input.limits.decisionCases)
  const tasteExamples = assets
    .filter((asset) => asset.type === "taste_reference" || asset.type === "taste_anti_reference")
    .slice(0, input.limits.tasteExamples)
  const rubrics = assets
    .filter((asset) => asset.type === "rubric")
    .slice(0, input.limits.rubrics)
  const invalidEvidence = input.evidenceRefs.some(
    (reference) =>
      reference.validity !== "verified" ||
      !evidenceExists(input.companyId, input.scope, reference),
  )
  const insufficient = principles.length === 0
    || input.evidenceRefs.length === 0
    || input.currentFacts.length === 0
  const blockReasons = [
    ...(missingAsset ? ["asset_reference_missing" as const] : []),
    ...(forbiddenAsset ? ["asset_scope_forbidden" as const] : []),
    ...(invalidEvidence ? ["evidence_reference_invalid" as const] : []),
    ...(insufficient ? ["context_insufficient" as const] : []),
  ]
  return FounderContextProjection.parse({
    schemaVersion: 1,
    status: blockReasons.length > 0 ? "blocked" : "ready",
    companyId: input.companyId,
    scope: input.scope,
    currentGoal: input.currentGoal,
    discussion: input.discussion,
    authorizationBoundary: input.authorizationBoundary,
    currentFacts: input.currentFacts,
    evidenceRefs: input.evidenceRefs,
    snapshotId: snapshot.id,
    snapshotChecksum: snapshot.checksum,
    principles,
    decisionCases,
    tasteExamples,
    rubrics,
    missingInformation: [
      ...(decisionCases.length === 0 ? ["Relevant historical decision cases"] : []),
      ...(tasteExamples.length === 0 ? ["Relevant taste examples"] : []),
      ...(rubrics.length === 0 ? ["Relevant evaluation rubric"] : []),
    ],
    blockReasons,
  })
}

function decisionFromRow(row: typeof FounderShadowDecisionTable.$inferSelect) {
  return FounderShadowDecision.parse({
    id: row.id,
    companyId: row.company_id,
    status: row.status,
    blockReasons: JSON.parse(row.block_reasons_json),
    scope: { kind: row.scope_kind, ...(row.scope_ref ? { ref: row.scope_ref } : {}) },
    ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
    ...(row.snapshot_checksum ? { snapshotChecksum: row.snapshot_checksum } : {}),
    modelConfigRef: row.model_config_ref,
    ...(row.recommendation ? { recommendation: row.recommendation } : {}),
    alternatives: JSON.parse(row.alternatives_json),
    ...(row.authority_class ? { authorityClass: row.authority_class } : {}),
    ...(row.confidence === null ? {} : { confidence: row.confidence / 1_000_000 }),
    principleRefs: JSON.parse(row.principle_refs_json),
    decisionCaseRefs: JSON.parse(row.decision_case_refs_json),
    tasteExampleRefs: JSON.parse(row.taste_example_refs_json),
    rubricRefs: JSON.parse(row.rubric_refs_json),
    evidenceRefs: FounderShadowEvidenceRef.array().parse(JSON.parse(row.evidence_refs_json)),
    missingInformation: JSON.parse(row.missing_information_json),
    createsGate: false,
    canSpeak: false,
    canExecute: false,
    createdBy: row.created_by,
    createdAt: row.created_at,
  })
}

function comparisonFromRow(row: typeof FounderShadowComparisonTable.$inferSelect) {
  return FounderShadowComparison.parse({
    id: row.id,
    companyId: row.company_id,
    shadowDecisionId: row.shadow_decision_id,
    actualDecision: row.actual_decision,
    actualDecisionRef: JSON.parse(row.actual_decision_ref_json),
    alignment: row.alignment,
    rationale: row.rationale,
    verificationStatus: row.verification_status,
    ...(row.confirmed_by ? { confirmedBy: row.confirmed_by } : {}),
    ...(row.confirmation_event_id ? { confirmationEventId: row.confirmation_event_id } : {}),
    comparedBy: row.compared_by,
    createdAt: row.created_at,
  })
}

function saveShadow(
  input: FounderShadowRunInputValue,
  context: ReturnType<typeof buildContext>,
  modelConfigRef: string,
  reasons: FounderShadowDecision["blockReasons"],
  output?: FounderShadowModelOutput,
) {
  const suggested = reasons.length === 0 && output !== undefined
  const id = Identifier.create("fshd", "ascending")
  Database.transaction((db) =>
    db.insert(FounderShadowDecisionTable)
      .values({
        id,
        company_id: input.context.companyId,
        status: suggested ? "suggested" : "blocked",
        block_reasons_json: JSON.stringify(reasons),
        scope_kind: input.context.scope.kind,
        scope_ref: input.context.scope.ref ?? null,
        snapshot_id: suggested ? context.snapshotId! : null,
        snapshot_checksum: suggested ? context.snapshotChecksum! : null,
        model_config_ref: modelConfigRef,
        recommendation: suggested ? output!.recommendation : null,
        alternatives_json: JSON.stringify(suggested ? output!.alternatives : []),
        authority_class: suggested ? output!.authorityClass : null,
        confidence: suggested ? Math.round(output!.confidence * 1_000_000) : null,
        principle_refs_json: JSON.stringify(suggested ? output!.principleRefs : context.principles.map(assetRef)),
        decision_case_refs_json: JSON.stringify(suggested ? output!.decisionCaseRefs : context.decisionCases.map(assetRef)),
        taste_example_refs_json: JSON.stringify(context.tasteExamples.map(assetRef)),
        rubric_refs_json: JSON.stringify(context.rubrics.map(assetRef)),
        evidence_refs_json: JSON.stringify(suggested ? output!.evidenceRefs : context.evidenceRefs),
        missing_information_json: JSON.stringify([
          ...context.missingInformation,
          ...(suggested ? output!.missingInformation : []),
        ]),
        created_by: input.createdBy,
        created_at: Date.now(),
      })
      .run(),
  )
  return decisionFromRow(Database.use((db) =>
    db.select().from(FounderShadowDecisionTable).where(eq(FounderShadowDecisionTable.id, id)).get()!,
  ))
}

export function runShadow(raw: FounderShadowRunInputValue) {
  const input = FounderShadowRunInput.parse(raw)
  return Effect.gen(function* () {
    const context = buildContext(input.context)
    const snapshot = latestSnapshot(input.context.companyId)
    const modelConfigRef = snapshot?.model_config_ref ?? "company-default-model"
    if (context.status === "blocked")
      return saveShadow(input, context, modelConfigRef, context.blockReasons)
    const provider = yield* FounderModelProvider
    const generated = yield* provider.generateShadow({
      companyId: input.context.companyId,
      modelConfigRef,
      snapshot: { id: context.snapshotId!, checksum: context.snapshotChecksum! },
      context,
      timeoutMs: 30_000,
    }).pipe(Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (output) => ({ output }),
    }))
    if ("error" in generated)
      return saveShadow(input, context, modelConfigRef, [
        generated.error.reason === "timeout"
          ? "model_timeout"
          : generated.error.reason === "invalid_output"
            ? "model_output_invalid"
            : "model_unavailable",
      ])
    const output = FounderShadowModelOutput.safeParse(generated.output)
    if (!output.success) return saveShadow(input, context, modelConfigRef, ["model_output_invalid"])
    const principleRefs = new Set(context.principles.map((asset) => `${asset.id}:${asset.version}`))
    const decisionCaseRefs = new Set(context.decisionCases.map((asset) => `${asset.id}:${asset.version}`))
    const evidenceRefs = new Set(context.evidenceRefs.map((reference) =>
      `${reference.kind}:${reference.id}:${reference.version ?? ""}:${reference.validity}`
    ))
    const invalidReference = output.data.principleRefs.some((reference) =>
      !principleRefs.has(`${reference.assetId}:${reference.version}`)
    )
      || output.data.decisionCaseRefs.some((reference) =>
        !decisionCaseRefs.has(`${reference.assetId}:${reference.version}`)
      )
      || output.data.evidenceRefs.some((reference) =>
        !evidenceRefs.has(`${reference.kind}:${reference.id}:${reference.version ?? ""}:${reference.validity}`)
        || reference.validity !== "verified"
      )
    if (invalidReference) return saveShadow(input, context, modelConfigRef, ["model_output_invalid"])
    return saveShadow(input, context, modelConfigRef, [], output.data)
  })
}

export function compare(raw: FounderShadowComparisonInputValue) {
  const input = FounderShadowComparisonInput.parse(raw)
  const shadow = Database.use((db) =>
    db
      .select()
      .from(FounderShadowDecisionTable)
      .where(and(
        eq(FounderShadowDecisionTable.id, input.shadowDecisionId),
        eq(FounderShadowDecisionTable.company_id, input.companyId),
      ))
      .get(),
  )
  if (!shadow) throw new Error("Shadow decision was not found")
  if (shadow.status !== "suggested") throw new Error("Blocked Shadow attempts cannot be compared as decisions")
  const id = Identifier.create("fscmp", "ascending")
  Database.transaction((db) =>
    db.insert(FounderShadowComparisonTable)
      .values({
        id,
        company_id: input.companyId,
        shadow_decision_id: input.shadowDecisionId,
        actual_decision: input.actualDecision,
        actual_decision_ref_json: JSON.stringify(input.actualDecisionRef),
        alignment: input.alignment,
        rationale: input.rationale,
        verification_status: input.confirmation ? "human_confirmed" : "not_confirmed",
        confirmed_by: input.confirmation?.confirmedBy ?? null,
        confirmation_event_id: input.confirmation?.eventId ?? null,
        compared_by: input.comparedBy,
        created_at: Date.now(),
      })
      .run(),
  )
  return comparisonFromRow(Database.use((db) =>
    db.select().from(FounderShadowComparisonTable).where(eq(FounderShadowComparisonTable.id, id)).get()!,
  ))
}

export function boardProjection(companyId: string) {
  return FounderBoardShadowProjection.parse({
    schemaVersion: 1,
    companyId,
    readOnly: true,
    chatIntegrated: false,
    createsGate: false,
    decisions: Database.use((db) =>
      db
        .select()
        .from(FounderShadowDecisionTable)
        .where(eq(FounderShadowDecisionTable.company_id, companyId))
        .orderBy(desc(FounderShadowDecisionTable.created_at))
        .limit(100)
        .all(),
    ).map(decisionFromRow),
    comparisons: Database.use((db) =>
      db
        .select()
        .from(FounderShadowComparisonTable)
        .where(eq(FounderShadowComparisonTable.company_id, companyId))
        .orderBy(desc(FounderShadowComparisonTable.created_at))
        .limit(100)
        .all(),
    ).map(comparisonFromRow),
    calibrationQueue: calibrationItems(companyId),
    authorization: { status: "not_confirmed", blocking: false },
  })
}
