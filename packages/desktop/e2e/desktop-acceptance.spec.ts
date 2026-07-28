import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import electronPath from "electron"

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const artifacts = path.join(desktop, ".artifacts", "m2-desktop")
const appData = path.join(artifacts, "app-data")
const companyHome = path.join(artifacts, "company-home")
const serverPort = process.env.PLAYWRIGHT_DESKTOP_SERVER_PORT ?? "4397"
const serverURL = `http://127.0.0.1:${serverPort}`
const webUIURL = "http://127.0.0.1:3210"
const goalDraft = "Desktop restart keeps this local goal draft"

let application: ElectronApplication | undefined
const rendererDiagnostics: string[] = []

async function launch() {
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktop, "--disable-gpu", "--lang=en-US"],
    env: {
      ...process.env,
      APPDATA: appData,
      XDG_CONFIG_HOME: appData,
      AGENTCOMPANY_USER_DATA: path.join(appData, "user-data"),
      AGENTCOMPANY_PORT: serverPort,
      AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
    },
    timeout: 120_000,
  })
  return application
}

async function stop() {
  const current = application
  application = undefined
  if (!current) return
  const closed = current.waitForEvent("close", { timeout: 30_000 })
  await current.evaluate(({ app }) => {
    setImmediate(() => app.quit())
  })
  await closed
}

async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow({ timeout: 120_000 }).catch(async (error) => {
    const snapshot = await app
      .evaluate(({ app, BrowserWindow }) => ({
        ready: app.isReady(),
        windows: BrowserWindow.getAllWindows().length,
        userData: app.getPath("userData"),
      }))
      .catch((snapshotError) => ({ error: String(snapshotError) }))
    const health = await fetch(serverURL + "/global/health", { signal: AbortSignal.timeout(1_000) })
      .then((response) => ({ status: response.status }))
      .catch((healthError) => ({ error: String(healthError) }))
    const mainLog = await fs
      .readFile(path.join(appData, "user-data", "logs", "main.log"), "utf8")
      .catch((logError) => `Desktop main log unavailable: ${String(logError)}`)
    await test.info().attach("desktop-initialization", {
      body: Buffer.from(JSON.stringify({ snapshot, health }, null, 2)),
      contentType: "application/json",
    })
    await test.info().attach("desktop-main-log", { body: Buffer.from(mainLog), contentType: "text/plain" })
    throw error
  })
  page.on("console", (message) => rendererDiagnostics.push(`console:${message.type()}: ${message.text()}`))
  page.on("pageerror", (error) => rendererDiagnostics.push(`pageerror: ${error.stack ?? error.message}`))
  page.on("requestfailed", (request) => {
    rendererDiagnostics.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    )
  })
  page.on("response", (response) => {
    if (!response.url().includes("/api/agent-company/")) return
    rendererDiagnostics.push(`response: ${response.status()} ${response.url()}`)
  })
  await page.waitForLoadState("domcontentloaded")
  return page
}

async function setCompanyHomeDialog(app: ElectronApplication, result: { canceled: boolean; filePaths: string[] }) {
  await app.evaluate(({ app, dialog }, value) => {
    const state = globalThis as typeof globalThis & {
      m2Exit?: typeof app.exit
      m2Relaunch?: typeof app.relaunch
    }
    state.m2Exit ??= app.exit.bind(app)
    state.m2Relaunch ??= app.relaunch.bind(app)
    Object.defineProperty(app, "exit", { configurable: true, value: () => undefined })
    Object.defineProperty(app, "relaunch", { configurable: true, value: () => undefined })
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => value,
    })
  }, result)
}

async function restoreAppLifecycle(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    const state = globalThis as typeof globalThis & {
      m2Exit?: typeof app.exit
      m2Relaunch?: typeof app.relaunch
    }
    if (state.m2Exit) Object.defineProperty(app, "exit", { configurable: true, value: state.m2Exit })
    if (state.m2Relaunch) Object.defineProperty(app, "relaunch", { configurable: true, value: state.m2Relaunch })
  })
}

async function expectSharedWorkspace(page: Page) {
  await page.waitForURL((url) => url.origin === webUIURL && url.pathname === "/inbox", { timeout: 120_000 })
  await page.waitForLoadState("domcontentloaded")
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible({ timeout: 120_000 })
  const navigation = page.getByRole("navigation", { name: "主导航" })
  await expect(navigation.getByRole("link")).toHaveCount(5)
  await expect(navigation.getByRole("link").allTextContents()).resolves.toEqual([
    "Inbox",
    "Work",
    "Team",
    "Library",
    "Settings",
  ])
  await expect(page.getByRole("link", { name: "本地连接状态：需要配置，还未连接模型 Provider" })).toHaveAttribute(
    "data-connection",
    "degraded",
  )
  const snapshot: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/agent-company/snapshot")
    if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}.`)
    return response.json()
  })
  expect(snapshot).toMatchObject({
    connection: "degraded",
    issue: { kind: "provider_required" },
    company: { id: "cmp_local", providerConfigured: false },
    work: [],
  })
  return navigation
}

test.beforeAll(async () => {
  rendererDiagnostics.length = 0
  await fs.rm(artifacts, { recursive: true, force: true })
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const mainLog = await fs
      .readFile(path.join(appData, "user-data", "logs", "main.log"), "utf8")
      .catch((error) => `Desktop main log unavailable: ${String(error)}`)
    await test.info().attach("desktop-renderer-diagnostics", {
      body: Buffer.from(rendererDiagnostics.join("\n")),
      contentType: "text/plain",
    })
    await test.info().attach("desktop-main-log", { body: Buffer.from(mainLog), contentType: "text/plain" })
  }
  await stop()
})

test("closes the native Desktop R0 gate through shared WebUI and restart recovery", async ({ request }) => {
  const preflightApp = await launch()
  const preflight = await firstWindow(preflightApp)
  await expect(preflight.getByRole("heading", { name: "Choose a Company home" })).toBeVisible()

  await setCompanyHomeDialog(preflightApp, { canceled: true, filePaths: [] })
  await preflight.getByRole("button", { name: "Choose folder", exact: true }).click()
  await expect(preflight.getByRole("heading", { name: "Choose a Company home" })).toBeVisible()

  await setCompanyHomeDialog(preflightApp, { canceled: false, filePaths: [companyHome] })
  await preflight.getByRole("button", { name: "Choose folder", exact: true }).click()
  await expect(preflight.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled()
  await restoreAppLifecycle(preflightApp)
  await stop()

  const readyApp = await launch()
  const desktopPage = await firstWindow(readyApp)
  const navigation = await expectSharedWorkspace(desktopPage)
  expect((await request.get(serverURL + "/global/health")).status()).toBe(200)
  expect((await request.get(serverURL + "/global/readiness")).status()).toBe(200)
  const companyBeforeRestart = await request.get(serverURL + "/company")
  expect(companyBeforeRestart.status()).toBe(200)
  expect((await companyBeforeRestart.json()) as unknown).toMatchObject({ company: { id: "cmp_local" } })

  await expect(desktopPage.getByRole("heading", { level: 2, name: "用本地 AI 团队交付第一个目标" })).toBeVisible()
  await desktopPage.getByRole("button", { name: "跳过引导，直接进入空工作区" }).click()
  await expect(desktopPage.getByRole("heading", { level: 2, name: "让本地 AI 团队接手第一个交付目标" })).toBeVisible()
  const draft = desktopPage.getByLabel("描述你希望团队交付的结果")
  await draft.fill(goalDraft)
  await expect(desktopPage.getByRole("button", { name: "生成只读目标摘要" })).toBeDisabled()
  await expect(desktopPage.getByRole("link", { name: "连接 Provider" })).toHaveAttribute("href", "/settings")
  await navigation.getByRole("link", { name: "Work" }).click()
  await expect(desktopPage).toHaveURL(`${webUIURL}/work`)
  await expect(desktopPage.getByRole("heading", { level: 1, name: "Work" })).toBeVisible()

  await stop()
  await expect
    .poll(() =>
      fetch(serverURL + "/global/health", { signal: AbortSignal.timeout(500) })
        .then(() => false)
        .catch(() => true),
    )
    .toBe(true)

  const restartedApp = await launch()
  const restartedPage = await firstWindow(restartedApp)
  await expectSharedWorkspace(restartedPage)
  await expect(restartedPage.getByLabel("描述你希望团队交付的结果")).toHaveValue(goalDraft)
  const companyAfterRestart = await request.get(serverURL + "/company")
  expect(companyAfterRestart.status()).toBe(200)
  expect((await companyAfterRestart.json()) as unknown).toMatchObject({ company: { id: "cmp_local" } })
})
