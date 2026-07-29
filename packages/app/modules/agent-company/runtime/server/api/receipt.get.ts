import {
  DiscoverySummary,
  type DiscoverySummary as DiscoverySummaryValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<DiscoverySummaryValue> => {
  const projectID = getRouterParam(event, "projectID")
  const receiptID = getRouterParam(event, "receiptID")
  if (!projectID || !receiptID)
    throw createError({ statusCode: 400, statusMessage: "工作或 Receipt ID 无效" })

  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const result = await requestControlPlaneSDK<unknown>(
    client.experience.work.receipt({ projectID, receiptID }),
  )
  if (!result.ok) {
    if (result.failure.statusCode === 404)
      throw createError({ statusCode: 404, statusMessage: "Receipt 投影不存在" })
    if (result.failure.kind === "authorization_required")
      throw createError({ statusCode: 401, statusMessage: "读取 Receipt 投影需要重新授权" })
    throw createError({ statusCode: 503, statusMessage: "Receipt 投影暂时不可用" })
  }

  const parsed = DiscoverySummary.safeParse(result.value)
  if (parsed.success) return parsed.data
  throw createError({ statusCode: 502, statusMessage: "Receipt 投影响应无法识别" })
})
