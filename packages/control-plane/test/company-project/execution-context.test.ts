import { describe, expect, test } from "bun:test"
import {
  assertTaskPromptBudget,
  contextOverflowDiagnostic,
  defaultTaskContextBudget,
  TaskEvidenceBudgetExceeded,
  TaskPromptBudgetExceeded,
  taskEvidenceSnapshot,
  type TaskContextBudget,
} from "../../src/company-project/execution-context"
import {
  AcceptanceFact,
  ApprovalGate,
  Artifact,
  Project,
  WorkAttempt,
  WorkItem,
  WorkReceipt,
  type WorkItem as WorkItemValue,
} from "../../src/company-project/schema"

const project = Project.parse({
  id: "project-1",
  goal: "Produce a verified delivery",
  title: "Project",
  status: "executing",
  output_dir: "/tmp/project-1",
  active_plan_version: 1,
  execution_strategy: "legacy_full_plan",
  orchestration_state: "idle",
  orchestrator_version: 1,
  dispatch_paused: false,
  dispatch_generation: 0,
  graph_revision: 3,
  created_at: 1,
  updated_at: 1,
})

function item(id: string, depends_on: string[] = [], input: Partial<WorkItemValue> = {}) {
  return WorkItem.parse({
    id,
    project_id: project.id,
    plan_id: "plan-1",
    title: `Task ${id}`,
    description: `Complete ${id}`,
    kind: "worker",
    work_type: "analysis",
    role: "analyst",
    capability_packs: [],
    decision_scope: [],
    resource_scope: [],
    inputs: [],
    expected_outputs: ["result"],
    validators: ["artifact_exists"],
    disposition: "retain",
    depends_on,
    model_group: "standard",
    risk_level: "low",
    review_status: "not_required",
    status: "pending",
    purpose: "delivery",
    origin_kind: "legacy",
    graph_revision_created: 0,
    validation_mode: "self_check",
    validation_contract_version: 1,
    acceptance_criteria: ["artifact_exists"],
    attempt: 0,
    max_attempts: 3,
    created_at: 1,
    updated_at: 1,
    ...input,
  })
}

const budget: TaskContextBudget = {
  usable_input_tokens: 20_000,
  prompt_token_cap: 12_000,
  evidence_token_cap: 9_000,
  source: "model",
}

describe("task execution context", () => {
  test("keeps task-scoped accepted facts, current gates, and the latest failure", () => {
    const dependency = item("dependency", [], { status: "completed", review_status: "accepted" })
    const transitive = item("transitive", [], { status: "completed", review_status: "accepted" })
    const current = item("current", [dependency.id])
    const withTransitiveDependency = item(dependency.id, [transitive.id], {
      status: "completed",
      review_status: "accepted",
    })
    const artifact = Artifact.parse({
      id: "artifact-1",
      project_id: project.id,
      work_item_id: dependency.id,
      attempt_id: "attempt-latest",
      integrity_sha256: "a".repeat(64),
      kind: "delivery",
      title: "Accepted output",
      content: `private-body-${"x".repeat(20_000)}`,
      evidence: { accepted: true },
      created_at: 3,
    })
    const olderReceipt = WorkReceipt.parse({
      id: "receipt-old",
      project_id: project.id,
      work_item_id: dependency.id,
      attempt_id: "attempt-old",
      idempotency_key: "old",
      outcome: "completed",
      summary: "old fact",
      artifact_ids: [],
      evidence_refs: [{ kind: "project_event", id: "event-old" }],
      confirmed_facts: ["old fact"],
      invalidated_assumptions: [],
      unknowns: [],
      blockers: [],
      capability_gaps: [],
      task_proposals: [],
      dependency_proposals: [],
      questions: [],
      processing_status: "processed",
      created_at: 2,
      processed_at: 2,
    })
    const latestReceipt = WorkReceipt.parse({
      ...olderReceipt,
      id: "receipt-latest",
      attempt_id: "attempt-latest",
      idempotency_key: "latest",
      summary: "latest accepted fact",
      artifact_ids: [artifact.id],
      evidence_refs: [{ kind: "artifact", id: artifact.id }],
      confirmed_facts: ["receipt-claim-must-not-be-truth"],
      created_at: 4,
      processed_at: 4,
    })
    const supersededFact = AcceptanceFact.parse({
      id: "acceptance-old",
      project_id: project.id,
      work_item_id: dependency.id,
      attempt_id: latestReceipt.attempt_id,
      artifact_id: artifact.id,
      artifact_integrity_sha256: "a".repeat(64),
      criterion_id: "criterion-1",
      verdict: "passed",
      authority: "control_plane",
      evaluator: "artifact_exists",
      observation: { result: "old" },
      evidence_refs: [{ kind: "artifact", id: artifact.id }],
      evidence_sha256: "b".repeat(64),
      input_sha256: "c".repeat(64),
      idempotency_key: "acceptance-old",
      created_at: 3,
    })
    const currentFact = AcceptanceFact.parse({
      ...supersededFact,
      id: "acceptance-current",
      observation: { result: "verified" },
      evidence_sha256: "d".repeat(64),
      input_sha256: "e".repeat(64),
      idempotency_key: "acceptance-current",
      supersedes_fact_id: supersededFact.id,
      created_at: 5,
    })
    const failedFact = AcceptanceFact.parse({
      ...supersededFact,
      id: "acceptance-failed",
      criterion_id: "criterion-2",
      verdict: "failed",
      observation: { result: "failed" },
      evidence_sha256: "f".repeat(64),
      input_sha256: "0".repeat(64),
      idempotency_key: "acceptance-failed",
      created_at: 6,
    })
    const gate = ApprovalGate.parse({
      id: "gate-current",
      project_id: project.id,
      scope_type: "project",
      kind: "risk_approval",
      status: "pending",
      title: "Current approval",
      summary: "Awaiting an explicit decision",
      resource_scope: [],
      requested_at: 5,
    })
    const resolvedGate = ApprovalGate.parse({ ...gate, id: "gate-old", status: "approved", decided_at: 6 })
    const oldFailure = WorkAttempt.parse({
      id: "failure-old",
      project_id: project.id,
      work_item_id: current.id,
      repair_criterion_ids: [],
      ordinal: 1,
      status: "failed",
      failure_kind: "environment",
      safe_summary: "old failure",
      started_at: 5,
      finished_at: 6,
    })
    const latestFailure = WorkAttempt.parse({
      ...oldFailure,
      id: "failure-latest",
      ordinal: 2,
      safe_summary: "latest failure",
      started_at: 7,
      finished_at: 8,
    })
    const result = taskEvidenceSnapshot({
      project,
      item: current,
      work_items: [current, withTransitiveDependency, transitive],
      artifacts: [artifact],
      gates: [resolvedGate, gate],
      attempts: [oldFailure, latestFailure],
      receipts: [olderReceipt, latestReceipt],
      acceptance_facts: [supersededFact, currentFact, failedFact],
      budget,
    })

    expect(result.evidence.task.id).toBe(current.id)
    expect(result.evidence.dependencies.map((entry) => entry.work_item.id)).toEqual([dependency.id, transitive.id])
    expect(result.evidence.dependencies[0]?.latest_receipt?.id).toBe(latestReceipt.id)
    expect(result.evidence.dependencies[0]?.current_acceptance_facts.map((fact) => fact.id)).toEqual([
      currentFact.id,
    ])
    expect(result.evidence.current_gates.map((entry) => entry.id)).toEqual([gate.id])
    expect(result.evidence.recent_failure?.attempt_id).toBe(latestFailure.id)
    expect(JSON.stringify(result.evidence)).not.toContain("private-body")
    expect(JSON.stringify(result.evidence)).not.toContain("receipt-claim-must-not-be-truth")
    expect(result.diagnostics.estimated_tokens).toBeLessThanOrEqual(budget.evidence_token_cap)
    expect(
      taskEvidenceSnapshot({
        project,
        item: current,
        work_items: [current, withTransitiveDependency, transitive],
        artifacts: [artifact],
        gates: [resolvedGate, gate],
        attempts: [oldFailure, latestFailure],
        receipts: [olderReceipt, latestReceipt],
        acceptance_facts: [supersededFact, currentFact, failedFact],
        budget,
      }).diagnostics.evidence_digest,
    ).toBe(result.diagnostics.evidence_digest)
  })

  test("bounds unrelated evidence to references and digests", () => {
    const current = item("current")
    const artifacts = Array.from({ length: 40 }, (_, index) =>
      Artifact.parse({
        id: `artifact-${index.toString().padStart(2, "0")}`,
        project_id: project.id,
        kind: "historical",
        title: `Historical ${index}`,
        content: `never-inline-${index}-${"证据".repeat(10_000)}`,
        evidence: { index },
        created_at: index,
      }),
    )
    const result = taskEvidenceSnapshot({
      project,
      item: current,
      work_items: [current],
      artifacts,
      gates: [],
      attempts: [],
      receipts: [],
      acceptance_facts: [],
      budget: defaultTaskContextBudget(),
    })

    expect(JSON.stringify(result.evidence)).not.toContain("never-inline")
    expect(result.evidence.references.inventory.find((entry) => entry.kind === "artifact")?.count).toBe(40)
    expect(result.diagnostics.estimated_tokens).toBeLessThanOrEqual(result.diagnostics.evidence_token_cap)
  })

  test("fails before execution when the required task exceeds its budget", () => {
    const current = item("current", [], { description: "超限".repeat(5_000) })
    const invoke = () =>
      taskEvidenceSnapshot({
        project,
        item: current,
        work_items: [current],
        artifacts: [],
        gates: [],
        attempts: [],
        receipts: [],
        acceptance_facts: [],
        budget: { usable_input_tokens: 400, prompt_token_cap: 240, evidence_token_cap: 180, source: "model" },
      })

    expect(invoke).toThrow(TaskEvidenceBudgetExceeded)
    try {
      invoke()
    } catch (error) {
      expect(contextOverflowDiagnostic({ error })).toEqual({
        code: "context_too_large",
        source: "preflight",
        message: "Task evidence exceeds the execution context budget",
      })
    }
  })

  test("reuses provider stream overflow classification", () => {
    expect(
      contextOverflowDiagnostic({
        error: { type: "error", error: { code: "context_length_exceeded" } },
      }),
    ).toEqual({
      code: "context_too_large",
      source: "stream",
      message: "Input exceeds context window of this model",
    })
  })

  test("fails before dispatch when the complete prompt exceeds the model budget", () => {
    const invoke = () =>
      assertTaskPromptBudget({
        prompt: "完整提示".repeat(2_000),
        budget: { usable_input_tokens: 400, prompt_token_cap: 240, evidence_token_cap: 180, source: "model" },
      })

    expect(invoke).toThrow(TaskPromptBudgetExceeded)
    try {
      invoke()
    } catch (error) {
      expect(contextOverflowDiagnostic({ error })?.source).toBe("preflight")
    }
  })
})
