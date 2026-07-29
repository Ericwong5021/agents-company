import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyCommonsSearchResponses } from "@agents-company/sdk/v2"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const Query = z.object({
  q: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export default defineAgentCompanyHandler(async (event): Promise<CompanyCommonsSearchResponses[200]> => {
  const query = Query.safeParse(getQuery(event))
  if (!query.success) throw createError({ statusCode: 400, statusMessage: "搜索条件无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const result = await requestControlPlaneSDK<CompanyCommonsSearchResponses[200]>(
    client.companyCommons.search({
      company_id: access.company_id,
      project_ids: access.project_ids.join(","),
      private_owner_id: access.private_owner_id,
      q: query.data.q,
      limit: query.data.limit,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "Commons 搜索暂时不可用",
    })
  return result.value
})
