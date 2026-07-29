import { createHash } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import z from "zod"
import {
  FounderAdvisorReadiness,
  FounderAdvisorReadinessRecordInput,
  type FounderAdvisorReadinessRecordInput as FounderAdvisorReadinessRecordInputValue,
} from "@agents-company/shared/founder-os"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import {
  CompanyProjectTable,
  CompanyWorktreeRunTable,
} from "@/company-project/company-project.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { FounderAdvisorReadinessTable } from "./advisor.sql"
import { FounderGovernanceEventTable } from "./decision-ledger.sql"
import * as FounderOSMode from "./mode"
import { FounderBenchmarkReportTable } from "./shadow.sql"

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function metrics(row?: typeof FounderBenchmarkReportTable.$inferSelect) {
  const value = row
    ? z
        .object({
          caseCount: z.number().int().nonnegative(),
          redRecall: z.number().min(0).max(1).nullable(),
          traceabilityRate: z.number().min(0).max(1).nullable(),
          agreementRate: z.number().min(0).max(1).nullable(),
        })
        .parse(JSON.parse(row.metrics_json))
    : undefined
  return {
    confirmedSampleCount: row?.confirmed_sample_count ?? 0,
    redRecall: value?.redRecall ?? null,
    traceabilityRate: value?.traceabilityRate ?? null,
    historicalAgreementRate: value?.agreementRate ?? null,
  }
}

export function readiness(companyId: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(FounderAdvisorReadinessTable)
      .where(eq(FounderAdvisorReadinessTable.company_id, companyId))
      .orderBy(desc(FounderAdvisorReadinessTable.created_at), desc(FounderAdvisorReadinessTable.id))
      .get(),
  )
  if (row)
    return FounderAdvisorReadiness.parse({
      schemaVersion: 1,
      companyId,
      status: "ready",
      exactCommit: {
        status: "passed",
        sha: row.exact_commit_sha,
        evidenceRef: row.exact_commit_evidence_ref,
      },
      benchmarkReportId: row.benchmark_report_id,
      metrics: {
        confirmedSampleCount: row.confirmed_sample_count,
        redRecall: row.red_recall / 1_000_000,
        traceabilityRate: row.traceability_rate / 1_000_000,
        historicalAgreementRate: row.historical_agreement_rate / 1_000_000,
      },
      authorization: {
        status: "human_confirmed",
        eventId: row.authorization_event_id,
        confirmedBy: row.confirmed_by,
      },
      failClosedReasons: [],
      autoPromotionAllowed: false,
      recordedAt: row.created_at,
    })
  const report = Database.use((db) =>
    db
      .select()
      .from(FounderBenchmarkReportTable)
      .where(and(
        eq(FounderBenchmarkReportTable.company_id, companyId),
        eq(FounderBenchmarkReportTable.benchmark_type, "founder_decision"),
      ))
      .orderBy(desc(FounderBenchmarkReportTable.created_at), desc(FounderBenchmarkReportTable.id))
      .get(),
  )
  const values = metrics(report)
  const metricReasons = [
    ...(values.confirmedSampleCount > 0 ? [] : ["Human-confirmed holdout samples are missing."]),
    ...(values.redRecall === 1 ? [] : ["Red-light recall must equal 100%."]),
    ...(values.traceabilityRate === 1 ? [] : ["Traceability must equal 100%."]),
    ...(values.historicalAgreementRate !== null && values.historicalAgreementRate >= 0.7
      ? []
      : ["Historical agreement must be at least 70%."]),
  ]
  return FounderAdvisorReadiness.parse({
    schemaVersion: 1,
    companyId,
    status: values.confirmedSampleCount === 0 ? "not_confirmed" : metricReasons.length ? "blocked" : "not_confirmed",
    exactCommit: { status: "missing", sha: null, evidenceRef: null },
    benchmarkReportId: report?.id ?? null,
    metrics: values,
    authorization: { status: "missing", eventId: null, confirmedBy: null },
    failClosedReasons: [
      ...metricReasons,
      "W4 exact-commit evidence is missing.",
      "Human authorization is missing.",
    ],
    autoPromotionAllowed: false,
    recordedAt: null,
  })
}

export function record(raw: FounderAdvisorReadinessRecordInputValue) {
  const input = FounderAdvisorReadinessRecordInput.parse(raw)
  const inputSha256 = digest(input)
  Database.transaction((db) => {
    const existing = db
      .select()
      .from(FounderAdvisorReadinessTable)
      .where(and(
        eq(FounderAdvisorReadinessTable.company_id, input.companyId),
        eq(FounderAdvisorReadinessTable.idempotency_key, input.idempotencyKey),
      ))
      .get()
    if (existing) {
      if (existing.input_sha256 !== inputSha256)
        throw new Error("Advisor readiness idempotency key has different facts")
      return
    }
    const company = db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(input.companyId))).get()
    if (!company) throw new Error("Company was not found")
    const mode = FounderOSMode.resolve({
      founderTwinMode: company.founder_twin_mode,
      companyCommonsMode: company.company_commons_mode,
    })
    if (company.founder_twin_mode !== "shadow")
      throw new Error("Advisor readiness promotion requires current company mode shadow")
    if (!["advisor", "green-delegated", "yellow-delegated"].includes(mode.globalMaximum.founderTwinMode))
      throw new Error("Global Founder Twin mode does not allow Advisor")
    const report = db
      .select()
      .from(FounderBenchmarkReportTable)
      .where(and(
        eq(FounderBenchmarkReportTable.id, input.benchmarkReportId),
        eq(FounderBenchmarkReportTable.company_id, input.companyId),
        eq(FounderBenchmarkReportTable.benchmark_type, "founder_decision"),
      ))
      .get()
    const values = metrics(report)
    if (
      !report
      || report.status !== "pass"
      || values.confirmedSampleCount === 0
      || values.redRecall !== 1
      || values.traceabilityRate !== 1
      || values.historicalAgreementRate === null
      || values.historicalAgreementRate < 0.7
    )
      throw new Error("Advisor readiness benchmark thresholds are not satisfied")
    const worktree = db
      .select()
      .from(CompanyWorktreeRunTable)
      .where(eq(CompanyWorktreeRunTable.id, input.exactCommit.worktreeRunId))
      .get()
    const project = worktree
      ? db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, worktree.project_id)).get()
      : undefined
    if (
      !worktree
      || project?.company_id !== input.companyId
      || worktree.status !== "merged"
      || worktree.head_commit !== input.exactCommit.sha
      || !worktree.merge_gate_id
    )
      throw new Error("Advisor readiness requires a merged W4 exact-commit WorktreeRun")
    const authorization = db
      .select()
      .from(FounderGovernanceEventTable)
      .where(and(
        eq(FounderGovernanceEventTable.id, input.authorizationEventId),
        eq(FounderGovernanceEventTable.company_id, input.companyId),
        eq(FounderGovernanceEventTable.actor_kind, "human"),
        eq(FounderGovernanceEventTable.actor_id, input.actor.id),
      ))
      .get()
    const authorizationData = authorization
      ? z.object({ decision: z.literal("approve") }).catchall(z.unknown()).safeParse(JSON.parse(authorization.data_json))
      : undefined
    if (
      !authorization
      || authorization.type !== "approval_gate.resolved"
      || !authorizationData?.success
    )
      throw new Error("Advisor readiness requires an approved human authorization event")
    db.insert(FounderAdvisorReadinessTable)
      .values({
        id: Identifier.create("fard", "ascending"),
        company_id: input.companyId,
        idempotency_key: input.idempotencyKey,
        input_sha256: inputSha256,
        exact_commit_sha: input.exactCommit.sha,
        exact_commit_evidence_ref: worktree.id,
        benchmark_report_id: report.id,
        confirmed_sample_count: values.confirmedSampleCount,
        red_recall: Math.round(values.redRecall * 1_000_000),
        traceability_rate: Math.round(values.traceabilityRate * 1_000_000),
        historical_agreement_rate: Math.round(values.historicalAgreementRate * 1_000_000),
        authorization_event_id: authorization.id,
        confirmed_by: input.actor.id,
        created_at: Date.now(),
      })
      .run()
    db.update(CompanyTable)
      .set({ founder_twin_mode: "advisor", time_updated: Date.now() })
      .where(eq(CompanyTable.id, CompanyID.parse(input.companyId)))
      .run()
  }, { behavior: "immediate" })
  return readiness(input.companyId)
}
