import { createError, getRouterParam, readValidatedBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { AgentInterestProfileRecord } from "@agents-company/sdk/v2"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const Input = z.object({
  topics: z.array(z.string().trim().min(1).max(200)).max(200),
  preferred_lenses: z.array(z.string().trim().min(1).max(300)).max(100),
  excluded_topics: z.array(z.string().trim().min(1).max(200)).max(200),
  novelty_threshold: z.number().min(0).max(1),
  weekly_reading_budget: z.number().int().min(0).max(168),
  max_concurrency: z.number().int().min(1).max(3),
  privacy_scopes: z.array(z.enum(["company", "project", "private"])).min(1).max(3),
}).strict()

export default defineAgentCompanyHandler(async (event): Promise<AgentInterestProfileRecord> => {
  const agentID = getRouterParam(event, "agentID")
  if (!agentID) throw createError({ statusCode: 400, statusMessage: "Reader Agent 不可用" })
  const input = await readValidatedBody(event, Input.parse)
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const result = await requestControlPlaneSDK<AgentInterestProfileRecord>(
    client.companyReading.upsertProfile({
      agentID,
      company_id: access.company_id,
      ...input,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "Reader Interest Profile 未保存",
    })
  return result.value
})
