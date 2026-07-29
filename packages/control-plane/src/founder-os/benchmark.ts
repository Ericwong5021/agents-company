import { and, asc, eq } from "drizzle-orm"
import {
  FounderAssetReference,
  FounderBenchmarkCase,
  FounderBenchmarkCaseInput,
  FounderBenchmarkPrediction,
  FounderBenchmarkReport,
  FounderBenchmarkRunInput,
  type FounderBenchmarkCaseInput as FounderBenchmarkCaseInputValue,
  type FounderBenchmarkRunInput as FounderBenchmarkRunInputValue,
} from "@agents-company/shared/founder-os"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { FounderTwinSnapshotTable, GovernanceAssetTable } from "./asset.sql"
import { FounderBenchmarkCaseTable, FounderBenchmarkReportTable } from "./shadow.sql"

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
  )
    throw new Error("Benchmark source asset requires verifiable human authority")
  const id = Identifier.create("fbcase", "ascending")
  Database.transaction((db) =>
    db.insert(FounderBenchmarkCaseTable)
      .values({
        id,
        company_id: input.companyId,
        benchmark_type: input.benchmarkType,
        dataset_version: input.datasetVersion,
        split: input.split,
        source_asset_id: input.sourceAsset.assetId,
        source_asset_version: input.sourceAsset.version,
        expected_json: JSON.stringify(input.expected),
        confirmation_event_id: input.confirmationEventId,
        confirmed_by: input.confirmedBy,
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
  const predictionByCase = new Map(input.predictions.map((prediction) => [prediction.caseId, prediction]))
  const holdoutIds = new Set(holdout.map((item) => item.id))
  const snapshotRefs = new Set(
    snapshot
      ? FounderAssetReference.array()
        .parse(JSON.parse(snapshot.asset_refs_json))
        .map((reference) => `${reference.assetId}:${reference.version}`)
      : [],
  )
  const blockReasons = [
    ...(!snapshot ? ["snapshot_missing" as const] : []),
    ...(holdout.length === 0 ? ["holdout_empty" as const] : []),
    ...(holdout.length !== input.predictions.length
      || input.predictions.some((prediction) => !holdoutIds.has(prediction.caseId))
      || holdout.some((item) => !predictionByCase.has(item.id))
      ? ["prediction_set_incomplete" as const]
      : []),
    ...(holdout.some((item) =>
      snapshotRefs.has(`${item.sourceAsset.assetId}:${item.sourceAsset.version}`))
      ? ["training_holdout_leakage" as const]
      : []),
  ]
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
    : traceabilityRate === 1
      && agreementRate !== null
      && agreementRate >= (input.benchmarkType === "founder_decision" ? 0.7 : 0.8)
      && (input.benchmarkType === "taste" || redRecall === 1)
      ? "pass"
      : "fail"
  const inputChecksum = digest({
    benchmarkType: input.benchmarkType,
    datasetVersion: input.datasetVersion,
    snapshotId: input.snapshotId,
    cases: holdout.map((item) => ({
      id: item.id,
      sourceAsset: item.sourceAsset,
      expected: item.expected,
      confirmationEventId: item.confirmationEventId,
    })),
    predictions: input.predictions.toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
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
}
