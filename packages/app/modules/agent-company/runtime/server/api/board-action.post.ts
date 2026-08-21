import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reaction"), message_id: z.string().startsWith("cmsg_"), emoji: z.string().min(1).max(16) }).strict(),
  z.object({ kind: z.literal("vote"), message_id: z.string().startsWith("cmsg_"), option_id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("read"), sequence: z.number().int().nonnegative() }).strict(),
  z.object({
    kind: z.literal("poll"),
    request_id: z.string().uuid(),
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(12),
    multiple: z.boolean().default(false),
  }).strict(),
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid board action" })
  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const request = <T>(path: string, options?: Record<string, unknown>) =>
    ofetch<T>(new URL(path, baseURL).toString(), { headers, ...options })
  const state = await request<unknown>("/company")
  if (!record(state) || state.state !== "ready" || !record(state.company) || typeof state.company.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }
  const companyID = state.company.id
  const channels = await request<unknown>(`/company/channels?company_id=${encodeURIComponent(companyID)}`)
  const board = Array.isArray(channels)
    ? channels.find((channel) => record(channel) && channel.kind === "board" && typeof channel.id === "string")
    : undefined
  if (!record(board) || typeof board.id !== "string") {
    throw createError({ statusCode: 503, statusMessage: "Board channel is unavailable" })
  }
  const root = `/company/channels/${encodeURIComponent(board.id)}`
  const query = `company_id=${encodeURIComponent(companyID)}`
  if (parsed.data.kind === "reaction") {
    return request(`${root}/messages/${encodeURIComponent(parsed.data.message_id)}/reactions?${query}`, {
      method: "POST",
      body: { emoji: parsed.data.emoji },
    })
  }
  if (parsed.data.kind === "vote") {
    return request(`${root}/messages/${encodeURIComponent(parsed.data.message_id)}/votes?${query}`, {
      method: "POST",
      body: { option_id: parsed.data.option_id },
    })
  }
  if (parsed.data.kind === "read") {
    await request(`${root}/read-state?${query}`, { method: "POST", body: { sequence: parsed.data.sequence } })
    return { ok: true }
  }
  return request(`${root}/messages?${query}`, {
    method: "POST",
    body: {
      request_id: parsed.data.request_id,
      body: parsed.data.question,
      kind: "poll",
      poll: {
        question: parsed.data.question,
        options: parsed.data.options.map((label, index) => ({ id: `option-${index + 1}`, label })),
        multiple: parsed.data.multiple,
      },
      mentions: [],
      resources: [],
      intent_override: "discuss",
    },
  })
})
