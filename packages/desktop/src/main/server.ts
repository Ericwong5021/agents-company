import { randomBytes } from "node:crypto"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export async function spawnLocalServer(hostname: string, port: number, companyHome: string) {
  prepareServerEnv(companyHome)
  const { Log, Server } = await import("virtual:opencode-server")
  await Log.init({ level: "WARN", print: false })
  const credentials = { username: "agentcompany", password: randomBytes(32).toString("base64url") }
  const listener = await Server.listen({
    port,
    hostname,
    auth: credentials,
    cors: ["ac://renderer"],
  })
  if (!listener.credentials) throw new Error("Local server did not return credentials")

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, listener.credentials)) return
      }
    }

    await ready()
  })()

  return { listener, credentials: listener.credentials, health: { wait } }
}

function prepareServerEnv(companyHome: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const env = {
    ...process.env,
    ...shellEnv,
    AGENTCOMPANY_EXPERIMENTAL_ICON_DISCOVERY: "true",
    AGENTCOMPANY_EXPERIMENTAL_FILEWATCHER: "true",
    AGENTCOMPANY_CLIENT: "desktop",
    AGENTCOMPANY_HOME: companyHome,
  }
  Object.assign(process.env, env)
}

export async function checkHealth(url: string, credentials?: { username: string; password: string } | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (credentials) {
    const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
