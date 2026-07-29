import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { RolloutActionRequest } from "@agents-company/shared/rollout"
import * as CompanyRollout from "../../src/company-rollout/company-rollout"
import { CompanyRolloutJournalTable, CompanyRolloutStateTable } from "../../src/company-rollout/company-rollout.sql"
import { CompanyProjectTable } from "../../src/company-project/company-project.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

let previousExecutionMode: string | undefined

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
    expect(
      CompanyRollout.transition({
        idempotencyKey: "phase-pre-public",
        to: "pre_public_default",
        reason: "enable pre-public default",
      }).state.phase,
    ).toBe("pre_public_default")
    expect(
      storeError(() =>
        CompanyRollout.transition({
          idempotencyKey: "phase-after-final",
          to: "pre_public_default",
          reason: "cannot advance past final phase",
        }),
      ).code,
    ).toBe("invalid_transition")
    expect(CompanyRollout.listJournal().items).toHaveLength(4)
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
