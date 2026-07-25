import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineAgentCompanyHandler(async (event) => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "Project ID is required" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const state = await ofetch<unknown>(new URL("/company", baseURL).toString(), { headers })
  const repository =
    record(state) && record(state.company) && record(state.company.repository) ? state.company.repository : undefined
  if (!repository || typeof repository.root_path !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Company repository is not ready" })
  }

  const target = new URL(`/company-project/${encodeURIComponent(projectID)}/retry`, baseURL)
  target.searchParams.set("directory", repository.root_path)
  const response = await ofetch.raw<unknown>(target.toString(), {
    method: "POST",
    headers,
    body: {},
    ignoreResponseError: true,
  })
  if (!response.ok) {
    const data = record(response._data) ? response._data : undefined
    const details = data && record(data.data) ? data.data : undefined
    throw createError({
      statusCode: response.status,
      statusMessage:
        (details && typeof details.message === "string" && details.message) ||
        (data && typeof data.message === "string" && data.message) ||
        response.statusText ||
        "Control Plane request failed",
      data: response._data,
    })
  }
  return response._data
})
