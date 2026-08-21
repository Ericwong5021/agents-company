import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { companyOperationPage } from "../../shared/company-operations"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { requestControlPlane } from "../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function queryValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const companyResult = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    "/company",
    config.agentCompanyControlPlaneAuthorization || undefined,
    1,
  )
  if (!companyResult.ok || !record(companyResult.value) || !record(companyResult.value.company) || typeof companyResult.value.company.id !== "string")
    throw createError({ statusCode: 503, statusMessage: "公司状态暂时不可用" })
  const query = getQuery(event)
  const target = new URLSearchParams({ company_id: companyResult.value.company.id })
  ;["cursor", "category", "severity", "importance", "project_id", "agent_id", "from", "to", "limit"].forEach((key) => {
    const value = queryValue(query[key])
    if (value) target.set(key, value)
  })
  const result = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    `/company/operations?${target}`,
    config.agentCompanyControlPlaneAuthorization || undefined,
    1,
  )
  if (!result.ok) throw createError({ statusCode: result.failure.statusCode ?? 503, statusMessage: "运营记录暂时不可用" })
  const page = companyOperationPage(result.value)
  if (!page) throw createError({ statusCode: 502, statusMessage: "运营记录响应无法识别" })
  return page
})
