import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { EventEmitter } from "node:events"
import type { Event } from "electron"
import { app, BrowserWindow, dialog, Menu, Tray } from "electron"
import pkg from "electron-updater"
import contextMenu from "electron-context-menu"

import type { InitStep, ServerReadyData, WslConfig } from "../preload/types"
import { PRODUCT_BRAND, COMPANY_HOME_KEY } from "../shared/brand"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { launcherState, loadCompanyRuntime, normalizeCompanyHome, type LauncherState } from "./company-home"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServer } from "./server"
import { getStore } from "./store"
import { createMainWindow, getAppIconPath, registerRendererProtocol, setBackgroundColor, setDockIcon } from "./windows"

contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

try {
  process.chdir(homedir())
} catch {}

process.env.AGENTCOMPANY_DISABLE_EMBEDDED_WEB_UI = "true"

const appId = app.isPackaged ? PRODUCT_BRAND.app_ids[CHANNEL] : PRODUCT_BRAND.app_ids.dev
app.setName(app.isPackaged ? PRODUCT_BRAND.names[CHANNEL] : PRODUCT_BRAND.names.dev)
app.setAppUserModelId(appId)
if (process.env.AGENTCOMPANY_USER_DATA && !isAbsolute(process.env.AGENTCOMPANY_USER_DATA)) {
  throw new Error("AGENTCOMPANY_USER_DATA must be an absolute path")
}
app.setPath("userData", process.env.AGENTCOMPANY_USER_DATA ?? join(app.getPath("appData"), appId))

const { autoUpdater } = pkg
const initEmitter = new EventEmitter()
const pendingDeepLinks: string[] = []
const serverReady = defer<ServerReadyData>()
const logger = initLogging()

let initStep: InitStep = { phase: "server_waiting" }
let mainWindow: BrowserWindow | null = null
let server: Awaited<ReturnType<typeof spawnLocalServer>>["listener"] | null = null
let tray: Tray | null = null
let quitting = false

logger.log("app starting", { version: app.getVersion(), packaged: app.isPackaged })

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const result = await serverReady.promise
      logger.log("server ready", { url: result.url })
      return result
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getLauncherState: () => currentLauncherState(),
  selectCompanyHome: () => selectCompanyHome(),
  getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  setBackgroundColor: (color) => setBackgroundColor(color),
})

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg) => arg.startsWith(`${PRODUCT_BRAND.deep_link_protocol}://`))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    quitting = true
    killSidecar()
  })
  app.on("will-quit", () => killSidecar())
  app.on("activate", () => focusMainWindow())

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      app.exit(0)
    })
  }

  void app
    .whenReady()
    .then(async () => {
      logger.log("app ready")
      app.setAsDefaultProtocolClient(PRODUCT_BRAND.deep_link_protocol)
      registerRendererProtocol()
      setDockIcon()
      setupAutoUpdater()

      const state = currentLauncherState()
      logger.log("launcher state resolved", { state: state.state })
      if (state.state === "needs_company_home") {
        mainWindow = createMainWindow()
        wireMenu()
        wireWindowLifecycle()
        return
      }

      logger.log("company runtime loading")
      await loadCompanyRuntime(state.company_home, () => initialize(state.company_home))
      logger.log("company runtime initialized")
    })
    .catch((error) => logger.error("app initialization failed", error))
}

function currentLauncherState(): LauncherState {
  const value = getStore().get(COMPANY_HOME_KEY)
  const home = typeof value === "string" && isAbsolute(value) ? normalizeCompanyHome(value) : null
  return launcherState(home, app.getPath("documents"))
}

async function selectCompanyHome() {
  const state = currentLauncherState()
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    defaultPath: state.state === "ready" ? state.company_home : state.suggested_path,
    title: "Choose your Agent Company home",
  })
  if (result.canceled || !result.filePaths[0]) return null

  const companyHome = normalizeCompanyHome(result.filePaths[0])
  await mkdir(companyHome, { recursive: true })
  const probe = join(companyHome, `.agent-company-write-${randomUUID()}`)
  await writeFile(probe, "")
  await rm(probe)
  getStore().set(COMPANY_HOME_KEY, companyHome)
  return companyHome
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function wireWindowLifecycle() {
  if (!mainWindow) return
  mainWindow.on("close", (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on("closed", () => {
    mainWindow = null
  })
  if (tray) return
  tray = new Tray(getAppIconPath())
  tray.setToolTip(PRODUCT_BRAND.names.prod)
  tray.on("click", () => focusMainWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Agent Company", click: () => focusMainWindow() },
      {
        label: "Hide Window",
        click: () => mainWindow?.hide(),
      },
      { type: "separator" },
      {
        label: "Quit Agent Company",
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize(companyHome: string) {
  logger.log("sidecar port resolving")
  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  logger.log("sidecar connection started", { url })

  const { listener, health } = await spawnLocalServer(hostname, port, companyHome, (step) => {
    logger.log("sidecar initialization", { step })
  })
  server = listener
  serverReady.resolve({ url })

  await Promise.race([
    health.wait,
    delay(30_000).then(() => {
      throw new Error("Sidecar health check timed out")
    }),
  ]).catch((error) => logger.error("sidecar health check failed", error))

  setInitStep({ phase: "done" })
  mainWindow = createMainWindow()
  wireMenu()
  wireWindowLifecycle()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
  })
}

function killSidecar() {
  if (!server) return
  void server.stop()
  server = null
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)

    for (const host of loopback) {
      if (items.some((value) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.AGENTCOMPANY_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.on("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (typeof address !== "object" || !address) {
        socket.close()
        reject(new Error("Failed to get port"))
        return
      }
      socket.close(() => resolve(address.port))
    })
  })
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
}

let updateReady = false

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  updateReady = false
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) return { updateAvailable: false }
    await autoUpdater.downloadUpdate()
    updateReady = true
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

async function installUpdate() {
  if (!updateReady) return
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: result.failed ? "error" : "info", message: "No update available." })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await installUpdate()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
