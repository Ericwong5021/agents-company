import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import {
  FounderAssetReference,
  FounderBenchmarkCase,
  FounderBenchmarkCaseInput,
  FounderBenchmarkPrediction,
  FounderBenchmarkReport,
  FounderBenchmarkRunInput,
  FounderBenchmarkSourcePayload,
  GovernanceAssetScope,
  type FounderBenchmarkCaseInput as FounderBenchmarkCaseInputValue,
  type FounderBenchmarkRunInput as FounderBenchmarkRunInputValue,
} from "@agents-company/shared/founder-os"
import { Identifier } from "@/id/id"
import { CompanyID } from "@/company/schema"
import { activeBenchmarkTarget } from "@/company-learning/target-adapters"
import { Database } from "@/storage"
import { FounderTwinSnapshotTable, GovernanceAssetTable } from "./asset.sql"
import { FounderBenchmarkCaseTable, FounderBenchmarkReportTable } from "./shadow.sql"
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

function sourcePayload(content: string) {
  try {
    return FounderBenchmarkSourcePayload.safeParse(JSON.parse(content)).data
  } catch {
    return undefined
  }
}

function caseFromRow(row: typeof FounderBenchmarkCaseTable.$inferSelect) {
  return FounderBenchmarkCase.parse({
    id: row.id,
    companyId: row.company_id,
    benchmarkType: row.benchmark_type,
    datasetVersion: row.dataset_version,
    split: row.split,
    sourceAsset: { assetId: row.source_asset_id, version: row.source_asset_version },
    expected: JSON.parse(row.expected_json),
    confirmationEventId: row.confirmation_event_id,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
  })
}

function reportFromRow(row: typeof FounderBenchmarkReportTable.$inferSelect) {
  return FounderBenchmarkReport.parse({
    id: row.id,
    companyId: row.company_id,
    benchmarkType: row.benchmark_type,
    datasetVersion: row.dataset_version,
    snapshotId: row.snapshot_id,
    status: row.status,
    blockReasons: JSON.parse(row.block_reasons_json),
    metrics: JSON.parse(row.metrics_json),
    authorization: {
      status: "not_confirmed",
      blocking: false,
      confirmedSampleCount: row.confirmed_sample_count,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
  })
}

export function registerCase(raw: FounderBenchmarkCaseInputValue) {
  const input = FounderBenchmarkCaseInput.parse(raw)
  const asset = Database.use((db) =>
    db
      .select()
      .from(GovernanceAssetTable)
      .where(and(
        eq(GovernanceAssetTable.id, input.sourceAsset.assetId),
        eq(GovernanceAssetTable.version, input.sourceAsset.version),
        eq(GovernanceAssetTable.company_id, input.companyId),
      ))
      .get(),
  )
  if (!asset) throw new Error("Benchmark source asset was not found")
  if (
    input.benchmarkType === "founder_decision"
    && asset.type !== "decision_case"
  )
    throw new Error("Founder Decision Benchmark requires a decision_case asset")
  if (
    input.benchmarkType === "taste"
    && asset.type !== "taste_reference"
    && asset.type !== "taste_anti_reference"
  )
    throw new Error("Taste Benchmark requires a taste asset")
  if (
    asset.status !== "active"
    || (asset.authority !== "human_explicit" && asset.authority !== "human_confirmed")
    || !asset.confirmation_event_id
    || !asset.approved_by
  )
    throw new Error("Benchmark source asset requires verifiable human authority")
  const payload = sourcePayload(asset.content)
  if (!payload || payload.benchmarkType !== input.benchmarkType)
    throw new Error("Benchmark source asset requires a typed payload matching the benchmark type")
  if (
    input.confirmationEventId !== asset.confirmation_event_id
    || input.confirmedBy !== asset.approved_by
    || digest(input.expected) !== digest(payload.expected)
  )
    throw new Error("Benchmark case facts must exactly match the human-confirmed source asset")
  const confirmationEventId = asset.confirmation_event_id
  const confirmedBy = asset.approved_by
  const id = Identifier.create("fbcase", "ascending")
  Database.transaction((db) =>
    db.insert(FounderBenchmarkCaseTable)
      .values({
        id,
        company_id: CompanyID.parse(input.companyId),
        benchmark_type: input.benchmarkType,
        dataset_version: input.datasetVersion,
        split: input.split,
        source_asset_id: input.sourceAsset.assetId,
        source_asset_version: input.sourceAsset.version,
        expected_json: JSON.stringify(payload.expected),
        confirmation_event_id: confirmationEventId,
        confirmed_by: confirmedBy,
        created_at: Date.now(),
      })
      .run(),
  )
  return caseFromRow(Database.use((db) =>
    db.select().from(FounderBenchmarkCaseTable).where(eq(FounderBenchmarkCaseTable.id, id)).get()!,
  ))
}

export function cases(companyId: string, benchmarkType: "founder_decision" | "taste", datasetVersion: string) {
  return Database.use((db) =>
    db
      .select()
      .from(FounderBenchmarkCaseTable)
      .where(and(
        eq(FounderBenchmarkCaseTable.company_id, companyId),
        eq(FounderBenchmarkCaseTable.benchmark_type, benchmarkType),
        eq(FounderBenchmarkCaseTable.dataset_version, datasetVersion),
      ))
      .orderBy(asc(FounderBenchmarkCaseTable.id))
      .all(),
  ).map(caseFromRow)
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : numerator / denominator
}

export function run(raw: FounderBenchmarkRunInputValue) {
  const input = FounderBenchmarkRunInput.parse(raw)
  return Effect.gen(function* () {
    const target = Database.use((db) => activeBenchmarkTarget(db, input.companyId, input.datasetVersion))
    if (target && (
      target.payload.benchmark_type !== input.benchmarkType
      || target.payload.dataset_version !== input.datasetVersion
    ))
      throw new Error("Active Benchmark target does not match the requested benchmark")
    const thresholds = target?.payload ?? {
      benchmark_type: input.benchmarkType,
      dataset_version: input.datasetVersion,
      minimum_sample_count: 1,
      minimum_agreement_rate: input.benchmarkType === "founder_decision" ? 0.7 : 0.8,
      minimum_traceability_rate: 1,
      required_red_recall: input.benchmarkType === "founder_decision" ? 1 : null,
      affects_authority_or_release_gate: false,
    }
    const snapshot = Database.use((db) =>
      db
        .select()
        .from(FounderTwinSnapshotTable)
        .where(and(
          eq(FounderTwinSnapshotTable.id, input.snapshotId),
          eq(FounderTwinSnapshotTable.company_id, input.companyId),
        ))
        .get(),
    )
    const dataset = cases(input.companyId, input.benchmarkType, input.datasetVersion)
    const holdout = dataset.filter((item) => item.split === "holdout")
    const snapshotRefs = new Set(
      snapshot
        ? FounderAssetReference.array()
          .parse(JSON.parse(snapshot.asset_refs_json))
          .map((reference) => `${reference.assetId}:${reference.version}`)
        : [],
    )
    const validSnapshot = snapshot
      ? snapshot.checksum === digest({
          schemaVersion: 1,
          profileSummaryHash: digest(snapshot.profile_summary),
          assetRefs: JSON.parse(snapshot.asset_refs_json),
          promptTemplateVersion: snapshot.prompt_template_version,
          modelConfigRef: snapshot.model_config_ref,
          retrievalConfigRef: snapshot.retrieval_config_ref,
          permissionConfigRef: snapshot.permission_config_ref,
          compiledPromptHash: snapshot.compiled_prompt_hash,
        })
      : false
    const sourceAssets = holdout.map((item) => ({
      item,
      asset: Database.use((db) =>
        db
          .select()
          .from(GovernanceAssetTable)
          .where(and(
            eq(GovernanceAssetTable.id, item.sourceAsset.assetId),
            eq(GovernanceAssetTable.version, item.sourceAsset.version),
            eq(GovernanceAssetTable.company_id, input.companyId),
          ))
          .get(),
      ),
    })).map((entry) => ({
      ...entry,
      payload: entry.asset ? sourcePayload(entry.asset.content) : undefined,
    }))
    const initialReasons: FounderBenchmarkReport["blockReasons"] = [
      ...(!snapshot ? ["snapshot_missing" as const] : []),
      ...(snapshot && !validSnapshot ? ["snapshot_checksum_invalid" as const] : []),
      ...(holdout.length === 0 ? ["holdout_empty" as const] : []),
      ...(sourceAssets.some((entry) =>
        !entry.asset || !entry.payload || entry.payload.benchmarkType !== input.benchmarkType)
        ? ["model_output_invalid" as const]
        : []),
      ...(holdout.some((item) =>
        snapshotRefs.has(`${item.sourceAsset.assetId}:${item.sourceAsset.version}`))
        ? ["training_holdout_leakage" as const]
        : []),
    ]
    const provider = yield* FounderModelProvider
    const generated = initialReasons.length
      ? { output: [] as unknown }
      : yield* provider.generateBenchmark({
          companyId: input.companyId,
          modelConfigRef: snapshot!.model_config_ref,
          snapshot: { id: snapshot!.id, checksum: snapshot!.checksum },
          benchmarkType: input.benchmarkType,
          cases: sourceAssets.map((entry) => ({
            id: entry.item.id,
            sourceAsset: entry.item.sourceAsset,
            scope: GovernanceAssetScope.parse({
              kind: entry.asset!.scope_kind,
              ...(entry.asset!.scope_ref ? { ref: entry.asset!.scope_ref } : {}),
            }),
            prompt: entry.payload!.prompt,
            tags: JSON.parse(entry.asset!.tags_json),
            evidenceRefs: JSON.parse(entry.asset!.source_refs_json).map(
              (reference: { kind: string; id: string }) => ({
                kind: reference.kind === "external" ? "fact" : reference.kind,
                id: reference.id,
                validity: "verified",
              }),
            ),
          })),
          timeoutMs: 60_000,
        }).pipe(Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (output) => ({ output }),
        }))
    const parsed = "error" in generated
      ? undefined
      : FounderBenchmarkPrediction.array().safeParse(generated.output)
    const predictionValues = parsed?.success ? parsed.data : []
    const predictionByCase = new Map(predictionValues.map((prediction) => [prediction.caseId, prediction]))
    const holdoutIds = new Set(holdout.map((item) => item.id))
    const referencesValid = predictionValues.every((prediction) => {
      const source = sourceAssets.find((entry) => entry.item.id === prediction.caseId)?.asset
      const evidenceRefs = new Set(
        source
          ? JSON.parse(source.source_refs_json).map(
              (reference: { kind: string; id: string }) =>
                `${reference.kind === "external" ? "fact" : reference.kind}:${reference.id}`,
            )
          : [],
      )
      return prediction.principleRefs.every((reference) =>
        snapshotRefs.has(`${reference.assetId}:${reference.version}`)
      )
        && prediction.decisionCaseRefs.every((reference) =>
          snapshotRefs.has(`${reference.assetId}:${reference.version}`)
        )
        && prediction.evidenceRefs.every((reference) =>
          reference.validity === "verified" && evidenceRefs.has(`${reference.kind}:${reference.id}`)
        )
        && (
          input.benchmarkType === "founder_decision"
            ? prediction.authorityClass !== undefined && prediction.decision !== undefined
            : prediction.preference !== undefined
        )
    })
    const blockReasons: FounderBenchmarkReport["blockReasons"] = [
      ...initialReasons,
      ...("error" in generated
        ? [
            generated.error.reason === "timeout"
              ? "model_timeout" as const
              : generated.error.reason === "invalid_output"
                ? "model_output_invalid" as const
                : "model_unavailable" as const,
          ]
        : []),
      ...(!parsed?.success || !referencesValid ? ["model_output_invalid" as const] : []),
      ...(holdout.length !== predictionValues.length
        || predictionValues.some((prediction) => !holdoutIds.has(prediction.caseId))
        || holdout.some((item) => !predictionByCase.has(item.id))
        ? ["prediction_set_incomplete" as const]
        : []),
    ].filter((reason, index, reasons) => reasons.indexOf(reason) === index)
    const predictions = holdout
      .map((item) => ({ item, prediction: predictionByCase.get(item.id) }))
      .filter((entry): entry is { item: FounderBenchmarkCase; prediction: FounderBenchmarkPrediction } =>
        entry.prediction !== undefined)
    const red = predictions.filter((entry) => entry.item.expected.authorityClass === "red")
    const redRecall = ratio(
      red.filter((entry) => entry.prediction.authorityClass === "red").length,
      red.length,
    )
    const traceabilityRate = ratio(
      predictions.filter((entry) =>
        entry.prediction.principleRefs.length > 0
        && entry.prediction.evidenceRefs.some((reference) => reference.validity === "verified"),
      ).length,
      predictions.length,
    )
    const agreementRate = ratio(
      predictions.filter((entry) =>
        input.benchmarkType === "founder_decision"
          ? entry.prediction.authorityClass === entry.item.expected.authorityClass
            && entry.prediction.decision?.trim() === entry.item.expected.decision?.trim()
          : entry.prediction.preference === entry.item.expected.preference,
      ).length,
      predictions.length,
    )
    const metrics = {
      caseCount: holdout.length,
      redRecall: input.benchmarkType === "founder_decision" ? redRecall : null,
      traceabilityRate,
      agreementRate,
    }
    const status = blockReasons.length > 0
      ? "blocked"
      : holdout.length >= thresholds.minimum_sample_count
        && traceabilityRate !== null
        && traceabilityRate >= thresholds.minimum_traceability_rate
        && agreementRate !== null
        && agreementRate >= thresholds.minimum_agreement_rate
        && (thresholds.required_red_recall === null
          || redRecall !== null && redRecall >= thresholds.required_red_recall)
        ? "pass"
        : "fail"
    const inputChecksum = digest({
      benchmarkType: input.benchmarkType,
      datasetVersion: input.datasetVersion,
      snapshotId: input.snapshotId,
      targetVersionId: target?.id ?? null,
      cases: holdout.map((item) => ({
        id: item.id,
        sourceAsset: item.sourceAsset,
        expected: item.expected,
        confirmationEventId: item.confirmationEventId,
      })),
      predictions: predictionValues.toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
    })
    const existing = Database.use((db) =>
      db
        .select()
        .from(FounderBenchmarkReportTable)
        .where(and(
          eq(FounderBenchmarkReportTable.company_id, input.companyId),
          eq(FounderBenchmarkReportTable.benchmark_type, input.benchmarkType),
          eq(FounderBenchmarkReportTable.dataset_version, input.datasetVersion),
          eq(FounderBenchmarkReportTable.snapshot_id, input.snapshotId),
          eq(FounderBenchmarkReportTable.input_checksum, inputChecksum),
        ))
        .get(),
    )
    if (existing) return reportFromRow(existing)
    const id = Identifier.create("fbrep", "ascending")
    Database.transaction((db) =>
      db.insert(FounderBenchmarkReportTable)
        .values({
          id,
          company_id: input.companyId,
          benchmark_type: input.benchmarkType,
          dataset_version: input.datasetVersion,
          snapshot_id: input.snapshotId,
          status,
          block_reasons_json: JSON.stringify(blockReasons),
          metrics_json: JSON.stringify(metrics),
          confirmed_sample_count: holdout.length,
          input_checksum: inputChecksum,
          created_by: input.createdBy,
          created_at: Date.now(),
        })
        .run(),
    )
    return reportFromRow(Database.use((db) =>
      db.select().from(FounderBenchmarkReportTable).where(eq(FounderBenchmarkReportTable.id, id)).get()!,
    ))
  })
}
