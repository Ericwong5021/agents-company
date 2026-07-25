import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "@playwright/test"

const baseURL = process.env.AGENT_COMPANY_QA_BASE_URL || "http://127.0.0.1:3210"
const outputDir = path.resolve(import.meta.dirname, "../.artifacts/visual-qa")
const browser = await chromium.launch()
const timeout = setTimeout(() => void browser.close(), 60_000)

async function capture(
  page: Page,
  name: string,
  route: string,
  heading: string,
) {
  await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible" })
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true })

  return page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    workspaceWidth: document.documentElement.getBoundingClientRect().width,
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }))
}

type Scenario = readonly [name: string, route: string, heading: string]
type CaptureEntry = readonly [string, Awaited<ReturnType<typeof capture>>]

async function captureSet(page: Page, scenarios: readonly Scenario[]) {
  return Object.fromEntries(
    await scenarios.reduce<Promise<CaptureEntry[]>>(
      async (entries, [name, route, heading]) => [
        ...(await entries),
        [name, await capture(page, name, route, heading)],
      ],
      Promise.resolve([]),
    ),
  )
}

try {
  await mkdir(outputDir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${baseURL}/inbox`, { waitUntil: "domcontentloaded" })
  await page.waitForURL(`${baseURL}/inbox`)

  const desktop = await captureSet(page, [
    ["inbox-desktop", "/inbox", "Inbox"],
    ["work-desktop", "/work", "Work"],
    ["team-desktop", "/team", "Team"],
    ["settings-desktop", "/settings", "Settings"],
  ])

  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await captureSet(page, [
    ["inbox-mobile", "/inbox", "Inbox"],
    ["work-mobile", "/work", "Work"],
    ["team-mobile", "/team", "Team"],
    ["settings-mobile", "/settings", "Settings"],
  ])

  const metrics = { baseURL, capturedAt: new Date().toISOString(), desktop, mobile }
  if (
    Object.values({ ...desktop, ...mobile }).some(
      (entry) =>
        entry.horizontalOverflow ||
        entry.workspaceWidth !== entry.viewport.width ||
        entry.scrollWidth !== entry.viewport.width,
    )
  ) {
    throw new Error("Visual QA failed: workspace width or horizontal overflow contract was violated.")
  }

  await Bun.write(path.join(outputDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`)
  console.log(`Visual QA passed. Artifacts: ${outputDir}`)
} finally {
  clearTimeout(timeout)
  await browser.close()
}
