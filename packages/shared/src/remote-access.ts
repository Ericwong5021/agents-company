import { z } from "zod"

export const remoteProtocolVersion = "agent-company-remote/v1"
export const remoteSocketProtocol = "agent-company-remote-v1"
export const remoteMaxChunkBytes = 64 * 1024
export const remoteMaxFrameBytes = 1024 * 1024
export const remoteMaxRequestBytes = 50 * 1024 * 1024

const Identifier = z.string().trim().min(1).max(200)
const Identity = {
  protocol_version: z.literal(remoteProtocolVersion),
  device_id: Identifier,
  runtime_instance_id: Identifier,
  connection_epoch: z.number().int().positive(),
}

export const RemoteMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol_version: z.literal(remoteProtocolVersion),
    device_id: Identifier,
    device_token: z.string().min(32).max(512),
    runtime_instance_id: Identifier,
    control_plane_version: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("hello_ack"),
    ...Identity,
    heartbeat_interval_ms: z.number().int().min(5_000).max(120_000),
    max_request_bytes: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    ...Identity,
    active_channels: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("heartbeat_ack"),
    ...Identity,
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("request_open"),
    ...Identity,
    channel_id: Identifier,
    request_id: Identifier,
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/").max(8_192),
    headers: z.record(z.string(), z.string().max(16_384)),
  }),
  z.object({
    type: z.literal("request_chunk"),
    ...Identity,
    channel_id: Identifier,
    sequence: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil((remoteMaxChunkBytes * 4) / 3) + 8),
  }),
  z.object({
    type: z.literal("request_end"),
    ...Identity,
    channel_id: Identifier,
  }),
  z.object({
    type: z.literal("request_cancel"),
    ...Identity,
    channel_id: Identifier,
    reason: z.string().trim().min(1).max(240),
  }),
  z.object({
    type: z.literal("response_open"),
    ...Identity,
    channel_id: Identifier,
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string().max(16_384)),
  }),
  z.object({
    type: z.literal("response_chunk"),
    ...Identity,
    channel_id: Identifier,
    sequence: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil((remoteMaxChunkBytes * 4) / 3) + 8),
  }),
  z.object({
    type: z.literal("response_end"),
    ...Identity,
    channel_id: Identifier,
  }),
  z.object({
    type: z.literal("response_error"),
    ...Identity,
    channel_id: Identifier,
    error: z.string().trim().min(1).max(240),
  }),
])

export type RemoteMessage = z.infer<typeof RemoteMessage>

export function decodeRemoteMessage(value: string) {
  if (Buffer.byteLength(value) > remoteMaxFrameBytes) throw new Error("remote_frame_too_large")
  return RemoteMessage.parse(JSON.parse(value))
}

export function encodeRemoteMessage(value: RemoteMessage) {
  const encoded = JSON.stringify(RemoteMessage.parse(value))
  if (Buffer.byteLength(encoded) > remoteMaxFrameBytes) throw new Error("remote_frame_too_large")
  return encoded
}
