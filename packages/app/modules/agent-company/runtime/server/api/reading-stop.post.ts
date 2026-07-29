import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyReadingStopResponses } from "@agents-company/sdk/v2"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<CompanyReadingStopResponses[200]> => {
  const assignmentID = getRouterParam(event, "assignmentID")
  if (!assignmentID) throw createError({ statusCode: 400, statusMessage: "阅读任务 ID 无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const result = await requestControlPlaneSDK<CompanyReadingStopResponses[200]>(
    client.companyReading.stop({ assignmentID, ...access }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "阅读任务未能停止",
    })
  return result.value
})
