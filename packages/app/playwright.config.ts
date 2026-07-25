import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3310"
const controlPlaneURL = "http://127.0.0.1:3311"

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".artifacts/e2e/test-results",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT ?? ".artifacts/e2e/junit.xml" }],
    ["html", { outputFolder: ".artifacts/e2e/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: "bun e2e/fake-control-plane.ts",
          url: `${controlPlaneURL}/__test/state`,
          timeout: 30_000,
          reuseExistingServer: false,
          stdout: "ignore",
          stderr: "ignore",
        },
        {
          command: process.env.PLAYWRIGHT_APP_SERVER_COMMAND ?? "bun run dev",
          url: `${baseURL}/login`,
          timeout: 180_000,
          reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
          stdout: "ignore",
          stderr: "ignore",
          env: {
            PORT: "3310",
            NUXT_DEVTOOLS: "false",
            BETTER_AUTH_URL: baseURL,
            BETTER_AUTH_SECRET: "agent-company-r0-shell-local-test-secret",
            INTERNAL_API_SECRET: "agent-company-r0-shell-internal-test-secret",
            AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneURL,
            AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION: "e2e-control-plane-token",
          },
        },
      ],
})
