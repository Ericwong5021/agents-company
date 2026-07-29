import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

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

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "Invalid channel message" })

  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const stateResult = await requestControlPlaneSDK<unknown>(client.company.current())
  if (!stateResult.ok) throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  const state = stateResult.value
  if (!record(state) || state.state !== "ready" || !record(state.company)) {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }
  const companyID = typeof state.company.id === "string" ? state.company.id : ""
  if (!companyID) throw createError({ statusCode: 503, statusMessage: "Company is not ready" })

  const channelsResult = await requestControlPlaneSDK<unknown>(
    client.company.channels({ company_id: companyID }),
  )
  if (!channelsResult.ok) throw createError({ statusCode: 503, statusMessage: "项目频道暂时不可用" })
  const channels = channelsResult.value
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

  const result = await requestControlPlaneSDK(
    client.company.channelSend({
      channelID: channel.id,
      company_id: companyID,
      channelSendInput: {
        request_id: parsed.data.request_id,
        body: parsed.data.body,
        mentions: parsed.data.mentions,
      },
    }),
  )
  if (result.ok) return result.value
  throw createError({
    statusCode: result.failure.statusCode ?? 502,
    statusMessage: "消息未被本地服务接受",
  })
})
