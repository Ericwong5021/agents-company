import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import {
  _electron as electron,
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import electronPath from "electron"

const run = promisify(execFile)
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const artifacts = path.join(desktop, ".artifacts", "m2-desktop")
const appData = path.join(artifacts, "app-data")
const companyHome = path.join(artifacts, "company-home")
const repository = path.join(artifacts, "repository")
const serverPort = process.env.PLAYWRIGHT_DESKTOP_SERVER_PORT ?? "4397"
const serverURL = `http://127.0.0.1:${serverPort}`
const messageBody = "Desktop native gate sends a real M2 board goal"

let application: ElectronApplication | undefined

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
  await current.close()
}

async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow({ timeout: 120_000 })
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

async function bootstrap(page: Page) {
  await expect(page.getByRole("heading", { name: "Set up your local company" })).toBeVisible()
  await page.getByLabel("Provider").selectOption("openai")
  await page.getByPlaceholder("API key").fill("test-openai-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Continue", exact: true }).click()

  await expect(page.getByLabel("Company name")).toHaveValue("Agent Company")
  await page.getByRole("button", { name: "Continue", exact: true }).click()

  await page.getByLabel("Repository path").fill(repository)
  await page.getByRole("button", { name: "Inspect repository", exact: true }).click()
  await expect(page.getByText("main", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Continue", exact: true }).click()

  await expect(page.getByRole("radio", { name: /Balanced/ })).toBeChecked()
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.getByRole("button", { name: "Create company", exact: true }).click()
  await expect(page.locator(".company-composer")).toBeVisible()
}

async function basicCredentials(page: Page) {
  return page.evaluate(() => window.api.awaitInitialization(() => undefined))
}

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return value
}

async function responseJson(response: APIResponse) {
  const value: unknown = await response.json()
  return value
}

function browserCredential(value: unknown) {
  const record = objectValue(value, "Pairing exchange response")
  return {
    token: stringValue(Reflect.get(record, "token"), "Pairing exchange token"),
    credential_id: stringValue(Reflect.get(record, "credential_id"), "Pairing exchange credential id"),
  }
}

function companyID(value: unknown) {
  const response = objectValue(value, "Company response")
  const company = objectValue(Reflect.get(response, "company"), "Company response company")
  return stringValue(Reflect.get(company, "id"), "Company id")
}

function channelList(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Channels response must be an array")
  return value.map((item, index) => {
    const channel = objectValue(item, `Channel ${index}`)
    return {
      id: stringValue(Reflect.get(channel, "id"), `Channel ${index} id`),
      kind: stringValue(Reflect.get(channel, "kind"), `Channel ${index} kind`),
    }
  })
}

function messageList(value: unknown) {
  const response = objectValue(value, "Messages response")
  const items = Reflect.get(response, "items")
  if (!Array.isArray(items)) throw new Error("Messages response items must be an array")
  return items.map((item, index) => {
    const message = objectValue(item, `Message ${index}`)
    const sourceThreadID = Reflect.get(message, "sourceThreadID")
    if (sourceThreadID !== undefined && typeof sourceThreadID !== "string") {
      throw new Error(`Message ${index} sourceThreadID must be a string`)
    }
    return {
      id: stringValue(Reflect.get(message, "id"), `Message ${index} id`),
      body: stringValue(Reflect.get(message, "body"), `Message ${index} body`),
      sourceThreadID,
    }
  })
}

async function createBrowserCredential(page: Page, request: APIRequestContext) {
  await page.locator(".company-rail-button").nth(1).click()
  await page.getByRole("button", { name: "Connect browser", exact: true }).click()
  const code = (await page.locator(".company-ready-pairing strong").innerText()).trim()
  const exchange = await request.post(serverURL + "/local-auth/exchange", {
    data: { code, label: "Browser" },
  })
  if (!exchange.ok()) throw new Error(`Pairing exchange failed (${exchange.status()}): ${await exchange.text()}`)
  return browserCredential(await responseJson(exchange))
}

test.beforeAll(async () => {
  await fs.rm(artifacts, { recursive: true, force: true })
  await fs.mkdir(repository, { recursive: true })
  await fs.writeFile(path.join(repository, "README.md"), "# Desktop M2 acceptance repository\n")
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "desktop-e2e@agentcompany.test"],
    ["config", "user.name", "Desktop E2E"],
    ["add", "README.md"],
    ["commit", "-m", "Initial desktop fixture"],
  ]) {
    await run("git", args, { cwd: repository })
  }
})

test.afterEach(async () => {
  await stop()
})

test("closes the native Desktop gate from home selection through restart, pairing, and shared conversation", async ({ request }) => {
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
  await bootstrap(desktopPage)
  const firstSidecar = await basicCredentials(desktopPage)
  expect(firstSidecar.url).toBe(serverURL)

  await desktopPage.getByLabel("Send a message").fill(messageBody)
  await desktopPage.getByRole("button", { name: "Send", exact: true }).click()
  const desktopMessage = desktopPage.locator(".company-message", { hasText: messageBody })
  await expect(desktopMessage).toBeVisible()
  await desktopMessage.getByRole("button", { name: "View source thread" }).click()
  await expect(desktopPage.getByRole("complementary", { name: "Thread" })).toBeVisible()

  const issued = await createBrowserCredential(desktopPage, request)
  const bearer = { authorization: "Bearer " + issued.token }
  const companyResponse = await request.get(serverURL + "/company", { headers: bearer })
  expect(companyResponse.ok()).toBe(true)
  const company = companyID(await responseJson(companyResponse))
  const channelsResponse = await request.get(`${serverURL}/company/channels?company_id=${company}`, { headers: bearer })
  expect(channelsResponse.ok()).toBe(true)
  const board = channelList(await responseJson(channelsResponse)).find((channel) => channel.kind === "board")
  if (!board) throw new Error("Board channel was not returned")
  const messagesResponse = await request.get(
    `${serverURL}/company/channels/${board.id}/messages?company_id=${company}&limit=50`,
    { headers: bearer },
  )
  expect(messagesResponse.ok()).toBe(true)
  const sharedMessage = messageList(await responseJson(messagesResponse)).find((message) => message.body === messageBody)
  if (!sharedMessage?.sourceThreadID) throw new Error("Shared Desktop message has no source Thread")
  const threadResponse = await request.get(
    `${serverURL}/company/threads/${sharedMessage.sourceThreadID}?company_id=${company}`,
    { headers: bearer },
  )
  expect(threadResponse.ok()).toBe(true)

  await stop()
  await expect
    .poll(() => fetch(serverURL + "/global/health", { signal: AbortSignal.timeout(500) }).then(() => false).catch(() => true))
    .toBe(true)

  const restartedApp = await launch()
  const restartedPage = await firstWindow(restartedApp)
  await expect(restartedPage.locator(".company-message", { hasText: messageBody })).toBeVisible()
  const afterRestart = await request.get(
    `${serverURL}/company/channels/${board.id}/messages?company_id=${company}&limit=50`,
    { headers: bearer },
  )
  expect(afterRestart.ok()).toBe(true)
  expect(messageList(await responseJson(afterRestart)).find((message) => message.id === sharedMessage.id)?.sourceThreadID).toBe(
    sharedMessage.sourceThreadID,
  )

  await restartedPage.locator(".company-rail-button").nth(1).click()
  const credential = restartedPage.locator(".company-ready-credential-list > div", { hasText: "Browser" })
  await expect(credential).toBeVisible()
  await credential.getByRole("button", { name: "Revoke", exact: true }).click()
  await expect.poll(async () => (await request.get(serverURL + "/company", { headers: bearer })).status()).toBe(401)
})
