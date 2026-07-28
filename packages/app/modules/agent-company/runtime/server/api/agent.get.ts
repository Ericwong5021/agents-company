import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import type { CompanyAgentDetail } from "../../shared/company-contract"
import { parseAgents } from "../../shared/snapshot-contract"
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

function records(value: unknown) {
  return Array.isArray(value) ? value.filter(record) : []
}

// TEAM-01：Agent 详情只投影 Control Plane 的真实事实（活动、能力证据、工作历史），不补默认值。
export default defineAgentCompanyHandler(async (event): Promise<CompanyAgentDetail> => {
  const agentID = getRouterParam(event, "agentID")
  if (!agentID) throw createError({ statusCode: 400, statusMessage: "Agent ID is required" })

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

  const companyID = state.company.id
  const [agentsRaw, recruitmentRaw] = await Promise.all([
    request(`/company/agents?company_id=${encodeURIComponent(companyID)}`),
    request(`/company/recruitment?company_id=${encodeURIComponent(companyID)}`),
  ])
  const agents = parseAgents(agentsRaw)
  if (!agents.ok) throw createError({ statusCode: 503, statusMessage: "员工投影不符合当前契约" })
  const agent = agents.value.find((entry) => entry.id === agentID)
  if (!agent) throw createError({ statusCode: 404, statusMessage: "Agent was not found" })

  const recruitment = record(recruitmentRaw) ? recruitmentRaw : {}
  const forAgent = (rows: unknown) => records(rows).filter((row) => text(row.agent_id) === agentID)
  return {
    agent,
    capabilities: forAgent(recruitment.capabilities).map((row) => ({
      pack: text(row.capability_pack),
      status: text(row.status),
      available: row.available === true,
      source: text(row.source),
      lastVerifiedAt: typeof row.last_verified_at === "number" ? row.last_verified_at : undefined,
      failureCount: number(row.failure_count),
      availabilityReasons: Array.isArray(row.availability_reasons)
        ? row.availability_reasons.filter((item): item is string => typeof item === "string")
        : [],
    })),
    performances: forAgent(recruitment.performances).map((row) => ({
      projectID: text(row.project_id),
      outcome: text(row.outcome),
      qualityScore: number(row.quality_score),
      reliabilityScore: number(row.reliability_score),
      reviewSummary: text(row.review_summary),
      timeCreated: number(row.time_created),
    })),
    selections: forAgent(recruitment.selections).map((row) => ({
      projectID: text(row.project_id),
      decision: row.decision === "selected" ? "selected" : "rejected",
      reason: text(row.reason),
      candidateRank: number(row.candidate_rank),
      released: typeof row.time_released === "number",
    })),
    employmentReviews: forAgent(recruitment.employment_reviews).map((row) => ({
      status: text(row.status),
      rationale: text(row.rationale),
      timeDecided: typeof row.time_decided === "number" ? row.time_decided : undefined,
    })),
  }
})
