import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "@playwright/test"

const baseURL = process.env.AGENT_COMPANY_QA_BASE_URL || "http://127.0.0.1:3210"
const outputDir = path.resolve(import.meta.dirname, "../.artifacts/visual-qa")
const browser = await chromium.launch()
const timeout = setTimeout(() => void browser.close(), 300_000)

async function capture(
  page: Page,
  name: string,
  route: string,
  heading: string,
) {
  await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible" })
  await page.locator('.ac-app-titlebar__status[data-connection="ready"]').waitFor({ state: "attached" })
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
type Viewport = readonly [name: string, width: number, height: number]

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

  const scenarios = [
    ["company", "/company", "Agent Company"],
    ["inbox", "/inbox", "收件箱"],
    ["team", "/team", "团队"],
    ["library", "/library", "成果库"],
    ["settings", "/settings", "设置"],
  ] as const satisfies readonly Scenario[]
  const viewports = [
    ["desktop-1440", 1440, 900],
    ["desktop-1280", 1280, 800],
    ["tablet-1024", 1024, 768],
    ["mobile-390", 390, 844],
  ] as const satisfies readonly Viewport[]
  const metrics: Record<string, Record<string, Awaited<ReturnType<typeof capture>>>> = {}
  for (const [name, width, height] of viewports) {
    await page.setViewportSize({ width, height })
    metrics[name] = await captureSet(page, scenarios.map(([scenario, route, heading]) => [
      `${scenario}-${name}`,
      route,
      heading,
    ]))
  }
  const result = { baseURL, capturedAt: new Date().toISOString(), viewports: metrics }
  if (
    Object.values(metrics).flatMap(entries => Object.values(entries)).some(
      (entry) =>
        entry.horizontalOverflow ||
        entry.workspaceWidth !== entry.viewport.width ||
        entry.scrollWidth !== entry.viewport.width,
    )
  ) {
    throw new Error("Visual QA failed: workspace width or horizontal overflow contract was violated.")
  }

  await Bun.write(path.join(outputDir, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Visual QA passed. Artifacts: ${outputDir}`)
} finally {
  clearTimeout(timeout)
  await browser.close()
}
