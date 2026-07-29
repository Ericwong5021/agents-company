import {
  AttentionRouteDecision,
  AttentionRouteInput,
  type AttentionIssueKind,
  type AttentionMateriality,
  type AttentionRoute,
  type ProjectActionKind,
} from "./schema"

const materialityByIssue = {
  implementation_error: "internal",
  missing_prerequisite: "internal",
  capability_gap: "internal",
  reviewer_finding: "internal",
  graph_dependency_error: "internal",
  runtime_transient: "internal",
  permission_required: "permission",
  scope_change: "scope",
  acceptance_change: "acceptance",
  budget_change: "budget",
  external_side_effect: "external_side_effect",
  permanent_organization_change: "organization",
  unresolved_material_risk: "unresolved_risk",
} as const satisfies Record<AttentionIssueKind, AttentionMateriality>

const routeByIssue = {
  implementation_error: "worker_rework",
  missing_prerequisite: "graph_supervisor",
  capability_gap: "recruitment_resolver",
  reviewer_finding: "worker_rework",
  graph_dependency_error: "graph_mutation_policy",
  runtime_transient: "automatic_recovery",
  permission_required: "approval_gate",
  scope_change: "project_dri",
  acceptance_change: "project_dri",
  budget_change: "user",
  external_side_effect: "user",
  permanent_organization_change: "company_governance",
  unresolved_material_risk: "user",
} as const satisfies Record<AttentionIssueKind, AttentionRoute>

const actionsByRoute = {
  worker_rework: ["retry"],
  graph_supervisor: [],
  recruitment_resolver: [],
  graph_mutation_policy: [],
  automatic_recovery: ["retry"],
  approval_gate: ["resolve_blocker", "stop_work"],
  project_dri: ["resolve_blocker", "stop_work"],
  user: ["resolve_blocker", "stop_work"],
  company_governance: [],
} as const satisfies Record<AttentionRoute, readonly ProjectActionKind[]>

export function route(raw: unknown) {
  const input = AttentionRouteInput.parse(raw)
  if (materialityByIssue[input.issue_kind] !== input.materiality)
    throw new Error(
      `Attention issue ${input.issue_kind} requires materiality ${materialityByIssue[input.issue_kind]}`,
    )
  const route = routeByIssue[input.issue_kind]
  const material =
    input.materiality !== "internal" &&
    (input.materiality !== "unresolved_risk" || input.risk === "high" || input.risk === "critical")
  return AttentionRouteDecision.parse({
    ...input,
    route,
    material,
    interrupts_user:
      material &&
      (route === "approval_gate" || route === "project_dri" || route === "user"),
    allowed_actions:
      input.issue_kind === "unresolved_material_risk" && !material
        ? []
        : actionsByRoute[route],
  })
}
