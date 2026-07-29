import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import type { CompanyProjectDetail } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function list(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function records(value: unknown) {
  return Array.isArray(value) ? value.filter(record) : []
}

export default defineAgentCompanyHandler(async (event): Promise<CompanyProjectDetail> => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "Project ID is required" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const request = (path: string) => ofetch<unknown>(new URL(path, baseURL).toString(), { headers })
  const state = await request("/company")
  if (!record(state) || !record(state.company) || typeof state.company.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }

  const [raw, recruitmentRaw, agentsRaw] = await Promise.all([
    request(`/company-project/${encodeURIComponent(projectID)}`),
    request(
      `/company/recruitment?company_id=${encodeURIComponent(state.company.id)}&project_id=${encodeURIComponent(projectID)}`,
    ),
    request(`/company/agents?company_id=${encodeURIComponent(state.company.id)}`),
  ])
  if (!record(raw) || !record(raw.project)) {
    throw createError({ statusCode: 404, statusMessage: "Project was not found" })
  }

  const charter = record(raw.charter) ? raw.charter : undefined
  const recruitment = record(recruitmentRaw) ? recruitmentRaw : {}
  const candidates = [...records(recruitment.candidate_pool), ...records(recruitment.assigned_candidates)]
  const people = [
    ...records(agentsRaw).flatMap((entry) =>
      record(entry.agent)
        ? [
            {
              id: text(entry.agent.id),
              name: text(entry.agent.name),
              lifecycle: text(entry.agent.lifecycle),
            },
          ]
        : [],
    ),
    ...candidates.map((candidate) => ({
      id: text(candidate.id),
      name: text(candidate.name),
      lifecycle: text(candidate.lifecycle),
    })),
  ]
  return {
    project: {
      id: text(raw.project.id),
      title: text(raw.project.title),
      goal: text(raw.project.goal),
      status: text(raw.project.status),
      ownerAgentID: text(raw.project.owner_agent_id) || undefined,
      sourceThreadID: text(raw.project.source_thread_id) || undefined,
      executionStrategy:
        raw.project.execution_strategy === "seed_and_grow"
          ? "seed_and_grow"
          : raw.project.execution_strategy === "legacy_full_plan"
            ? "legacy_full_plan"
            : undefined,
      seedMode:
        raw.project.seed_mode === "seed_pair"
          ? "seed_pair"
          : raw.project.seed_mode === "discovery_first"
            ? "discovery_first"
            : raw.project.seed_mode === "direct_single"
              ? "direct_single"
              : undefined,
      graphRevision:
        typeof raw.project.graph_revision === "number" && Number.isInteger(raw.project.graph_revision)
          ? raw.project.graph_revision
          : undefined,
    },
    charter: charter
      ? {
          value: text(charter.value),
          deliverables: list(charter.deliverables),
          acceptance: list(charter.acceptance_criteria),
          scope: list(charter.scope),
          nonGoals: list(charter.non_goals),
          constraints: list(charter.constraints),
          risks: records(charter.risks).map((risk) => ({
            description: text(risk.description),
            mitigation: text(risk.mitigation),
          })),
          milestones: list(charter.milestones),
          driAgentID: text(charter.dri_agent_id),
        }
      : undefined,
    workItems: records(raw.work_items).map((item) => ({
      id: text(item.id),
      title: text(item.title),
      status: text(item.status),
      kind: text(item.kind),
      ownerAgentID: text(item.owner_agent_id) || undefined,
      dependsOn: list(item.depends_on),
      reviewStatus: text(item.review_status),
      attempt: number(item.attempt),
      maxAttempts: number(item.max_attempts),
      error: text(item.error) || undefined,
      purpose: text(item.purpose) || undefined,
      role: text(item.role) || undefined,
      originKind: text(item.origin_kind) || undefined,
    })),
    artifacts: records(raw.artifacts).map((artifact) => ({
      id: text(artifact.id),
      title: text(artifact.title),
      kind: text(artifact.kind),
      workItemID: text(artifact.work_item_id) || undefined,
      createdAt: number(artifact.created_at),
    })),
    gates: records(raw.gates).map((gate) => ({
      id: text(gate.id),
      title: text(gate.title),
      kind: text(gate.kind),
      status: text(gate.status),
    })),
    recruitment: {
      needs: records(recruitment.needs).map((need) => ({
        id: text(need.id),
        role: text(need.role),
        capabilityPacks: list(need.capability_packs),
      })),
      selections: records(recruitment.selections).map((selection) => ({
        id: text(selection.id),
        capabilityNeedID: text(selection.capability_need_id),
        agentID: text(selection.agent_id),
        decision: selection.decision === "selected" ? "selected" : "rejected",
        reason: text(selection.reason),
        released: typeof selection.time_released === "number",
      })),
      candidates: [...new Map(people.map((person) => [person.id, person])).values()],
      departments: records(recruitment.departments).map((department) => ({
        id: text(department.id),
        name: text(department.name),
        purpose: text(department.purpose),
        status: text(department.status),
      })),
    },
  }
})
