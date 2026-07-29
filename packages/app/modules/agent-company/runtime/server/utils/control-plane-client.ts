import { createControlPlaneClient } from "@agents-company/sdk/v2"
import { ofetch } from "ofetch"

export type ControlPlaneFailure = {
  kind: "authorization_required" | "invalid_configuration" | "service_error" | "service_unreachable"
  statusCode?: number
}

export type ControlPlaneResult<T> = { ok: true; value: T } | { ok: false; failure: ControlPlaneFailure }

type SDKResponse<T> = {
  data?: T
  error?: unknown
  response: Response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function statusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  if (typeof error.statusCode === "number") return error.statusCode
  if (!isRecord(error.response)) return undefined
  return typeof error.response.status === "number" ? error.response.status : undefined
}

function configuredHostname(value: string): string | undefined {
  const authority = value.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (!authority || authority.includes("@")) return undefined
  if (authority.startsWith("[")) return authority.match(/^(\[[^\]]+\])(?::\d+)?$/)?.[1]
  return authority.match(/^([^:]+)(?::\d+)?$/)?.[1]
}

function isLoopbackIPv4(value: string) {
  const octets = value.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  )
}

export function controlPlaneURL(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
  const hostname = configuredHostname(value)
  if (!hostname) return undefined
  if (hostname.toLowerCase() !== "localhost" && hostname.toLowerCase() !== "[::1]" && !isLoopbackIPv4(hostname)) return undefined
  return new URL(url.origin)
}

export function publicControlPlaneEndpoint(url: URL) {
  return `${url.protocol}//${url.host}`
}

export function controlPlaneSDK(baseURL: string, authorization?: string) {
  const url = controlPlaneURL(baseURL)
  if (!url) return
  const sdkFetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init)
      return fetch(new Request(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
      }))
    },
    { preconnect: fetch.preconnect },
  )
  return createControlPlaneClient({
    baseUrl: url.origin,
    fetch: sdkFetch,
    headers: authorization ? { authorization } : undefined,
  })
}

export function controlPlaneRequestURL(value: string, path: string): URL | undefined {
  const baseURL = controlPlaneURL(value)
  if (!baseURL) return undefined
  const target = new URL(path, baseURL)
  if (target.origin !== baseURL.origin) return undefined
  return target
}

export function classifyControlPlaneFailure(error: unknown): ControlPlaneFailure {
  const status = statusCode(error)
  if (status === 401 || status === 403) return { kind: "authorization_required", statusCode: status }
  if (status !== undefined) return { kind: "service_error", statusCode: status }
  return { kind: "service_unreachable" }
}

export async function requestControlPlaneSDK<T>(
  operation: Promise<SDKResponse<T>>,
): Promise<ControlPlaneResult<T>> {
  return operation.then(
    (result) => {
      if (result.data !== undefined) return { ok: true as const, value: result.data }
      return {
        ok: false as const,
        failure: classifyControlPlaneFailure({ statusCode: result.response.status }),
      }
    },
    (error: unknown) => ({ ok: false as const, failure: classifyControlPlaneFailure(error) }),
  )
}

export async function requestControlPlane<T>(
  baseURL: string,
  path: string,
  authorization?: string,
  retry = 0,
): Promise<ControlPlaneResult<T>> {
  const target = controlPlaneRequestURL(baseURL, path)
  if (!target) return { ok: false, failure: { kind: "invalid_configuration" } }
  return ofetch<T>(target.toString(), {
    headers: authorization ? { authorization } : undefined,
    retry,
    retryDelay: retry ? 100 : undefined,
    timeout: 5_000,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, failure: classifyControlPlaneFailure(error) }),
  )
}

export async function writeControlPlane<T>(
  baseURL: string,
  path: string,
  body: Record<string, unknown>,
  authorization?: string,
): Promise<ControlPlaneResult<T>> {
  const target = controlPlaneRequestURL(baseURL, path)
  if (!target) return { ok: false, failure: { kind: "invalid_configuration" } }
  return ofetch<T>(target.toString(), {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
    body,
    retry: 0,
    timeout: 5_000,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, failure: classifyControlPlaneFailure(error) }),
  )
}
