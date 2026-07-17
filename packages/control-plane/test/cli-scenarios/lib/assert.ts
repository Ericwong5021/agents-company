import { stat } from "fs/promises"
import type { CliEnvelope } from "./cli"

export function expectOk<T>(envelope: CliEnvelope<T>) {
  if (envelope.ok) return envelope.data
  throw new Error(`${envelope.type} failed: ${envelope.error.code}: ${envelope.error.message}`)
}

export function expectField<T>(value: unknown, field: string) {
  const result = field.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
  if (result === undefined) throw new Error(`Expected field ${field}`)
  return result as T
}

export async function waitUntil(check: () => Promise<boolean>, options: { timeoutMs?: number; intervalMs?: number } = {}) {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 1_000
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

export async function expectFile(pathname: string) {
  const info = await stat(pathname)
  if (!info.isFile()) throw new Error(`Expected file: ${pathname}`)
}
