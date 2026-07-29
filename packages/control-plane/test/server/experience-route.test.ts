import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MockLanguageModelV3 } from "ai/test"
import fs from "node:fs/promises"
import path from "node:path"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import {
  DiscoverySummary,
  ExperienceApiError,
  ExperienceArtifactUnavailable,
  ExperienceArtifactView,
  ExperienceWorkActionResult,
  GraphChangeSummary,
  GoalBrief,
  GoalBriefHistory,
  GoalBriefStructuredFailure,
  OrganizationProjection,
  ValidationSummary,
  WorkProjection,
  WorkProjectionList,
} from "@agents-company/shared/experience"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import {
  CompanyArtifactTable,
  CompanyGraphMutationTable,
  CompanyPlanTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyValidationGateTable,
  CompanyWorkAttemptTable,
  CompanyWorkItemTable,
  CompanyWorkReceiptTable,
} from "../../src/company-project/company-project.sql"
import * as ExperienceArtifact from "../../src/company-project/experience-artifact"
import {
  CompanyCapabilityNeedTable,
  CompanyProjectAssignmentTable,
  CompanyTeamSelectionTable,
} from "../../src/company-recruitment/company-recruitment.sql"
import { GoalBriefModelAdapter } from "../../src/goal-brief"
import { GoalBriefTable } from "../../src/goal-brief/goal-brief.sql"
import { createExperienceRoutes } from "../../src/server/routes/instance/experience"
import { Server } from "../../src/server/server"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function brief() {
  return {
    goal: "通过共享契约交付体验改进",
    deliverables: [{ id: "delivery-1", title: "体验改进", description: "完成实现和验证" }],
    acceptanceCriteria: [
      { id: "criterion-1", description: "契约响应可解析", verification: "使用共享 Zod Schema 验证" },
    ],
    constraints: ["不依赖外部 Provider"],
    nonGoals: ["不修改 App"],
    assumptions: [{ id: "assumption-1", description: "本地 API 可用", confirmed: true }],
    openQuestions: [],
    riskLevel: "low",
    recommendedPlan: {
      summary: "建立契约并验证 API",
      steps: [{ id: "step-1", title: "契约验证", outcome: "所有响应符合共享 Schema" }],
    },
    approvalMode: "balanced",
    sourceRefs: [{ kind: "user", id: "user-local" }],
  }
}

async function json(pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set("content-type", "application/json")
  const response = await Server.Default().app.request(pathname, { ...init, headers })
  return { response, body: (await response.json()) as unknown }
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

describe.serial("/experience", () => {
  test.serial("returns only shared Goal Brief schemas and protects version writes", async () => {
    const createdResult = await json("/experience/goal-brief", {
      method: "POST",
      body: JSON.stringify({ source: "user_input", brief: brief() }),
    })
    expect(createdResult.response.status).toBe(200)
    const created = GoalBrief.parse(createdResult.body)

    const readResult = await json(`/experience/goal-brief/${created.id}`)
    expect(readResult.response.status).toBe(200)
    expect(GoalBrief.parse(readResult.body)).toEqual(created)

    const appendResult = await json(`/experience/goal-brief/${created.id}/versions`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        source: "user_confirmation",
        brief: { ...brief(), goal: "交付已确认的体验改进" },
      }),
    })
    expect(appendResult.response.status).toBe(200)
    expect(GoalBrief.parse(appendResult.body).version).toBe(2)

    const conflictResult = await json(`/experience/goal-brief/${created.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, source: "system_suggestion", brief: brief() }),
    })
    expect(conflictResult.response.status).toBe(409)
    expect(conflictResult.body).toMatchObject({ code: "version_conflict", currentVersion: 2 })

    const historyResult = await json(`/experience/goal-brief/${created.id}/versions`)
    expect(GoalBriefHistory.parse(historyResult.body).versions).toHaveLength(2)
  })

  test.serial("rejects unknown Goal Brief fields before persistence", async () => {
    const result = await json("/experience/goal-brief", {
      method: "POST",
      body: JSON.stringify({
        source: "user_input",
        brief: { ...brief(), markdown: "**Goal**" },
      }),
    })

    expect(result.response.status).toBe(400)
  })

  test.serial("returns a recoverable 422 and does not persist after structured generation exhaustion", async () => {
    const routes = createExperienceRoutes(() =>
      Effect.fail(new GoalBriefModelAdapter.GoalBriefModelAdaptationError("openai_compatible", 3)),
    )
    const response = await routes.request("/goal-brief/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-generate-failure",
        goal: "生成完整 Goal Brief",
      }),
    })

    expect(response.status).toBe(422)
    expect(GoalBriefStructuredFailure.parse(await response.json())).toEqual({
      code: "goal_brief_structured_output_failed",
      message: "未能生成完整 Goal Brief。你可以重试，或手动补充目标信息。",
      attempts: 3,
      recoveryActions: ["retry", "manual_edit"],
    })
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
  })

  test.serial("does not rewrite Provider failures as structured-output failures", async () => {
    const providerError = Object.assign(new Error("rate limited"), { statusCode: 429 })
    let caught: unknown
    const routes = createExperienceRoutes(() => Effect.fail(providerError))
    routes.onError((error) => {
      caught = error
      return new Response("provider unavailable", { status: 503 })
    })
    const response = await routes.request("/goal-brief/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-provider-failure",
        goal: "验证 Provider 故障不会伪装成结构错误",
      }),
    })

    expect(response.status).toBe(503)
    expect(caught).toBe(providerError)
    expect(Database.use((db) => db.select({ value: count() }).from(GoalBriefTable).get())?.value).toBe(0)
  })

  test.serial("returns a shared 409 contract for a conflicting generation requestId", async () => {
    let calls = 0
    const routes = createExperienceRoutes((input) =>
      Effect.tryPromise({
        try: () =>
          GoalBriefModelAdapter.generateAndCreate(input, {
            resolveDefaultModel: async () => ({
              adapterProvider: "openai_compatible",
              model: new MockLanguageModelV3(),
            }),
            generate: async (call) => {
              calls += 1
              const { sourceRefs: _, ...output } = brief()
              return call.schema.parse(output)
            },
          }),
        catch: (error) => error,
      }),
    )
    const first = await routes.request("/goal-brief/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-route-idempotent",
        goal: "生成可重放 Goal Brief",
      }),
    })
    const replay = await routes.request("/goal-brief/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-route-idempotent",
        goal: "生成可重放 Goal Brief",
      }),
    })
    const conflict = await routes.request("/goal-brief/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-route-idempotent",
        goal: "改变同一 requestId 的请求",
      }),
    })

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(GoalBrief.parse(await replay.json())).toEqual(GoalBrief.parse(await first.json()))
    expect(conflict.status).toBe(409)
    expect(ExperienceApiError.parse(await conflict.json())).toMatchObject({ code: "request_conflict" })
    expect(calls).toBe(1)
  })

  test.serial("returns shared not-found errors for every missing experience resource", async () => {
    const responses = await Promise.all([
      json("/experience/goal-brief/project/project-missing"),
      json("/experience/goal-brief/brief-missing/versions"),
      json("/experience/goal-brief/brief-missing"),
      json("/experience/work/project-missing"),
      json("/experience/work/project-missing/organization"),
      json("/experience/work/project-missing/graph"),
      json("/experience/work/project-missing/receipts/receipt-missing"),
      json("/experience/work/project-missing/validation"),
      json("/experience/goal-brief/brief-missing/versions", {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 1,
          source: "user_confirmation",
          brief: brief(),
        }),
      }),
    ])

    expect(responses.map((item) => item.response.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404])
    responses.forEach((item) => {
      expect(ExperienceApiError.parse(item.body).code).toBe("not_found")
    })
  })

  test.serial("executes a strict durable Experience work action contract", async () => {
    Database.use((db) =>
      db
        .insert(CompanyProjectTable)
        .values({
          id: "project-action-api",
          goal: "Pause safely",
          title: "Action API",
          status: "executing",
          output_dir: "/tmp/project-action-api",
          execution_strategy: "seed_and_grow",
          seed_mode: "direct_single",
          graph_revision: 2,
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        .run(),
    )
    const request = {
      action: "pause_work",
      idempotencyKey: "api-pause-1",
      expectedGraphRevision: 2,
      reason: "Inspect current evidence",
    }
    const first = await json("/experience/work/project-action-api/actions", {
      method: "POST",
      body: JSON.stringify(request),
    })
    const replay = await json("/experience/work/project-action-api/actions", {
      method: "POST",
      body: JSON.stringify(request),
    })
    const invalid = await json("/experience/work/project-action-api/actions", {
      method: "POST",
      body: JSON.stringify({ ...request, unexpected: true }),
    })
    const invalidResolve = await json("/experience/work/project-action-api/actions", {
      method: "POST",
      body: JSON.stringify({
        action: "resolve_blocker",
        idempotencyKey: "api-resolve-invalid",
        expectedGraphRevision: 2,
        resolution: "No target",
      }),
    })
    const conflict = await json("/experience/work/project-action-api/actions", {
      method: "POST",
      body: JSON.stringify({ ...request, reason: "Different facts" }),
    })
    const missing = await json("/experience/work/project-action-missing/actions", {
      method: "POST",
      body: JSON.stringify({ ...request, idempotencyKey: "api-pause-missing" }),
    })

    expect(first.response.status).toBe(200)
    expect(ExperienceWorkActionResult.parse(first.body)).toMatchObject({
      projectId: "project-action-api",
      action: "pause_work",
      status: "applied",
      replayed: false,
    })
    expect(ExperienceWorkActionResult.parse(replay.body)).toMatchObject({
      status: "applied",
      replayed: true,
    })
    expect(invalid.response.status).toBe(400)
    expect(invalidResolve.response.status).toBe(400)
    expect(conflict.response.status).toBe(409)
    expect(ExperienceApiError.parse(conflict.body).code).toBe("request_conflict")
    expect(missing.response.status).toBe(404)
    expect(ExperienceApiError.parse(missing.body).code).toBe("not_found")
  })

  test.serial("returns work list and detail through the shared projection schemas", async () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-api",
          goal: "交付 API 投影",
          title: "API 投影",
          status: "executing",
          output_dir: "/tmp/project-api",
          created_at: 100,
          updated_at: 300,
        })
        .run()
      db.insert(CompanyProjectEventTable)
        .values([
          {
            id: "event-api-1",
            project_id: "project-api",
            type: "project.created",
            data_json: JSON.stringify({ goal: "交付 API 投影" }),
            created_at: 100,
          },
          {
            id: "event-api-2",
            project_id: "project-api",
            type: "project.status_changed",
            data_json: JSON.stringify({ from: "intake", to: "executing" }),
            created_at: 300,
          },
        ])
        .run()
    })

    const detailResult = await json("/experience/work/project-api")
    expect(detailResult.response.status).toBe(200)
    const detail = WorkProjection.parse(detailResult.body)
    if (detail.availability !== "available") throw new Error("Expected an available work projection")
    expect(detail.summary.userStatus).toBe("running")

    const listResult = await json("/experience/work")
    expect(listResult.response.status).toBe(200)
    expect(WorkProjectionList.parse(listResult.body).items).toHaveLength(1)
  })

  test.serial("projects organization, graph, receipt, and validation from persisted source facts", async () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-b4",
          goal: "验证 B4 真实只读投影",
          title: "B4 只读投影",
          status: "executing",
          output_dir: "/tmp/project-b4",
          active_plan_version: 1,
          graph_revision: 1,
          created_at: 100,
          updated_at: 900,
        })
        .run()
      db.insert(CompanyPlanTable)
        .values({
          id: "plan-b4",
          project_id: "project-b4",
          version: 1,
          phase: "execution",
          status: "active",
          summary: "执行可追溯投影",
          assumptions_json: "[]",
          acceptance_criteria_json: JSON.stringify(["共享契约可解析"]),
          created_at: 100,
        })
        .run()
      db.insert(CompanyWorkItemTable)
        .values({
          id: "item-b4",
          project_id: "project-b4",
          plan_id: "plan-b4",
          title: "建立真实投影",
          description: "从 SQLite 事实生成安全摘要",
          kind: "worker",
          work_type: "analysis",
          role: "Projection Builder",
          capability_packs_json: JSON.stringify(["projection"]),
          decision_scope_json: "[]",
          resource_scope_json: "[]",
          inputs_json: "[]",
          expected_outputs_json: JSON.stringify(["只读投影"]),
          validators_json: JSON.stringify(["targeted tests"]),
          disposition: "temporary",
          model_group: "standard",
          risk_level: "medium",
          review_status: "not_required",
          status: "completed",
          purpose: "delivery",
          origin_kind: "seed",
          graph_revision_created: 0,
          validation_mode: "machine",
          acceptance_criteria_json: JSON.stringify(["targeted tests pass"]),
          attempt: 1,
          max_attempts: 3,
          started_at: 150,
          completed_at: 400,
          created_at: 100,
          updated_at: 400,
        })
        .run()
      db.insert(CompanyWorkAttemptTable)
        .values({
          id: "attempt-b4",
          project_id: "project-b4",
          work_item_id: "item-b4",
          ordinal: 1,
          status: "completed",
          safe_summary: "完成真实 SQLite 投影实现",
          started_at: 200,
          finished_at: 400,
        })
        .run()
      db.insert(CompanyWorkReceiptTable)
        .values({
          id: "receipt-b4",
          project_id: "project-b4",
          work_item_id: "item-b4",
          attempt_id: "attempt-b4",
          idempotency_key: "receipt-b4-idempotency",
          outcome: "completed",
          summary: "发现并映射现有事实",
          artifact_ids_json: "[]",
          evidence_refs_json: "[]",
          confirmed_facts_json: JSON.stringify(["发现真实代码事实"]),
          invalidated_assumptions_json: JSON.stringify(["旧投影不足以表达组织"]),
          unknowns_json: "[]",
          blockers_json: "[]",
          capability_gaps_json: "[]",
          task_proposals_json: JSON.stringify([{ privateProposal: "不得暴露原始提案" }]),
          dependency_proposals_json: JSON.stringify([{ privateDependency: "不得暴露原始依赖" }]),
          questions_json: "[]",
          processing_status: "processed",
          processed_mutation_id: "mutation-b4",
          created_at: 500,
          processed_at: 600,
        })
        .run()
      db.insert(CompanyGraphMutationTable)
        .values({
          id: "mutation-b4",
          project_id: "project-b4",
          trigger_receipt_id: "receipt-b4",
          expected_revision: 0,
          applied_revision: 1,
          orchestrator_version: 1,
          idempotency_key: "mutation-b4-idempotency",
          decision: "accept",
          rationale: "已有事实足以收敛",
          evidence_refs_json: "[]",
          operations_json: "[]",
          status: "applied",
          policy_verdict_json: JSON.stringify({ result: "allowed", violations: [] }),
          created_at: 650,
          applied_at: 700,
        })
        .run()
      db.insert(CompanyValidationGateTable)
        .values({
          id: "gate-b4",
          project_id: "project-b4",
          work_item_id: "item-b4",
          kind: "unit_test",
          status: "passed",
          criteria_json: JSON.stringify([
            {
              id: "criterion-b4",
              statement: "targeted tests pass",
              anchor: { kind: "unit_test", reference: "bun test targeted" },
              operator: "exit_code",
              expected: 0,
            },
          ]),
          criteria_sha256: "a".repeat(64),
          blocking_work_item_ids_json: JSON.stringify(["item-b4"]),
          evidence_refs_json: "[]",
          evaluator: "command_exit_v1",
          repair_round: 0,
          max_repair_rounds: 3,
          created_at: 750,
          evaluated_at: 800,
        })
        .run()
      db.insert(CompanyAgentTable)
        .values({
          id: "agent-b4",
          lifecycle: "assigned",
          name: "Projection Builder",
          preferred_runtime: "pi",
          time_created: 100,
          time_updated: 700,
        })
        .run()
      db.insert(CompanyCapabilityNeedTable)
        .values({
          id: "need-b4",
          project_id: "project-b4",
          need_key: "projection.builder",
          work_item_id: "item-b4",
          source_receipt_id: "receipt-b4",
          role: "Projection Builder",
          work_type: "analysis",
          capability_packs_json: JSON.stringify(["projection"]),
          risk_level: "medium",
          demand_horizon: "project",
          required_runtime_capabilities_json: "[]",
          required_tools_json: "[]",
          allowed_permission_modes_json: JSON.stringify(["read_only"]),
          workspace_scopes_json: "[]",
          independent_from_agent_ids_json: "[]",
          time_created: 650,
          time_updated: 700,
        })
        .run()
      db.insert(CompanyTeamSelectionTable)
        .values({
          id: "selection-b4",
          project_id: "project-b4",
          capability_need_id: "need-b4",
          selection_round: 1,
          agent_id: "agent-b4",
          decision: "selected",
          source: "new_candidate",
          lifecycle_at_selection: "candidate",
          reason: "具备真实投影能力",
          score_json: JSON.stringify({
            capability_match: 100,
            availability: 100,
            historical_quality: 80,
            historical_reliability: 80,
            cost_efficiency: 80,
            speed: 80,
            risk_fit: 90,
            reuse_value: 70,
            total: 680,
          }),
          constraint_results_json: "[]",
          time_created: 700,
          time_updated: 700,
        })
        .run()
      db.insert(CompanyProjectAssignmentTable)
        .values({
          id: "assignment-b4",
          project_id: "project-b4",
          work_item_id: "item-b4",
          capability_need_id: "need-b4",
          selection_id: "selection-b4",
          agent_id: "agent-b4",
          version: 1,
          idempotency_key: "assignment-b4-idempotency",
          temporary_role: "Projection Builder",
          responsibility: "生成安全且可追溯的只读投影",
          decision_scope_json: "[]",
          resource_scope_json: "[]",
          permission_mode: "read_only",
          source_receipt_id: "receipt-b4",
          status: "active",
          assigned_at: 700,
          started_at: 710,
        })
        .run()
    })

    const organizationResult = await json("/experience/work/project-b4/organization")
    expect(organizationResult.response.status).toBe(200)
    const organization = OrganizationProjection.parse(organizationResult.body)
    if (organization.availability !== "available") throw new Error("Expected organization projection")
    expect(organization.projectorVersion).toBe(4)
    expect(organization.activeAssignmentCount).toBe(1)
    expect(organization.assignments[0]).toMatchObject({
      availability: "available",
      assignmentId: "assignment-b4",
      sourceReceiptId: "receipt-b4",
      currentLifecycle: "assigned",
    })
    expect(organizationResult.body).not.toHaveProperty("assignments.0.score")

    const graphResult = await json("/experience/work/project-b4/graph")
    expect(graphResult.response.status).toBe(200)
    const graph = GraphChangeSummary.parse(graphResult.body)
    if (graph.availability !== "available") throw new Error("Expected graph projection")
    expect(graph.revision).toBe(1)
    expect(graph.changes[0].operationCounts).toEqual({
      addedWorkItems: 0,
      addedDependencies: 0,
      removedDependencies: 0,
      supersededWorkItems: 0,
      addedValidationGates: 0,
      requestedCapabilities: 0,
      requestedUserDecisions: 0,
    })
    expect(graphResult.body).not.toHaveProperty("changes.0.operations")

    const discoveryResult = await json("/experience/work/project-b4/receipts/receipt-b4")
    expect(discoveryResult.response.status).toBe(200)
    const discovery = DiscoverySummary.parse(discoveryResult.body)
    if (discovery.availability !== "available") throw new Error("Expected discovery projection")
    expect(discovery.confirmedFacts).toEqual(["发现真实代码事实"])
    expect(discovery.attempt).toMatchObject({ id: "attempt-b4", status: "completed" })
    expect(discoveryResult.body).not.toHaveProperty("taskProposals")
    expect(discoveryResult.body).not.toHaveProperty("dependencyProposals")

    const validationResult = await json("/experience/work/project-b4/validation")
    expect(validationResult.response.status).toBe(200)
    const validation = ValidationSummary.parse(validationResult.body)
    if (validation.availability !== "available") throw new Error("Expected validation projection")
    expect(validation.blockingGateCount).toBe(0)
    expect(validation.gates[0]).toMatchObject({
      gateId: "gate-b4",
      status: "passed",
      criteriaSha256: "a".repeat(64),
    })

    const sourceKinds = new Set([
      ...organization.assignments[0].sourceRefs.map((ref) => ref.kind),
      ...graph.changes[0].sourceRefs.map((ref) => ref.kind),
      ...discovery.sourceRefs.map((ref) => ref.kind),
      ...validation.gates[0].sourceRefs.map((ref) => ref.kind),
    ])
    expect(sourceKinds).toEqual(
      new Set([
        "project",
        "work_item",
        "work_attempt",
        "work_receipt",
        "graph_mutation",
        "project_assignment",
        "validation_gate",
      ]),
    )
    expect(
      DiscoverySummary.parse((await json("/experience/work/project-b4/receipts/receipt-b4")).body).sourceWatermark,
    ).toBe(discovery.sourceWatermark)

    Database.use((db) =>
      db
        .update(CompanyWorkReceiptTable)
        .set({ confirmed_facts_json: "{" })
        .where(eq(CompanyWorkReceiptTable.id, "receipt-b4"))
        .run(),
    )
    const unavailable = DiscoverySummary.parse((await json("/experience/work/project-b4/receipts/receipt-b4")).body)
    expect(unavailable.availability).toBe("unavailable")
  })

  test.serial("makes every delivered Artifact ref resolve to a safe project-bound view", async () => {
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-delivery-api",
          goal: "交付可打开成果",
          title: "可打开交付",
          status: "completed",
          output_dir: "/tmp/project-delivery-api",
          created_at: 100,
          updated_at: 400,
        })
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-delivery-api",
          project_id: "project-delivery-api",
          kind: "product",
          title: "交付说明.txt",
          content: "这是可直接查看的交付内容。",
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
      db.insert(CompanyProjectEventTable)
        .values([
          {
            id: "event-delivery-created",
            project_id: "project-delivery-api",
            type: "artifact.created",
            data_json: JSON.stringify({ artifact_id: "artifact-delivery-api", kind: "product" }),
            created_at: 200,
          },
          {
            id: "event-delivery-ready",
            project_id: "project-delivery-api",
            type: "delivery.ready",
            data_json: JSON.stringify({
              delivery_id: "delivery-api",
              version: 1,
              artifact_ids: ["artifact-delivery-api"],
            }),
            created_at: 300,
          },
          {
            id: "event-delivery-completed",
            project_id: "project-delivery-api",
            type: "project.status_changed",
            data_json: JSON.stringify({ from: "executing", to: "completed" }),
            created_at: 400,
          },
        ])
        .run()
    })

    const projectionResult = await json("/experience/work/project-delivery-api")
    const projection = WorkProjection.parse(projectionResult.body)
    if (projection.availability !== "available" || !projection.delivery)
      throw new Error("Expected an available delivery")
    expect(projection.delivery.artifacts).toEqual([
      {
        id: "artifact-delivery-api",
        projectId: "project-delivery-api",
        kind: "product",
        title: "交付说明.txt",
        href: "/experience/projects/project-delivery-api/artifacts/artifact-delivery-api",
      },
    ])

    const artifactResult = await json(projection.delivery.artifacts[0].href)
    expect(artifactResult.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(artifactResult.body)).toMatchObject({
      id: "artifact-delivery-api",
      projectId: "project-delivery-api",
      source: "inline",
      encoding: "utf8",
      presentation: "text",
      content: "这是可直接查看的交付内容。",
    })
    expect(artifactResult.body).not.toHaveProperty("path")
  })

  test.serial("reads only bounded project files and does not leak traversal or symlink targets", async () => {
    await using temporary = await tmpdir()
    const outputDirectory = path.join(temporary.path, "project-output")
    const readablePath = path.join(outputDirectory, "result.json")
    const mediaPath = path.join(outputDirectory, "preview.png")
    const downloadPath = path.join(outputDirectory, "result.bin")
    const emptyPath = path.join(outputDirectory, "empty.txt")
    const secretPath = path.join(temporary.path, "secret.txt")
    const linkedSecretPath = path.join(outputDirectory, "linked-secret.txt")
    await fs.mkdir(outputDirectory)
    await Bun.write(readablePath, '{"result":"safe"}')
    await Bun.write(mediaPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    await Bun.write(downloadPath, new Uint8Array([0, 1, 2]))
    await Bun.write(emptyPath, "")
    await Bun.write(secretPath, "never expose this secret")
    await fs.symlink(secretPath, linkedSecretPath)
    expect(ExperienceArtifact.openable({ outputDirectory, path: null, content: null })).toBe(false)
    expect(ExperienceArtifact.openable({ outputDirectory, path: downloadPath, content: "" })).toBe(true)
    expect(ExperienceArtifact.openable({ outputDirectory, path: outputDirectory, content: null })).toBe(false)
    expect(ExperienceArtifact.openable({ outputDirectory, path: emptyPath, content: null })).toBe(false)
    expect(ExperienceArtifact.read("project-missing", "artifact-missing")).toEqual({ status: "not_found" })

    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values([
          {
            id: "project-artifact-security",
            goal: "安全读取 Artifact",
            title: "Artifact 安全",
            status: "executing",
            output_dir: outputDirectory,
            created_at: 100,
            updated_at: 100,
          },
          {
            id: "project-artifact-other",
            goal: "验证项目绑定",
            title: "其他项目",
            status: "executing",
            output_dir: outputDirectory,
            created_at: 100,
            updated_at: 100,
          },
        ])
        .run()
      db.insert(CompanyArtifactTable)
        .values([
          {
            id: "artifact-readable",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "result.json",
            path: readablePath,
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-media",
            project_id: "project-artifact-security",
            kind: "preview",
            title: "preview.png",
            path: mediaPath,
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-download",
            project_id: "project-artifact-security",
            kind: "product",
            title: "result.bin",
            path: downloadPath,
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-empty-file",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "empty.txt",
            path: emptyPath,
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-traversal",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "Traversal",
            path: path.join(outputDirectory, "..", "secret.txt"),
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-symlink",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "Symlink",
            path: linkedSecretPath,
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-missing",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "Missing",
            path: path.join(outputDirectory, "missing.txt"),
            evidence_json: "{}",
            created_at: 200,
          },
          {
            id: "artifact-empty",
            project_id: "project-artifact-security",
            kind: "evidence",
            title: "Empty",
            content: "",
            evidence_json: "{}",
            created_at: 200,
          },
        ])
        .run()
    })

    const readable = await json("/experience/projects/project-artifact-security/artifacts/artifact-readable")
    expect(readable.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(readable.body)).toMatchObject({
      source: "project_file",
      mediaType: "application/json",
      encoding: "utf8",
      presentation: "text",
      content: '{"result":"safe"}',
    })
    const media = await json("/experience/projects/project-artifact-security/artifacts/artifact-media")
    expect(media.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(media.body)).toMatchObject({
      source: "project_file",
      mediaType: "image/png",
      encoding: "base64",
      presentation: "media",
      content: "iVBORw0KGgo=",
      byteLength: 8,
    })
    const download = await json("/experience/projects/project-artifact-security/artifacts/artifact-download")
    expect(download.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(download.body)).toMatchObject({
      source: "project_file",
      encoding: "base64",
      presentation: "download",
      content: "AAEC",
      byteLength: 3,
    })

    const wrongProject = await json("/experience/projects/project-artifact-other/artifacts/artifact-readable")
    expect(wrongProject.response.status).toBe(404)
    expect(ExperienceApiError.parse(wrongProject.body).code).toBe("not_found")

    for (const artifactID of [
      "artifact-traversal",
      "artifact-symlink",
      "artifact-missing",
      "artifact-empty",
      "artifact-empty-file",
    ]) {
      const result = await json(`/experience/projects/project-artifact-security/artifacts/${artifactID}`)
      expect(result.response.status).toBe(422)
      expect(ExperienceArtifactUnavailable.parse(result.body).code).toBe("artifact_unavailable")
      expect(JSON.stringify(result.body)).not.toContain(temporary.path)
      expect(JSON.stringify(result.body)).not.toContain("never expose this secret")
    }
  })

  test.serial("does not leak an atomically swapped symlink during concurrent Artifact reads", async () => {
    await using temporary = await tmpdir()
    const outputDirectory = path.join(temporary.path, "project-output")
    const artifactPath = path.join(outputDirectory, "result.txt")
    const secretPath = path.join(temporary.path, "secret.txt")
    await fs.mkdir(outputDirectory)
    await Bun.write(artifactPath, "safe artifact")
    await Bun.write(secretPath, "outside secret")
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-artifact-race",
          goal: "阻止 Artifact 竞争条件",
          title: "Artifact 竞争条件",
          status: "executing",
          output_dir: outputDirectory,
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-race",
          project_id: "project-artifact-race",
          kind: "evidence",
          title: "result.txt",
          path: artifactPath,
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
    })

    const stable = await json("/experience/projects/project-artifact-race/artifacts/artifact-race")
    expect(stable.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(stable.body).content).toBe("safe artifact")

    const attacker = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import fs from "node:fs"
          const [target, secret] = process.argv.slice(1)
          const end = Date.now() + 10_000
          while (Date.now() < end) {
            const swap = target + ".swap"
            fs.rmSync(swap, { force: true })
            fs.symlinkSync(secret, swap)
            fs.renameSync(swap, target)
            fs.writeFileSync(swap, "safe artifact")
            fs.renameSync(swap, target)
          }
        `,
        artifactPath,
        secretPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    await Bun.sleep(20)

    const statuses: number[] = []
    try {
      for (let attempt = 0; attempt < 2_500; attempt += 1) {
        const result = await json("/experience/projects/project-artifact-race/artifacts/artifact-race")
        statuses.push(result.response.status)
        expect([200, 422]).toContain(result.response.status)
        expect(JSON.stringify(result.body)).not.toContain("outside secret")
        if (result.response.status === 200)
          expect(ExperienceArtifactView.parse(result.body).content).toBe("safe artifact")
      }
    } finally {
      attacker.kill()
      await attacker.exited
    }
    expect(statuses).toContain(422)
  })

  test.serial("does not leak through an atomically swapped Artifact ancestor directory", async () => {
    await using temporary = await tmpdir()
    const outputDirectory = path.join(temporary.path, "project-output")
    const artifactDirectory = path.join(outputDirectory, "artifact-directory")
    const heldDirectory = path.join(outputDirectory, "artifact-directory-held")
    const outsideDirectory = path.join(temporary.path, "outside")
    const artifactPath = path.join(artifactDirectory, "result.txt")
    await fs.mkdir(artifactDirectory, { recursive: true })
    await fs.mkdir(outsideDirectory)
    await Bun.write(artifactPath, "safe ancestor artifact")
    await Bun.write(path.join(outsideDirectory, "result.txt"), "outside ancestor secret")
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-artifact-ancestor-race",
          goal: "阻止 Artifact 祖先目录竞争条件",
          title: "Artifact 祖先目录竞争条件",
          status: "executing",
          output_dir: outputDirectory,
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-ancestor-race",
          project_id: "project-artifact-ancestor-race",
          kind: "evidence",
          title: "result.txt",
          path: artifactPath,
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
    })

    const stable = await json("/experience/projects/project-artifact-ancestor-race/artifacts/artifact-ancestor-race")
    expect(stable.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(stable.body).content).toBe("safe ancestor artifact")

    const attacker = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import fs from "node:fs"
          const [target, held, outside] = process.argv.slice(1)
          const staged = target + "-staged"
          const end = Date.now() + 10_000
          while (Date.now() < end) {
            fs.renameSync(target, held)
            fs.symlinkSync(outside, staged)
            fs.renameSync(staged, target)
            fs.rmSync(target)
            fs.renameSync(held, target)
          }
        `,
        artifactDirectory,
        heldDirectory,
        outsideDirectory,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    await Bun.sleep(20)

    const statuses: number[] = []
    try {
      for (let attempt = 0; attempt < 2_500; attempt += 1) {
        const result = await json(
          "/experience/projects/project-artifact-ancestor-race/artifacts/artifact-ancestor-race",
        )
        statuses.push(result.response.status)
        expect([200, 422]).toContain(result.response.status)
        expect(JSON.stringify(result.body)).not.toContain("outside ancestor secret")
        if (result.response.status === 200)
          expect(ExperienceArtifactView.parse(result.body).content).toBe("safe ancestor artifact")
      }
    } finally {
      attacker.kill()
      await attacker.exited
    }
    expect(statuses).toContain(422)
  })

  test.serial("does not leak through an atomically swapped project output directory", async () => {
    await using temporary = await tmpdir()
    const outputDirectory = path.join(temporary.path, "project-output")
    const heldDirectory = path.join(temporary.path, "project-output-held")
    const outsideDirectory = path.join(temporary.path, "outside")
    const artifactPath = path.join(outputDirectory, "result.txt")
    await fs.mkdir(outputDirectory)
    await fs.mkdir(outsideDirectory)
    await Bun.write(artifactPath, "safe output artifact")
    await Bun.write(path.join(outsideDirectory, "result.txt"), "outside output secret")
    Database.use((db) => {
      db.insert(CompanyProjectTable)
        .values({
          id: "project-output-race",
          goal: "阻止项目输出目录竞争条件",
          title: "项目输出目录竞争条件",
          status: "executing",
          output_dir: outputDirectory,
          created_at: 100,
          updated_at: 100,
        })
        .run()
      db.insert(CompanyArtifactTable)
        .values({
          id: "artifact-output-race",
          project_id: "project-output-race",
          kind: "evidence",
          title: "result.txt",
          path: artifactPath,
          evidence_json: "{}",
          created_at: 200,
        })
        .run()
    })

    const stable = await json("/experience/projects/project-output-race/artifacts/artifact-output-race")
    expect(stable.response.status).toBe(200)
    expect(ExperienceArtifactView.parse(stable.body).content).toBe("safe output artifact")

    const attacker = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import fs from "node:fs"
          const [target, held, outside] = process.argv.slice(1)
          const staged = target + "-staged"
          const end = Date.now() + 10_000
          while (Date.now() < end) {
            fs.renameSync(target, held)
            fs.symlinkSync(outside, staged)
            fs.renameSync(staged, target)
            fs.rmSync(target)
            fs.renameSync(held, target)
          }
        `,
        outputDirectory,
        heldDirectory,
        outsideDirectory,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    await Bun.sleep(20)

    const statuses: number[] = []
    try {
      for (let attempt = 0; attempt < 2_500; attempt += 1) {
        const result = await json("/experience/projects/project-output-race/artifacts/artifact-output-race")
        statuses.push(result.response.status)
        expect([200, 422]).toContain(result.response.status)
        expect(JSON.stringify(result.body)).not.toContain("outside output secret")
        if (result.response.status === 200)
          expect(ExperienceArtifactView.parse(result.body).content).toBe("safe output artifact")
      }
    } finally {
      attacker.kill()
      await attacker.exited
    }
    expect(statuses).toContain(422)
  })

  test.serial("publishes concrete OpenAPI schemas for every experience response", async () => {
    const spec = await Server.openapi()
    const operations = [
      { method: "post", path: "/experience/goal-brief", statuses: ["200"] },
      { method: "post", path: "/experience/goal-brief/generate", statuses: ["200", "409", "422"] },
      { method: "get", path: "/experience/goal-brief/project/{projectID}", statuses: ["200", "404"] },
      { method: "get", path: "/experience/goal-brief/{briefID}/versions", statuses: ["200", "404"] },
      { method: "post", path: "/experience/goal-brief/{briefID}/versions", statuses: ["200", "404", "409"] },
      { method: "get", path: "/experience/goal-brief/{briefID}", statuses: ["200", "404"] },
      {
        method: "get",
        path: "/experience/projects/{projectID}/artifacts/{artifactID}",
        statuses: ["200", "404", "422"],
      },
      { method: "get", path: "/experience/work", statuses: ["200"] },
      {
        method: "post",
        path: "/experience/work/{projectID}/actions",
        statuses: ["200", "404", "409"],
      },
      {
        method: "get",
        path: "/experience/work/{projectID}/organization",
        statuses: ["200", "404"],
      },
      { method: "get", path: "/experience/work/{projectID}/graph", statuses: ["200", "404"] },
      {
        method: "get",
        path: "/experience/work/{projectID}/receipts/{receiptID}",
        statuses: ["200", "404"],
      },
      {
        method: "get",
        path: "/experience/work/{projectID}/validation",
        statuses: ["200", "404"],
      },
      { method: "get", path: "/experience/work/{projectID}", statuses: ["200", "404"] },
    ] as const

    for (const item of operations) {
      const operation = spec.paths?.[item.path]?.[item.method]
      expect(operation?.operationId).toBeDefined()
      for (const status of item.statuses) {
        const response = operation?.responses?.[status]
        if (!response || !("content" in response))
          throw new Error(`Missing JSON response schema for ${item.method} ${item.path} ${status}`)
        const schema = response.content?.["application/json"]?.schema
        expect(schema).toBeDefined()
        expect(JSON.stringify(schema)).not.toContain('"type":"unknown"')
      }
    }

    for (const item of [
      { method: "post", path: "/experience/goal-brief" },
      { method: "post", path: "/experience/goal-brief/generate" },
      { method: "post", path: "/experience/goal-brief/{briefID}/versions" },
      { method: "post", path: "/experience/work/{projectID}/actions" },
    ] as const) {
      const requestBody = spec.paths?.[item.path]?.[item.method]?.requestBody
      if (!requestBody || "$ref" in requestBody)
        throw new Error(`Missing concrete request body for ${item.method} ${item.path}`)
      expect(requestBody.required).toBe(true)
      expect(requestBody.content["application/json"]?.schema).toBeDefined()
    }
  })
})
