import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlane,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  const query = `company_id=${encodeURIComponent(access.company_id)}`
  const [beliefs, experiments, patches, evidencePackage] = await Promise.all([
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company-learning/beliefs?${query}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    ),
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company-learning/experiments?${query}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    ),
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company-learning/patches?${query}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    ),
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company-learning/evidence-package?${query}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    ),
  ])
  if (!beliefs.ok || !experiments.ok || !patches.ok || !evidencePackage.ok)
    throw createError({ statusCode: 503, statusMessage: "Learning workspace 暂时不可用" })
  return {
    beliefs: beliefs.value,
    experiments: experiments.value,
    patches: patches.value,
    evidencePackage: evidencePackage.value,
  }
})
