import {
  GoalBriefProjectView,
  type GoalBriefProjectView as GoalBriefProjectViewValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL, requestControlPlane } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(
  async (event): Promise<GoalBriefProjectViewValue> => {
    const projectID = getRouterParam(event, "projectID")
    if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })

    const config = useRuntimeConfig(event)
    const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
    if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })

    const result = await requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/experience/goal-brief/project/${encodeURIComponent(projectID)}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    )
    if (!result.ok) {
      if (result.failure.statusCode === 404) {
        throw createError({ statusCode: 404, statusMessage: "目标摘要不存在" })
      }
      if (result.failure.kind === "authorization_required") {
        throw createError({ statusCode: 401, statusMessage: "读取目标摘要需要重新授权" })
      }
      throw createError({ statusCode: 503, statusMessage: "目标摘要暂时不可用" })
    }

    const parsed = GoalBriefProjectView.safeParse(result.value)
    if (parsed.success) return parsed.data
    throw createError({ statusCode: 502, statusMessage: "目标摘要响应无法识别" })
  },
)
