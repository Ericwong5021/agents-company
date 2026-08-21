import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { companyOperationItem } from "../../../shared/company-operations"
import { defineAgentCompanyHandler } from "../../utils/authenticated-handler"
import { requestControlPlane } from "../../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineAgentCompanyHandler(async (event) => {
  const operationID = getRouterParam(event, "operationID")
  if (!operationID) throw createError({ statusCode: 400, statusMessage: "Operation ID is required" })
  const config = useRuntimeConfig(event)
  const companyResult = await requestControlPlane<unknown>(config.agentCompanyControlPlaneUrl, "/company", config.agentCompanyControlPlaneAuthorization || undefined, 1)
  if (!companyResult.ok || !record(companyResult.value) || !record(companyResult.value.company) || typeof companyResult.value.company.id !== "string")
    throw createError({ statusCode: 503, statusMessage: "公司状态暂时不可用" })
  const result = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    `/company/operations/${encodeURIComponent(operationID)}?company_id=${encodeURIComponent(companyResult.value.company.id)}`,
    config.agentCompanyControlPlaneAuthorization || undefined,
    1,
  )
  if (!result.ok) throw createError({ statusCode: result.failure.statusCode ?? 503, statusMessage: result.failure.statusCode === 404 ? "未找到这条运营记录" : "运营记录详情暂时不可用" })
  const item = companyOperationItem(result.value)
  if (!item) throw createError({ statusCode: 502, statusMessage: "运营记录详情无法识别" })
  return item
})
