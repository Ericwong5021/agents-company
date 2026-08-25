import assert from "node:assert/strict"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, expect as playwrightExpect } from "@playwright/test"
import { z } from "zod"

const expect = playwrightExpect.configure({ timeout: 30_000 })

const packageRoot = path.resolve(import.meta.dir, "..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const controlPlaneRoot = path.join(repositoryRoot, "packages/control-plane")
const navigation = [
  { label: "公司总览", route: "/company", heading: "Agent Company" },
  { label: "收件箱", route: "/inbox" },
  { label: "工作", route: "/work" },
  { label: "董事会", route: "/company/board", heading: "董事会" },
  { label: "运营日志", route: "/company/operations", heading: "运营中心" },
  { label: "团队", route: "/team" },
  { label: "成果库", route: "/library" },
  { label: "设置", route: "/settings" },
] as const
const legacyRoutes = [
  { from: "/company", to: "/company" },
  { from: "/company/board", to: "/company/board" },
  { from: "/company/employees", to: "/team" },
  { from: "/company/projects/legacy", to: "/work/legacy" },
  { from: "/chat", to: "/work" },
  { from: "/chat/legacy", to: "/work" },
  { from: "/settings/profile", to: "/settings" },
  { from: "/settings/integrations", to: "/settings" },
  { from: "/settings/company", to: "/settings" },
] as const
const deferredRoutes = ["/life", "/ambient", "/dreaming", "/agent-home", "/departments", "/office"] as const
const scenarios = [
  {
    id: "default",
    config: {},
    expected: { dream: false, distill: false },
  },
  {
    id: "dream-distill-enabled",
    config: {
      dream: { auto: true, interval_days: 0 },
      distill: { auto: true, interval_days: 0 },
    },
    expected: { dream: true, distill: true },
  },
] as const
const configPayload = z.object({
  dream: z.object({ auto: z.boolean().optional() }).optional(),
  distill: z.object({ auto: z.boolean().optional() }).optional(),
})
const companyPayload = z.object({
  data_directory: z.string(),
  company: z.object({ id: z.string() }),
})
const snapshotPayload = z.object({
  company: z.object({ id: z.string() }),
  issue: z.object({
    diagnostic: z.object({ endpoint: z.string() }),
  }),
})

function capture(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let output = ""
  const done = (async () => {
    const reader = stream.getReader()

    for (;;) {
      const result = await reader.read()
      if (result.done) break
      output = `${output}${decoder.decode(result.value, { stream: true })}`.slice(-16_000)
    }

    output = `${output}${decoder.decode()}`.slice(-16_000)
  })()

  return {
    done,
    read: () => output,
  }
}

function startProcess(input: { cmd: string[]; cwd: string; env: Record<string, string | undefined> }) {
  const child = Bun.spawn({
    ...input,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = capture(child.stdout)
  const stderr = capture(child.stderr)

  return {
    child,
    output: () => `${stdout.read()}\n${stderr.read()}`.trim(),
    drained: Promise.all([stdout.done, stderr.done]),
  }
}

async function stopProcess(process: ReturnType<typeof startProcess>) {
  if (process.child.exitCode === null) process.child.kill("SIGTERM")
  const graceful = await Promise.race([process.child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])

  if (!graceful && process.child.exitCode === null) process.child.kill("SIGKILL")
  await process.child.exited
  await process.drained
}

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Unable to allocate an isolated loopback port."))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function waitForReady(process: ReturnType<typeof startProcess>, url: string) {
  const deadline = Date.now() + 180_000

  for (;;) {
    const ready = await fetch(url)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    if (process.child.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready.\n${process.output()}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${url}.\n${process.output()}`)
    }
    await Bun.sleep(250)
  }
}

async function runScenario(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  matrixRoot: string,
  webuiRoot: string,
  scenario: (typeof scenarios)[number],
) {
  const scenarioRoot = path.join(matrixRoot, scenario.id)
  const webuiScenarioRoot = path.join(webuiRoot, scenario.id)
  const controlPlaneHome = path.join(scenarioRoot, "control-plane")
  const isolatedHome = path.join(scenarioRoot, "home")
  const workspace = path.join(scenarioRoot, "workspace")
  const webuiData = path.join(webuiScenarioRoot, "data")
  const webuiBuild = path.join(webuiScenarioRoot, "build")
  const webuiOutput = path.join(webuiScenarioRoot, "output")
  const xdg = {
    data: path.join(scenarioRoot, "xdg-data"),
    config: path.join(scenarioRoot, "xdg-config"),
    cache: path.join(scenarioRoot, "xdg-cache"),
    state: path.join(scenarioRoot, "xdg-state"),
  }

  await Promise.all([
    fs.mkdir(controlPlaneHome, { recursive: true }),
    fs.mkdir(isolatedHome, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(webuiData, { recursive: true }),
    ...Object.values(xdg).map((directory) => fs.mkdir(directory, { recursive: true })),
  ])

  const controlPlanePort = await availablePort()
  const controlPlaneURL = `http://127.0.0.1:${controlPlanePort}`
  const sharedEnvironment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("AGENTCOMPANY_") &&
          !key.startsWith("XDG_") &&
          !["HOME", "USERPROFILE", "DATABASE_URL"].includes(key),
      ),
    ),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    AGENTCOMPANY_HOME: controlPlaneHome,
    XDG_DATA_HOME: xdg.data,
    XDG_CONFIG_HOME: xdg.config,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
    AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
    AGENTCOMPANY_PURE: "1",
  }
  const controlPlane = startProcess({
    cmd: [
      process.execPath,
      "--preload",
      path.join(packageRoot, "script/process-owner-monitor.mjs"),
      "--conditions=browser",
      path.join(controlPlaneRoot, "src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(controlPlanePort),
    ],
    cwd: workspace,
    env: {
      ...sharedEnvironment,
      AGENT_COMPANY_PROCESS_OWNER_PID: String(process.pid),
      ...(scenario.id === "default" ? {} : { AGENTCOMPANY_CONFIG_CONTENT: JSON.stringify(scenario.config) }),
    },
  })

  try {
    await waitForReady(controlPlane, `${controlPlaneURL}/config`)
    const config = configPayload.parse(await fetch(`${controlPlaneURL}/config`).then((response) => response.json()))
    assert.equal(config.dream?.auto ?? false, scenario.expected.dream)
    assert.equal(config.distill?.auto ?? false, scenario.expected.distill)

    const company = companyPayload.parse(await fetch(`${controlPlaneURL}/company`).then((response) => response.json()))
    assert.equal(company.data_directory, path.join(controlPlaneHome, "data"))
    assert.equal(company.company?.id, "cmp_local")

    const webuiPort = await availablePort()
    const webuiURL = `http://127.0.0.1:${webuiPort}`
    const webui = startProcess({
      cmd: [process.execPath, path.join(packageRoot, "script/dev.ts")],
      cwd: packageRoot,
      env: {
        ...sharedEnvironment,
        PORT: String(webuiPort),
        HOST: "127.0.0.1",
        NUXT_DEVTOOLS: "false",
        NUXT_TELEMETRY_DISABLED: "1",
        BETTER_AUTH_URL: webuiURL,
        BETTER_AUTH_SECRET: `r0-config-matrix-${scenario.id}-local-auth-secret`,
        INTERNAL_API_SECRET: `r0-config-matrix-${scenario.id}-internal-api-secret`,
        AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneURL,
        AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION: "",
        AGENT_COMPANY_WEBUI_DATA_DIR: webuiData,
        AGENT_COMPANY_WEBUI_BUILD_DIR: webuiBuild,
        AGENT_COMPANY_WEBUI_OUTPUT_DIR: webuiOutput,
        AGENT_COMPANY_NUXT_EXTERNAL_OWNER_PID: String(process.pid),
      },
    })

    try {
      await waitForReady(webui, `${webuiURL}/login`)
      const context = await browser.newContext({ baseURL: webuiURL })

      try {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url())
          if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
            await route.continue()
            return
          }
          await route.abort("blockedbyclient")
        })

        const page = await context.newPage()
        const loginResponse = page.waitForResponse((response) => {
          return response.url().endsWith("/api/auth/local") && response.request().method() === "POST"
        })
        await page.goto("/login")
        const loginStatus = (await loginResponse).status()
        assert.equal(loginStatus >= 200 && loginStatus < 300, true)
        await expect(page).toHaveURL((url) => url.pathname === "/inbox")

        const snapshotResponse = await context.request.get("/api/agent-company/snapshot")
        assert.equal(snapshotResponse.ok(), true)
        const snapshot = snapshotPayload.parse(await snapshotResponse.json())
        assert.equal(snapshot.company?.id, "cmp_local")
        assert.equal(snapshot.issue?.diagnostic?.endpoint, controlPlaneURL)

        await page.goto("/")
        await expect(page).toHaveURL((url) => url.pathname === "/inbox")

        for (const item of navigation) {
          const response = await page.goto(item.route)
          assert.equal(response?.status(), 200)
          await expect(page).toHaveURL((url) => url.pathname === item.route)
          await expect(page).toHaveTitle(`${item.label} · Agent Company`)
          await expect(page.getByRole("heading", { level: 1, name: item.heading ?? item.label })).toBeVisible()
          await expect(
            page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: item.label }),
          ).toHaveAttribute("aria-current", "page")

          const hrefs = await page.locator("a[href]").evaluateAll((links) =>
            links.flatMap((link) => {
              const href = link.getAttribute("href")
              return href ? [new URL(href, document.baseURI).pathname] : []
            }),
          )
          assert.equal(
            deferredRoutes.some((route) => hrefs.includes(route)),
            false,
          )
        }

        assert.deepEqual(
          (await page.getByRole("navigation", { name: "主导航" }).getByRole("link").evaluateAll(links =>
            links.map(link => link.getAttribute("aria-label") ?? "")))
            .filter(label => navigation.some(item => item.label === label)),
          navigation.map(item => item.label),
        )

        for (const route of legacyRoutes) {
          await page.goto(route.from)
          await expect(page).toHaveURL((url) => url.pathname === route.to)
        }

        for (const route of deferredRoutes) {
          const response = await page.goto(route)
          assert.equal(response?.status(), 404)
          await expect(page).toHaveURL((url) => url.pathname === route)
          await expect(page.getByRole("heading", { level: 1, name: "页面不存在" })).toBeVisible()
        }
      } finally {
        await context.close()
      }
    } finally {
      await stopProcess(webui)
    }

    return {
      id: scenario.id,
      config: scenario.expected,
      navigation: navigation.map((item) => item.route),
      legacyRoutes: legacyRoutes.length,
      deferredRoutes: deferredRoutes.length,
      controlPlaneData: "isolated",
      webuiData: "isolated",
    }
  } finally {
    await stopProcess(controlPlane)
  }
}

const linker = Bun.spawn({
  cmd: [process.execPath, path.join(packageRoot, "script/link-eve-dependencies.ts")],
  cwd: packageRoot,
  stdout: "inherit",
  stderr: "inherit",
})
assert.equal(await linker.exited, 0)

await fs.mkdir(path.join(packageRoot, ".artifacts"), { recursive: true })
const matrixRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-r0-config-matrix-"))
const webuiRoot = await fs.mkdtemp(path.join(packageRoot, ".artifacts/r0-config-matrix-"))

try {
  const browser = await chromium.launch({ headless: true })

  try {
    const results = []
    for (const scenario of scenarios) {
      results.push(await runScenario(browser, matrixRoot, webuiRoot, scenario))
    }
    console.log(JSON.stringify({ status: "pass", scenarios: results }, null, 2))
  } finally {
    await browser.close()
  }
} finally {
  assert.equal(matrixRoot.startsWith(path.join(os.tmpdir(), "agent-company-r0-config-matrix-")), true)
  assert.equal(webuiRoot.startsWith(path.join(packageRoot, ".artifacts/r0-config-matrix-")), true)
  await Promise.all([
    fs.rm(matrixRoot, { recursive: true, force: true }),
    fs.rm(webuiRoot, { recursive: true, force: true }),
  ])
}
