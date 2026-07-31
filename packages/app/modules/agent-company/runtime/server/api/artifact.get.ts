import {
  ExperienceArtifactView,
  type ExperienceArtifactView as ExperienceArtifactViewValue,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL, requestControlPlane } from "../utils/control-plane-client"
import { sanitizeAttemptFailureContent } from "../../shared/execution-diagnostics"

export default defineAgentCompanyHandler(async (event): Promise<ExperienceArtifactViewValue> => {
  const projectID = getRouterParam(event, "projectID")
  const artifactID = getRouterParam(event, "artifactID")
  if (!projectID || !artifactID) throw createError({ statusCode: 400, statusMessage: "成果地址无效" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "本地服务配置不可用" })

  const result = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    `/experience/projects/${encodeURIComponent(projectID)}/artifacts/${encodeURIComponent(artifactID)}`,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!result.ok) {
    if (result.failure.statusCode === 404) {
      throw createError({ statusCode: 404, statusMessage: "没有找到这项成果" })
    }
    if (result.failure.statusCode === 422) {
      throw createError({ statusCode: 422, statusMessage: "这项成果暂时无法安全读取" })
    }
    if (result.failure.kind === "authorization_required") {
      throw createError({ statusCode: 401, statusMessage: "读取成果需要重新授权" })
    }
    throw createError({ statusCode: 503, statusMessage: "成果暂时不可用" })
  }

  const parsed = ExperienceArtifactView.safeParse(result.value)
  if (!parsed.success || parsed.data.projectId !== projectID || parsed.data.id !== artifactID) {
    throw createError({ statusCode: 502, statusMessage: "成果响应无法识别" })
  }
  if (parsed.data.kind !== "attempt_failure" || parsed.data.encoding !== "utf8") return parsed.data
  const content = sanitizeAttemptFailureContent(parsed.data.content)
  return {
    ...parsed.data,
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
  }
})
