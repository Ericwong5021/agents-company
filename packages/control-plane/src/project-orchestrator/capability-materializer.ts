import { Context, Effect, Layer } from "effect"
import { CompanyID } from "@/company/schema"
import { CompanyProject } from "@/company-project/company-project"
import type { GraphDecision, WorkItem } from "@/company-project/schema"
import { CompanyRecruitment, stableLogicalKey } from "@/company-recruitment"
import { assignmentConstraints } from "./seed-team"

export type MaterializationResult = {
  decision_id: string
  capability_need_ids: string[]
  assignment_ids: string[]
  work_item_ids: string[]
}

const fallbackCapabilityPacks: Record<WorkItem["work_type"], string[]> = {
  coding: ["software-implementation@1"],
  decision: ["board-strategy@1"],
  research: ["research-analysis@1"],
  writing: ["document-authoring@1"],
  design: ["design-production@1"],
  analysis: ["research-analysis@1"],
  knowledge_reading: ["commons-reading@1"],
}

export interface Interface {
  readonly materializeDecision: (decision: GraphDecision) => Effect.Effect<MaterializationResult>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CapabilityMaterializer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const projects = yield* CompanyProject.Service
    const recruitment = yield* CompanyRecruitment.Service

    const materializeDecision = Effect.fn("CapabilityMaterializer.materializeDecision")(function* (
      decision: GraphDecision,
    ) {
      if (decision.status !== "applied")
        return {
          decision_id: decision.id,
          capability_need_ids: [],
          assignment_ids: [],
          work_item_ids: [],
        }
      const project = yield* projects.get(decision.project_id)
      if (!project) throw new Error(`Company project not found: ${decision.project_id}`)
      const items = yield* projects.listWorkItems(project.id)
      const currentAssignments = yield* recruitment.listAssignments({ project_id: project.id })
      const activeAgentIDs = [
        ...new Set(
          currentAssignments
            .filter((assignment) => assignment.status === "assigned" || assignment.status === "active")
            .map((assignment) => assignment.agent_id),
        ),
      ]
      const results = yield* Effect.forEach(
        decision.operations.filter((operation) => operation.type === "request_capability"),
        (operation) =>
          Effect.gen(function* () {
            const item = items.find((candidate) => candidate.id === operation.need.work_item_id)
            if (!item)
              throw new Error(
                `Capability Need ${operation.need.id} references unavailable WorkItem ${operation.need.work_item_id}`,
              )
            const assigned = currentAssignments.find(
              (assignment) =>
                assignment.work_item_id === item.id &&
                (assignment.status === "assigned" || assignment.status === "active"),
            )
            if (assigned)
              return {
                capability_need_id: assigned.capability_need_id,
                assignment_id: assigned.id,
                work_item_id: item.id,
              }
            const capability_packs = item.capability_packs.length
              ? item.capability_packs
              : fallbackCapabilityPacks[item.work_type]
            const constraints = assignmentConstraints(capability_packs)
            const allowed_permission_modes = constraints.allowed_permission_modes.filter((mode) =>
              operation.need.allowed_permission_modes.includes(mode as "read_only" | "workspace_write"),
            )
            if (!allowed_permission_modes.length)
              throw new Error(`Capability Need ${operation.need.id} has no permitted runtime mode`)
            const need = yield* recruitment.createNeed({
              ...(project.company_id ? { company_id: CompanyID.parse(project.company_id) } : {}),
              project_id: project.id,
              work_item_id: item.id,
              source_receipt_id: decision.receipt_id,
              need_key: stableLogicalKey(
                `graph-${decision.receipt_id}-${operation.need.id}-${operation.need.work_item_id}`,
              ),
              role: item.role,
              work_type: item.work_type,
              capability_packs,
              risk_level: item.risk_level,
              demand_horizon: "project",
              required_runtime_capabilities: constraints.required_runtime_capabilities,
              required_tools: constraints.required_tools,
              allowed_permission_modes,
              workspace_scopes: operation.need.resource_scope.length
                ? operation.need.resource_scope
                : item.resource_scope,
              independent_from_agent_ids: activeAgentIDs,
            })
            const selected = yield* recruitment.selectAndAssign({
              capability_need_id: need.id,
              exclude_agent_ids: activeAgentIDs,
              permission_mode: allowed_permission_modes[0],
            })
            return {
              capability_need_id: need.id,
              assignment_id: selected.assignment.id,
              work_item_id: item.id,
            }
          }),
        { concurrency: 1 },
      )
      return {
        decision_id: decision.id,
        capability_need_ids: results.map((result) => result.capability_need_id),
        assignment_ids: results.map((result) => result.assignment_id),
        work_item_ids: results.map((result) => result.work_item_id),
      }
    })

    return Service.of({ materializeDecision })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CompanyProject.defaultLayer),
  Layer.provide(CompanyRecruitment.defaultLayer),
)

export * as CapabilityMaterializer from "./capability-materializer"
