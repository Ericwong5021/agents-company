import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

const Input = z
  .object({
    thread_id: z.string().min(1),
    request_id: z.string().uuid(),
    charter: z
      .object({
        title: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1),
        deliverables: z.array(z.string().trim().min(1)).min(1),
        acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
        scope: z.array(z.string().trim().min(1)).min(1),
        non_goals: z.array(z.string().trim().min(1)).min(1),
        constraints: z.array(z.string().trim().min(1)).min(1),
        resources: z
          .array(
            z
              .object({
                kind: z.enum(["file", "application", "web", "data", "repository", "other"]),
                scope: z.string().trim().min(1),
                disposition: z.string().trim().min(1),
              })
              .strict(),
          )
          .min(1),
        risks: z.array(
          z
            .object({
              description: z.string().trim().min(1),
              mitigation: z.string().trim().min(1),
            })
            .strict(),
        ),
        dri_agent_id: z.string().trim().min(1),
        milestones: z.array(z.string().trim().min(1)).min(1),
        open_decisions: z.array(z.string().trim().min(1)).max(0),
      })
      .strict(),
  })
  .strict()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Charter 未满足正式下达条件" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const state = await ofetch<unknown>(new URL("/company", baseURL).toString(), { headers })
  if (!record(state) || !record(state.company) || typeof state.company.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }

  const response = await ofetch.raw<unknown>(
    new URL(
      `/company/threads/${encodeURIComponent(parsed.data.thread_id)}/actions?company_id=${encodeURIComponent(state.company.id)}`,
      baseURL,
    ).toString(),
    {
      method: "POST",
      headers,
      body: {
        kind: "decide",
        request_id: parsed.data.request_id,
        charter: parsed.data.charter,
      },
      ignoreResponseError: true,
    },
  )
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
