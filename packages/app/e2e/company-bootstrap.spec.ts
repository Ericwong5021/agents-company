import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const serverUrl = "http://127.0.0.1:4096"

test("enters trusted loopback and completes real M1 bootstrap", async ({ page, request }) => {
  const repository =
    process.env.PLAYWRIGHT_M1_REPOSITORY ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.artifacts/m1-e2e/repository")

  expect((await request.get(serverUrl + "/company")).status()).toBe(200)

  const providers = page.waitForResponse((response) => new URL(response.url()).pathname === "/company/providers")
  const providerAuth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/company/providers/auth",
  )
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "初始化本地 Company" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "配对此浏览器" })).toHaveCount(0)
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

  await expect(page.getByRole("heading", { name: "董事会圆桌会议" })).toBeVisible()
  // M2: the gate server explicitly enables the real conversation capability.
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator(".company-composer")).toBeVisible()
  await expect(page.locator('[data-capability="board-messages-disabled"]')).toHaveCount(0)
  await expect(page.locator(".company-approval, .company-delivery")).toHaveCount(0)

  // M1 company facts remain reachable in the context-preserving settings dialog.
  await page.getByRole("button", { name: "打开设置" }).click()
  await expect(page.getByText("Balanced", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Company 初始化完成" })).toBeVisible()

  await page.reload()
  // After reload the workspace rebuilds from the persisted snapshot without
  // re-bootstrap and preserves the enabled capability.
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator(".company-composer")).toBeVisible()
})
