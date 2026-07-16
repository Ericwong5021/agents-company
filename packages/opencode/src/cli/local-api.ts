import { bootstrap } from "./bootstrap"
import { Server } from "../server/server"

export type LocalJson = <T>(method: string, pathname: string, body?: unknown) => Promise<T>

export async function withLocalApi<T>(fn: (json: LocalJson) => Promise<T>) {
  return bootstrap(process.cwd(), async () => {
    const json = async <T>(method: string, pathname: string, body?: unknown): Promise<T> => {
      const response = await Server.Default().app.fetch(
        new Request(new URL(pathname, "http://opencode.internal"), {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )

      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `${method} ${pathname} failed with HTTP ${response.status}`)
      }

      if (response.status === 204) return undefined as T
      return (await response.json()) as T
    }

    return fn(json)
  })
}

export function queryString(input: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams()
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value))
  })
  const text = params.toString()
  return text ? `?${text}` : ""
}
