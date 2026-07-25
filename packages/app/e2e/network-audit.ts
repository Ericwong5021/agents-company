import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BrowserContext, TestInfo } from "@playwright/test"

const sessions = new WeakMap<BrowserContext, {
  blockedExternal: Map<string, NetworkEntry>
  observedLoopback: Map<string, NetworkEntry>
}>()
const scenarios: ScenarioAudit[] = []

type NetworkEntry = {
  protocol: "http" | "websocket"
  method: string
  origin: string
  pathname: string
  resourceType: string
}

type ScenarioAudit = {
  testId: string
  title: string
  retry: number
  status?: string
  externalAttemptCount: number
  blockedExternal: NetworkEntry[]
  observedLoopback: NetworkEntry[]
}

function loopback(url: URL) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
}

function entry(
  url: URL,
  protocol: NetworkEntry["protocol"],
  method: string,
  resourceType: string,
): NetworkEntry {
  return {
    protocol,
    method,
    origin: url.origin,
    pathname: url.pathname,
    resourceType,
  }
}

function key(value: NetworkEntry) {
  return [
    value.protocol,
    value.method,
    value.origin,
    value.pathname,
    value.resourceType,
  ].join("\0")
}

export async function installNetworkAudit(context: BrowserContext) {
  if (!process.env.PLAYWRIGHT_NETWORK_AUDIT_PATH) return
  if (!process.env.PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID) {
    throw new Error("PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID is required with PLAYWRIGHT_NETWORK_AUDIT_PATH")
  }

  const session = {
    blockedExternal: new Map<string, NetworkEntry>(),
    observedLoopback: new Map<string, NetworkEntry>(),
  }
  sessions.set(context, session)

  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!["http:", "https:"].includes(url.protocol)) {
      await route.continue()
      return
    }
    const value = entry(url, "http", request.method(), request.resourceType())
    if (loopback(url)) {
      session.observedLoopback.set(key(value), value)
      await route.continue()
      return
    }
    session.blockedExternal.set(key(value), value)
    await route.abort("blockedbyclient")
  })

  await context.routeWebSocket(/.*/, async (socket) => {
    const url = new URL(socket.url())
    const value = entry(url, "websocket", "CONNECT", "websocket")
    if (loopback(url)) {
      session.observedLoopback.set(key(value), value)
      socket.connectToServer()
      return
    }
    session.blockedExternal.set(key(value), value)
    await socket.close({ code: 1008, reason: "Loopback-only audit" })
  })
}

export async function finalizeNetworkAudit(context: BrowserContext, testInfo: TestInfo) {
  const session = sessions.get(context)
  const outputPath = process.env.PLAYWRIGHT_NETWORK_AUDIT_PATH
  if (!session || !outputPath) return

  scenarios.push({
    testId: testInfo.testId,
    title: testInfo.title,
    retry: testInfo.retry,
    status: testInfo.status,
    externalAttemptCount: session.blockedExternal.size,
    blockedExternal: [...session.blockedExternal.values()],
    observedLoopback: [...session.observedLoopback.values()],
  })
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true })
  await writeFile(path.resolve(outputPath), `${JSON.stringify({
    schemaVersion: 1,
    policy: "loopback-only",
    sideEffectAuditId: process.env.PLAYWRIGHT_SIDE_EFFECT_AUDIT_ID,
    externalAttemptCount: scenarios.reduce((total, scenario) => total + scenario.externalAttemptCount, 0),
    scenarios,
  }, null, 2)}\n`)
}
