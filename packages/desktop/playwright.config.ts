import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type ReporterDescription } from "@playwright/test"

const reporter: ReporterDescription[] = [["line"]]
const webUIURL = "http://127.0.0.1:3210"
const controlPlaneURL = "http://127.0.0.1:4397"
const desktop = path.dirname(fileURLToPath(import.meta.url))

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./.artifacts/m2-desktop/test-results",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter,
  webServer: {
    command: "bun script/production-e2e-server.ts",
    cwd: path.resolve(desktop, "../app"),
    url: `${webUIURL}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOST: "127.0.0.1",
      PORT: "3210",
      NUXT_DEVTOOLS: "false",
      BETTER_AUTH_URL: webUIURL,
      BETTER_AUTH_SECRET: "agent-company-desktop-e2e-local-test-secret",
      INTERNAL_API_SECRET: "agent-company-desktop-e2e-internal-test-secret",
      AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneURL,
    },
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
