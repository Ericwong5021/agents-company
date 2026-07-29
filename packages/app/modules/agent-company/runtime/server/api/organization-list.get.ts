import {
  OrganizationProjection,
  WorkProjectionList,
  type OrganizationProjection as OrganizationProjectionValue,
} from "@agents-company/shared/experience"
import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL, requestControlPlane } from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<OrganizationProjectionValue[]> => {
  const config = useRuntimeConfig(event)
  if (!controlPlaneURL(config.agentCompanyControlPlaneUrl))
    throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const read = (path: string) =>
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      path,
      config.agentCompanyControlPlaneAuthorization || undefined,
    )
  const workResult = await read("/experience/work")
  if (!workResult.ok) throw createError({ statusCode: 503, statusMessage: "Work 投影暂时不可用" })
  const work = WorkProjectionList.safeParse(workResult.value)
  if (!work.success) throw createError({ statusCode: 502, statusMessage: "Work 投影响应无法识别" })

  const projectIDs = work.data.items.flatMap((item) =>
    item.availability === "available" ? [item.summary.workId] : [],
  )
  const results = await Promise.all(
    projectIDs.map((projectID) =>
      read(`/experience/work/${encodeURIComponent(projectID)}/organization`),
    ),
  )
  if (results.some((result) => !result.ok))
    throw createError({ statusCode: 503, statusMessage: "组织投影暂时不可用" })
  const projections = results.map((result) =>
    OrganizationProjection.safeParse(result.ok ? result.value : undefined),
  )
  if (projections.some((projection) => !projection.success))
    throw createError({ statusCode: 502, statusMessage: "组织投影响应无法识别" })
  return projections.flatMap((projection) => (projection.success ? [projection.data] : []))
})
