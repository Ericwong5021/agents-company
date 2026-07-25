import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const controlPlaneURL = "http://127.0.0.1:3311"
const candidateRoot = path.resolve(
  import.meta.dirname,
  "../../../.artifacts/experience-refactor/r0-candidate",
)
const screenshotRoot = path.join(candidateRoot, "screenshots")

async function setControlPlaneMode(request: APIRequestContext, mode: string) {
  const response = await request.put(`${controlPlaneURL}/__test/mode`, {
    data: { mode, reset: true },
  })
  expect(response.ok()).toBe(true)
}

async function open(page: Page, pathName: string, first = false) {
  await page.goto(first
    ? `/login?redirect=${encodeURIComponent(pathName)}`
    : pathName)
  await page.waitForURL(url => url.pathname === pathName)
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible()
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo(0, 0)
    document.querySelector(".ac-shell-workspace")?.scrollTo(0, 0)
  })
  await page.screenshot({
    path: path.join(screenshotRoot, `${name}.png`),
    fullPage: true,
  })
}

test("renders the eight R0 human-review screenshot candidates", async ({ page, request }) => {
  await mkdir(screenshotRoot, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1600 })

  await setControlPlaneMode(request, "empty-work")
  await open(page, "/inbox", true)
  await expect(page.getByRole("heading", { name: "让本地 AI 团队接手第一个交付目标" })).toBeVisible()
  await capture(page, "first-run")

  await setControlPlaneMode(request, "ready")
  await open(page, "/inbox")
  await expect(page.getByRole("link", { name: /审查发布候选/ })).toBeVisible()
  await capture(page, "inbox")

  await open(page, "/work/project-brief")
  await expect(page.getByRole("heading", { level: 1, name: "定义本地研究交付" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "目标摘要" })).toBeVisible()
  await capture(page, "goal-brief")

  await open(page, "/work/project-running")
  await expect(page.getByText("执行中", { exact: true })).toBeVisible()
  await capture(page, "running")

  await open(page, "/work/project-blocked")
  await expect(page.getByText("受阻", { exact: true })).toBeVisible()
  await capture(page, "blocked")

  await open(page, "/work/project-gate")
  await expect(page.getByText("等待审批", { exact: true })).toBeVisible()
  await capture(page, "gate")

  await open(page, "/work/project-delivered")
  await expect(page.getByText("已交付", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "交付版本 1" })).toBeVisible()
  await expect(page.getByText("1 项成果")).toBeVisible()
  await expect(page.getByRole("link", { name: /体验审查报告/ })).toBeVisible()
  await capture(page, "delivery")

  await open(page, "/team")
  await expect(page.getByRole("heading", { level: 2, name: "小岚" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "阿衡" })).toBeVisible()
  await capture(page, "team")

  const names = [
    "first-run",
    "inbox",
    "goal-brief",
    "running",
    "blocked",
    "gate",
    "delivery",
    "team",
  ]
  await writeFile(
    path.join(candidateRoot, "sha256-manifest.txt"),
    `${(await Promise.all(names.map(async (name) =>
      `${createHash("sha256").update(await readFile(path.join(screenshotRoot, `${name}.png`))).digest("hex")}  screenshots/${name}.png`,
    ))).join("\n")}\n`,
  )
})
