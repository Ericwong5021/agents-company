import { afterEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import {
  CompanyAcceptanceFact,
  CompanyGraphMutation,
  CompanyProject,
  CompanyValidationGate,
  CompanyWorkFacts,
  NewGraphWorkItem,
  ValidationEvaluation,
} from "../../src/company-project"
import {
  CompanyArtifactTable,
  CompanyValidationGateTable,
  CompanyValidationRepairTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
} from "../../src/company-project/company-project.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = path.resolve(import.meta.dir, "../..")
const reportRoot = path.join(root, ".artifacts/seed-grow-a3")
const validationGateMigrationPath = path.join(
  root,
  "migration/20260729020000_company_validation_gate/migration.sql",
)
const acceptanceFactMigrationPath = path.join(
  root,
  "migration/20260811010000_acceptance_fact_shadow/migration.sql",
)

async function writeReport(name: string, value: Record<string, unknown>) {
  await fs.mkdir(reportRoot, { recursive: true })
  await Bun.write(
    path.join(reportRoot, `${name}.json`),
    `${JSON.stringify({ schemaVersion: 1, result: "pass", scenario: name, ...value }, null, 2)}\n`,
  )
}

function seed(projects: CompanyProject.Interface, label: string) {
  return Effect.gen(function* () {
    const project = yield* projects.create({ goal: `Validation ${label}` })
    yield* projects.transition({ id: project.id, status: "planning" })
    const plan = yield* projects.createPlan({
      project_id: project.id,
      phase: "execution",
      summary: `Validation ${label}`,
      acceptance_criteria: ["Reality anchor passes"],
    })
    return { project, plan }
  })
}

function createItem(
  projects: CompanyProject.Interface,
  project_id: string,
  plan_id: string,
  label: string,
  depends_on: string[] = [],
) {
  return projects.createWorkItem({
    project_id,
    plan_id,
    title: label,
    description: label,
    kind: "worker",
    work_type: "analysis",
    role: "analyst",
    capability_packs: [],
    decision_scope: ["project"],
    resource_scope: ["workspace"],
    inputs: [],
    expected_outputs: [label],
    validators: [label],
    disposition: "retain",
    model_group: "standard",
    risk_level: "medium",
    review_status: "not_required",
    purpose: "delivery",
    validation_mode: "machine",
    owner_agent_id: `agent-${label}`,
    acceptance_criteria: [label],
    max_attempts: 3,
    depends_on,
  })
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CompanyProject.defaultLayer,
    CompanyWorkFacts.defaultLayer,
    CompanyGraphMutation.makeLayer({ publish: async () => {} }),
    CompanyValidationGate.defaultLayer,
    CompanyAcceptanceFact.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

test("[a3-prerequisite-repair] creates the ValidationGate migration without weakening existing facts", async () => {
  await using directory = await tmpdir()
  const database = new SQLite(path.join(directory.path, "a2.db"))
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("CREATE TABLE company_project (id text PRIMARY KEY NOT NULL)")
  database.exec(
    "CREATE TABLE company_work_item (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE)",
  )
  database.exec(await Bun.file(validationGateMigrationPath).text())
  expect(
    database
      .query(
        `SELECT count(*) AS count
         FROM pragma_index_list('company_validation_repair')
         WHERE name = 'company_validation_repair_gate_idempotency_idx' AND "unique" = 1`,
      )
      .get(),
  ).toEqual({ count: 1 })
  database.close()
})

test("[acceptance-fact-shadow] adds lineage and fact tables without rewriting legacy rows", async () => {
  await using directory = await tmpdir()
  const database = new SQLite(path.join(directory.path, "acceptance-shadow.db"))
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("CREATE TABLE company_project (id text PRIMARY KEY NOT NULL)")
  database.exec(
    "CREATE TABLE company_plan (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE)",
  )
  database.exec(
    "CREATE TABLE company_work_item (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE, plan_id text NOT NULL REFERENCES company_plan(id) ON DELETE CASCADE, kind text NOT NULL DEFAULT 'worker', status text NOT NULL DEFAULT 'pending')",
  )
  database.exec(
    "CREATE TABLE company_work_attempt (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE, work_item_id text NOT NULL REFERENCES company_work_item(id) ON DELETE CASCADE)",
  )
  database.exec(
    "CREATE TABLE company_artifact (id text PRIMARY KEY NOT NULL, project_id text REFERENCES company_project(id) ON DELETE CASCADE, work_item_id text REFERENCES company_work_item(id) ON DELETE SET NULL, kind text NOT NULL)",
  )
  database.exec(
    "CREATE TABLE company_validation_gate (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE, work_item_id text REFERENCES company_work_item(id) ON DELETE SET NULL)",
  )
  database.exec(
    "CREATE TABLE company_work_receipt (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES company_project(id) ON DELETE CASCADE, work_item_id text NOT NULL REFERENCES company_work_item(id) ON DELETE CASCADE, attempt_id text NOT NULL REFERENCES company_work_attempt(id) ON DELETE CASCADE)",
  )
  database.exec("INSERT INTO company_project (id) VALUES ('project-legacy')")
  database.exec("INSERT INTO company_plan (id, project_id) VALUES ('plan-legacy', 'project-legacy')")
  database.exec(
    "INSERT INTO company_work_item (id, project_id, plan_id) VALUES ('item-legacy', 'project-legacy', 'plan-legacy')",
  )
  database.exec(await Bun.file(acceptanceFactMigrationPath).text())
  expect(
    database
      .query(
        "SELECT dispatch_generation FROM company_project WHERE id = 'project-legacy'",
      )
      .get(),
  ).toEqual({ dispatch_generation: 0 })
  expect(
    database
      .query(
        "SELECT validation_contract_version, dispatch_claim_id, reviews_work_item_id FROM company_work_item WHERE id = 'item-legacy'",
      )
      .get(),
  ).toEqual({ validation_contract_version: 1, dispatch_claim_id: null, reviews_work_item_id: null })
  expect(
    database
      .query(
        `SELECT count(*) AS count
         FROM pragma_table_info('company_acceptance_fact')
         WHERE name IN ('attempt_id', 'artifact_id', 'criterion_id', 'artifact_integrity_sha256')`,
      )
      .get(),
  ).toEqual({ count: 4 })
  database.close()
})

it.live("[acceptance-fact-shadow] rejects worker claims and stale Artifact lineage", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const acceptance = yield* CompanyAcceptanceFact.Service
      const seeded = yield* seed(projects, "acceptance-shadow")
      const item = yield* createItem(projects, seeded.project.id, seeded.plan.id, "scoped-result")
      yield* projects.startWorkItem(item.id)
      const attempt = (yield* projects.listWorkAttempts(seeded.project.id)).find(
        (candidate) => candidate.work_item_id === item.id,
      )!
      const artifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "analysis",
        title: "Scoped result",
        path: "artifacts/scoped-result.json",
        content: JSON.stringify({ result: true }),
      })
      const integrity = artifact.content_sha256!
      Database.use((db) => {
        db.update(CompanyWorkItemTable)
          .set({ validation_contract_version: 2 })
          .where(eq(CompanyWorkItemTable.id, item.id))
          .run()
      })
      expect(
        (yield* acceptance.createCriterion({
          project_id: seeded.project.id,
          plan_id: seeded.plan.id,
          work_item_id: item.id,
          ordinal: 1,
          statement: "artifact_exists",
          verification_kind: "deterministic",
          evaluator: "policy_invariant_v1",
          required: true,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      const criterion = yield* acceptance.createCriterion({
        project_id: seeded.project.id,
        plan_id: seeded.plan.id,
        work_item_id: item.id,
        ordinal: 1,
        statement: "artifact_exists",
        verification_kind: "deterministic",
        evaluator: "artifact_digest_v1",
        required: true,
      })
      const workerClaim = yield* acceptance.record({
        project_id: seeded.project.id,
        work_item_id: item.id,
        attempt_id: attempt.id,
        artifact_id: artifact.id,
        criterion_id: criterion.criterion.id,
        verdict: "passed",
        authority: "worker_claim",
        evaluator: "worker_claim_v1",
        observation: { digest: integrity },
        evidence_refs: [{ kind: "artifact", id: artifact.id }],
        idempotency_key: `worker:${artifact.id}`,
      }).pipe(Effect.exit)
      expect(workerClaim._tag).toBe("Failure")
      expect(
        (yield* acceptance.currentCoverage({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
        })).state,
      ).toBe("pending")
      expect(
        (yield* acceptance.record({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
          criterion_id: criterion.criterion.id,
          verdict: "passed",
          authority: "control_plane",
          evaluator: "policy_invariant_v1",
          observation: { digest: integrity },
          evidence_refs: [{ kind: "artifact", id: artifact.id }],
          idempotency_key: `wrong-evaluator:${artifact.id}`,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      const humanCriterion = yield* acceptance.createCriterion({
        project_id: seeded.project.id,
        plan_id: seeded.plan.id,
        work_item_id: item.id,
        ordinal: 2,
        statement: "用户明确接受当前成果",
        verification_kind: "human",
        evaluator: "human_acceptance_v1",
        required: false,
      })
      expect(
        (yield* acceptance.record({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
          criterion_id: humanCriterion.criterion.id,
          verdict: "passed",
          authority: "human",
          evaluator: "human_acceptance_v1",
          observation: { accepted: true },
          evidence_refs: [
            { kind: "artifact", id: artifact.id },
            { kind: "project_event", id: (yield* projects.listEvents(seeded.project.id))[0]!.id },
          ],
          idempotency_key: `human:${artifact.id}`,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      const semanticCriterion = yield* acceptance.createCriterion({
        project_id: seeded.project.id,
        plan_id: seeded.plan.id,
        work_item_id: item.id,
        ordinal: 3,
        statement: "语义质量满足目标",
        verification_kind: "semantic_review",
        required: false,
      })
      expect(
        (yield* acceptance.record({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
          criterion_id: semanticCriterion.criterion.id,
          verdict: "passed",
          authority: "independent_reviewer",
          evaluator: "independent_review_v2",
          observation: { accepted: true },
          evidence_refs: [{ kind: "artifact", id: artifact.id }],
          idempotency_key: `fabricated-review:${artifact.id}`,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      const recorded = yield* acceptance.record({
        project_id: seeded.project.id,
        work_item_id: item.id,
        attempt_id: attempt.id,
        artifact_id: artifact.id,
        criterion_id: criterion.criterion.id,
        verdict: "passed",
        authority: "control_plane",
        evaluator: "artifact_digest_v1",
        observation: { digest: integrity },
        evidence_refs: [{ kind: "artifact", id: artifact.id }],
        idempotency_key: `host:${artifact.id}`,
      })
      expect(recorded.replayed).toBe(false)
      expect((yield* acceptance.record({
        project_id: seeded.project.id,
        work_item_id: item.id,
        attempt_id: attempt.id,
        artifact_id: artifact.id,
        criterion_id: criterion.criterion.id,
        verdict: "passed",
        authority: "control_plane",
        evaluator: "artifact_digest_v1",
        observation: { digest: integrity },
        evidence_refs: [{ kind: "artifact", id: artifact.id }],
        idempotency_key: `host:${artifact.id}`,
      })).replayed).toBe(true)
      expect(
        (yield* acceptance.assertCompletable({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
        })).state,
      ).toBe("verified")
      yield* Effect.promise(() => Bun.write(artifact.path!, JSON.stringify({ result: false })))
      expect(
        (yield* acceptance.currentCoverage({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
        })).state,
      ).toBe("stale")
      expect(
        (yield* acceptance.assertCompletable({
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  ),
)

it.live("[validation-gate-lineage] binds Gate replay to one Attempt and Artifact", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const gates = yield* CompanyValidationGate.Service
      const seeded = yield* seed(projects, "gate-lineage")
      const item = yield* createItem(projects, seeded.project.id, seeded.plan.id, "lineage-target")
      yield* projects.startWorkItem(item.id)
      const firstAttempt = (yield* projects.listWorkAttempts(seeded.project.id)).find(
        (candidate) => candidate.work_item_id === item.id,
      )!
      const firstArtifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "analysis",
        title: "First scoped result",
        content: JSON.stringify({ version: 1 }),
      })
      const firstDigest = new Bun.CryptoHasher("sha256").update(firstArtifact.content!).digest("hex")
      const first = yield* gates.create({
        id: "gate-attempt-artifact-lineage",
        project_id: seeded.project.id,
        work_item_id: item.id,
        attempt_id: firstAttempt.id,
        artifact_id: firstArtifact.id,
        kind: "artifact",
        criteria: [
          {
            id: "artifact-bytes-match",
            statement: "Artifact bytes match the current Attempt",
            anchor: { kind: "artifact", reference: `artifact:${firstArtifact.id}` },
            operator: "digest",
            expected: firstDigest,
          },
        ],
        blocking_work_item_ids: [item.id],
        evaluator: "artifact_digest_v1",
        max_repair_rounds: 3,
      })
      expect(first).toMatchObject({
        attempt_id: firstAttempt.id,
        artifact_id: firstArtifact.id,
        status: "passed",
      })
      expect(
        Database.use((db) =>
          db
            .select({
              attempt_id: CompanyValidationGateTable.attempt_id,
              artifact_id: CompanyValidationGateTable.artifact_id,
            })
            .from(CompanyValidationGateTable)
            .where(eq(CompanyValidationGateTable.id, first.id))
            .get(),
        ),
      ).toEqual({ attempt_id: firstAttempt.id, artifact_id: firstArtifact.id })
      expect(
        (yield* gates.create({
          id: first.id,
          project_id: seeded.project.id,
          work_item_id: item.id,
          attempt_id: firstAttempt.id,
          artifact_id: firstArtifact.id,
          kind: "artifact",
          criteria: first.criteria,
          blocking_work_item_ids: [item.id],
          evaluator: "artifact_digest_v1",
          max_repair_rounds: 3,
        })).id,
      ).toBe(first.id)
      yield* projects.blockWorkItem({ id: item.id, error: "Retry with a new Artifact" })
      yield* projects.retryWorkItem(item.id)
      yield* projects.startWorkItem(item.id)
      const secondAttempt = (yield* projects.listWorkAttempts(seeded.project.id)).find(
        (candidate) => candidate.work_item_id === item.id && candidate.ordinal === 2,
      )!
      const secondArtifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "analysis",
        title: "Second scoped result",
        content: JSON.stringify({ version: 2 }),
      })
      expect(
        (yield* gates
          .create({
            id: first.id,
            project_id: seeded.project.id,
            work_item_id: item.id,
            attempt_id: secondAttempt.id,
            artifact_id: secondArtifact.id,
            kind: "artifact",
            criteria: first.criteria,
            blocking_work_item_ids: [item.id],
            evaluator: "artifact_digest_v1",
            max_repair_rounds: 3,
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* gates
          .create({
            id: "gate-mismatched-attempt-artifact",
            project_id: seeded.project.id,
            work_item_id: item.id,
            attempt_id: secondAttempt.id,
            artifact_id: firstArtifact.id,
            kind: "artifact",
            criteria: first.criteria,
            blocking_work_item_ids: [item.id],
            evaluator: "artifact_digest_v1",
            max_repair_rounds: 3,
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  ),
)

it.live("[a3-prerequisite-repair] blocks S16 dispatch and rewires recovery from unchanged evidence", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const graph = yield* CompanyGraphMutation.Service
      const gates = yield* CompanyValidationGate.Service
      const seeded = yield* seed(projects, "s16")
      const source = yield* createItem(projects, seeded.project.id, seeded.plan.id, "false-prerequisite")
      const downstream = yield* createItem(
        projects,
        seeded.project.id,
        seeded.plan.id,
        "dependent-work",
        [source.id],
      )
      yield* projects.startWorkItem(source.id)
      const sourceArtifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: source.id,
        kind: "prerequisite_probe",
        title: "False prerequisite evidence",
        content: JSON.stringify({ exists: false }),
      })
      yield* projects.blockWorkItem({
        id: source.id,
        error: "Required local capability is absent",
      })
      const receipt = (yield* projects.listWorkReceipts(seeded.project.id)).find(
        (candidate) => candidate.work_item_id === source.id,
      )!
      const gate = yield* gates.create({
        id: "gate-s16-prerequisite",
        project_id: seeded.project.id,
        work_item_id: source.id,
        kind: "prerequisite",
        criteria: [
          {
            id: "runtime-capability-exists",
            statement: "Required local capability exists",
            anchor: { kind: "prerequisite", reference: "local-capability:required" },
            operator: "exists",
            expected: true,
          },
        ],
        blocking_work_item_ids: [downstream.id],
        evaluator: "fact_match_v1",
        max_repair_rounds: 3,
      })
      const failed = yield* gates.evaluate({
        gate_id: gate.id,
        evaluator: "fact_match_v1",
        evidence: [
          {
            criterion_id: "runtime-capability-exists",
            anchor: "prerequisite",
            reference: "local-capability:required",
            observed: false,
            evidence_ref: { kind: "artifact", id: sourceArtifact.id },
          },
        ],
      })
      expect(failed.status).toBe("failed")
      expect((yield* projects.readyWorkItems(seeded.project.id)).map((item) => item.id)).not.toContain(
        downstream.id,
      )

      const recovery = NewGraphWorkItem.parse({
        id: "s16-recovery",
        plan_id: seeded.plan.id,
        parent_id: source.id,
        title: "Restore required local capability",
        description: "Restore and verify the unchanged prerequisite",
        kind: "worker",
        work_type: "analysis",
        role: "environment repair",
        capability_packs: [],
        decision_scope: ["project"],
        resource_scope: ["workspace"],
        inputs: ["False prerequisite Receipt"],
        expected_outputs: ["Reality anchor passes"],
        validators: ["Required local capability exists"],
        disposition: "retain",
        model_group: "standard",
        risk_level: "medium",
        review_status: "not_required",
        owner_agent_id: "agent-recovery",
        acceptance_criteria: ["Required local capability exists"],
        max_attempts: 3,
        purpose: "recovery",
        validation_mode: "machine",
      })
      const proposal = yield* gates.planPrerequisiteRepair({
        gate_id: gate.id,
        trigger_receipt_id: receipt.id,
        recovery_item: recovery,
        idempotency_key: "s16-prerequisite-repair",
        orchestrator_version: 1,
      })
      const mutation = yield* graph.apply(proposal)
      expect(mutation.status).toBe("applied")
      expect((yield* projects.readyWorkItems(seeded.project.id)).map((item) => item.id)).toContain(
        recovery.id,
      )
      yield* projects.startWorkItem(recovery.id)
      const recoveryArtifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: recovery.id,
        kind: "prerequisite_probe",
        title: "Recovered prerequisite evidence",
        content: JSON.stringify({ exists: true }),
      })
      yield* projects.completeWorkItem(recovery.id)
      const repaired = yield* gates.repair({
        gate_id: gate.id,
        idempotency_key: "s16-reverify-1",
        diagnosis: {
          kind: "missing_prerequisite",
          finding: "The required local capability was absent",
          affected_work_item_ids: [downstream.id],
          suggested_fix: "Restore the local capability and reverify the same anchor",
          evidence_refs: [{ kind: "artifact", id: sourceArtifact.id }],
        },
        fix_summary: "Restored the required local capability",
        repair_diff: [`dependency:${downstream.id}:${source.id}->${recovery.id}`],
        evaluator: "fact_match_v1",
        evidence: [
          {
            criterion_id: "runtime-capability-exists",
            anchor: "prerequisite",
            reference: "local-capability:required",
            observed: true,
            evidence_ref: { kind: "artifact", id: recoveryArtifact.id },
          },
        ],
      })
      expect(repaired.status).toBe("passed")
      expect(repaired.gate.criteria_sha256).toBe(gate.criteria_sha256)
      expect((yield* projects.readyWorkItems(seeded.project.id)).map((item) => item.id)).toContain(
        downstream.id,
      )
      const dependencies = Database.use((db) =>
        db
          .select()
          .from(CompanyWorkItemDependencyTable)
          .where(eq(CompanyWorkItemDependencyTable.work_item_id, downstream.id))
          .all(),
      )
      expect(dependencies).toEqual([
        { work_item_id: downstream.id, depends_on_id: recovery.id },
      ])
      yield* Effect.promise(() =>
        writeReport("prerequisite-repair", {
          benchmark: "S16",
          gate_id: gate.id,
          criteria_sha256: gate.criteria_sha256,
          failed_status: failed.status,
          mutation_status: mutation.status,
          dependency_diff: dependencies,
          recovery_status: repaired.status,
          ready_work_item_ids: [downstream.id],
          source_receipt_id: receipt.id,
        }),
      )
    }),
  ),
)

it.live("[a3-repair-circuit] stops S22 after three diagnosed repair rounds and emits one Attention", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const gates = yield* CompanyValidationGate.Service
      const seeded = yield* seed(projects, "s22")
      const item = yield* createItem(projects, seeded.project.id, seeded.plan.id, "persistent-failure")
      const artifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "policy_probe",
        title: "Persistent failure evidence",
        content: JSON.stringify({ invariant: false }),
      })
      const gate = yield* gates.create({
        id: "gate-s22-circuit",
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "policy",
        criteria: [
          {
            id: "invariant-holds",
            statement: "The deterministic invariant holds",
            anchor: { kind: "policy", reference: "policy:persistent-invariant" },
            operator: "equals",
            expected: true,
          },
        ],
        blocking_work_item_ids: [item.id],
        evaluator: "policy_invariant_v1",
        max_repair_rounds: 3,
      })
      yield* gates.evaluate({
        gate_id: gate.id,
        evaluator: "policy_invariant_v1",
        evidence: [
          {
            criterion_id: "invariant-holds",
            anchor: "policy",
            reference: "policy:persistent-invariant",
            observed: false,
            evidence_ref: { kind: "artifact", id: artifact.id },
          },
        ],
      })
      const runRound = (round: number) =>
        gates.repair({
          gate_id: gate.id,
          idempotency_key: `s22-repair-${round}`,
          diagnosis: {
            kind: "implementation",
            finding: `Invariant still fails after round ${round}`,
            affected_work_item_ids: [item.id],
            suggested_fix: `Apply deterministic fix ${round}`,
            evidence_refs: [{ kind: "artifact", id: artifact.id }],
          },
          fix_summary: `Applied deterministic fix ${round}`,
          repair_diff: [`fix-${round}`],
          evaluator: "policy_invariant_v1",
          evidence: [
            {
              criterion_id: "invariant-holds",
              anchor: "policy",
              reference: "policy:persistent-invariant",
              observed: false,
              evidence_ref: { kind: "artifact", id: artifact.id },
            },
          ],
        })
      const rounds = [
        yield* runRound(1),
        yield* runRound(2),
        yield* runRound(3),
      ]
      expect(rounds.map((round) => round.status)).toEqual([
        "retry_allowed",
        "retry_allowed",
        "circuit_open",
      ])
      const fourth = yield* runRound(4)
      expect(fourth).toMatchObject({ status: "circuit_open", round: 3, replayed: true })
      const traces = Database.use((db) =>
        db
          .select()
          .from(CompanyValidationRepairTable)
          .where(eq(CompanyValidationRepairTable.gate_id, gate.id))
          .orderBy(CompanyValidationRepairTable.round)
          .all(),
      )
      const events = yield* projects.listEvents(seeded.project.id)
      expect(traces).toHaveLength(3)
      expect(events.filter((event) => event.type === "failure_diagnosis.recorded")).toHaveLength(3)
      expect(events.filter((event) => event.type === "graph_repair.completed")).toHaveLength(3)
      expect(events.filter((event) => event.type === "attention.requested")).toHaveLength(1)
      expect((yield* projects.readyWorkItems(seeded.project.id)).map((candidate) => candidate.id)).not.toContain(
        item.id,
      )
      yield* Effect.promise(() =>
        writeReport("repair-circuit", {
          benchmark: "S22",
          gate_id: gate.id,
          criteria_sha256: gate.criteria_sha256,
          repair_rounds: traces.map((trace) => ({
            round: trace.round,
            failure_kind: trace.failure_kind,
            result: trace.result,
            repair_diff: JSON.parse(trace.repair_diff_json),
          })),
          fourth_attempt_scheduled: false,
          attention_count: 1,
        }),
      )
    }),
  ),
)

it.live("[a3-validation-policy] rejects warnings and weaker criteria while making Reviewer risk-driven", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const projects = yield* CompanyProject.Service
      const gates = yield* CompanyValidationGate.Service
      const seeded = yield* seed(projects, "policy")
      const item = yield* createItem(projects, seeded.project.id, seeded.plan.id, "policy-target")
      const artifact = yield* projects.addArtifact({
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "command_report",
        title: "Command report",
        content: JSON.stringify({ exit_code: 0, warning: true }),
      })
      const criterion = {
        id: "command-succeeds",
        statement: "The registered command exits successfully without warnings",
        anchor: { kind: "unit_test" as const, reference: "command:test:policy" },
        operator: "exit_code" as const,
        expected: 0,
      }
      const gate = yield* gates.create({
        id: "gate-a3-policy",
        project_id: seeded.project.id,
        work_item_id: item.id,
        kind: "unit_test",
        criteria: [criterion],
        blocking_work_item_ids: [item.id],
        evaluator: "command_exit_v1",
        max_repair_rounds: 3,
      })
      const warningOnly = yield* gates.evaluate({
        gate_id: gate.id,
        evaluator: "command_exit_v1",
        evidence: [
          {
            criterion_id: criterion.id,
            anchor: criterion.anchor.kind,
            reference: criterion.anchor.reference,
            observed: 0,
            warning: "The command emitted a release-blocking warning",
            evidence_ref: { kind: "artifact", id: artifact.id },
          },
        ],
      })
      expect(warningOnly.status).toBe("failed")
      const weakened = yield* gates
        .create({
          id: "gate-a3-policy-weakened",
          project_id: seeded.project.id,
          work_item_id: item.id,
          kind: "unit_test",
          criteria: [{ ...criterion, expected: 1 }],
          blocking_work_item_ids: [item.id],
          evaluator: "command_exit_v1",
          max_repair_rounds: 3,
          supersedes_gate_id: gate.id,
        })
        .pipe(Effect.exit)
      expect(weakened._tag).toBe("Failure")
      const low = CompanyValidationGate.validationPolicy({
        risk_level: "low",
        external_side_effect: false,
        deterministic_anchors: true,
      })
      const high = CompanyValidationGate.validationPolicy({
        risk_level: "high",
        external_side_effect: false,
        deterministic_anchors: true,
      })
      const external = CompanyValidationGate.validationPolicy({
        risk_level: "medium",
        external_side_effect: true,
        deterministic_anchors: true,
      })
      expect(low).toEqual({
        validation_mode: "machine",
        reviewer_required: false,
        user_gate_required: false,
      })
      expect(high).toEqual({
        validation_mode: "independent_review",
        reviewer_required: true,
        user_gate_required: false,
      })
      expect(external).toEqual({
        validation_mode: "review_and_user_gate",
        reviewer_required: true,
        user_gate_required: true,
      })
      expect(
        ValidationEvaluation.safeParse({
          gate_id: gate.id,
          evaluator: "command_exit_v1",
          evidence: [],
          passed: true,
        }).success,
      ).toBe(false)
      const persisted = Database.use((db) =>
        db
          .select()
          .from(CompanyValidationGateTable)
          .where(eq(CompanyValidationGateTable.id, gate.id))
          .get()!,
      )
      yield* Effect.promise(() =>
        writeReport("validation-policy", {
          gate_id: gate.id,
          warning_only_status: warningOnly.status,
          criteria_sha256: persisted.criteria_sha256,
          weakened_replacement_rejected: weakened._tag === "Failure",
          caller_passed_field_rejected: true,
          policy: { low, high, external },
        }),
      )
    }),
  ),
)
