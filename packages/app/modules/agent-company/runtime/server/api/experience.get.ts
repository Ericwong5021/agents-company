import {
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
  type GraphChangeSummary as GraphChangeSummaryValue,
  type OrganizationProjection as OrganizationProjectionValue,
  type ValidationSummary as ValidationSummaryValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL, requestControlPlane } from "../utils/control-plane-client"

const projections = {
  organization: OrganizationProjection,
  graph: GraphChangeSummary,
  validation: ValidationSummary,
}

export default defineAgentCompanyHandler(
  async (
    event,
  ): Promise<OrganizationProjectionValue | GraphChangeSummaryValue | ValidationSummaryValue> => {
    const projectID = getRouterParam(event, "projectID")
    const projection = getRouterParam(event, "projection")
    if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
    if (!projection || !(projection in projections))
      throw createError({ statusCode: 404, statusMessage: "体验投影不存在" })

    const config = useRuntimeConfig(event)
    if (!controlPlaneURL(config.agentCompanyControlPlaneUrl))
      throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })

    const result = await requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/experience/work/${encodeURIComponent(projectID)}/${projection}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    )
    if (!result.ok) {
      if (result.failure.statusCode === 404)
        throw createError({ statusCode: 404, statusMessage: "体验投影不存在" })
      if (result.failure.kind === "authorization_required")
        throw createError({ statusCode: 401, statusMessage: "读取体验投影需要重新授权" })
      throw createError({ statusCode: 503, statusMessage: "体验投影暂时不可用" })
    }

    const parsed = projections[projection as keyof typeof projections].safeParse(result.value)
    if (parsed.success) return parsed.data
    throw createError({ statusCode: 502, statusMessage: "体验投影响应无法识别" })
  },
)
