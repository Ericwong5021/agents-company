import {
  GoalBriefAppendRequest,
  type ExperienceApiError,
  type GoalBrief,
} from "@agents-company/shared/experience"
import { createError, getRouterParam, readBody, setResponseStatus } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"
import { parseGoalBriefAppendResponse } from "../../shared/goal-brief-view"

export default defineAgentCompanyHandler(
  async (event): Promise<GoalBrief | ExperienceApiError> => {
    const briefID = getRouterParam(event, "briefID")
    if (!briefID) throw createError({ statusCode: 400, statusMessage: "缺少 Goal Brief 标识" })

    const input = GoalBriefAppendRequest.safeParse(await readBody(event))
    if (!input.success) throw createError({ statusCode: 400, statusMessage: "目标摘要修改不完整" })

    const config = useRuntimeConfig(event)
    const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
    if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
    const result = await ofetch
      .raw<unknown>(
        new URL(`/experience/goal-brief/${encodeURIComponent(briefID)}/versions`, baseURL).toString(),
        {
          method: "POST",
          headers: config.agentCompanyControlPlaneAuthorization
            ? { authorization: config.agentCompanyControlPlaneAuthorization }
            : undefined,
          body: input.data,
          ignoreResponseError: true,
          retry: 0,
          timeout: 30_000,
        },
      )
      .then(
        (response) => ({ ok: true as const, response }),
        () => ({ ok: false as const }),
      )
    if (!result.ok) throw createError({ statusCode: 503, statusMessage: "目标摘要服务暂时不可用" })

    const response = parseGoalBriefAppendResponse(result.response.status, result.response._data)
    if (!response) {
      if (result.response.status === 401 || result.response.status === 403) {
        throw createError({ statusCode: 401, statusMessage: "修改目标摘要需要重新授权" })
      }
      throw createError({ statusCode: 502, statusMessage: "目标摘要响应无法识别" })
    }
    if (response.kind === "success") return response.brief
    setResponseStatus(event, response.kind === "not_found" ? 404 : 409)
    return response.kind === "not_found"
      ? { code: "not_found", message: "Goal Brief 不存在" }
      : { code: "version_conflict", message: "Goal Brief 已被其他修改更新", currentVersion: response.currentVersion }
  },
)
