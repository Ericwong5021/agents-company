import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { finalizeNetworkAudit, installNetworkAudit } from "./network-audit"

// QA-01：以完整用户成果闭环覆盖 R1—R3 已实现的只读交付路径。
// 受契约约束（ExperienceR0ImplementedMutationActions = []），Accept/请求修改/Gate 决策等变更类动作
// 在当前版本恒为禁用；这些用例只验证“如实禁用且不伪造成功”，真正的接受/返工闭环留待后端接线后补齐。

const controlPlaneURL = "http://127.0.0.1:3311"

async function enterWorkspace(page: Page, path = "/inbox") {
  await page.goto(`/login?redirect=${encodeURIComponent(path)}`)
  await page.waitForURL((url) => url.pathname === path)
}

async function setControlPlaneMode(request: APIRequestContext, mode: string, reset = false) {
  const response = await request.put(`${controlPlaneURL}/__test/mode`, { data: { mode, reset } })
  expect(response.ok()).toBe(true)
}

async function screenshotFromTop(page: Page, path: string) {
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo(0, 0)
    document.querySelector(".ac-shell-workspace")?.scrollTo(0, 0)
  })
  await page.screenshot({ path, fullPage: true })
}

test.beforeEach(async ({ context, request }) => {
  await installNetworkAudit(context)
  await setControlPlaneMode(request, "ready", true)
})

test.afterEach(async ({ context }, testInfo) => {
  await finalizeNetworkAudit(context, testInfo)
})

test("@r1-r3-flows @scenario-deliv05 presents a result-centric delivery package with an acceptance checklist", async ({
  page,
}, testInfo) => {
  await enterWorkspace(page, "/work/project-delivered")

  const delivery = page.locator(".ac-detail-panel", { hasText: "交付版本 1" })
  await expect(delivery).toBeVisible()

  // Delivered 与 Accepted 必须可区分：pending 交付显示“待验收”并提示需要用户判断。
  const stage = delivery.locator(".ac-status-badge[data-stage]")
  await expect(stage).toHaveAttribute("data-stage", "delivered")
  await expect(stage).toHaveText("待验收")
  await expect(delivery.locator(".ac-delivery-hint").first()).toContainText("执行工作项已完成，成果仍待你逐项核对")

  // 可消费成果链接必须真实指向 Artifact 详情页。
  const artifactLink = delivery.getByRole("link", { name: /体验审查报告/ })
  await expect(artifactLink).toHaveAttribute("href", "/library/artifacts/project-delivered/artifact-report")

  // 验收标准逐项核对清单来自最初的 Goal Brief；逐项结论未由后端下发时统一标记为“未逐项核对”，不伪造 pass。
  const checklist = delivery.locator(".ac-acceptance__item")
  await expect(checklist).toHaveCount(2)
  await expect(checklist.locator(".ac-acceptance__verdict")).toHaveText(["待你核对", "待你核对"])
  await expect(delivery).toContainText("报告可直接打开并阅读。")
  await expect(delivery).toContainText("关键结论保留来源。")

  await screenshotFromTop(page, testInfo.outputPath("delivery-package.png"))
})

test("@r1-r3-flows @scenario-deliv03 opens a delivered artifact with inline preview and consumption actions", async ({
  page,
}, testInfo) => {
  await enterWorkspace(page, "/library/artifacts/project-delivered/artifact-report")

  await expect(page.locator("section").getByRole("heading", { level: 1, name: "体验审查报告", exact: true })).toBeVisible()

  // DELIV-03：真实成果必须可打开、可下载、可复制链接，而不是只展示 kind/title/status。
  const download = page.getByRole("link", { name: "下载成果" })
  await expect(download).toHaveAttribute("download", /.+/)
  await expect(page.getByRole("button", { name: "复制链接" })).toBeVisible()

  // Markdown 走安全的内联文本预览，并携带正文真实内容。
  const preview = page.locator(".ac-readable-artifact")
  await expect(preview).toBeVisible()
  await expect(preview).toContainText("体验审查报告")
  await expect(preview).toContainText("核心路径已完成审查，交付状态与证据来源均可追溯。")
  await expect(page.locator(".ac-artifact-meta")).toContainText("Markdown 文档")

  await screenshotFromTop(page, testInfo.outputPath("artifact-markdown.png"))
})

test("@r1-r3-flows @scenario-deliv03 shows a truthful error for a missing artifact instead of a fake success", async ({
  page,
}) => {
  await enterWorkspace(page, "/library/artifacts/project-delivered/artifact-missing")

  await expect(page.getByRole("heading", { level: 1, name: "成果暂时不可用" })).toBeVisible()
  await expect(page.locator("body")).not.toContainText("体验审查报告")
  await expect(page.getByRole("button", { name: "重新读取" })).toBeVisible()
})
