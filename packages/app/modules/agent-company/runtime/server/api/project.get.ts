import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyProjectDetail } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

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
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const stateResult = await requestControlPlaneSDK<unknown>(client.company.current())
  if (!stateResult.ok) throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  const state = stateResult.value
  if (!record(state) || !record(state.company) || typeof state.company.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }

  const [rawResult, recruitmentResult, agentsResult, attemptsResult, receiptsResult] = await Promise.all([
    requestControlPlaneSDK<unknown>(client.companyProject.get({ projectID })),
    requestControlPlaneSDK<unknown>(
      client.company.recruitment.snapshot({ company_id: state.company.id, project_id: projectID }),
    ),
    requestControlPlaneSDK<unknown>(client.company.agents({ company_id: state.company.id })),
    requestControlPlaneSDK<unknown>(client.companyProject.attempts({ projectID })),
    requestControlPlaneSDK<unknown>(client.companyProject.receipts({ projectID })),
  ])
  if (!rawResult.ok) throw createError({ statusCode: 404, statusMessage: "Project was not found" })
  const raw = rawResult.value
  const recruitmentRaw = recruitmentResult.ok ? recruitmentResult.value : {}
  const agentsRaw = agentsResult.ok ? agentsResult.value : []
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
      activePlanVersion:
        typeof raw.project.active_plan_version === "number" && Number.isInteger(raw.project.active_plan_version)
          ? raw.project.active_plan_version
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
    workAttempts: records(attemptsResult.ok ? attemptsResult.value : raw.work_attempts).map((attempt) => ({
      id: text(attempt.id),
      workItemID: text(attempt.work_item_id),
      agentRunID: text(attempt.agent_run_id) || undefined,
      ordinal: number(attempt.ordinal),
      status: text(attempt.status),
      failureKind: text(attempt.failure_kind) || undefined,
      summary: text(attempt.safe_summary) || undefined,
      startedAt: number(attempt.started_at),
      finishedAt: typeof attempt.finished_at === "number" ? attempt.finished_at : undefined,
    })),
    workReceipts: records(receiptsResult.ok ? receiptsResult.value : raw.work_receipts).map((receipt) => ({
      id: text(receipt.id),
      workItemID: text(receipt.work_item_id),
      attemptID: text(receipt.attempt_id),
      outcome: text(receipt.outcome),
      summary: text(receipt.summary),
      processingStatus: text(receipt.processing_status),
      artifactIDs: list(receipt.artifact_ids),
      evidenceRefs: records(receipt.evidence_refs).map((reference) => ({
        kind: text(reference.kind),
        id: text(reference.id),
      })),
      confirmedFacts: list(receipt.confirmed_facts),
      unknowns: list(receipt.unknowns),
      blockers: list(receipt.blockers),
      capabilityGaps: list(receipt.capability_gaps),
      createdAt: number(receipt.created_at),
      processedAt: typeof receipt.processed_at === "number" ? receipt.processed_at : undefined,
    })),
    agentRuns: records(raw.agent_runs).map((run) => ({
      id: text(run.id),
      agentID: text(run.agentID),
      workItemID: text(run.workItemID) || undefined,
      runtime: text(run.runtime),
      runtimeVersion: text(run.runtimeVersion) || undefined,
      capabilityChecksum: text(run.capabilityChecksum) || undefined,
      model: text(run.model) || undefined,
      state: text(run.state),
      permissionMode: text(run.permissionMode),
      safeErrorSummary: text(run.safeErrorSummary) || undefined,
      startedAt: record(run.time) && typeof run.time.started === "number" ? run.time.started : undefined,
      finishedAt: record(run.time) && typeof run.time.finished === "number" ? run.time.finished : undefined,
    })),
    usage: record(raw.usage) && record(raw.usage.observedTokens)
      ? {
          runCount: number(raw.usage.runCount),
          total: number(raw.usage.observedTokens.total),
          input: number(raw.usage.observedTokens.input),
          output: number(raw.usage.observedTokens.output),
          reasoning: number(raw.usage.observedTokens.reasoning),
          cacheRead: number(raw.usage.observedTokens.cacheRead),
          cacheWrite: number(raw.usage.observedTokens.cacheWrite),
          cost: number(raw.usage.observedTokens.cost),
          workItems: records(raw.usage.workItems).map((item) => ({
            workItemID: text(item.workItemID),
            runIDs: list(item.runIDs),
            models: list(item.models),
            total: record(item.observedTokens) ? number(item.observedTokens.total) : 0,
            cost: record(item.observedTokens) ? number(item.observedTokens.cost) : 0,
          })),
        }
      : undefined,
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
