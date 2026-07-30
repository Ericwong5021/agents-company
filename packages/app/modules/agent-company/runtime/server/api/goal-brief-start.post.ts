import {
  ExperienceApiError,
  GoalBriefStartRequest,
  GoalBriefStartResult,
  type ExperienceApiError as ExperienceApiErrorValue,
  type GoalBriefStartResult as GoalBriefStartResultValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam, readBody, setResponseStatus } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(
  async (event): Promise<GoalBriefStartResultValue | ExperienceApiErrorValue> => {
    const briefID = getRouterParam(event, "briefID")
    if (!briefID) throw createError({ statusCode: 400, statusMessage: "缺少 Goal Brief 标识" })
    const input = GoalBriefStartRequest.safeParse(await readBody(event))
    if (!input.success) throw createError({ statusCode: 400, statusMessage: "开始执行请求不完整" })
    const config = useRuntimeConfig(event)
    const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
    if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
    const result = await ofetch
      .raw<unknown>(new URL(`/experience/goal-brief/${encodeURIComponent(briefID)}/start`, baseURL).toString(), {
        method: "POST",
        headers: config.agentCompanyControlPlaneAuthorization
          ? { authorization: config.agentCompanyControlPlaneAuthorization }
          : undefined,
        body: input.data,
        ignoreResponseError: true,
        retry: 0,
        timeout: 5 * 60_000,
      })
      .then(
        (response) => ({ ok: true as const, response }),
        () => ({ ok: false as const }),
      )
    if (!result.ok) throw createError({ statusCode: 503, statusMessage: "开始执行服务暂时不可用" })
    if (result.response.status === 200) {
      const response = GoalBriefStartResult.safeParse(result.response._data)
      if (response.success) return response.data
    }
    const error = ExperienceApiError.safeParse(result.response._data)
    if (error.success && [404, 409].includes(result.response.status)) {
      setResponseStatus(event, result.response.status)
      return error.data
    }
    if (result.response.status === 401 || result.response.status === 403)
      throw createError({ statusCode: 401, statusMessage: "开始执行需要重新授权" })
    throw createError({ statusCode: 502, statusMessage: "开始执行响应无法识别" })
  },
)
