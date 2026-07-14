import { expect, test } from "@playwright/test"

test("root route renders an anonymous browser pairing shell", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "配对此浏览器" })).toBeVisible()
  await expect(page.getByLabel("配对码")).toBeVisible()
  await expect(page.getByLabel("浏览器名称")).toBeVisible()
  await expect(page.locator('[data-component="app-shell"]')).toHaveCount(0)
})
