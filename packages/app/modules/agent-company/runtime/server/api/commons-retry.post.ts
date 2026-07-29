import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CommonsSourceRecord } from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<CommonsSourceRecord> => {
  const sourceID = getRouterParam(event, "sourceID")
  if (!sourceID) throw createError({ statusCode: 400, statusMessage: "资料 ID 无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const result = await requestControlPlaneSDK<CommonsSourceRecord>(
    client.companyCommons.retry({
      sourceID,
      company_id: access.company_id,
      project_ids: access.project_ids,
      private_owner_id: access.private_owner_id,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "资料重试未完成",
    })
  return result.value
})
