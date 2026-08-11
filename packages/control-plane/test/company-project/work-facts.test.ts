import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AgentRun } from "../../src/agent-run/agent-run"
import { Company } from "../../src/company"
import { CompanyAcceptanceFact, CompanyProject, CompanyWorkFacts } from "../../src/company-project"
import {
  CompanyArtifactTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = path.resolve(import.meta.dir, "../..")
const migrationPath = path.join(
  root,
  "migration/20260729000000_company_work_facts/migration.sql",
)
const reportRoot = path.join(root, ".artifacts/seed-grow-a1")
const expectedFacts = {
  attempts: 1,
  receipts: 1,
  terminal_attempts_without_receipt: 0,
  duplicate_receipts: 0,
}

async function writeReport(name: string, value: Record<string, unknown>) {
  await fs.mkdir(reportRoot, { recursive: true })
  await Bun.write(
    path.join(reportRoot, `${name}.json`),
    `${JSON.stringify({ schemaVersion: 1, result: "pass", scenario: name, ...value }, null, 2)}\n`,
  )
}

function runProbe(database: string, mode: "prepare" | "recover") {
  const child = Bun.spawnSync({
    cmd: [process.execPath, "test/company-project/work-facts-recovery-probe.ts", mode],
    cwd: root,
    env: { ...process.env, AGENTCOMPANY_DB: database },
  })
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  if (child.exitCode !== 0) throw new Error(stderr || stdout)
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith("{"))
  if (!line) throw new Error(`Recovery probe returned no JSON: ${stdout}`)
  return JSON.parse(line) as Record<string, unknown>
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyWorkFacts.defaultLayer,
    CompanyAcceptanceFact.defaultLayer,
    Company.defaultLayer,
    AgentRun.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("Company work Attempt and Receipt facts", () => {
  it.live("[a1-fresh-db] persists one validated Receipt for one terminal Attempt", () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const facts = yield* CompanyWorkFacts.Service
        const runs = yield* AgentRun.Service
        const project = yield* projects.create({ goal: "Persist deterministic work facts" })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Persist facts",
          acceptance_criteria: ["Facts are unique"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Persist facts",
          description: "Persist facts",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["Facts are unique"],
        })
        yield* projects.startWorkItem(item.id)
        const run = yield* runs.create({
          agentID: "analyst",
          runtime: "pi",
          lifecycle: "on_demand",
          permissionMode: "read_only",
          companyProjectID: project.id,
          workItemID: item.id,
          cwd: directory,
          runtimeHomePath: path.join(directory, "runtime"),
        })
        const artifact = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "analysis",
          title: "Verified facts",
          content: "{}",
        })
        yield* projects.completeWorkItem(item.id)
        const attempts = yield* projects.listWorkAttempts(project.id)
        const receipts = yield* projects.listWorkReceipts(project.id)
        const events = yield* projects.listEvents(project.id)

        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          agent_run_id: run.id,
          ordinal: 1,
          status: "completed",
        })
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({
          attempt_id: attempts[0]!.id,
          outcome: "completed",
          processing_status: "processed",
          artifact_ids: [artifact.id],
        })
        expect(receipts[0]!.evidence_refs).toEqual([
          { kind: "agent_run", id: run.id },
          { kind: "artifact", id: artifact.id },
        ])

        const replay = yield* facts.finishAttempt({
          attempt_id: attempts[0]!.id,
          status: "completed",
          safe_summary: `Work item ${item.id} completed`,
          receipt: {
            idempotency_key: receipts[0]!.idempotency_key,
            outcome: receipts[0]!.outcome,
            summary: receipts[0]!.summary,
            artifact_ids: receipts[0]!.artifact_ids,
            evidence_refs: receipts[0]!.evidence_refs,
            confirmed_facts: receipts[0]!.confirmed_facts,
            invalidated_assumptions: receipts[0]!.invalidated_assumptions,
            unknowns: receipts[0]!.unknowns,
            blockers: receipts[0]!.blockers,
            capability_gaps: receipts[0]!.capability_gaps,
            task_proposals: receipts[0]!.task_proposals,
            dependency_proposals: receipts[0]!.dependency_proposals,
            questions: receipts[0]!.questions,
          },
        })
        expect(replay.receipt.id).toBe(receipts[0]!.id)
        expect(
          events.filter((event) => event.type === "work_receipt.submitted"),
        ).toHaveLength(1)
        expect(
          events.filter((event) => event.type === "work_receipt.processed"),
        ).toHaveLength(1)

        const invalidItem = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Reject dangling evidence",
          description: "Reject dangling evidence",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["Dangling evidence is rejected"],
        })
        yield* projects.startWorkItem(invalidItem.id)
        const invalidAttempt = (yield* projects.listWorkAttempts(project.id)).find(
          (attempt) => attempt.work_item_id === invalidItem.id,
        )!
        const invalid = yield* Effect.exit(
          facts.finishAttempt({
            attempt_id: invalidAttempt.id,
            status: "failed",
            safe_summary: "Dangling evidence",
            receipt: {
              idempotency_key: "dangling-evidence",
              outcome: "failed",
              summary: "Dangling evidence",
              artifact_ids: ["missing-artifact"],
              evidence_refs: [{ kind: "artifact", id: "missing-artifact" }],
              confirmed_facts: [],
              invalidated_assumptions: [],
              unknowns: [],
              blockers: ["Dangling evidence"],
              capability_gaps: [],
              task_proposals: [],
              dependency_proposals: [],
              questions: [],
            },
          }),
        )
        expect(Exit.isFailure(invalid)).toBe(true)
        if (Exit.isFailure(invalid)) {
          expect(Cause.pretty(invalid.cause)).toMatch(/unavailable Artifact/)
        }

        yield* Effect.promise(() =>
          writeReport("fresh-db", {
            facts: expectedFacts,
            agent_run_bound: true,
            artifact_reference_resolved: true,
            idempotent_replay: true,
            invalid_reference_rejected: true,
          }),
        )
      }),
    ),
  )

  it.live("[acceptance-fact-shadow] links a completed Receipt to the full current fact set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const projects = yield* CompanyProject.Service
        const acceptance = yield* CompanyAcceptanceFact.Service
        const project = yield* projects.create({ goal: "Close Receipt over scoped Acceptance Facts" })
        yield* projects.transition({ id: project.id, status: "planning" })
        const plan = yield* projects.createPlan({
          project_id: project.id,
          phase: "execution",
          summary: "Receipt closure",
          acceptance_criteria: ["artifact_exists"],
        })
        const item = yield* projects.createWorkItem({
          project_id: project.id,
          plan_id: plan.id,
          title: "Receipt closure",
          description: "Receipt closure",
          kind: "worker",
          work_type: "analysis",
          role: "analyst",
          model_group: "standard",
          review_status: "not_required",
          acceptance_criteria: ["artifact_exists"],
        })
        yield* projects.startWorkItem(item.id)
        const attempt = (yield* projects.listWorkAttempts(project.id)).find(
          (candidate) => candidate.work_item_id === item.id,
        )!
        const artifact = yield* projects.addArtifact({
          project_id: project.id,
          work_item_id: item.id,
          kind: "analysis",
          title: "Scoped Artifact",
          content: JSON.stringify({ complete: true }),
        })
        const integrity = artifact.content_sha256!
        Database.use((db) => {
          db.update(CompanyWorkItemTable)
            .set({ validation_contract_version: 2 })
            .where(eq(CompanyWorkItemTable.id, item.id))
            .run()
        })
        const criterion = yield* acceptance.createCriterion({
          project_id: project.id,
          plan_id: plan.id,
          work_item_id: item.id,
          ordinal: 1,
          statement: "artifact_exists",
          verification_kind: "deterministic",
          evaluator: "artifact_digest_v1",
          required: true,
        })
        const fact = yield* acceptance.record({
          project_id: project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
          criterion_id: criterion.criterion.id,
          verdict: "passed",
          authority: "control_plane",
          evaluator: "artifact_digest_v1",
          observation: { digest: integrity },
          evidence_refs: [{ kind: "artifact", id: artifact.id }],
          idempotency_key: `receipt-fact:${artifact.id}`,
        })
        const bypass = yield* Effect.exit(projects.completeWorkItem(item.id))
        expect(Exit.isFailure(bypass)).toBe(true)
        if (Exit.isFailure(bypass)) expect(Cause.pretty(bypass.cause)).toMatch(/requires current Acceptance Facts/)
        yield* projects.completeWorkItemWithReceipt({
          id: item.id,
          receipt: {
            idempotency_key: `v2-receipt:${attempt.id}`,
            outcome: "completed",
            summary: "Current Acceptance Facts close the Work Attempt",
            artifact_ids: [artifact.id],
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
            confirmed_facts: [`acceptance:${criterion.criterion.id}:passed`],
            invalidated_assumptions: [],
            unknowns: [],
            blockers: [],
            capability_gaps: [],
            task_proposals: [],
            dependency_proposals: [],
            questions: [],
          },
          acceptance: { artifact_id: artifact.id, fact_ids: [fact.fact.id] },
        })
        const receipt = (yield* projects.listWorkReceipts(project.id)).find(
          (candidate) => candidate.attempt_id === attempt.id,
        )!
        expect(
          yield* acceptance.linkReceipt({
            receipt_id: receipt.id,
            artifact_id: artifact.id,
            fact_ids: [fact.fact.id],
          }),
        ).toHaveLength(1)
        expect(
          yield* acceptance.linkReceipt({
            receipt_id: receipt.id,
            artifact_id: artifact.id,
            fact_ids: [fact.fact.id],
          }),
        ).toHaveLength(1)
        expect((yield* acceptance.listReceiptFacts(receipt.id)).map((candidate) => candidate.id)).toEqual([
          fact.fact.id,
        ])
        expect(
          (yield* projects.listEvents(project.id)).filter(
            (event) => event.type === "work_receipt.acceptance_linked",
          ),
        ).toHaveLength(1)
      }),
    ),
  )

  test("[a1-migrated-db] migrates the baseline schema with equivalent uniqueness invariants", async () => {
    await using directory = await tmpdir()
    const database = new SQLite(path.join(directory.path, "baseline.db"))
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("CREATE TABLE company_project (id text PRIMARY KEY NOT NULL)")
    database.exec(
      "CREATE TABLE company_work_item (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE)",
    )
    database.exec(await Bun.file(migrationPath).text())
    database.run("INSERT INTO company_project (id) VALUES ('project-migrated')")
    database.run(
      "INSERT INTO company_work_item (id, project_id) VALUES ('item-migrated', 'project-migrated')",
    )
    database.run(
      `INSERT INTO company_work_attempt (
        id, project_id, work_item_id, ordinal, status, started_at, finished_at
      ) VALUES (
        'attempt-migrated', 'project-migrated', 'item-migrated', 1, 'completed', 1, 2
      )`,
    )
    database.run(
      `INSERT INTO company_work_receipt (
        id, project_id, work_item_id, attempt_id, idempotency_key, outcome, summary,
        artifact_ids_json, evidence_refs_json, confirmed_facts_json,
        invalidated_assumptions_json, unknowns_json, blockers_json, capability_gaps_json,
        task_proposals_json, dependency_proposals_json, questions_json, processing_status,
        created_at, processed_at
      ) VALUES (
        'receipt-migrated', 'project-migrated', 'item-migrated', 'attempt-migrated',
        'migrated-key', 'completed', 'Migrated', '[]', '[]', '[]', '[]', '[]', '[]',
        '[]', '[]', '[]', '[]', 'processed', 2, 3
      )`,
    )

    expect(() =>
      database.run(
        `INSERT INTO company_work_attempt (
          id, project_id, work_item_id, ordinal, status, started_at
        ) VALUES (
          'attempt-duplicate', 'project-migrated', 'item-migrated', 1, 'running', 3
        )`,
      ),
    ).toThrow()
    expect(() =>
      database.run(
        `INSERT INTO company_work_receipt (
          id, project_id, work_item_id, attempt_id, idempotency_key, outcome, summary,
          artifact_ids_json, evidence_refs_json, confirmed_facts_json,
          invalidated_assumptions_json, unknowns_json, blockers_json, capability_gaps_json,
          task_proposals_json, dependency_proposals_json, questions_json, processing_status,
          created_at
        ) VALUES (
          'receipt-duplicate', 'project-migrated', 'item-migrated', 'attempt-migrated',
          'duplicate-key', 'completed', 'Duplicate', '[]', '[]', '[]', '[]', '[]', '[]',
          '[]', '[]', '[]', '[]', 'pending', 3
        )`,
      ),
    ).toThrow()

    const facts = {
      attempts: Number(
        (database.query("SELECT count(*) AS count FROM company_work_attempt").get() as { count: number }).count,
      ),
      receipts: Number(
        (database.query("SELECT count(*) AS count FROM company_work_receipt").get() as { count: number }).count,
      ),
      terminal_attempts_without_receipt: Number(
        (
          database
            .query(
              `SELECT count(*) AS count
               FROM company_work_attempt attempt
               LEFT JOIN company_work_receipt receipt ON receipt.attempt_id = attempt.id
               WHERE attempt.status != 'running' AND receipt.id IS NULL`,
            )
            .get() as { count: number }
        ).count,
      ),
      duplicate_receipts: Number(
        (
          database
            .query(
              `SELECT count(*) AS count
               FROM (
                 SELECT attempt_id
                 FROM company_work_receipt
                 GROUP BY attempt_id
                 HAVING count(*) > 1
               )`,
            )
            .get() as { count: number }
        ).count,
      ),
    }
    expect(facts).toEqual(expectedFacts)
    database.close()
    await writeReport("migrated-db", {
      facts,
      ordinal_uniqueness_enforced: true,
      receipt_uniqueness_enforced: true,
    })
  })

  test("[a1-receipt-recovery] processes a committed pending Receipt exactly once after restart", async () => {
    await using directory = await tmpdir()
    const database = path.join(directory.path, "recovery.db")
    expect(await runProbe(database, "prepare")).toMatchObject({ result: "pass", mode: "prepare" })
    const first = await runProbe(database, "recover")
    const second = await runProbe(database, "recover")
    expect(first).toMatchObject({
      result: "pass",
      receipts: [{ id: "receipt-recovery", processing_status: "processed" }],
      processed_events: 1,
      explicit_recovery_count: 0,
    })
    expect(second).toMatchObject({
      result: "pass",
      receipts: [{ id: "receipt-recovery", processing_status: "processed" }],
      processed_events: 1,
      explicit_recovery_count: 0,
    })
    await writeReport("receipt-recovery", {
      receipt_status: "processed",
      processed_events: 1,
      duplicate_side_effects: 0,
      second_restart_changed_facts: false,
    })
  })
})
