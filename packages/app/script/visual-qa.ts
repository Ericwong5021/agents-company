import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "@playwright/test"

const baseURL = process.env.EVE_QA_BASE_URL || "http://127.0.0.1:3210"
const outputDir = path.resolve(import.meta.dirname, "../design-qa-artifacts")
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
  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Need an account? Sign up", exact: true }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Agent Company Visual QA")
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`visual-qa-${Date.now()}@agent-company.local`)
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("Local-Visual-QA-2026!")
  await page.getByRole("button", { name: "Create account", exact: true }).click()
  await page.waitForURL(`${baseURL}/company`)

  const desktop = await captureSet(page, [
    ["company-desktop", "/company", "Agent Company"],
    ["board-desktop", "/company/board", "Roundtable"],
    ["employees-desktop", "/company/employees", "Employees"],
    ["settings-desktop", "/settings/company", "Settings"],
  ])

  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await captureSet(page, [
    ["company-mobile", "/company", "Agent Company"],
    ["board-mobile", "/company/board", "Roundtable"],
    ["settings-mobile", "/settings/company", "Settings"],
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
