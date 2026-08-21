import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { companyOperationSummary } from "../../../shared/company-operations"
import { defineAgentCompanyHandler } from "../../utils/authenticated-handler"
import { requestControlPlane } from "../../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
  const result = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    `/company/operations/summary?company_id=${encodeURIComponent(companyResult.value.company.id)}`,
    config.agentCompanyControlPlaneAuthorization || undefined,
    1,
  )
  if (!result.ok) throw createError({ statusCode: result.failure.statusCode ?? 503, statusMessage: "运营摘要暂时不可用" })
  const summary = companyOperationSummary(result.value)
  if (!summary) throw createError({ statusCode: 502, statusMessage: "运营摘要响应无法识别" })
  return summary
})
