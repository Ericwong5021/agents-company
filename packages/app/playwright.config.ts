import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const serverURL = `http://${serverHost}:${serverPort}`
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const reporter = [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]] as const

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter,
  webServer: [
    {
      command: "bun run e2e/m1-server.ts",
      url: serverURL + "/global/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PLAYWRIGHT_BASE_URL: baseURL,
        PLAYWRIGHT_PORT: String(port),
        PLAYWRIGHT_SERVER_HOST: serverHost,
        PLAYWRIGHT_SERVER_PORT: serverPort,
      },
    },
    {
      command,
      url: baseURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        VITE_AGENTCOMPANY_SERVER_HOST: serverHost,
        VITE_AGENTCOMPANY_SERVER_PORT: serverPort,
      },
    },
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "company-bootstrap",
      testMatch: "company-bootstrap.spec.ts",
      retries: 0,
      use: { ...devices["Desktop Chrome"], locale: "zh-CN" },
    },
    {
      name: "app-shell",
      testMatch: "app-shell.spec.ts",
      use: { ...devices["Desktop Chrome"], locale: "zh-CN" },
    },
  ],
})
