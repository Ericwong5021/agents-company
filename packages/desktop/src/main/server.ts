import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

export type SidecarInitializationStep =
  | "environment_prepared"
  | "module_loaded"
  | "logging_ready"
  | "listener_ready"

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

export async function spawnLocalServer(
  hostname: string,
  port: number,
  companyHome: string,
  report: (step: SidecarInitializationStep) => void = () => undefined,
) {
  prepareServerEnv(companyHome)
  report("environment_prepared")
  const { Log, Server } = await import("virtual:opencode-server")
  report("module_loaded")
  await Log.init({ level: "WARN", print: false })
  report("logging_ready")
  const listener = await Server.listen({
    port,
    hostname,
    noAuth: true,
    cors: ["ac://renderer"],
  })
  report("listener_ready")

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url)) return
      }
    }

    await ready()
  })()

  return { listener, health: { wait } }
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

export async function checkHealth(url: string): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
