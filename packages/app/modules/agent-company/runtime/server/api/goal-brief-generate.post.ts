import {
  GoalBriefGenerateRequest,
  type ExperienceApiError,
  type GoalBrief,
  type GoalBriefStructuredFailure,
} from "@agents-company/shared/experience"
import { createError, readBody, setResponseStatus } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"
import { parseGoalBriefGenerationResponse } from "../../shared/goal-brief-generation"

const Input = GoalBriefGenerateRequest.pick({
  requestId: true,
  goal: true,
}).strict()

export default defineAgentCompanyHandler(
  async (
    event,
  ): Promise<GoalBrief | GoalBriefStructuredFailure | ExperienceApiError> => {
    const input = Input.safeParse(await readBody(event))
    if (!input.success) throw createError({ statusCode: 400, statusMessage: "目标草稿不完整" })

    const config = useRuntimeConfig(event)
    const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
    if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
    const result = await ofetch
      .raw<unknown>(new URL("/experience/goal-brief/generate", baseURL).toString(), {
        method: "POST",
        headers: config.agentCompanyControlPlaneAuthorization
          ? { authorization: config.agentCompanyControlPlaneAuthorization }
          : undefined,
        body: input.data,
        ignoreResponseError: true,
        retry: 0,
        timeout: 160_000,
      })
      .then(
        (response) => ({ ok: true as const, response }),
        () => ({ ok: false as const }),
      )
    if (!result.ok) throw createError({ statusCode: 503, statusMessage: "目标摘要服务暂时不可用" })

    const response = parseGoalBriefGenerationResponse(result.response.status, result.response._data)
    if (!response) {
      if (result.response.status === 401 || result.response.status === 403) {
        throw createError({ statusCode: 401, statusMessage: "生成目标摘要需要重新授权" })
      }
      if (result.response.status >= 500) {
        throw createError({ statusCode: 503, statusMessage: "模型服务连接中断，请稍后重试" })
      }
      throw createError({ statusCode: 502, statusMessage: "目标摘要响应无法识别" })
    }
    if (response.kind === "success") return response.brief
    if (response.kind === "structured_failure") {
      setResponseStatus(event, 422)
      return response.failure
    }
    setResponseStatus(event, 409)
    return response.error
  },
)
