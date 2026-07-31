import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyProjectMessage } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"
import {
  projectMessageSummary,
  safeProjectMessageBody,
} from "../../shared/execution-diagnostics"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default defineAgentCompanyHandler(async (event): Promise<CompanyProjectMessage[]> => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const stateResult = await requestControlPlaneSDK<unknown>(client.company.current())
  if (!stateResult.ok || !record(stateResult.value) || !record(stateResult.value.company))
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  const companyID = typeof stateResult.value.company.id === "string" ? stateResult.value.company.id : ""
  if (!companyID) throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  const channelsResult = await requestControlPlaneSDK<unknown>(
    client.company.channels({ company_id: companyID }),
  )
  if (!channelsResult.ok || !Array.isArray(channelsResult.value))
    throw createError({ statusCode: 503, statusMessage: "项目频道暂时不可用" })
  const channel = channelsResult.value.find(
    (entry) =>
      record(entry) &&
      entry.kind === "project" &&
      entry.scopeID === projectID &&
      typeof entry.id === "string",
  )
  if (!record(channel) || typeof channel.id !== "string")
    throw createError({ statusCode: 404, statusMessage: "当前项目没有可用的项目频道" })
  const messagesResult = await requestControlPlaneSDK<unknown>(
    client.company.channelMessages({
      channelID: channel.id,
      company_id: companyID,
      limit: 100,
    }),
  )
  if (!messagesResult.ok || !record(messagesResult.value) || !Array.isArray(messagesResult.value.items))
    throw createError({ statusCode: 503, statusMessage: "项目讨论暂时不可用" })
  return messagesResult.value.items.flatMap((message) => {
    if (!record(message) || !record(message.author) || !record(message.time)) return []
    if (
      typeof message.id !== "string" ||
      typeof message.body !== "string" ||
      typeof message.author.kind !== "string" ||
      typeof message.author.id !== "string" ||
      typeof message.time.created !== "number"
    )
      return []
    return [{
      id: message.id,
      author:
        message.author.kind === "user"
          ? "你"
          : message.author.kind === "system"
            ? "系统"
            : message.author.id,
      ...(() => {
        if (message.author.kind === "user") return { body: message.body }
        const detail = safeProjectMessageBody(message.body)
        const body = projectMessageSummary(detail)
        return body === detail ? { body } : { body, detail }
      })(),
      createdAt: message.time.created,
      signalType: typeof message.signalType === "string" ? message.signalType : undefined,
      sourceThreadID: typeof message.sourceThreadID === "string" ? message.sourceThreadID : undefined,
    }]
  })
})
