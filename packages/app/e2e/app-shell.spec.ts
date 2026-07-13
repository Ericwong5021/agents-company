import { expect, test } from "@playwright/test"

test("root route renders the company workspace inside the shared app chrome", async ({ page }) => {
  await page.goto("/")

  await expect(page.locator('[data-component="app-shell"]')).toBeVisible()
  await expect(page.locator('[data-component="app-titlebar"]')).toBeVisible()
  await expect(page.locator(".company-workspace")).toBeVisible()
  await expect(page.locator('[data-component="app-titlebar"]')).toHaveAttribute("data-tauri-drag-region", "")
})

test("new-session deep links keep the shared app chrome mounted", async ({ page }) => {
  const directory = "/tmp/agents-company-app-shell"
  const slug = Buffer.from(directory).toString("base64url")

  await page.goto("/")
  await expect(page.locator('[data-component="app-shell"]')).toBeVisible()
  await page.evaluate(
    (url) => {
      window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [url] } }))
    },
    `opencode://new-session?directory=${encodeURIComponent(directory)}&prompt=inspect%20M0`,
  )

  await expect(page).toHaveURL(new RegExp(`/${slug}/session(?:\\?.*)?$`))
  await expect(page.locator('[data-component="app-shell"]')).toBeVisible()
  await expect(page.locator('[data-component="app-titlebar"]')).toBeVisible()
})

test("company channels, thread, composer, and approval use the development data source", async ({ page }) => {
  await page.goto("/")

  await page.getByRole("button", { name: /^公司大厅/ }).click()
  await expect(page.getByRole("heading", { level: 1, name: "公司大厅" })).toBeVisible()

  await page.getByRole("button", { name: /^Pre-Public WebUI/ }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Pre-Public WebUI" })).toBeVisible()

  await page.getByRole("button", { name: "关闭 Thread" }).click()
  await expect(page.locator(".company-thread")).toBeHidden()
  await page.getByRole("button", { name: "查看证据" }).click()
  await expect(page.locator(".company-thread")).toBeVisible()

  await page.getByRole("textbox", { name: "发送消息" }).fill("M0 App Shell 冒烟通过")
  await page.getByRole("textbox", { name: "发送消息" }).press("Enter")
  await expect(page.getByText("M0 App Shell 冒烟通过", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "批准合并" }).click()
  await expect(page.getByRole("button", { name: "已批准" })).toBeDisabled()
})
