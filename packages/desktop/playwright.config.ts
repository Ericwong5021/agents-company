import { defineConfig, type ReporterDescription } from "@playwright/test"

const reporter: ReporterDescription[] = [["line"]]

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
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
