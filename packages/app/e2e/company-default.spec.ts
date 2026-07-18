import { expect, test } from "@playwright/test"

const serverUrl = "http://127.0.0.1:4096"

test("opens an empty Company and configures providers from Settings", async ({ page, request }) => {
  const response = await request.get(serverUrl + "/company")
  expect(response.ok()).toBe(true)
  expect(await response.json()).toMatchObject({
    state: "ready",
    company: { name: "Agent Company", provider: null },
  })

  await page.goto("/")
  await expect(page.getByRole("heading", { name: "初始化本地 Company" })).toHaveCount(0)
  await expect(page.locator(".company-channels")).toBeVisible()
  await expect(page.locator('[data-company-state="needs-bootstrap"]')).toHaveCount(0)

  await page.getByRole("button", { name: "打开设置" }).click()
  await page.getByRole("tab", { name: "提供商" }).click()
  await expect(page.locator('[data-component="agent-company-compatible-provider-settings"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "连接" })).toBeVisible()
})

test("expands the thread panel inside the workspace layout", async ({ page }) => {
  await page.setViewportSize({ width: 1038, height: 900 })
  await page.goto("/")

  const newConversation = page.getByRole("button", { name: "新建对话" })
  await expect(newConversation).toHaveCount(1)
  await expect(newConversation).toBeVisible()
  await newConversation.click()

  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector(".company-workspace")
    const main = document.querySelector(".company-conversation")
    const thread = document.querySelector(".company-thread")
    if (!workspace || !main || !thread) throw new Error("Expected the open thread layout")
    const workspaceRect = workspace.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    const threadRect = thread.getBoundingClientRect()
    return {
      threadPosition: getComputedStyle(thread).position,
      mainRight: mainRect.right,
      threadLeft: threadRect.left,
      threadRight: threadRect.right,
      workspaceRight: workspaceRect.right,
    }
  })

  expect(geometry.threadPosition).toBe("relative")
  expect(Math.abs(geometry.mainRight - geometry.threadLeft)).toBeLessThan(2)
  expect(geometry.threadRight).toBeLessThanOrEqual(geometry.workspaceRight + 1)
})
