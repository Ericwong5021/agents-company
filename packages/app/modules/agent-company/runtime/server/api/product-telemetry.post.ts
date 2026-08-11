import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import z from "zod"
import {
  metricDefinitionVersion,
  productEventTypes,
  sanitizeEventProps,
} from "../../shared/product-telemetry"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"

const Input = z.object({
  consent: z.literal(true),
  events: z.array(z.object({
    type: z.enum(productEventTypes),
    at: z.string().datetime(),
    version: z.string().min(1).max(100),
    scenario: z.string().max(100).optional(),
    dedupeKey: z.string().max(500).optional(),
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).strict()).min(1).max(100),
}).strict()

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "匿名体验数据无效" })
  const config = useRuntimeConfig(event)
  if (!config.agentCompanyTelemetryUrl) return { reported: false, reason: "not_configured" }
  if (!URL.canParse(config.agentCompanyTelemetryUrl))
    throw createError({ statusCode: 503, statusMessage: "匿名体验数据接收端配置无效" })
  const target = new URL(config.agentCompanyTelemetryUrl)
  if (!["http:", "https:"].includes(target.protocol))
    throw createError({ statusCode: 503, statusMessage: "匿名体验数据接收端配置无效" })
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.agentCompanyTelemetryAuthorization
        ? { authorization: config.agentCompanyTelemetryAuthorization }
        : {}),
    },
    body: JSON.stringify({
      definitionVersion: metricDefinitionVersion,
      events: parsed.data.events.map(item => ({
        type: item.type,
        at: item.at,
        version: item.version,
        scenario: item.scenario,
        props: sanitizeEventProps(item.props),
      })),
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  if (!response?.ok)
    throw createError({ statusCode: 502, statusMessage: "匿名体验数据暂未上报，本地记录不受影响" })
  return { reported: true }
})
