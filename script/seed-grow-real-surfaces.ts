import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const appRoot = path.join(root, "packages/app")
const controlPlaneRoot = path.join(root, "packages/control-plane")
const chromium = createRequire(path.join(appRoot, "package.json"))("@playwright/test").chromium
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-seed-grow-real-"))

async function freePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("reserved")
    },
  })
  const port = server.port
  await server.stop(true)
  return port
}

function captureTail(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state = { output: "" }
  const completed = (async () => {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        state.output = `${state.output}${decoder.decode()}`.slice(-16_000)
        return
      }
      state.output = `${state.output}${decoder.decode(chunk.value, { stream: true })}`.slice(-16_000)
    }
  })()
  return {
    completed,
    read() {
      return state.output
    },
  }
}

function start(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    child,
    stdout: captureTail(child.stdout),
    stderr: captureTail(child.stderr),
  }
}

async function terminate(managed: ReturnType<typeof start>) {
  if (managed.child.exitCode === null) {
    if (process.platform === "win32") {
      await Bun.spawn({
        cmd: ["taskkill", "/pid", String(managed.child.pid), "/t", "/f"],
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    } else {
      try {
        process.kill(-managed.child.pid, "SIGTERM")
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
      }
      const graceful = await Promise.race([managed.child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
      if (!graceful && managed.child.exitCode === null) {
        try {
          process.kill(-managed.child.pid, "SIGKILL")
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
        }
      }
    }
  }
  await managed.child.exited
  await Promise.allSettled([managed.stdout.completed, managed.stderr.completed])
}

async function waitForResponse(url: string, managed: ReturnType<typeof start>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null)
    if (response?.ok) return response
    if (managed.child.exitCode !== null) {
      await Promise.allSettled([managed.stdout.completed, managed.stderr.completed])
      throw new Error(`Process exited before ${url} became ready: ${managed.stderr.read()}\n${managed.stdout.read()}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${url}: ${managed.stderr.read()}`)
    }
    await Bun.sleep(250)
  }
}

function assertReadiness(readiness: { ready?: boolean; checks?: Array<{ status?: string }> }, message: string) {
  if (
    readiness.ready !== true ||
    !readiness.checks?.length ||
    readiness.checks.some((check) => !["pass", "warning"].includes(check.status ?? ""))
  ) {
    throw new Error(message)
  }
}

async function portClosed(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(500) }).then(
    () => false,
    () => true,
  )
}

const [controlPlanePort, webUIPort] = await Promise.all([freePort(), freePort()])
if (controlPlanePort === webUIPort) throw new Error("Dynamic ports must be unique.")
const controlPlaneURL = `http://127.0.0.1:${controlPlanePort}`
const webUIURL = `http://127.0.0.1:${webUIPort}`
const controlPlaneEnvironment = {
  ...process.env,
  AGENTCOMPANY_HOME: path.join(temporaryRoot, "control-plane-home"),
  AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
  AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
  AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
  AGENTCOMPANY_PURE: "1",
  XDG_DATA_HOME: path.join(temporaryRoot, "xdg-data"),
  XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
  XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
  XDG_STATE_HOME: path.join(temporaryRoot, "xdg-state"),
}
const startControlPlane = () =>
  start(
    [
      process.execPath,
      "--no-orphans",
      "--conditions=browser",
      "./src/index.ts",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(controlPlanePort),
      "--no-auth",
    ],
    controlPlaneRoot,
    controlPlaneEnvironment,
  )
const webUIEnvironment = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(webUIPort),
  NUXT_DEVTOOLS: "false",
  BETTER_AUTH_URL: webUIURL,
  BETTER_AUTH_SECRET: "agent-company-seed-grow-local-preview-secret",
  INTERNAL_API_SECRET: "agent-company-seed-grow-local-preview-internal-secret",
  AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneURL,
  AGENT_COMPANY_WEBUI_DATA_DIR: path.join(temporaryRoot, "webui-data"),
  AGENT_COMPANY_WEBUI_BUILD_DIR: path.join(temporaryRoot, "webui-build"),
  AGENT_COMPANY_WEBUI_OUTPUT_DIR: path.join(temporaryRoot, "webui-output"),
}

let controlPlane = startControlPlane()
let webUI: ReturnType<typeof start> | undefined
let closeBrowser: (() => Promise<void>) | undefined
let result: Record<string, unknown> | undefined
let cleanup: { controlPlanePortClosed: boolean; webUIPortClosed: boolean } | undefined

try {
  const health = (await (await waitForResponse(`${controlPlaneURL}/global/health`, controlPlane, 180_000)).json()) as {
    healthy?: boolean
    version?: string
  }
  if (health.healthy !== true || typeof health.version !== "string") {
    throw new Error("Real Control Plane health response is invalid.")
  }
  const readiness = (await (
    await waitForResponse(`${controlPlaneURL}/global/readiness`, controlPlane, 180_000)
  ).json()) as {
    ready?: boolean
    checks?: Array<{ status?: string }>
  }
  assertReadiness(readiness, "Real Control Plane readiness response is not ready.")

  webUI = start([process.execPath, "--no-orphans", "./script/production-e2e-server.ts"], appRoot, webUIEnvironment)
  await waitForResponse(`${webUIURL}/login`, webUI, 480_000)
  const browser = await chromium.launch()
  closeBrowser = () => browser.close()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${webUIURL}/login`, { waitUntil: "domcontentloaded" })
  await page.waitForURL((url) => url.pathname === "/inbox", { timeout: 60_000 })
  const routes = [
    ["/inbox", "Inbox"],
    ["/work", "Work"],
    ["/team", "Team"],
    ["/settings", "Settings"],
  ] as const
  for (const [route, heading] of routes) {
    await page.goto(`${webUIURL}${route}`, { waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible" })
  }
  const snapshotResponse = await context.request.get(`${webUIURL}/api/agent-company/snapshot`)
  if (!snapshotResponse.ok()) {
    throw new Error(`Real WebUI snapshot returned ${snapshotResponse.status()}.`)
  }
  const snapshot = (await snapshotResponse.json()) as { connection?: string; issue?: unknown }
  if (snapshot.connection !== "connected" || snapshot.issue) {
    throw new Error(`Real WebUI did not connect to the candidate Control Plane: ${JSON.stringify(snapshot)}`)
  }
  const visualQA = start([process.execPath, "--no-orphans", "./script/visual-qa.ts"], appRoot, {
    ...webUIEnvironment,
    AGENT_COMPANY_QA_BASE_URL: webUIURL,
  })
  const visualQAExit = await visualQA.child.exited
  if (visualQAExit !== 0) {
    await Promise.allSettled([visualQA.stdout.completed, visualQA.stderr.completed])
    throw new Error(`Visual QA failed: ${visualQA.stderr.read()}\n${visualQA.stdout.read()}`)
  }
  await Promise.all([visualQA.stdout.completed, visualQA.stderr.completed])

  await terminate(controlPlane)
  if (!(await portClosed(`${controlPlaneURL}/global/health`))) {
    throw new Error("Control Plane port remained open after the restart stop point.")
  }
  controlPlane = startControlPlane()
  const restartedHealth = (await (
    await waitForResponse(`${controlPlaneURL}/global/health`, controlPlane, 180_000)
  ).json()) as {
    healthy?: boolean
    version?: string
  }
  if (restartedHealth.healthy !== true || restartedHealth.version !== health.version) {
    throw new Error("Restarted Control Plane health does not match the initial candidate.")
  }
  const restartedReadiness = (await (
    await waitForResponse(`${controlPlaneURL}/global/readiness`, controlPlane, 180_000)
  ).json()) as {
    ready?: boolean
    checks?: Array<{ status?: string }>
  }
  assertReadiness(restartedReadiness, "Restarted Control Plane readiness response is not ready.")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForURL((url) => url.pathname === "/settings", { timeout: 30_000 })
  const recoveredSnapshot = (await (await context.request.get(`${webUIURL}/api/agent-company/snapshot`)).json()) as {
    connection?: string
    issue?: unknown
  }
  if (recoveredSnapshot.connection !== "connected" || recoveredSnapshot.issue) {
    throw new Error("WebUI did not reconnect to the restarted Control Plane.")
  }
  result = {
    result: "pass",
    candidateSha: Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim(),
    controlPlane: {
      healthy: health.healthy,
      version: health.version,
      readiness: readiness.ready,
      restarted: true,
    },
    webUI: {
      productionPreview: true,
      routes: routes.map(([route]) => route),
      realSnapshot: true,
      reconnected: true,
    },
    visualQA: "pass",
  }
} finally {
  if (closeBrowser) await closeBrowser()
  if (webUI) await terminate(webUI)
  await terminate(controlPlane)
  cleanup = {
    controlPlanePortClosed: await portClosed(`${controlPlaneURL}/global/health`),
    webUIPortClosed: await portClosed(`${webUIURL}/login`),
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true })
  if (result) result.cleanup = cleanup
}

if (!cleanup?.controlPlanePortClosed || !cleanup.webUIPortClosed) {
  throw new Error(`Real surface cleanup failed: ${JSON.stringify(cleanup)}`)
}
console.log(JSON.stringify(result, null, 2))
