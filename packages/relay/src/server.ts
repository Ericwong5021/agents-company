import { randomUUID, timingSafeEqual } from "node:crypto"
import {
  decodeRemoteMessage,
  encodeRemoteMessage,
  remoteMaxChunkBytes,
  remoteMaxRequestBytes,
  remoteProtocolVersion,
  remoteSocketProtocol,
  type RemoteMessage,
} from "@agents-company/shared/remote-access"
import { createBunWebSocket } from "hono/bun"
import { Hono } from "hono"
import { RemoteStore } from "./store"

type RelaySocket = {
  send(value: string): void
  close(code?: number, reason?: string): void
}

type RelayChannel = {
  id: string
  requestId: string
  resolve: (response: Response) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  opened: boolean
  completed: boolean
  sequence: number
  timeout?: ReturnType<typeof setTimeout>
}

type ActiveRuntime = {
  socket: RelaySocket
  deviceId: string
  deviceName: string
  runtimeInstanceId: string
  controlPlaneVersion: string
  connectionEpoch: number
  connectedAt: string
  lastHeartbeatAt: string
  channels: Map<string, RelayChannel>
}

export type RelayOptions = {
  host: string
  port: number
  database: string
  serviceToken: string
  publicURL: string
  allowedHosts: string[]
  release?: string
  sourceCommit?: string
  heartbeatIntervalMs?: number
}

const requestHeaderNames = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "last-event-id",
  "range",
  "x-agent-company-request-id",
])
const responseHeaderNames = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "x-accel-buffering",
])

function sameSecret(left: string, right: string) {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

function bearer(value?: string) {
  return value?.startsWith("Bearer ") ? value.slice(7) : ""
}

function publicHeaders(headers: Headers) {
  return Object.fromEntries([...headers].filter(([name]) => requestHeaderNames.has(name.toLowerCase())))
}

function responseHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => responseHeaderNames.has(name.toLowerCase())))
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  })
}

function requestErrorStatus(error: string) {
  if (error === "unauthorized") return 401
  if (error === "untrusted_host") return 403
  if (error === "not_found") return 404
  if (error === "body_too_large") return 413
  if (error === "runtime_offline") return 503
  if (error === "relay_response_timeout" || error === "relay_stream_idle_timeout") return 504
  return 502
}

function safeDeviceName(value: unknown) {
  if (typeof value !== "string") return "Agent Company Control Plane"
  return (
    value
      .replace(/[\r\n\0]/g, " ")
      .trim()
      .slice(0, 120) || "Agent Company Control Plane"
  )
}

export function createRelay(options: RelayOptions) {
  if (options.serviceToken.length < 32) throw new Error("relay_service_token_too_short")
  const publicURL = new URL(options.publicURL)
  if (publicURL.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(publicURL.hostname)) {
    throw new Error("relay_public_url_must_use_https")
  }
  const store = new RemoteStore(options.database)
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000
  const app = new Hono()
  const bunWebSocket = createBunWebSocket()
  const authorizationLimits = new Map<string, { count: number; resetAt: number }>()
  let runtime: ActiveRuntime | undefined
  let connectionEpoch = 0

  const trustedHost = (value?: string) => {
    if (!value || value.includes("/") || value.includes("\\")) return false
    const hostname = new URL(`http://${value}`).hostname.toLowerCase()
    return (
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname) ||
      options.allowedHosts.includes(value.toLowerCase()) ||
      options.allowedHosts.includes(hostname)
    )
  }

  app.use("*", async (context, next) => {
    if (!trustedHost(context.req.header("host"))) return context.json({ error: "untrusted_host" }, 403)
    await next()
  })

  app.get("/healthz", () =>
    json({
      ok: true,
      name: "Agent Company Relay",
      protocol_version: remoteProtocolVersion,
      release: options.release ?? "development",
      source_commit: options.sourceCommit ?? "unknown",
      runtime_connected: Boolean(runtime),
    }),
  )

  app.post("/api/v1/remote/device-authorizations", async (context) => {
    const client = context.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "direct"
    const current = authorizationLimits.get(client)
    if (current && current.resetAt > Date.now() && current.count >= 10)
      return json({ error: "authorization_rate_limited" }, 429)
    authorizationLimits.set(
      client,
      current && current.resetAt > Date.now()
        ? { count: current.count + 1, resetAt: current.resetAt }
        : { count: 1, resetAt: Date.now() + 10 * 60 * 1000 },
    )
    const body: Record<string, unknown> = await context.req.json<Record<string, unknown>>().catch(() => ({}))
    const authorization = store.createAuthorization(safeDeviceName(body.name))
    return json(
      {
        ...authorization,
        approval_url: new URL(
          `/remote/device-authorizations/${encodeURIComponent(authorization.authorization_id)}?code=${encodeURIComponent(authorization.user_code)}`,
          publicURL,
        ).toString(),
      },
      201,
    )
  })

  app.get("/api/v1/remote/device-authorizations/:id", (context) => {
    const authorization = store.authorization(context.req.param("id"), context.req.query("code") ?? "")
    if (!authorization) return json({ error: "authorization_not_found" }, 404)
    return json({
      status: authorization.status,
      device_name: authorization.device_name,
      expires_at: authorization.expires_at,
    })
  })

  app.post("/api/v1/remote/device-authorizations/:id/token", async (context) => {
    const body: Record<string, unknown> = await context.req.json<Record<string, unknown>>().catch(() => ({}))
    const credential = store.consumeAuthorization(context.req.param("id"), String(body.user_code ?? ""))
    if (!credential) return json({ status: "pending" }, 202)
    return json({ status: "approved", ...credential })
  })

  app.post("/api/v1/remote/devices/:id/revoke", (context) => {
    const device = store.deviceForToken(context.req.param("id"), bearer(context.req.header("authorization")))
    if (!device) return json({ error: "unauthorized" }, 401)
    store.revokeDevice(device.id)
    if (runtime?.deviceId === device.id) runtime.socket.close(4003, "device_revoked")
    return json({ revoked: true })
  })

  app.post("/api/v1/remote/internal/device-authorizations/:id/approve", async (context) => {
    if (!sameSecret(bearer(context.req.header("authorization")), options.serviceToken))
      return json({ error: "unauthorized" }, 401)
    const body: Record<string, unknown> = await context.req.json<Record<string, unknown>>().catch(() => ({}))
    return json(store.approveAuthorization(context.req.param("id"), String(body.user_code ?? "")))
  })

  app.get("/api/v1/remote/internal/devices", (context) => {
    if (!sameSecret(bearer(context.req.header("authorization")), options.serviceToken))
      return json({ error: "unauthorized" }, 401)
    return json({ devices: store.devices() })
  })

  app.get("/api/v1/remote/internal/status", (context) => {
    if (!sameSecret(bearer(context.req.header("authorization")), options.serviceToken))
      return json({ error: "unauthorized" }, 401)
    return json({
      runtime: runtime
        ? {
            connected: true,
            device_id: runtime.deviceId,
            device_name: runtime.deviceName,
            runtime_instance_id: runtime.runtimeInstanceId,
            control_plane_version: runtime.controlPlaneVersion,
            connection_epoch: runtime.connectionEpoch,
            connected_at: runtime.connectedAt,
            last_heartbeat_at: runtime.lastHeartbeatAt,
            active_channels: runtime.channels.size,
          }
        : { connected: false },
    })
  })

  app.post("/api/v1/remote/internal/devices/:id/revoke", (context) => {
    if (!sameSecret(bearer(context.req.header("authorization")), options.serviceToken))
      return json({ error: "unauthorized" }, 401)
    store.revokeDevice(context.req.param("id"))
    if (runtime?.deviceId === context.req.param("id")) runtime.socket.close(4003, "device_revoked")
    return json({ revoked: true })
  })

  const identity = () => {
    if (!runtime) throw new Error("runtime_offline")
    return {
      protocol_version: remoteProtocolVersion,
      device_id: runtime.deviceId,
      runtime_instance_id: runtime.runtimeInstanceId,
      connection_epoch: runtime.connectionEpoch,
    } as const
  }

  const send = (message: RemoteMessage) => {
    if (!runtime) throw new Error("runtime_offline")
    runtime.socket.send(encodeRemoteMessage(message))
  }

  const finishChannel = (channel: RelayChannel) => {
    if (channel.completed) return
    channel.completed = true
    if (channel.timeout) clearTimeout(channel.timeout)
    runtime?.channels.delete(channel.id)
  }

  const armChannelTimeout = (channel: RelayChannel, error: string, duration: number) => {
    if (channel.timeout) clearTimeout(channel.timeout)
    channel.timeout = setTimeout(() => {
      const current = runtime?.channels.get(channel.id)
      if (!current) return
      send({ type: "request_cancel", ...identity(), channel_id: channel.id, reason: error })
      failChannel(current, error)
    }, duration)
  }

  const failChannel = (channel: RelayChannel, error: string) => {
    if (channel.completed) return
    if (!channel.opened) channel.resolve(json({ error, request_id: channel.requestId }, requestErrorStatus(error)))
    else channel.controller?.error(new Error(error))
    finishChannel(channel)
  }

  const closeRuntime = (active: ActiveRuntime, detail: string) => {
    if (runtime !== active) return
    runtime = undefined
    active.channels.forEach((channel) => failChannel(channel, "relay_stream_interrupted"))
    store.audit(active.deviceId, "runtime_disconnected", detail)
  }

  const handleRuntimeMessage = (socket: RelaySocket, raw: string) => {
    const message = decodeRemoteMessage(raw)
    if (message.type === "hello") {
      const device = store.deviceForToken(message.device_id, message.device_token)
      if (!device) {
        socket.close(4003, "unauthorized")
        return
      }
      if (runtime) {
        const previous = runtime
        previous.socket.close(4001, "connection_replaced")
        closeRuntime(previous, "connection_replaced")
      }
      connectionEpoch += 1
      const timestamp = new Date().toISOString()
      runtime = {
        socket,
        deviceId: device.id,
        deviceName: device.name,
        runtimeInstanceId: message.runtime_instance_id,
        controlPlaneVersion: message.control_plane_version,
        connectionEpoch,
        connectedAt: timestamp,
        lastHeartbeatAt: timestamp,
        channels: new Map(),
      }
      store.audit(device.id, "runtime_connected", `epoch:${connectionEpoch}`)
      send({
        type: "hello_ack",
        ...identity(),
        heartbeat_interval_ms: heartbeatIntervalMs,
        max_request_bytes: remoteMaxRequestBytes,
      })
      return
    }
    const active = runtime
    if (!active || active.socket !== socket) throw new Error("runtime_connection_replaced")
    if (
      message.device_id !== active.deviceId ||
      message.runtime_instance_id !== active.runtimeInstanceId ||
      message.connection_epoch !== active.connectionEpoch
    ) {
      throw new Error("runtime_identity_mismatch")
    }
    if (message.type === "heartbeat") {
      active.lastHeartbeatAt = message.timestamp
      send({ type: "heartbeat_ack", ...identity(), timestamp: new Date().toISOString() })
      return
    }
    if (message.type === "response_open") {
      const channel = active.channels.get(message.channel_id)
      if (!channel || channel.opened) return
      channel.opened = true
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          channel.controller = controller
        },
        cancel() {
          if (!channel.completed) {
            send({ type: "request_cancel", ...identity(), channel_id: channel.id, reason: "web_request_cancelled" })
            finishChannel(channel)
          }
        },
      })
      channel.resolve(new Response(stream, { status: message.status, headers: responseHeaders(message.headers) }))
      armChannelTimeout(channel, "relay_stream_idle_timeout", 45_000)
      return
    }
    if (message.type === "response_chunk") {
      const channel = active.channels.get(message.channel_id)
      if (!channel || !channel.opened || channel.sequence !== message.sequence)
        throw new Error("response_sequence_invalid")
      channel.sequence += 1
      channel.controller?.enqueue(Buffer.from(message.data, "base64"))
      armChannelTimeout(channel, "relay_stream_idle_timeout", 45_000)
      return
    }
    if (message.type === "response_end") {
      const channel = active.channels.get(message.channel_id)
      if (!channel) return
      channel.controller?.close()
      finishChannel(channel)
      return
    }
    if (message.type === "response_error") {
      const channel = active.channels.get(message.channel_id)
      if (channel) failChannel(channel, message.error)
      return
    }
    throw new Error("unexpected_runtime_message")
  }

  app.get(
    "/api/v1/remote/connect",
    bunWebSocket.upgradeWebSocket((context) => {
      if (
        context.req
          .header("sec-websocket-protocol")
          ?.split(",")
          .map((value) => value.trim())
          .includes(remoteSocketProtocol) !== true
      ) {
        throw new Error("remote_protocol_required")
      }
      let socket: RelaySocket | undefined
      return {
        onOpen(_event, value) {
          socket = value
        },
        onMessage(event) {
          if (!socket) return
          if (typeof event.data !== "string") {
            socket.close(1003, "text_frames_required")
            return
          }
          try {
            handleRuntimeMessage(socket, event.data)
          } catch (error) {
            store.audit("runtime", "protocol_error", error instanceof Error ? error.message : "protocol_error")
            socket.close(1008, "protocol_error")
          }
        },
        onClose(_event) {
          if (!socket) return
          if (runtime?.socket === socket) closeRuntime(runtime, "socket_closed")
        },
        onError(_event) {
          if (!socket) return
          if (runtime?.socket === socket) closeRuntime(runtime, "socket_error")
        },
      }
    }),
  )

  app.all("*", async (context) => {
    if (!sameSecret(bearer(context.req.header("authorization")), options.serviceToken))
      return json({ error: "unauthorized" }, 401)
    const active = runtime
    if (!active) return json({ error: "runtime_offline" }, 503)
    const method = context.req.method.toUpperCase()
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      return json({ error: "method_not_allowed" }, 405)
    const channelId = randomUUID()
    const requestId = context.req.header("x-agent-company-request-id") ?? randomUUID()
    const target = new URL(context.req.url)
    const response = new Promise<Response>((resolve) => {
      const channel: RelayChannel = {
        id: channelId,
        requestId,
        resolve,
        opened: false,
        completed: false,
        sequence: 0,
      }
      active.channels.set(channelId, channel)
      armChannelTimeout(channel, "relay_response_timeout", 120_000)
      send({
        type: "request_open",
        ...identity(),
        channel_id: channelId,
        request_id: requestId,
        method: method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: `${target.pathname}${target.search}`,
        headers: publicHeaders(context.req.raw.headers),
      })
      void (async () => {
        const reader = context.req.raw.body?.getReader()
        let sequence = 0
        let bytes = 0
        if (reader) {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > remoteMaxRequestBytes) throw new Error("body_too_large")
            armChannelTimeout(channel, "relay_response_timeout", 120_000)
            for (let offset = 0; offset < next.value.byteLength; offset += remoteMaxChunkBytes) {
              const chunk = next.value.subarray(offset, Math.min(next.value.byteLength, offset + remoteMaxChunkBytes))
              send({
                type: "request_chunk",
                ...identity(),
                channel_id: channelId,
                sequence,
                data: Buffer.from(chunk).toString("base64"),
              })
              sequence += 1
            }
          }
        }
        send({ type: "request_end", ...identity(), channel_id: channelId })
      })().catch((error) => {
        if (!channel.completed && runtime === active)
          send({ type: "request_cancel", ...identity(), channel_id: channelId, reason: "request_stream_error" })
        failChannel(channel, error instanceof Error ? error.message : "request_stream_error")
      })
      context.req.raw.signal.addEventListener("abort", () => {
        if (channel.completed || runtime !== active) return
        send({ type: "request_cancel", ...identity(), channel_id: channelId, reason: "web_request_aborted" })
        finishChannel(channel)
      })
    })
    return response
  })

  const heartbeat = setInterval(
    () => {
      if (!runtime) return
      if (Date.now() - Date.parse(runtime.lastHeartbeatAt) <= heartbeatIntervalMs * 3) return
      const active = runtime
      active.socket.close(4004, "heartbeat_timeout")
      closeRuntime(active, "heartbeat_timeout")
    },
    Math.min(5_000, heartbeatIntervalMs),
  )

  return {
    app,
    websocket: bunWebSocket.websocket,
    store,
    runtime: () => runtime,
    close() {
      clearInterval(heartbeat)
      runtime?.socket.close(1001, "relay_shutdown")
      store.close()
    },
  }
}

export function relayOptions(): RelayOptions {
  const port = Number(process.env.AGENT_COMPANY_RELAY_PORT ?? 4318)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_relay_port")
  return {
    host: process.env.AGENT_COMPANY_RELAY_HOST ?? "127.0.0.1",
    port,
    database: process.env.AGENT_COMPANY_RELAY_DB ?? "./data/agent-company-relay.db",
    serviceToken: process.env.AGENT_COMPANY_RELAY_SERVICE_TOKEN ?? "",
    publicURL: process.env.AGENT_COMPANY_RELAY_PUBLIC_URL ?? "http://127.0.0.1:4318",
    allowedHosts: (process.env.AGENT_COMPANY_RELAY_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    release: process.env.AGENT_COMPANY_RELEASE,
    sourceCommit: process.env.AGENT_COMPANY_SOURCE_COMMIT,
  }
}
