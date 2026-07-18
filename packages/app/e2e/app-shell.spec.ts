import { expect, test } from "@playwright/test"

const serverUrl = "http://127.0.0.1:4096"

test("root route enters the trusted loopback workspace directly", async ({ page, request }) => {
  expect((await request.get(serverUrl + "/company")).status()).toBe(200)

  await page.goto("/")

  await expect(page.getByRole("heading", { name: "初始化本地 Company" })).toHaveCount(0)
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator('[data-company-state="needs-bootstrap"]')).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "配对此浏览器" })).toHaveCount(0)
  await expect(page.locator('[data-component="app-shell"]')).toBeVisible()
})
