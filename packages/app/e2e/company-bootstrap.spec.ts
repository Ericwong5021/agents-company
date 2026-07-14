import { Buffer } from "node:buffer"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const serverUrl = "http://127.0.0.1:4096"
const basic = "Basic " + Buffer.from("agentcompany:m1-e2e-secret").toString("base64")

test("pairs a browser and completes real M1 bootstrap", async ({ page, request }) => {
  const repository =
    process.env.PLAYWRIGHT_M1_REPOSITORY ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.artifacts/m1-e2e/repository")

  expect((await request.get(serverUrl + "/company")).status()).toBe(401)
  expect((await request.get(serverUrl + "/company/providers")).status()).toBe(401)
  expect((await request.get(serverUrl + "/global/event")).status()).toBe(401)

  const pairing = await request.post(serverUrl + "/local-auth/pairings", {
    headers: { authorization: basic },
    data: { label: "Playwright Chromium" },
  })
  expect(pairing.ok()).toBe(true)
  const pair = (await pairing.json()) as { code: string }

  await page.goto("/?pair=" + encodeURIComponent(pair.code))
  await page.getByLabel("浏览器名称").fill("Playwright Chromium")
  const providers = page.waitForResponse((response) => new URL(response.url()).pathname === "/company/providers")
  const providerAuth = page.waitForResponse((response) => new URL(response.url()).pathname === "/company/providers/auth")
  await page.getByRole("button", { name: "安全连接" }).click()
  await expect(page.getByRole("heading", { name: "初始化本地 Company" })).toBeVisible()
  expect((await providers).status()).toBe(200)
  expect((await providerAuth).status()).toBe(200)

  await page.getByLabel("模型提供商").selectOption("openai")
  await page.getByPlaceholder("API 密钥").fill("test-openai-key")
  await page.getByRole("button", { name: "连接", exact: true }).click()
  await expect(page.getByRole("button", { name: "继续", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "继续", exact: true }).click()

  await expect(page.getByLabel("公司名称")).toHaveValue("Agent Company")
  await expect(page.getByText("CEO", { exact: true })).toBeVisible()
  await expect(page.getByText("CTO", { exact: true })).toBeVisible()
  await expect(page.getByText("Product Lead", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "继续", exact: true }).click()

  await page.getByLabel("仓库路径").fill(repository)
  await page.getByRole("button", { name: "检查仓库", exact: true }).click()
  await expect(page.getByText("main", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "继续", exact: true }).click()

  await expect(page.getByRole("radio", { name: /平衡/ })).toBeChecked()
  await page.getByRole("button", { name: "继续", exact: true }).click()
  await expect(page.getByText("提供商与模型", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "创建 Company", exact: true }).click()

  await expect(page.getByRole("heading", { name: "Agent Company" })).toBeVisible()
  // M2: ready state renders the live workspace (channel sidebar + read-only
  // feed). Board messaging stays disabled until the release gate closes, so the
  // composer is replaced by a capability notice — no fabricated send entry.
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator('[data-capability="board-messages-disabled"]')).toBeVisible()
  await expect(page.locator(".company-composer")).toHaveCount(0)
  await expect(page.locator(".company-approval, .company-delivery")).toHaveCount(0)

  // M1 company facts and browser pairing remain reachable via the Context Panel.
  await page.getByRole("button", { name: "公司配置" }).click()
  await expect(page.getByText("Balanced", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Company 初始化完成" })).toBeVisible()

  const reused = await request.post(serverUrl + "/local-auth/exchange", {
    data: { code: pair.code, label: "Reused code" },
  })
  expect(reused.status()).toBe(400)

  await page.reload()
  // After reload the workspace rebuilds from the persisted snapshot; channels
  // and the capability notice reappear without re-bootstrap.
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator('[data-capability="board-messages-disabled"]')).toBeVisible()
})
