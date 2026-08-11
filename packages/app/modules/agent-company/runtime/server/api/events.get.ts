import { createError, setResponseHeaders } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneRequestURL } from "../utils/control-plane-client"

// WORK-06 — SSE 事件流代理：把 Control Plane 的 GET /event 原样转发给浏览器
// EventSource。上游不可用时按真实状态码抛错（EventSource 会自动重试），
// 不提供假心跳、不伪造 server.connected。

export default defineAgentCompanyHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const target = controlPlaneRequestURL(config.agentCompanyControlPlaneUrl, "/event")
  if (!target) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })

  // 浏览器断开订阅时中止上游连接，避免残留挂起的事件流。
  const controller = new AbortController()
  event.node.req.on("close", () => controller.abort())

  const upstream = await fetch(target, {
    headers: {
      accept: "text/event-stream",
      ...(typeof event.node.req.headers["last-event-id"] === "string"
        ? { "last-event-id": event.node.req.headers["last-event-id"] }
        : {}),
      ...(config.agentCompanyControlPlaneAuthorization
        ? { authorization: config.agentCompanyControlPlaneAuthorization }
        : {}),
    },
    signal: controller.signal,
  }).catch(() => undefined)
  if (!upstream?.ok || !upstream.body) {
    throw createError({ statusCode: upstream?.status ?? 502, statusMessage: "Control Plane 事件流不可用" })
  }

  setResponseHeaders(event, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  return upstream.body
})
