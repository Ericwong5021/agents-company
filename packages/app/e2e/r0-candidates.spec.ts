import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const controlPlaneURL = "http://127.0.0.1:3311"
const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
test.use({
  colorScheme: "light",
  locale: "zh-CN",
  reducedMotion: "reduce",
  timezoneId: "UTC",
})
const candidateSourcePaths = [
  "package.json",
  "bun.lock",
  "packages/app",
  "packages/shared",
  "packages/ui",
  "packages/sdk/js",
  "docs/product-design/experience-refactor/human-research-protocol.v1.json",
]
const buildSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim()
if (!/^[a-f0-9]{40}$/.test(buildSha)) throw new Error("R0 candidate generation requires a full build SHA.")
const candidateServerEnvironmentOverrides = [
  "PLAYWRIGHT_BASE_URL",
  "PLAYWRIGHT_APP_SERVER_COMMAND",
  "PLAYWRIGHT_REUSE_SERVER",
]
function assertCandidateServerEnvironment() {
  const activeOverrides = candidateServerEnvironmentOverrides.filter((name) => process.env[name] !== undefined)
  if (activeOverrides.length) {
    throw new Error(
      `R0 candidate generation requires the checkout-controlled Playwright servers; remove: ${activeOverrides.join(", ")}`,
    )
  }
}
function assertCandidateSourcesAtHead() {
  assertCandidateServerEnvironment()
  const candidateSourceStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...candidateSourcePaths],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const currentBuildSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim()
  if (currentBuildSha !== buildSha || candidateSourceStatus) {
    throw new Error(
      `R0 candidate generation requires every runtime source to match HEAD ${buildSha}: ${
        currentBuildSha === buildSha ? "" : `HEAD changed to ${currentBuildSha}; `
      }${candidateSourceStatus.split("\0").filter(Boolean).join(", ")}`,
    )
  }
}
const candidateRoot = path.join(repositoryRoot, ".artifacts/experience-refactor", buildSha, "human-review")
const screenshotRoot = path.join(candidateRoot, "screenshots")
const hr01Root = path.join(candidateRoot, "hr01-state-cards")
const protocolPath = path.join(
  repositoryRoot,
  "docs/product-design/experience-refactor/human-research-protocol.v1.json",
)

async function setControlPlaneMode(request: APIRequestContext, mode: string) {
  const response = await request.put(`${controlPlaneURL}/__test/mode`, {
    data: { mode, reset: true },
  })
  expect(response.ok()).toBe(true)
}

async function open(page: Page, pathName: string, first = false) {
  await page.goto(first ? `/login?redirect=${encodeURIComponent(pathName)}` : pathName)
  await page.waitForURL((url) => url.pathname === pathName)
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible()
}

async function capture(page: Page, name: string) {
  assertCandidateSourcesAtHead()
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo(0, 0)
    document.querySelector(".ac-shell-workspace")?.scrollTo(0, 0)
    return document.fonts.ready
  })
  await page.screenshot({
    path: path.join(screenshotRoot, `${name}.png`),
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  })
}

test("renders the eight R0 human-review screenshot candidates", async ({ page, request }) => {
  assertCandidateSourcesAtHead()
  await mkdir(screenshotRoot, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1600 })

  await setControlPlaneMode(request, "empty-work")
  await open(page, "/inbox", true)
  await expect(page.getByRole("heading", { name: "用本地 AI 团队交付第一个目标" })).toBeVisible()
  await expect(page.getByRole("group", { name: "选择开始方式" }).getByRole("button")).toHaveCount(2)
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
  await expect(page.getByLabel("高信号工作流").getByText("执行中", { exact: true })).toBeVisible()
  await capture(page, "running")

  await open(page, "/work/project-blocked")
  await expect(page.getByLabel("高信号工作流").getByText("受阻", { exact: true })).toBeVisible()
  await capture(page, "blocked")

  await open(page, "/work/project-gate")
  await expect(page.getByLabel("高信号工作流").getByText("等待审批", { exact: true })).toBeVisible()
  await capture(page, "gate")

  await open(page, "/work/project-delivered")
  await expect(page.getByLabel("高信号工作流").getByText("已交付", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "交付版本 1" })).toBeVisible()
  await expect(page.getByText("1 项成果")).toBeVisible()
  await expect(page.getByRole("link", { name: /体验审查报告/ })).toBeVisible()
  await capture(page, "delivery")

  await open(page, "/team")
  await expect(page.getByRole("heading", { level: 2, name: "小岚" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "阿衡" })).toBeVisible()
  await capture(page, "team")

  const surfaces = [
    { surface: "First-run", name: "first-run" },
    { surface: "Inbox", name: "inbox" },
    { surface: "Goal Brief", name: "goal-brief" },
    { surface: "Running", name: "running" },
    { surface: "Blocked", name: "blocked" },
    { surface: "Gate", name: "gate" },
    { surface: "Delivery", name: "delivery" },
    { surface: "Team", name: "team" },
  ]
  const screenshots = await Promise.all(
    surfaces.map(async (item) => ({
      surface: item.surface,
      relativePath: path.posix.join("human-review", "screenshots", `${item.name}.png`),
      sha256: createHash("sha256")
        .update(await readFile(path.join(screenshotRoot, `${item.name}.png`)))
        .digest("hex"),
    })),
  )
  assertCandidateSourcesAtHead()
  await writeFile(
    path.join(candidateRoot, "sha256-manifest.txt"),
    `${screenshots.map((item) => `${item.sha256}  ${item.relativePath}`).join("\n")}\n`,
  )
  assertCandidateSourcesAtHead()
  await writeFile(
    path.join(candidateRoot, "screenshots-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        buildSha,
        relativePathBase: "build-artifact-root",
        viewport: { width: 1440, height: 1600 },
        screenshots,
      },
      null,
      2,
    )}\n`,
  )
})

test("renders the twelve label-hidden HR-01 state cards", async ({ page, request }) => {
  assertCandidateSourcesAtHead()
  await mkdir(hr01Root, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1600 })
  await setControlPlaneMode(request, "hr01-states")
  await open(page, "/work", true)

  const protocolSource = await readFile(protocolPath, "utf8")
  const protocol = JSON.parse(protocolSource) as {
    id: string
    version: string
    studies: {
      "HR-01": {
        moderatorScriptVersion: string
        presentation: string
        exactPrompt: string
        prompts: { id: string; stateId: string }[]
      }
    }
  }
  const prompts = protocol.studies["HR-01"].prompts
  const cards = page.locator(".ac-work-card")
  await expect(cards).toHaveCount(prompts.length)
  await expect(page.locator(".ac-card-list")).toHaveCount(1)
  await expect(page.locator(".company-connection-state")).toHaveCount(0)
  const dimensions = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }),
  )
  expect(new Set(dimensions.map((item) => Math.round(item.width))).size).toBe(1)
  expect(Math.min(...dimensions.map((item) => item.width))).toBeGreaterThanOrEqual(600)
  expect(Math.min(...dimensions.map((item) => item.height))).toBeGreaterThanOrEqual(140)
  await page.addStyleTag({
    content: ".ac-status-badge { visibility: hidden !important; }",
  })
  await page.evaluate(() => document.fonts.ready)

  const stimuli = []
  for (const prompt of prompts) {
    const card = page.locator(`.ac-work-card:has(.ac-status-badge[data-status="${prompt.stateId}"])`)
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    await expect(card.locator(".ac-status-badge")).toBeHidden()
    const filename = `${prompt.id}.png`
    assertCandidateSourcesAtHead()
    await card.screenshot({
      path: path.join(hr01Root, filename),
      animations: "disabled",
    })
    stimuli.push({
      promptId: prompt.id,
      stateId: prompt.stateId,
      relativePath: path.posix.join("human-review", "hr01-state-cards", filename),
      sha256: createHash("sha256")
        .update(await readFile(path.join(hr01Root, filename)))
        .digest("hex"),
    })
  }
  assertCandidateSourcesAtHead()
  await writeFile(
    path.join(hr01Root, "stimuli-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        buildSha,
        protocol: {
          id: protocol.id,
          version: protocol.version,
          sha256: createHash("sha256").update(protocolSource).digest("hex"),
          studyId: "HR-01",
          moderatorScriptVersion: protocol.studies["HR-01"].moderatorScriptVersion,
        },
        presentation: protocol.studies["HR-01"].presentation,
        exactPrompt: protocol.studies["HR-01"].exactPrompt,
        stateLabelHidden: true,
        relativePathBase: "build-artifact-root",
        viewport: { width: 1440, height: 1600 },
        stimuli,
      },
      null,
      2,
    )}\n`,
  )
})
