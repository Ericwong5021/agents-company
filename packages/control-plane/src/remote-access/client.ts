import { randomUUID } from "node:crypto"
import {
  decodeRemoteMessage,
  encodeRemoteMessage,
  remoteMaxChunkBytes,
  remoteProtocolVersion,
  remoteSocketProtocol,
  type RemoteMessage,
} from "@agents-company/shared/remote-access"
import { InstallationVersion } from "../installation/version"
import { Server, type BasicCredentials } from "../server/server"
import { readRemoteAccessConfig, RemoteAccessPaths, type RemoteAccessConfig } from "./config"

type Identity = {
  protocol_version: typeof remoteProtocolVersion
  device_id: string
  runtime_instance_id: string
  connection_epoch: number
}

type RequestChannel = {
  writer?: WritableStreamDefaultWriter<Uint8Array>
  controller: AbortController
  sequence: number
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

function requestHeaders(headers: Record<string, string>, credentials?: BasicCredentials) {
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => requestHeaderNames.has(name.toLowerCase()))),
    ...(credentials ? { authorization: Server.authorization(credentials) } : {}),
  }
}

function responseHeaders(headers: Headers) {
  return Object.fromEntries([...headers].filter(([name]) => responseHeaderNames.has(name.toLowerCase())))
}

function socketURL(relayURL: string) {
  const url = new URL("/api/v1/remote/connect", relayURL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

export class RemoteAccessClient {
  private runtimeInstanceId = randomUUID()
  private socket?: WebSocket
  private identity?: Identity
  private config?: RemoteAccessConfig
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private configTimer?: ReturnType<typeof setInterval>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private reconnectAttempt = 0
  private channels = new Map<string, RequestChannel>()
  private stopped = false

  constructor(
    private localURL: URL,
    private credentials?: BasicCredentials,
  ) {}

  async start() {
    this.stopped = false
    await this.refreshConfig()
    this.configTimer = setInterval(() => void this.refreshConfig(), 2_000)
  }

  stop() {
    this.stopped = true
    if (this.configTimer) clearInterval(this.configTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.socket?.close(1000, "control_plane_shutdown")
    this.channels.forEach((channel) => channel.controller.abort())
    this.channels.clear()
  }

  private async refreshConfig() {
    const config = await readRemoteAccessConfig()
    if (!config) {
      if (this.config) this.disconnect("remote_access_disabled")
      this.config = undefined
      await this.writeStatus({ connected: false, configured: false })
      return
    }
    const changed = JSON.stringify(config) !== JSON.stringify(this.config)
    this.config = config
    if (changed) this.disconnect("remote_access_reconfigured")
    if (!this.socket && !this.reconnectTimer) this.connect()
  }

  private connect() {
    if (this.stopped || !this.config || this.socket) return
    const config = this.config
    const socket = new WebSocket(socketURL(config.relay_url), remoteSocketProtocol)
    this.socket = socket
    void this.writeStatus({ connected: false, configured: true, relay_url: config.relay_url, connecting: true })
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return
      socket.send(
        encodeRemoteMessage({
          type: "hello",
          protocol_version: remoteProtocolVersion,
          device_id: config.device_id,
          device_token: config.device_token,
          runtime_instance_id: this.runtimeInstanceId,
          control_plane_version: InstallationVersion,
        }),
      )
    })
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return
      Promise.resolve()
        .then(() => this.handleMessage(decodeRemoteMessage(event.data)))
        .catch((error) => {
          void this.writeStatus({
            connected: false,
            configured: true,
            relay_url: config.relay_url,
            error: error instanceof Error ? error.message : "remote_protocol_error",
          })
          socket.close(1008, "protocol_error")
        })
    })
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.identity = undefined
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.channels.forEach((channel) => channel.controller.abort())
      this.channels.clear()
      void this.writeStatus({ connected: false, configured: true, relay_url: config.relay_url })
      this.scheduleReconnect()
    })
    socket.addEventListener("error", () => socket.close())
  }

  private disconnect(reason: string) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close(1000, reason)
    this.socket = undefined
    this.identity = undefined
  }

  private scheduleReconnect() {
    if (this.stopped || !this.config || this.reconnectTimer) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5)) + Math.floor(Math.random() * 500)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private send(message: RemoteMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_socket_offline")
    this.socket.send(encodeRemoteMessage(message))
  }

  private async handleMessage(message: RemoteMessage) {
    if (message.type === "hello_ack") {
      if (
        !this.config ||
        message.device_id !== this.config.device_id ||
        message.runtime_instance_id !== this.runtimeInstanceId
      )
        throw new Error("relay_identity_mismatch")
      this.identity = {
        protocol_version: remoteProtocolVersion,
        device_id: message.device_id,
        runtime_instance_id: message.runtime_instance_id,
        connection_epoch: message.connection_epoch,
      }
      this.reconnectAttempt = 0
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (!this.identity) return
        this.send({
          type: "heartbeat",
          ...this.identity,
          active_channels: this.channels.size,
          timestamp: new Date().toISOString(),
        })
      }, message.heartbeat_interval_ms)
      await this.writeStatus({
        connected: true,
        configured: true,
        relay_url: this.config.relay_url,
        connected_at: new Date().toISOString(),
      })
      return
    }
    if (!this.identity) throw new Error("relay_handshake_required")
    if (message.type === "hello") throw new Error("unexpected_relay_hello")
    if (
      message.device_id !== this.identity.device_id ||
      message.runtime_instance_id !== this.identity.runtime_instance_id ||
      message.connection_epoch !== this.identity.connection_epoch
    )
      throw new Error("relay_identity_mismatch")
    if (message.type === "heartbeat_ack") return
    if (message.type === "request_open") {
      if (this.channels.has(message.channel_id)) throw new Error("request_channel_exists")
      const body = ["GET", "HEAD"].includes(message.method) ? undefined : new TransformStream<Uint8Array, Uint8Array>()
      const channel: RequestChannel = {
        writer: body?.writable.getWriter(),
        controller: new AbortController(),
        sequence: 0,
      }
      this.channels.set(message.channel_id, channel)
      void this.forward(message, channel, body?.readable).catch((error) => {
        if (!this.identity || !this.channels.has(message.channel_id)) return
        this.send({
          type: "response_error",
          ...this.identity,
          channel_id: message.channel_id,
          error: error instanceof Error ? error.message.slice(0, 240) : "local_response_failed",
        })
        this.channels.delete(message.channel_id)
      })
      return
    }
    if (message.type === "request_chunk") {
      const channel = this.channels.get(message.channel_id)
      if (!channel || !channel.writer || channel.sequence !== message.sequence)
        throw new Error("request_sequence_invalid")
      channel.sequence += 1
      await channel.writer.write(Buffer.from(message.data, "base64"))
      return
    }
    if (message.type === "request_end") {
      const channel = this.channels.get(message.channel_id)
      if (!channel) return
      await channel.writer?.close()
      return
    }
    if (message.type === "request_cancel") {
      const channel = this.channels.get(message.channel_id)
      if (!channel) return
      channel.controller.abort(message.reason)
      await channel.writer?.abort(message.reason).catch(() => undefined)
      this.channels.delete(message.channel_id)
      return
    }
    throw new Error("unexpected_relay_message")
  }

  private async forward(
    message: Extract<RemoteMessage, { type: "request_open" }>,
    channel: RequestChannel,
    body?: ReadableStream<Uint8Array>,
  ) {
    if (!this.identity) return
    const identity = this.identity
    const target = new URL(message.path, this.localURL)
    const response = await fetch(target, {
      method: message.method,
      headers: requestHeaders(message.headers, this.credentials),
      body,
      signal: channel.controller.signal,
    }).catch((error) => {
      this.send({
        type: "response_error",
        ...identity,
        channel_id: message.channel_id,
        error: error instanceof Error ? error.message.slice(0, 240) : "local_request_failed",
      })
      return undefined
    })
    if (!response || channel.controller.signal.aborted || !this.channels.has(message.channel_id)) {
      this.channels.delete(message.channel_id)
      return
    }
    this.send({
      type: "response_open",
      ...identity,
      channel_id: message.channel_id,
      status: response.status,
      headers: responseHeaders(response.headers),
    })
    const reader = response.body?.getReader()
    let sequence = 0
    if (reader) {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        for (let offset = 0; offset < next.value.byteLength; offset += remoteMaxChunkBytes) {
          this.send({
            type: "response_chunk",
            ...identity,
            channel_id: message.channel_id,
            sequence,
            data: Buffer.from(
              next.value.subarray(offset, Math.min(next.value.byteLength, offset + remoteMaxChunkBytes)),
            ).toString("base64"),
          })
          sequence += 1
        }
      }
    }
    if (!channel.controller.signal.aborted)
      this.send({ type: "response_end", ...identity, channel_id: message.channel_id })
    this.channels.delete(message.channel_id)
  }

  private async writeStatus(value: Record<string, unknown>) {
    await Bun.write(
      RemoteAccessPaths.status,
      `${JSON.stringify({ ...value, updated_at: new Date().toISOString() }, null, 2)}\n`,
    )
  }
}
