import { and, asc, desc, eq } from "drizzle-orm"
import {
  FounderSnapshotCompileInput,
  FounderSnapshotSelectInput,
  FounderStudioProjection,
  FounderTwinSnapshot,
  GovernanceAsset,
  GovernanceAssetDraftInput,
  GovernanceAssetRevisionInput,
  GovernanceAssetSourceRef,
  type FounderSnapshotCompileInput as FounderSnapshotCompileInputValue,
  type FounderSnapshotSelectInput as FounderSnapshotSelectInputValue,
  type GovernanceAssetDraftInput as GovernanceAssetDraftInputValue,
  type GovernanceAssetRevisionInput as GovernanceAssetRevisionInputValue,
  type GovernanceAssetScope,
} from "@agents-company/shared/founder-os"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  FounderTwinSnapshotSelectionTable,
  FounderTwinSnapshotTable,
  GovernanceAssetSelectionTable,
  GovernanceAssetTable,
} from "./asset.sql"

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

function parseJSON<T>(value: string, schema: { parse: (input: unknown) => T }) {
  return schema.parse(JSON.parse(value))
}

function ensureCompany(companyId: string) {
  if (!Database.use((db) => db.select({ id: CompanyTable.id }).from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(companyId))).get()))
    throw new Error("Company was not found")
}

function latestAssetSelections(companyId: string) {
  return new Map(
    Database.use((db) =>
      db
        .select()
        .from(GovernanceAssetSelectionTable)
        .where(eq(GovernanceAssetSelectionTable.company_id, companyId))
        .orderBy(asc(GovernanceAssetSelectionTable.created_at), asc(GovernanceAssetSelectionTable.id))
        .all(),
    ).map((row) => [row.asset_id, row.asset_version]),
  )
}

function selectedSnapshotId(companyId: string) {
  return Database.use((db) =>
    db
      .select()
      .from(FounderTwinSnapshotSelectionTable)
      .where(eq(FounderTwinSnapshotSelectionTable.company_id, companyId))
      .orderBy(desc(FounderTwinSnapshotSelectionTable.created_at), desc(FounderTwinSnapshotSelectionTable.id))
      .get(),
  )?.snapshot_id
}

function visible(scope: GovernanceAssetScope, row: typeof GovernanceAssetTable.$inferSelect) {
  if (row.scope_kind === "company") return true
  return row.scope_kind === scope.kind && row.scope_ref === scope.ref
}

function assetFromRow(row: typeof GovernanceAssetTable.$inferSelect, current: boolean) {
  return GovernanceAsset.parse({
    id: row.id,
    companyId: row.company_id,
    type: row.type,
    scope: { kind: row.scope_kind, ...(row.scope_ref ? { ref: row.scope_ref } : {}) },
    content: row.content,
    rationale: row.rationale,
    tags: parseJSON(row.tags_json, { parse: (value) => Array.isArray(value) ? value : [] }),
    authority: row.authority,
    status: row.status,
    sourceRefs: parseJSON(row.source_refs_json, GovernanceAssetSourceRef.array()),
    ...(row.supersedes_version ? { supersedes: row.supersedes_version } : {}),
    version: row.version,
    createdBy: row.created_by,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    createdAt: row.created_at,
    current,
  })
}

function snapshotFromRow(row: typeof FounderTwinSnapshotTable.$inferSelect, selected: boolean) {
  return FounderTwinSnapshot.parse({
    id: row.id,
    companyId: row.company_id,
    version: row.version,
    profileSummary: row.profile_summary,
    assetRefs: JSON.parse(row.asset_refs_json),
    promptTemplateVersion: row.prompt_template_version,
    modelConfigRef: row.model_config_ref,
    retrievalConfigRef: row.retrieval_config_ref,
    permissionConfigRef: row.permission_config_ref,
    compiledPromptHash: row.compiled_prompt_hash,
    checksum: row.checksum,
    createdBy: row.created_by,
    createdAt: row.created_at,
    selected,
  })
}

export function listAssets(companyId: string, scope: GovernanceAssetScope = { kind: "company" }) {
  ensureCompany(companyId)
  const selections = latestAssetSelections(companyId)
  return Database.use((db) =>
    db
      .select()
      .from(GovernanceAssetTable)
      .where(eq(GovernanceAssetTable.company_id, companyId))
      .orderBy(asc(GovernanceAssetTable.id), desc(GovernanceAssetTable.version))
      .all(),
  )
    .filter((row) => visible(scope, row))
    .map((row) => assetFromRow(row, selections.get(row.id) === row.version))
}

export function projection(companyId: string, scope: GovernanceAssetScope = { kind: "company" }) {
  const selected = selectedSnapshotId(companyId)
  return FounderStudioProjection.parse({
    schemaVersion: 1,
    companyId,
    assets: listAssets(companyId, scope),
    snapshots: Database.use((db) =>
      db
        .select()
        .from(FounderTwinSnapshotTable)
        .where(eq(FounderTwinSnapshotTable.company_id, companyId))
        .orderBy(desc(FounderTwinSnapshotTable.version))
        .all(),
    ).map((row) => snapshotFromRow(row, row.id === selected)),
    ...(selected ? { selectedSnapshotId: selected } : {}),
    authorization: { status: "not_confirmed", blocking: false },
  })
}

export function createDraft(raw: GovernanceAssetDraftInputValue) {
  const input = GovernanceAssetDraftInput.parse(raw)
  ensureCompany(input.companyId)
  const id = Identifier.create("gast", "ascending")
  const now = Date.now()
  Database.transaction((tx) =>
    tx
      .insert(GovernanceAssetTable)
      .values({
        id,
        company_id: input.companyId,
        type: input.type,
        scope_kind: input.scope.kind,
        scope_ref: input.scope.ref ?? null,
        content: input.content,
        rationale: input.rationale,
        tags_json: JSON.stringify(input.tags),
        authority: input.authority,
        status: "draft",
        source_refs_json: JSON.stringify(input.sourceRefs),
        supersedes_version: null,
        version: 1,
        created_by: input.createdBy,
        approved_by: null,
        confirmation_event_id: null,
        created_at: now,
      })
      .run(),
  )
  return assetFromRow(Database.use((db) =>
    db.select().from(GovernanceAssetTable).where(and(eq(GovernanceAssetTable.id, id), eq(GovernanceAssetTable.version, 1))).get()!,
  ), false)
}

export function revise(assetId: string, raw: GovernanceAssetRevisionInputValue) {
  const input = GovernanceAssetRevisionInput.parse(raw)
  const base = Database.use((db) =>
    db
      .select()
      .from(GovernanceAssetTable)
      .where(and(eq(GovernanceAssetTable.id, assetId), eq(GovernanceAssetTable.version, input.baseVersion)))
      .get(),
  )
  if (!base) throw new Error("Governance asset version was not found")
  const latest = Database.use((db) =>
    db.select().from(GovernanceAssetTable).where(eq(GovernanceAssetTable.id, assetId)).orderBy(desc(GovernanceAssetTable.version)).get(),
  )
  if (latest?.version !== input.baseVersion) throw new Error("Governance asset base version is stale")
  const humanAuthority = input.authority === "human_explicit" || input.authority === "human_confirmed"
  const authorityRank = {
    external_source: 0,
    ai_proposed: 0,
    human_confirmed: 1,
    human_explicit: 2,
  } as const
  if (authorityRank[input.authority] < authorityRank[base.authority as keyof typeof authorityRank])
    throw new Error("Governance asset authority cannot be downgraded")
  if (input.actorKind === "ai" && input.authority !== "ai_proposed")
    throw new Error("AI actors can only create ai_proposed drafts")
  if (input.actorKind === "external" && input.authority !== "external_source")
    throw new Error("External actors can only create external_source drafts")
  if (input.actorKind === "human" && !humanAuthority)
    throw new Error("Human confirmation revisions must use human authority")
  if (input.actorKind !== "human" && (humanAuthority || input.status !== "draft" || input.confirmation))
    throw new Error("AI and external actors can only create draft non-human authority")
  if (input.actorKind === "human" && humanAuthority && !input.confirmation)
    throw new Error("Human authority requires a confirmation event")
  if (!humanAuthority && (input.status !== "draft" || input.confirmation))
    throw new Error("Non-human authority remains draft")
  const version = base.version + 1
  const now = Date.now()
  Database.transaction((tx) => {
    tx.insert(GovernanceAssetTable)
      .values({
        id: assetId,
        company_id: base.company_id,
        type: base.type,
        scope_kind: base.scope_kind,
        scope_ref: base.scope_ref,
        content: input.content,
        rationale: input.rationale,
        tags_json: JSON.stringify(input.tags),
        authority: input.authority,
        status: input.status,
        source_refs_json: JSON.stringify(input.sourceRefs),
        supersedes_version: base.version,
        version,
        created_by: input.createdBy,
        approved_by: input.confirmation?.confirmedBy ?? null,
        confirmation_event_id: input.confirmation?.eventId ?? null,
        created_at: now,
      })
      .run()
    if (input.status === "draft") return
    const previous = latestAssetSelections(base.company_id).get(assetId)
    tx.insert(GovernanceAssetSelectionTable)
      .values({
        id: Identifier.create("gasel", "ascending"),
        company_id: base.company_id,
        asset_id: assetId,
        asset_version: version,
        previous_version: previous ?? null,
        selected_by: input.confirmation!.confirmedBy,
        created_at: now,
      })
      .run()
  }, { behavior: "immediate" })
  return projection(base.company_id, base.scope_ref ? { kind: base.scope_kind as GovernanceAssetScope["kind"], ref: base.scope_ref } : { kind: "company" })
}

export function compileSnapshot(raw: FounderSnapshotCompileInputValue) {
  const input = FounderSnapshotCompileInput.parse(raw)
  const refs = listAssets(input.companyId, input.scope)
    .filter((asset) => asset.current && asset.status === "active")
    .map((asset) => ({ assetId: asset.id, version: asset.version }))
    .toSorted((left, right) => `${left.assetId}:${left.version}`.localeCompare(`${right.assetId}:${right.version}`))
  const checksum = digest({
    schemaVersion: 1,
    profileSummaryHash: digest(input.profileSummary),
    assetRefs: refs,
    promptTemplateVersion: input.promptTemplateVersion,
    modelConfigRef: input.modelConfigRef,
    retrievalConfigRef: input.retrievalConfigRef,
    permissionConfigRef: input.permissionConfigRef,
    compiledPromptHash: input.compiledPromptHash,
  })
  const existing = Database.use((db) =>
    db.select().from(FounderTwinSnapshotTable).where(and(eq(FounderTwinSnapshotTable.company_id, input.companyId), eq(FounderTwinSnapshotTable.checksum, checksum))).get(),
  )
  if (existing) return snapshotFromRow(existing, existing.id === selectedSnapshotId(input.companyId))
  const version = (Database.use((db) =>
    db.select({ version: FounderTwinSnapshotTable.version }).from(FounderTwinSnapshotTable).where(eq(FounderTwinSnapshotTable.company_id, input.companyId)).orderBy(desc(FounderTwinSnapshotTable.version)).get(),
  )?.version ?? 0) + 1
  const id = Identifier.create("ftsnap", "ascending")
  Database.transaction((tx) =>
    tx.insert(FounderTwinSnapshotTable).values({
      id,
      company_id: input.companyId,
      version,
      profile_summary: input.profileSummary,
      asset_refs_json: JSON.stringify(refs),
      prompt_template_version: input.promptTemplateVersion,
      model_config_ref: input.modelConfigRef,
      retrieval_config_ref: input.retrievalConfigRef,
      permission_config_ref: input.permissionConfigRef,
      compiled_prompt_hash: input.compiledPromptHash,
      checksum,
      created_by: input.createdBy,
      created_at: Date.now(),
    }).run(),
  )
  return snapshotFromRow(Database.use((db) => db.select().from(FounderTwinSnapshotTable).where(eq(FounderTwinSnapshotTable.id, id)).get()!), false)
}

export function selectSnapshot(raw: FounderSnapshotSelectInputValue) {
  const input = FounderSnapshotSelectInput.parse(raw)
  const snapshot = Database.use((db) =>
    db.select().from(FounderTwinSnapshotTable).where(and(eq(FounderTwinSnapshotTable.id, input.snapshotId), eq(FounderTwinSnapshotTable.company_id, input.companyId))).get(),
  )
  if (!snapshot) throw new Error("Founder Twin Snapshot was not found")
  const previous = selectedSnapshotId(input.companyId)
  if (previous === input.snapshotId) return projection(input.companyId)
  Database.transaction((tx) =>
    tx.insert(FounderTwinSnapshotSelectionTable).values({
      id: Identifier.create("ftsel", "ascending"),
      company_id: input.companyId,
      snapshot_id: input.snapshotId,
      previous_snapshot_id: previous ?? null,
      reason: input.reason,
      selected_by: input.selectedBy,
      created_at: Date.now(),
    }).run(),
  )
  return projection(input.companyId)
}
