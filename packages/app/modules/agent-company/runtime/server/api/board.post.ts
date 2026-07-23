import { createError, defineEventHandler, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"

const Input = z.object({
  request_id: z.string().uuid(),
  body: z.string().trim().min(1).max(20_000),
}).strict()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineEventHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid board message" })

  const config = useRuntimeConfig(event)
  const baseURL = new URL(config.agentCompanyControlPlaneUrl)
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const request = <T>(path: string, options?: Record<string, unknown>) =>
    ofetch<T>(new URL(path, baseURL).toString(), { headers, ...options })
  const state = await request<unknown>("/company")
  if (!record(state) || state.state !== "ready" || !record(state.company)) {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }

  const companyID = typeof state.company.id === "string" ? state.company.id : ""
  if (!companyID) throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  if (!record(state.company.provider)) {
    await request("/company/setup-goal", { method: "PUT", body: { body: parsed.data.body } })
    throw createError({
      statusCode: 409,
      statusMessage: "Provider is not configured",
      data: { kind: "provider_required" },
    })
  }

  const channels = await request<unknown>(`/company/channels?company_id=${encodeURIComponent(companyID)}`)
  const board = Array.isArray(channels)
    ? channels.find((channel) => record(channel) && channel.kind === "board" && typeof channel.id === "string")
    : undefined
  if (!record(board) || typeof board.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Board channel is unavailable" })
  }

  return request(`/company/channels/${encodeURIComponent(board.id)}/messages?company_id=${encodeURIComponent(companyID)}`, {
    method: "POST",
    body: {
      request_id: parsed.data.request_id,
      body: parsed.data.body,
      mentions: [],
    },
  })
})
