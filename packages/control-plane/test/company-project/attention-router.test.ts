import { describe, expect, test } from "bun:test"
import { AttentionRouter, type AttentionRouteInput } from "../../src/company-project"

describe("AttentionRouter", () => {
  test("routes every structured issue without inspecting error text", () => {
    const cases: {
      input: AttentionRouteInput
      route: ReturnType<typeof AttentionRouter.route>["route"]
      material: boolean
      interrupts_user: boolean
      allowed_actions: ReturnType<typeof AttentionRouter.route>["allowed_actions"]
    }[] = [
      {
        input: { issue_kind: "implementation_error", risk: "medium", materiality: "internal" },
        route: "worker_rework",
        material: false,
        interrupts_user: false,
        allowed_actions: ["retry"],
      },
      {
        input: { issue_kind: "missing_prerequisite", risk: "medium", materiality: "internal" },
        route: "graph_supervisor",
        material: false,
        interrupts_user: false,
        allowed_actions: [],
      },
      {
        input: { issue_kind: "capability_gap", risk: "medium", materiality: "internal" },
        route: "recruitment_resolver",
        material: false,
        interrupts_user: false,
        allowed_actions: [],
      },
      {
        input: { issue_kind: "reviewer_finding", risk: "medium", materiality: "internal" },
        route: "worker_rework",
        material: false,
        interrupts_user: false,
        allowed_actions: ["retry"],
      },
      {
        input: { issue_kind: "graph_dependency_error", risk: "medium", materiality: "internal" },
        route: "graph_mutation_policy",
        material: false,
        interrupts_user: false,
        allowed_actions: [],
      },
      {
        input: { issue_kind: "runtime_transient", risk: "medium", materiality: "internal" },
        route: "automatic_recovery",
        material: false,
        interrupts_user: false,
        allowed_actions: ["retry"],
      },
      {
        input: { issue_kind: "permission_required", risk: "medium", materiality: "permission" },
        route: "approval_gate",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
      {
        input: { issue_kind: "scope_change", risk: "medium", materiality: "scope" },
        route: "project_dri",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
      {
        input: { issue_kind: "acceptance_change", risk: "medium", materiality: "acceptance" },
        route: "project_dri",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
      {
        input: { issue_kind: "budget_change", risk: "medium", materiality: "budget" },
        route: "user",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
      {
        input: {
          issue_kind: "external_side_effect",
          risk: "medium",
          materiality: "external_side_effect",
        },
        route: "user",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
      {
        input: {
          issue_kind: "permanent_organization_change",
          risk: "medium",
          materiality: "organization",
        },
        route: "company_governance",
        material: true,
        interrupts_user: false,
        allowed_actions: [],
      },
      {
        input: {
          issue_kind: "unresolved_material_risk",
          risk: "high",
          materiality: "unresolved_risk",
        },
        route: "user",
        material: true,
        interrupts_user: true,
        allowed_actions: ["resolve_blocker", "stop_work"],
      },
    ]

    for (const item of cases) {
      expect(AttentionRouter.route(item.input)).toEqual({
        ...item.input,
        route: item.route,
        material: item.material,
        interrupts_user: item.interrupts_user,
        allowed_actions: item.allowed_actions,
      })
    }
  })

  test("rejects mismatched or free-text routing facts and suppresses low unresolved risk", () => {
    expect(() =>
      AttentionRouter.route({
        issue_kind: "permission_required",
        risk: "high",
        materiality: "internal",
      }),
    ).toThrow("requires materiality permission")
    expect(() =>
      AttentionRouter.route({
        issue_kind: "runtime_transient",
        risk: "low",
        materiality: "internal",
        error: "permission denied",
      }),
    ).toThrow()
    expect(
      AttentionRouter.route({
        issue_kind: "unresolved_material_risk",
        risk: "low",
        materiality: "unresolved_risk",
      }),
    ).toMatchObject({
      route: "user",
      material: false,
      interrupts_user: false,
      allowed_actions: [],
    })
  })
})
