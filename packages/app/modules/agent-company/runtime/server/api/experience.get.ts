import {
  AcceptanceSummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
  type AcceptanceSummary as AcceptanceSummaryValue,
  type GraphChangeSummary as GraphChangeSummaryValue,
  type OrganizationProjection as OrganizationProjectionValue,
  type ValidationSummary as ValidationSummaryValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const projections = {
  acceptance: AcceptanceSummary,
  organization: OrganizationProjection,
  graph: GraphChangeSummary,
  validation: ValidationSummary,
}

export default defineAgentCompanyHandler(
  async (
    event,
  ): Promise<
    AcceptanceSummaryValue | OrganizationProjectionValue | GraphChangeSummaryValue | ValidationSummaryValue
  > => {
    const projectID = getRouterParam(event, "projectID")
    const projection = getRouterParam(event, "projection")
    if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
    if (!projection || !(projection in projections))
      throw createError({ statusCode: 404, statusMessage: "体验投影不存在" })

    const config = useRuntimeConfig(event)
    const client = controlPlaneSDK(
      config.agentCompanyControlPlaneUrl,
      config.agentCompanyControlPlaneAuthorization || undefined,
    )
    if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
    const result = await requestControlPlaneSDK<unknown>(
      projection === "acceptance"
        ? client.experience.work.acceptance({ projectID })
        : projection === "organization"
          ? client.experience.work.organization({ projectID })
          : projection === "graph"
            ? client.experience.work.graph({ projectID })
            : client.experience.work.validation({ projectID }),
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
