import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

// WORK-04 — 统一消息发送代理：按目标解析公司看板或项目频道，透传真实 mentions
// 与 request_id（幂等由本地服务按请求去重）。上游拒绝时按原状态码如实抛错，
// 不吞错误、不降级为假成功。

const Input = z
  .object({
    request_id: z.string().uuid(),
    body: z.string().trim().min(1).max(20_000),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("board") }).strict(),
      z.object({ kind: z.literal("project"), project_id: z.string().min(1) }).strict(),
    ]),
    mentions: z
      .array(z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }).strict())
      .max(20)
      .default([]),
  })
  .strict()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function upstreamStatus(error: unknown): number | undefined {
  if (!record(error)) return undefined
  if (typeof error.statusCode === "number") return error.statusCode
  if (!record(error.response)) return undefined
  return typeof error.response.status === "number" ? error.response.status : undefined
}

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid channel message" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
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

  const channels = await request<unknown>(`/company/channels?company_id=${encodeURIComponent(companyID)}`)
  const target = parsed.data.target
  const channel = Array.isArray(channels)
    ? channels.find((entry) =>
        record(entry) &&
        typeof entry.id === "string" &&
        (target.kind === "board" ? entry.kind === "board" : entry.kind === "project" && entry.scopeID === target.project_id),
      )
    : undefined
  if (!record(channel) || typeof channel.id !== "string") {
    throw createError({
      statusCode: 404,
      statusMessage: target.kind === "board" ? "Board channel is unavailable" : "当前项目没有可用的项目频道",
    })
  }

  return request(
    `/company/channels/${encodeURIComponent(channel.id)}/messages?company_id=${encodeURIComponent(companyID)}`,
    {
      method: "POST",
      body: {
        request_id: parsed.data.request_id,
        body: parsed.data.body,
        mentions: parsed.data.mentions,
      },
    },
  ).catch((error: unknown) => {
    throw createError({
      statusCode: upstreamStatus(error) ?? 502,
      statusMessage: "消息未被本地服务接受",
    })
  })
})
