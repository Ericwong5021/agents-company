import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import {
  RolloutActionRequest,
  RolloutLegacyPromotionDecision,
  RolloutPromotionEvaluationRequest,
  RolloutTransitionRequest,
} from "@agents-company/shared/rollout"
import {
  MetricContract,
  PrePublicCandidateMetricIds,
  PrePublicMetricContractSha256,
} from "@agents-company/shared/seed-grow-metrics"
import { ShadowComparisonReport } from "@agents-company/shared/seed-grow-shadow"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import {
  CompanyRolloutJournalTable,
  CompanyRolloutPromotionDecisionTable,
  CompanyRolloutStateTable,
} from "../../src/company-rollout/company-rollout.sql"
import { CompanyProjectTable } from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

let previousExecutionMode: string | undefined
const metricContract = MetricContract.parse(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../../docs/product-design/experience-refactor/metric-contract.v1.json"),
      "utf8",
    ),
  ) as unknown,
)

beforeEach(async () => {
  previousExecutionMode = process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
  if (previousExecutionMode === undefined) delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
  else process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = previousExecutionMode
})

function storeError(operation: () => unknown) {
  try {
    operation()
  } catch (error) {
    if (error instanceof CompanyRollout.RolloutStoreError) return error
    throw error
  }
  throw new Error("Expected RolloutStoreError")
}

function passingValue(operator: string, target: number) {
  if (operator === "<") return target - 1
  if (operator === ">") return target + 1
  return target
}

function metricReport(candidateSha: string) {
  const runIds = [`${candidateSha.slice(0, 8)}-metric-1`, `${candidateSha.slice(0, 8)}-metric-2`]
  return {
    schemaVersion: 1 as const,
    queryVersion: metricContract.queryVersion,
    candidateSha,
    inputDigest: "1".repeat(64),
    runIds,
    status: "pass" as const,
    results: PrePublicCandidateMetricIds.map((metricId) => {
      const metric = metricContract.metrics.find((item) => item.id === metricId)
      if (!metric || metric.target.value === null) throw new Error(`Missing blocking metric ${metricId}`)
      const value = passingValue(metric.target.operator, metric.target.value)
      return {
        metricId,
        blocking: true,
        status: "pass" as const,
        value,
        numerator: value,
        denominator: 1,
        sampleSize: 2,
        meetsThreshold: true,
        threshold: metric.target,
        blockedReasons: [],
        sourceRefs: runIds.map((runId, index) => ({
          kind: "gate_report" as const,
          id: `${metricId}-${index}`,
          candidateSha,
          runId,
          digest: String(index + 2).repeat(64),
        })),
      }
    }),
  }
}

function shadowReport(candidateSha: string) {
  if (!metricContract.shadowComparison) throw new Error("Missing shadow comparison policy")
  const values = Object.fromEntries(
    metricContract.shadowComparison.checks.map((check) => [check.field, passingValue(check.operator, check.value)]),
  )
  const legacyRunIds = [`${candidateSha.slice(0, 8)}-legacy-1`, `${candidateSha.slice(0, 8)}-legacy-2`]
  const seedAndGrowRunIds = [`${candidateSha.slice(0, 8)}-seed-1`, `${candidateSha.slice(0, 8)}-seed-2`]
  return ShadowComparisonReport.parse({
    schemaVersion: 1,
    queryVersion: metricContract.shadowComparison.queryVersion,
    comparisonId: `comparison-${candidateSha.slice(0, 8)}`,
    candidateSha,
    inputDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64),
    scenarioIds: ["S13", "S18"],
    legacyRunIds,
    seedAndGrowRunIds,
    status: "pass",
    blockedReasons: [],
    deltas: {
      completenessRateDelta: values.completenessRateDelta,
      modelCallsPerUnitDelta: -1,
      costPerUnitDelta: -1,
      reviewerInvocationRatio: values.reviewerInvocationRatio,
      unknownDiscoveryRateDelta: 1,
      errorRateDelta: values.errorRateDelta,
      candidateReuseRateDelta: values.candidateReuseRateDelta,
      lowRiskQualityRatio: values.lowRiskQualityRatio,
    },
    checks: metricContract.shadowComparison.checks.map((check) => ({
      id: check.id,
      field: check.field,
      operator: check.operator,
      target: check.value,
      blocking: check.blocking,
      status: "pass",
      value: values[check.field],
    })),
    sourceRefs: [...legacyRunIds, ...seedAndGrowRunIds].map((runId, index) => ({
      kind: "shadow_report",
      id: `shadow-source-${candidateSha.slice(0, 8)}-${index}`,
      candidateSha,
      runId,
      digest: String(index + 5).repeat(64),
    })),
  })
}

function advanceToDogfood() {
  for (const [to, id] of [
    ["shadow", "phase-shadow"],
    ["opt_in", "phase-opt-in"],
    ["dogfood_default", "phase-dogfood"],
  ] as const)
    CompanyRollout.transition({
      idempotencyKey: id,
      to,
      reason: `advance to ${to}`,
    })
}

function registerPromotionCandidate(id: string, candidateSha: string, copied = false) {
  const offset = id === "candidate-previous" ? 0 : 2
  const repeatOffset = copied ? 0 : offset
  CompanyRollout.recordAction({
    kind: "register_candidate",
    idempotencyKey: `register-${id}`,
    candidate: {
      id,
      candidateSha,
      targetRef: "refs/heads/main",
    },
  })
  for (const ordinal of [1, 2] as const)
    CompanyRollout.recordAction({
      kind: "record_local_repeat",
      idempotencyKey: `repeat-${id}-${ordinal}`,
      repeat: {
        id: `repeat-${id}-${ordinal}`,
        candidateId: id,
        runId: `run-${id}-${ordinal}`,
        ordinal,
        outcome: "completed",
        environmentSha256: String(repeatOffset + ordinal).repeat(64),
        evidenceSha256: String(repeatOffset + ordinal + 4).repeat(64),
        normalizedResultSha256: candidateSha.slice(0, 1).repeat(64),
        startedAt: (repeatOffset + ordinal) * 100,
        finishedAt: (repeatOffset + ordinal) * 100 + 50,
      },
    })
}

function promotionRequest(id: string, previousSha: string, currentSha: string) {
  return RolloutPromotionEvaluationRequest.parse({
    id,
    candidateIds: ["candidate-previous", "candidate-current"],
    metricContract,
    metricContractSha256: PrePublicMetricContractSha256,
    metricReports: [metricReport(previousSha), metricReport(currentSha)],
    shadowReports: [shadowReport(previousSha), shadowReport(currentSha)],
    ancestry: {
      previousCandidateSha: previousSha,
      currentCandidateSha: currentSha,
      parentSha: previousSha,
      targetRef: "refs/heads/main",
      verified: true,
      commandEvidenceSha256: "f".repeat(64),
    },
  })
}

describe("company rollout", () => {
  test("keeps the low-level execution mode separate from persisted new-project policy", () => {
    expect(CompanyRollout.status()).toEqual({
      state: {
        id: "seed_and_grow",
        phase: "off",
        version: 1,
        updatedAt: 0,
      },
      executionMode: "off",
      newProjectPolicy: {
        defaultStrategy: "legacy_full_plan",
        seedOptInAllowed: false,
        explicitLegacyFallbackAllowed: false,
      },
    })

    for (const executionMode of ["off", "shadow"] as const) {
      for (const phase of ["off", "shadow", "opt_in", "dogfood_default", "pre_public_default"] as const) {
        expect(
          CompanyRollout.resolveProjectStrategy({
            phase,
            executionMode,
            requested: "seed_and_grow",
          }),
        ).toBe("legacy_full_plan")
      }
    }

    expect(
      CompanyRollout.resolveProjectStrategy({
        phase: "off",
        executionMode: "active",
        requested: "seed_and_grow",
      }),
    ).toBe("legacy_full_plan")
    expect(
      CompanyRollout.resolveProjectStrategy({
        phase: "shadow",
        executionMode: "active",
        requested: "seed_and_grow",
      }),
    ).toBe("legacy_full_plan")
    expect(
      CompanyRollout.resolveProjectStrategy({
        phase: "opt_in",
        executionMode: "active",
        requested: "seed_and_grow",
      }),
    ).toBe("seed_and_grow")
    expect(
      CompanyRollout.resolveProjectStrategy({
        phase: "opt_in",
        executionMode: "active",
      }),
    ).toBe("legacy_full_plan")

    for (const phase of ["dogfood_default", "pre_public_default"] as const) {
      expect(
        CompanyRollout.resolveProjectStrategy({
          phase,
          executionMode: "active",
        }),
      ).toBe("seed_and_grow")
      expect(
        CompanyRollout.resolveProjectStrategy({
          phase,
          executionMode: "active",
          requested: "legacy_full_plan",
        }),
      ).toBe("legacy_full_plan")
    }
  })

  test("derives the normal execution mode from persisted rollout and keeps an explicit off override", () => {
    delete process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION
    expect(CompanyRollout.status()).toMatchObject({
      state: { phase: "off" },
      executionMode: "off",
      newProjectPolicy: { defaultStrategy: "legacy_full_plan" },
    })
    CompanyRollout.transition({
      idempotencyKey: "persisted-mode-shadow",
      to: "shadow",
      reason: "verify persisted shadow mode",
    })
    expect(CompanyRollout.status()).toMatchObject({
      state: { phase: "shadow" },
      executionMode: "shadow",
      newProjectPolicy: { defaultStrategy: "legacy_full_plan" },
    })
    CompanyRollout.transition({
      idempotencyKey: "persisted-mode-opt-in",
      to: "opt_in",
      reason: "verify persisted opt-in mode",
    })
    expect(CompanyRollout.status()).toMatchObject({
      state: { phase: "opt_in" },
      executionMode: "active",
      newProjectPolicy: { defaultStrategy: "legacy_full_plan", seedOptInAllowed: true },
    })
    CompanyRollout.transition({
      idempotencyKey: "persisted-mode-dogfood",
      to: "dogfood_default",
      reason: "verify persisted default mode",
    })
    expect(CompanyRollout.status()).toMatchObject({
      state: { phase: "dogfood_default" },
      executionMode: "active",
      newProjectPolicy: { defaultStrategy: "seed_and_grow" },
    })
    process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "off"
    expect(CompanyRollout.status()).toMatchObject({
      state: { phase: "dogfood_default" },
      executionMode: "off",
      newProjectPolicy: { defaultStrategy: "legacy_full_plan" },
    })
  })

  test("advances one phase at a time with an idempotent fail-closed journal", () => {
    expect(
      storeError(() =>
        CompanyRollout.transition({
          idempotencyKey: "skip-to-opt-in",
          to: "opt_in",
          reason: "invalid skip",
        }),
      ).code,
    ).toBe("invalid_transition")

    const shadow = CompanyRollout.transition({
      idempotencyKey: "phase-shadow",
      to: "shadow",
      reason: "begin shadow observation",
    })
    expect(shadow).toMatchObject({
      replayed: false,
      state: { phase: "shadow", version: 2 },
      transition: { from: "off", to: "shadow", version: 2 },
    })
    expect(
      CompanyRollout.transition({
        idempotencyKey: "phase-shadow",
        to: "shadow",
        reason: "begin shadow observation",
      }),
    ).toEqual({ ...shadow, replayed: true })
    expect(
      storeError(() =>
        CompanyRollout.transition({
          idempotencyKey: "phase-shadow",
          to: "shadow",
          reason: "different payload",
        }),
      ).code,
    ).toBe("idempotency_collision")

    Database.use((db) =>
      db
        .insert(CompanyProjectTable)
        .values({
          id: "project-running-rollout",
          goal: "block rollout transition",
          title: "Running rollout project",
          status: "executing",
          output_dir: "/tmp/project-running-rollout",
          created_at: 100,
          updated_at: 100,
        })
        .run(),
    )
    expect(
      storeError(() =>
        CompanyRollout.transition({
          idempotencyKey: "phase-opt-in",
          to: "opt_in",
          reason: "enable explicit opt in",
        }),
      ).code,
    ).toBe("running_projects")
    Database.use((db) =>
      db
        .update(CompanyProjectTable)
        .set({ status: "completed", completed_at: 200, updated_at: 200 })
        .where(eq(CompanyProjectTable.id, "project-running-rollout"))
        .run(),
    )

    expect(
      CompanyRollout.transition({
        idempotencyKey: "phase-opt-in",
        to: "opt_in",
        reason: "enable explicit opt in",
      }).state.phase,
    ).toBe("opt_in")
    expect(
      CompanyRollout.transition({
        idempotencyKey: "phase-dogfood",
        to: "dogfood_default",
        reason: "enable dogfood default",
      }).state.phase,
    ).toBe("dogfood_default")
    expect(() =>
      RolloutTransitionRequest.parse({
        idempotencyKey: "phase-pre-public",
        to: "pre_public_default",
        reason: "missing promotion decision",
      }),
    ).toThrow()
    expect(CompanyRollout.listJournal().items).toHaveLength(3)
  })

  test("promotes only the latest two reproducible candidates with machine evidence and both rollbacks", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    advanceToDogfood()
    registerPromotionCandidate("candidate-previous", previousSha)
    registerPromotionCandidate("candidate-current", currentSha)
    CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: "rollback-kill-switch",
      rollback: {
        id: "rollback-kill-switch",
        candidateId: "candidate-current",
        target: "kill_switch",
        phaseAtAction: "dogfood_default",
        executionModeAfter: "off",
        outcome: "completed",
        evidenceSha256: "c".repeat(64),
        observedAt: 500,
      },
    })
    process.env.AGENTCOMPANY_SEED_GROW_ORCHESTRATION = "active"
    CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: "rollback-legacy-fallback",
      rollback: {
        id: "rollback-legacy-fallback",
        candidateId: "candidate-current",
        target: "legacy_fallback",
        phaseAtAction: "dogfood_default",
        executionModeAfter: "active",
        outcome: "completed",
        evidenceSha256: "d".repeat(64),
        observedAt: 600,
      },
    })

    const request = promotionRequest("promotion-pass", previousSha, currentSha)
    const decision = CompanyRollout.evaluatePrePublicPromotion(request)
    expect(decision).toMatchObject({
      id: "promotion-pass",
      candidateIds: ["candidate-previous", "candidate-current"],
      repeatIds: [
        "repeat-candidate-previous-1",
        "repeat-candidate-previous-2",
        "repeat-candidate-current-1",
        "repeat-candidate-current-2",
      ],
      rollbackIds: ["rollback-kill-switch", "rollback-legacy-fallback"],
      derivedMetricResult: {
        metricId: "consecutive_reproducible_candidate_count",
        blocking: true,
        status: "pass",
        value: 2,
        numerator: 2,
        denominator: 2,
        sampleSize: 4,
        meetsThreshold: true,
        threshold: {
          gate: "R4",
          operator: ">=",
          value: 2,
        },
        reasons: [],
      },
      status: "pass",
      reasons: [],
    })
    expect(decision.derivedMetricResult.sourceRefs).toHaveLength(4)
    expect(CompanyRollout.evaluatePrePublicPromotion(request)).toEqual(decision)
    expect(
      storeError(() =>
        CompanyRollout.evaluatePrePublicPromotion({
          ...request,
          ancestry: { ...request.ancestry, commandEvidenceSha256: "e".repeat(64) },
        }),
      ).code,
    ).toBe("idempotency_collision")
    expect(
      CompanyRollout.transition({
        idempotencyKey: "phase-pre-public",
        to: "pre_public_default",
        reason: "machine promotion gate passed",
        promotionDecisionId: decision.id,
      }),
    ).toMatchObject({
      state: { phase: "pre_public_default", version: 5 },
      transition: { promotionDecisionId: decision.id },
    })
    expect(CompanyRollout.evidence().promotionDecisions).toEqual([decision])

    Database.use((db) =>
      db
        .update(CompanyRolloutPromotionDecisionTable)
        .set({ status: "failed", reasons_json: '["tampered"]' })
        .where(eq(CompanyRolloutPromotionDecisionTable.id, decision.id))
        .run(),
    )
    expect(storeError(() => CompanyRollout.evidence()).code).toBe("invalid_persisted_fact")
  })

  test("accepts exactly the 17 candidate metrics and rejects caller-supplied or non-passing results", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    advanceToDogfood()
    registerPromotionCandidate("candidate-previous", previousSha)
    registerPromotionCandidate("candidate-current", currentSha)
    const request = promotionRequest("promotion-extra-metric", previousSha, currentSha)
    const consecutiveMetric = metricContract.metrics.find(
      (metric) => metric.id === "consecutive_reproducible_candidate_count",
    )
    if (!consecutiveMetric) throw new Error("Missing consecutive candidate metric")
    const extraMetricDecision = CompanyRollout.evaluatePrePublicPromotion({
      ...request,
      metricReports: [
        {
          ...request.metricReports[0],
          results: [
            ...request.metricReports[0].results,
            {
              ...request.metricReports[0].results[0],
              metricId: consecutiveMetric.id,
              threshold: consecutiveMetric.target,
            },
          ],
        },
        request.metricReports[1],
      ],
    })
    expect(extraMetricDecision.reasons).toContain(`metric_result_set_invalid:${previousSha}`)
    expect(extraMetricDecision.derivedMetricResult).toMatchObject({
      metricId: "consecutive_reproducible_candidate_count",
      status: "failed",
      value: 0,
      reasons: [`metric_result_set_invalid:${previousSha}`],
    })

    const failedMetricId = request.metricReports[0].results[0].metricId
    const failedMetricDecision = CompanyRollout.evaluatePrePublicPromotion({
      ...request,
      id: "promotion-failed-metric",
      metricReports: [
        {
          ...request.metricReports[0],
          status: "failed",
          results: request.metricReports[0].results.map((result, index) =>
            index === 0 ? { ...result, status: "failed" as const } : result,
          ),
        },
        request.metricReports[1],
      ],
    })
    expect(failedMetricDecision.reasons).toEqual(
      expect.arrayContaining([
        `metric_report_not_pass:${previousSha}`,
        `metric_failed:${previousSha}:${failedMetricId}`,
      ]),
    )
    expect(failedMetricDecision.derivedMetricResult.status).toBe("failed")

    const failedShadowCheckId = request.shadowReports[0].checks[0].id
    const failedShadowDecision = CompanyRollout.evaluatePrePublicPromotion({
      ...request,
      id: "promotion-failed-shadow",
      shadowReports: [
        {
          ...request.shadowReports[0],
          status: "failed",
          checks: request.shadowReports[0].checks.map((check, index) =>
            index === 0 ? { ...check, status: "failed" as const } : check,
          ),
        },
        request.shadowReports[1],
      ],
    })
    expect(failedShadowDecision.derivedMetricResult).toMatchObject({
      status: "failed",
      reasons: [`shadow_check_not_pass:${previousSha}:${failedShadowCheckId}`, `shadow_report_failed:${previousSha}`],
    })
  })

  test("rejects copied repeat packages as non-independent and persists the derived result", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    advanceToDogfood()
    registerPromotionCandidate("candidate-previous", previousSha)
    registerPromotionCandidate("candidate-current", currentSha, true)
    const decision = CompanyRollout.evaluatePrePublicPromotion(
      promotionRequest("promotion-copied-repeat", previousSha, currentSha),
    )
    expect(decision.reasons).toContain("candidate_repeat_not_independent:candidate-current")
    expect(decision.derivedMetricResult).toMatchObject({
      metricId: "consecutive_reproducible_candidate_count",
      status: "failed",
      value: 0,
      meetsThreshold: false,
      reasons: ["candidate_repeat_not_independent:candidate-current"],
    })
    expect(CompanyRollout.getPromotionDecision(decision.id)).toEqual(decision)
  })

  test("reads pre-derived passing decisions as blocked after migration", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    const request = promotionRequest("promotion-legacy", previousSha, currentSha)
    const legacyDecision = RolloutLegacyPromotionDecision.parse({
      id: request.id,
      targetPhase: "pre_public_default",
      candidateIds: request.candidateIds,
      candidateShas: [previousSha, currentSha],
      repeatIds: ["legacy-repeat-1", "legacy-repeat-2", "legacy-repeat-3", "legacy-repeat-4"],
      rollbackIds: ["legacy-rollback-1", "legacy-rollback-2"],
      metricContractSha256: request.metricContractSha256,
      metricReportSha256s: request.metricReports.map(CompanyRollout.valueSha256),
      shadowReportSha256s: request.shadowReports.map(CompanyRollout.valueSha256),
      ancestry: request.ancestry,
      inputSha256: CompanyRollout.valueSha256(request),
      status: "pass",
      reasons: [],
      createdAt: 1,
    })
    Database.use((db) =>
      db
        .insert(CompanyRolloutPromotionDecisionTable)
        .values({
          id: legacyDecision.id,
          target_phase: legacyDecision.targetPhase,
          candidate_ids_json: JSON.stringify(legacyDecision.candidateIds),
          candidate_shas_json: JSON.stringify(legacyDecision.candidateShas),
          repeat_ids_json: JSON.stringify(legacyDecision.repeatIds),
          rollback_ids_json: JSON.stringify(legacyDecision.rollbackIds),
          metric_contract_sha256: legacyDecision.metricContractSha256,
          metric_report_sha256s_json: JSON.stringify(legacyDecision.metricReportSha256s),
          shadow_report_sha256s_json: JSON.stringify(legacyDecision.shadowReportSha256s),
          derived_metric_result_json:
            '{"metricId":"consecutive_reproducible_candidate_count","blocking":true,"status":"blocked","value":0,"numerator":0,"denominator":2,"sampleSize":0,"meetsThreshold":false,"threshold":{"gate":"R4","operator":">=","value":2},"reasons":["legacy_decision_missing_derived_metric"],"sourceRefs":[]}',
          ancestry_json: JSON.stringify(legacyDecision.ancestry),
          input_sha256: legacyDecision.inputSha256,
          input_json: JSON.stringify(request),
          output_sha256: CompanyRollout.valueSha256(legacyDecision),
          status: legacyDecision.status,
          reasons_json: JSON.stringify(legacyDecision.reasons),
          created_at: legacyDecision.createdAt,
        })
        .run(),
    )
    expect(CompanyRollout.getPromotionDecision(legacyDecision.id)).toMatchObject({
      id: legacyDecision.id,
      status: "blocked",
      reasons: ["legacy_decision_missing_derived_metric"],
      derivedMetricResult: {
        status: "blocked",
        reasons: ["legacy_decision_missing_derived_metric"],
      },
    })
  })

  test("does not derive the consecutive candidate metric without direct ancestry", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    advanceToDogfood()
    registerPromotionCandidate("candidate-previous", previousSha)
    registerPromotionCandidate("candidate-current", currentSha)
    const request = promotionRequest("promotion-invalid-ancestry", previousSha, currentSha)
    const decision = CompanyRollout.evaluatePrePublicPromotion({
      ...request,
      ancestry: {
        ...request.ancestry,
        parentSha: currentSha,
      },
    })
    expect(decision.reasons).toContain("candidate_ancestry_invalid")
    expect(decision.derivedMetricResult).toMatchObject({
      status: "failed",
      value: 0,
      reasons: ["candidate_ancestry_invalid"],
    })
  })

  test("persists a blocked promotion decision without advancing the rollout", () => {
    const previousSha = "a".repeat(40)
    const currentSha = "b".repeat(40)
    advanceToDogfood()
    CompanyRollout.recordAction({
      kind: "register_candidate",
      idempotencyKey: "register-candidate-previous",
      candidate: {
        id: "candidate-previous",
        candidateSha: previousSha,
        targetRef: "refs/heads/main",
      },
    })
    CompanyRollout.recordAction({
      kind: "register_candidate",
      idempotencyKey: "register-candidate-current",
      candidate: {
        id: "candidate-current",
        candidateSha: currentSha,
        targetRef: "refs/heads/main",
      },
    })
    const decision = CompanyRollout.evaluatePrePublicPromotion(
      promotionRequest("promotion-blocked", previousSha, currentSha),
    )
    expect(decision.status).toBe("blocked")
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "candidate_repeats_missing:candidate-current",
        "candidate_repeats_missing:candidate-previous",
        "rollback_missing:kill_switch",
        "rollback_missing:legacy_fallback",
      ]),
    )
    expect(
      storeError(() =>
        CompanyRollout.transition({
          idempotencyKey: "phase-pre-public-blocked",
          to: "pre_public_default",
          reason: "blocked evidence cannot promote",
          promotionDecisionId: decision.id,
        }),
      ).code,
    ).toBe("promotion_gate_required")
    expect(CompanyRollout.status().state.phase).toBe("dogfood_default")
  })

  test("persists candidate, local repeat, and rollback facts without a pass decision", () => {
    const candidateRequest = {
      kind: "register_candidate" as const,
      idempotencyKey: "candidate-action",
      candidate: {
        id: "candidate-1",
        candidateSha: "a".repeat(40),
        targetRef: "refs/heads/main",
      },
    }
    const candidate = CompanyRollout.recordAction(candidateRequest)
    expect(candidate).toMatchObject({
      kind: "register_candidate",
      replayed: false,
      candidate: {
        id: "candidate-1",
        candidateSha: "a".repeat(40),
      },
    })
    expect(CompanyRollout.recordAction(candidateRequest)).toEqual({
      ...candidate,
      replayed: true,
    })
    expect(
      storeError(() =>
        CompanyRollout.recordAction({
          ...candidateRequest,
          candidate: { ...candidateRequest.candidate, targetRef: "refs/heads/dev" },
        }),
      ).code,
    ).toBe("idempotency_collision")
    expect(
      storeError(() =>
        CompanyRollout.recordAction({
          kind: "record_local_repeat",
          idempotencyKey: "candidate-action",
          repeat: {
            id: "repeat-collision",
            candidateId: "candidate-1",
            runId: "run-collision",
            ordinal: 1,
            outcome: "failed",
            environmentSha256: "b".repeat(64),
            evidenceSha256: "c".repeat(64),
            startedAt: 100,
            finishedAt: 200,
          },
        }),
      ).code,
    ).toBe("idempotency_collision")

    expect(
      storeError(() =>
        CompanyRollout.recordAction({
          kind: "record_local_repeat",
          idempotencyKey: "missing-candidate-repeat",
          repeat: {
            id: "repeat-missing",
            candidateId: "candidate-missing",
            runId: "run-missing",
            ordinal: 1,
            outcome: "failed",
            environmentSha256: "b".repeat(64),
            evidenceSha256: "c".repeat(64),
            startedAt: 100,
            finishedAt: 200,
          },
        }),
      ).code,
    ).toBe("missing_candidate")
    expect(() =>
      RolloutActionRequest.parse({
        kind: "record_local_repeat",
        idempotencyKey: "repeat-without-result",
        repeat: {
          id: "repeat-invalid",
          candidateId: "candidate-1",
          runId: "run-invalid",
          ordinal: 1,
          outcome: "completed",
          environmentSha256: "b".repeat(64),
          evidenceSha256: "c".repeat(64),
          startedAt: 100,
          finishedAt: 200,
        },
      }),
    ).toThrow()

    const repeat = CompanyRollout.recordAction({
      kind: "record_local_repeat",
      idempotencyKey: "repeat-1-action",
      repeat: {
        id: "repeat-1",
        candidateId: "candidate-1",
        runId: "run-1",
        ordinal: 1,
        outcome: "completed",
        environmentSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64),
        normalizedResultSha256: "d".repeat(64),
        startedAt: 100,
        finishedAt: 200,
      },
    })
    expect(repeat).toMatchObject({
      kind: "record_local_repeat",
      repeat: { ordinal: 1, outcome: "completed" },
    })

    const rollback = CompanyRollout.recordAction({
      kind: "record_rollback",
      idempotencyKey: "rollback-action",
      rollback: {
        id: "rollback-1",
        candidateId: "candidate-1",
        target: "kill_switch",
        phaseAtAction: "off",
        executionModeAfter: "off",
        outcome: "completed",
        evidenceSha256: "e".repeat(64),
        observedAt: 300,
      },
    })
    expect(rollback).toMatchObject({
      kind: "record_rollback",
      rollback: { target: "kill_switch", outcome: "completed" },
    })

    const evidence = CompanyRollout.evidence()
    expect(evidence.candidates).toHaveLength(1)
    expect(evidence.localRepeats).toHaveLength(1)
    expect(evidence.rollbacks).toHaveLength(1)
    expect(JSON.stringify(evidence)).not.toContain('"pass"')
    expect(CompanyRollout.listJournal().items).toHaveLength(3)

    Database.use((db) =>
      db
        .update(CompanyRolloutJournalTable)
        .set({ payload_json: "{}" })
        .where(eq(CompanyRolloutJournalTable.id, candidate.journal.id))
        .run(),
    )
    expect(storeError(() => CompanyRollout.recordAction(candidateRequest)).code).toBe("invalid_persisted_fact")
  })

  test("fails closed when the persisted singleton state is missing", () => {
    CompanyRollout.status()
    Database.use((db) =>
      db.delete(CompanyRolloutStateTable).where(eq(CompanyRolloutStateTable.id, "seed_and_grow")).run(),
    )
    expect(storeError(CompanyRollout.status).code).toBe("invalid_persisted_fact")
  })
})
