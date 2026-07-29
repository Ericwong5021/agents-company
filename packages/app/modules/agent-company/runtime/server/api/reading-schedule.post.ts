import { createError, readValidatedBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyReadingScheduleResponses } from "@agents-company/sdk/v2"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const Input = z.object({
  source_id: z.string().trim().min(1),
  project_id: z.string().trim().min(1),
}).strict()

export default defineAgentCompanyHandler(async (event): Promise<CompanyReadingScheduleResponses[200]> => {
  const input = await readValidatedBody(event, Input.parse)
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  if (!access.project_ids.includes(input.project_id))
    throw createError({ statusCode: 403, statusMessage: "项目阅读范围不可用" })
  const result = await requestControlPlaneSDK<CompanyReadingScheduleResponses[200]>(
    client.companyReading.schedule({
      ...access,
      ...input,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "阅读任务未能调度",
    })
  return result.value
})
