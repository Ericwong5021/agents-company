import { defineConfig, devices } from "@playwright/test"

const baseURL = "http://127.0.0.1:3312"
const controlPlaneURL = "http://127.0.0.1:3311"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "production.spec.ts",
  outputDir: ".artifacts/e2e-production/test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["junit", { outputFile: ".artifacts/e2e-production/junit.xml" }],
    ["html", { outputFolder: ".artifacts/e2e-production/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-production",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun e2e/fake-control-plane.ts",
      url: `${controlPlaneURL}/__test/state`,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
    },
    {
      command: "bun script/production-e2e-server.ts",
      url: `${baseURL}/login`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
      env: {
        HOST: "127.0.0.1",
        PORT: "3312",
        NUXT_DEVTOOLS: "false",
        BETTER_AUTH_URL: baseURL,
        BETTER_AUTH_SECRET: "agent-company-r0-shell-production-test-secret",
        INTERNAL_API_SECRET: "agent-company-r0-shell-production-internal-test-secret",
        AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneURL,
        AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION: "e2e-control-plane-token",
      },
    },
  ],
})
