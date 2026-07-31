import {
  WorkProjectionList,
  type WorkProjection,
} from "@agents-company/shared/experience"
import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { requestControlPlane } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<WorkProjection[]> => {
  const config = useRuntimeConfig(event)
  const result = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    "/experience/work/archived",
    config.agentCompanyControlPlaneAuthorization || undefined,
    1,
  )
  if (!result.ok) throw createError({ statusCode: 503, statusMessage: "已归档工作暂时不可用" })
  const parsed = WorkProjectionList.safeParse(result.value)
  if (!parsed.success) throw createError({ statusCode: 502, statusMessage: "已归档工作响应无法识别" })
  return parsed.data.items
})
