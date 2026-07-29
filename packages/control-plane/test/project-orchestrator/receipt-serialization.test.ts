import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Company } from "../../src/company"
import { CompanyProject, CompanyWorkFacts } from "../../src/company-project"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyWorkFacts.defaultLayer,
    Company.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

afterEach(resetDatabase)

describe("Seed receipt serialization", () => {
  it.live("claims one receipt per project and keeps legacy processing separate", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const facts = yield* CompanyWorkFacts.Service
        const project = yield* projects.create({
          goal: "Serialize seed receipts",
          execution_strategy: "seed_and_grow",
          seed_mode: "seed_pair",
        })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Serialize receipts",
          acceptance_criteria: ["Every receipt is processed exactly once"],
        })
        const items = yield* Effect.forEach(["first", "second"], (title) =>
          projects.createWorkItem({
            project_id: project.id,
            plan_id: plan.id,
            title,
            description: title,
            kind: "worker",
            work_type: "analysis",
            role: "analyst",
            model_group: "standard",
            review_status: "not_required",
            acceptance_criteria: [title],
          }),
        )
        yield* Effect.forEach(
          items,
          (item) =>
            Effect.gen(function* () {
              yield* projects.startWorkItem(item.id)
              yield* projects.addArtifact({
                project_id: project.id,
                work_item_id: item.id,
                kind: "analysis",
                title: item.title,
                content: "{}",
              })
              yield* projects.completeWorkItem(item.id)
            }),
          { concurrency: 1 },
        )
        const receipts = yield* facts.listReceipts(project.id)
        expect(receipts.map((receipt) => receipt.processing_status)).toEqual(["pending", "pending"])
        expect(Exit.isFailure(yield* facts.processReceipt(receipts[0]!.id).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* facts.claimReceipt(receipts[1]!.id).pipe(Effect.exit))).toBe(true)
        const first = yield* facts.claimReceipt(receipts[0]!.id)
        expect(first.receipt.processing_status).toBe("processing")
        expect(Exit.isFailure(yield* facts.claimReceipt(receipts[1]!.id).pipe(Effect.exit))).toBe(true)
        yield* facts.finalizeReceipt({
          id: receipts[0]!.id,
          claim_id: first.claim_id,
          decision_id: "decision-first",
        })
        const second = yield* facts.claimNextPending(project.id)
        expect(second?.receipt.id).toBe(receipts[1]!.id)
        expect(second?.receipt.processing_status).toBe("processing")
      }),
    ),
  )
})
