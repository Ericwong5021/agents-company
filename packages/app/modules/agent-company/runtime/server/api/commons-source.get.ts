import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyCommonsSourceResponses } from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<CompanyCommonsSourceResponses[200]> => {
  const sourceID = getRouterParam(event, "sourceID")
  if (!sourceID) throw createError({ statusCode: 400, statusMessage: "资料 ID 无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const result = await requestControlPlaneSDK<CompanyCommonsSourceResponses[200]>(
    client.companyCommons.source({
      sourceID,
      company_id: access.company_id,
      project_ids: access.project_ids.join(","),
      private_owner_id: access.private_owner_id,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "资料暂时不可用",
    })
  return result.value
})
