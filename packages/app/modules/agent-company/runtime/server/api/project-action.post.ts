import { ExperienceWorkActionRequest } from "@agents-company/shared/experience"
import { createError, getRouterParam, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
  const parsed = ExperienceWorkActionRequest.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "工作动作无效" })

  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const result = await requestControlPlaneSDK(
    client.experience.work.action({ projectID, body: parsed.data }),
  )
  if (result.ok) return result.value
  throw createError({
    statusCode: result.failure.statusCode ?? 503,
    statusMessage: "工作动作未被本地服务接受",
  })
})
