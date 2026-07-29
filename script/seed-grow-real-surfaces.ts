import crypto from "node:crypto"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"

const root = path.resolve(import.meta.dir, "..")
const appRoot = path.join(root, "packages/app")
const controlPlaneRoot = path.join(root, "packages/control-plane")
const desktopRoot = path.join(root, "packages/desktop")
const appRequire = createRequire(path.join(appRoot, "package.json"))
const desktopRequire = createRequire(path.join(desktopRoot, "package.json"))
const chromium = appRequire("@playwright/test").chromium
const electronPath = desktopRequire("electron") as string
const candidateSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
})
  .stdout.toString()
  .trim()
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-seed-grow-real-"))
const modelsSnapshotPath = path.join(temporaryRoot, "models.json")
await fs.writeFile(modelsSnapshotPath, "{}\n")
await fs.mkdir(path.join(appRoot, ".artifacts"), { recursive: true })
const evidenceRoot = path.join(appRoot, ".artifacts/seed-grow-b4")
await fs.rm(evidenceRoot, { recursive: true, force: true })
await fs.mkdir(evidenceRoot, { recursive: true })
const evidenceReport = path.join(evidenceRoot, "result.json")
const beforeScreenshot = path.join(evidenceRoot, "work-before-restart.png")
const afterScreenshot = path.join(evidenceRoot, "work-after-restart.png")
const webUIRuntimeRoot = await fs.mkdtemp(path.join(appRoot, ".artifacts/seed-grow-real-runtime-"))

const projectTitle = "B4 自动验收：真实 Seed-and-Grow"
const projectGoal = "读取本地项目事实并交付一份可复核、无外部副作用的证据结论"
const firstSlice = {
  id: "b4-first-real-slice",
  title: "形成 B4 第一份可复核证据结论",
  description: "分析本地项目文件与运行时事实，形成可追溯的 First Slice。",
  work_type: "analysis",
  role: "evidence analyst",
  capability_packs: ["research-analysis@1"],
  decision_scope: ["证据含义"],
  resource_scope: ["artifacts/b4-evidence-analysis"],
  acceptance_criteria: ["方法、发现、结论与限制完整"],
  reality_contact: 3,
  information_gain: 3,
  user_value: 2,
  reversible: true,
  dependency_count: 0,
  reality_anchor: "本地项目文件与运行时",
  within_authorized_scope: true,
  external_side_effect: false,
}
const wayfinderReply = {
  summary: "已完成 B4 只读现实检查",
  confirmed_facts: ["项目文件可读取", "First Slice 可在本地完成"],
  invalidated_assumptions: [],
  unknowns: ["生产发布凭据未知"],
  blockers: [],
  capability_gaps: [],
  recommended_first_slice: firstSlice,
  dependency_proposals: [],
  questions: ["是否允许后续生产发布"],
}
const builderReply = {
  summary: "B4 第一份证据结论已完成",
  submission: {
    question: "本地证据说明了什么",
    dataSources: ["项目文件", "本地运行时"],
    methodology: "先读取项目文件与本地运行时，再结构化归类事实，并将每个结论逐项映射回对应证据。",
    findings: ["First Slice 已接触真实项目文件与运行时。"],
    conclusions: ["限定范围内的分析交付满足验收条件。"],
    limitations: ["未执行外部发布"],
  },
}

async function freePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("reserved")
    },
  })
  const port = server.port
  await server.stop(true)
  return port
}

function captureTail(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state = { output: "" }
  const completed = (async () => {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        state.output = `${state.output}${decoder.decode()}`.slice(-24_000)
        return
      }
      state.output = `${state.output}${decoder.decode(chunk.value, { stream: true })}`.slice(-24_000)
    }
  })()
  return {
    completed,
    read() {
      return state.output
    },
  }
}

function start(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    child,
    stdout: captureTail(child.stdout),
    stderr: captureTail(child.stderr),
  }
}

async function terminate(managed: ReturnType<typeof start>) {
  if (managed.child.exitCode === null) {
    if (process.platform === "win32") {
      await Bun.spawn({
        cmd: ["taskkill", "/pid", String(managed.child.pid), "/t", "/f"],
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    } else {
      try {
        process.kill(-managed.child.pid, "SIGTERM")
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
      }
      const graceful = await Promise.race([managed.child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
      if (!graceful && managed.child.exitCode === null) {
        try {
          process.kill(-managed.child.pid, "SIGKILL")
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
        }
      }
    }
  }
  await managed.child.exited
  await Promise.allSettled([managed.stdout.completed, managed.stderr.completed])
}

async function waitForResponse(url: string, managed: ReturnType<typeof start>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null)
    if (response?.ok) return response
    if (managed.child.exitCode !== null) {
      await Promise.allSettled([managed.stdout.completed, managed.stderr.completed])
      throw new Error(`Process exited before ${url} became ready: ${managed.stderr.read()}\n${managed.stdout.read()}`)
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${url}: ${managed.stderr.read()}`)
    await Bun.sleep(250)
  }
}

async function waitForValue<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  timeoutMs: number,
  message: string,
) {
  const deadline = Date.now() + timeoutMs
  let latest: T | undefined
  for (;;) {
    latest = await read()
    if (accepted(latest)) return latest
    if (Date.now() >= deadline) throw new Error(`${message}: ${JSON.stringify(latest)}`)
    await Bun.sleep(250)
  }
}

async function json<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok)
    throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${await response.text()}`)
  return (await response.json()) as T
}

function assertReadiness(readiness: { ready?: boolean; checks?: Array<{ status?: string }> }, message: string) {
  if (
    readiness.ready !== true ||
    !readiness.checks?.length ||
    readiness.checks.some((check) => !["pass", "warning"].includes(check.status ?? ""))
  )
    throw new Error(message)
}

function durableCompanyIdentity(value: unknown) {
  const state = value as {
    data_directory?: unknown
    company?: {
      id?: unknown
      name?: unknown
      data_version?: unknown
      created_at?: unknown
      approval_policy?: unknown
      repository?: unknown
      board?: Array<{ id?: unknown; role?: unknown }>
    }
  }
  if (
    typeof state.data_directory !== "string" ||
    typeof state.company?.id !== "string" ||
    !state.company.id ||
    typeof state.company.name !== "string" ||
    state.company.data_version !== 1 ||
    typeof state.company.created_at !== "number" ||
    !Array.isArray(state.company.board) ||
    state.company.board.length !== 3
  )
    throw new Error("Control Plane company identity is invalid.")
  return {
    dataDirectory: state.data_directory,
    id: state.company.id,
    name: state.company.name,
    dataVersion: state.company.data_version,
    createdAt: state.company.created_at,
    approvalPolicy: state.company.approval_policy,
    repository: state.company.repository,
    board: state.company.board.map((member) => ({ id: member.id, role: member.role })),
  }
}

function asRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function watermark(value: unknown, message: string) {
  const projection = asRecord(value, message)
  if (!["available", "unavailable"].includes(String(projection.availability)))
    throw new Error(`${message}: projection availability is invalid`)
  if (typeof projection.sourceWatermark !== "string" || !/^[a-f0-9]{64}$/.test(projection.sourceWatermark))
    throw new Error(`${message}: invalid sourceWatermark`)
  return projection.sourceWatermark
}

function availableProjection(value: unknown, message: string) {
  const projection = asRecord(value, message)
  if (projection.availability !== "available") throw new Error(`${message}: projection is unavailable`)
  return projection
}

function workProjectionID(value: unknown, message: string) {
  const projection = asRecord(value, message)
  if (projection.availability === "unavailable") {
    if (typeof projection.workId !== "string") throw new Error(`${message}: unavailable workId is invalid`)
    return projection.workId
  }
  const summary = asRecord(projection.summary, `${message}: summary is invalid`)
  if (typeof summary.workId !== "string") throw new Error(`${message}: available workId is invalid`)
  return summary.workId
}

function sourceRefs(value: unknown, message: string) {
  const projection = asRecord(value, message)
  if (!Array.isArray(projection.sourceRefs) || projection.sourceRefs.length === 0)
    throw new Error(`${message}: missing sourceRefs`)
  return projection.sourceRefs
}

async function portClosed(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(500) }).then(
    () => false,
    () => true,
  )
}

function completion(content: string, stream: boolean) {
  if (!stream)
    return Response.json({
      id: "chatcmpl-seed-grow-b4",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 64, completion_tokens: 64, total_tokens: 128 },
    })
  const chunks = [
    {
      id: "chatcmpl-seed-grow-b4",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-seed-grow-b4",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-seed-grow-b4",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 64, completion_tokens: 64, total_tokens: 128 },
    },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function digest(value: Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

async function screenshotDiff(beforePath: string, afterPath: string) {
  const before = await sharp(beforePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const after = await sharp(afterPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (
    before.info.width !== after.info.width ||
    before.info.height !== after.info.height ||
    before.info.channels !== after.info.channels
  )
    throw new Error("Deterministic screenshot dimensions changed after restart.")
  let changedPixels = 0
  let maxChannelDelta = 0
  for (let offset = 0; offset < before.data.length; offset += before.info.channels) {
    let changed = false
    for (let channel = 0; channel < before.info.channels; channel++) {
      const delta = Math.abs(before.data[offset + channel] - after.data[offset + channel])
      if (delta > maxChannelDelta) maxChannelDelta = delta
      if (delta > 0) changed = true
    }
    if (changed) changedPixels += 1
  }
  const pixels = before.info.width * before.info.height
  const ratio = changedPixels / pixels
  if (ratio > 0.001) throw new Error(`Restart screenshot diff ratio ${ratio} exceeds 0.001.`)
  return {
    width: before.info.width,
    height: before.info.height,
    changedPixels,
    ratio,
    maxChannelDelta,
    beforeSha256: digest(await fs.readFile(beforePath)),
    afterSha256: digest(await fs.readFile(afterPath)),
  }
}

async function freezeSurface(page: {
  addStyleTag: (input: { content: string }) => Promise<unknown>
  evaluate: (fn: () => Promise<unknown>) => Promise<unknown>
}) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}",
  })
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

const providerID = "seed-grow-evidence"
const providerModelID = "evidence-model"
const providerRequests: Array<{ path: string; kind: string }> = []
const providerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: providerModelID, name: "Evidence Model" }] })
    if (url.pathname !== "/v1/chat/completions") return new Response("Not found", { status: 404 })
    const body = asRecord(await request.json(), "Provider request body is invalid.")
    const serialized = JSON.stringify(body)
    const kind = serialized.includes("你是 Wayfinder，只读检查现实环境")
      ? "wayfinder"
      : serialized.includes("你的临时角色：evidence analyst")
        ? "builder"
        : serialized.includes("Generate a title for this conversation")
          ? "title"
          : "other"
    providerRequests.push({ path: url.pathname, kind })
    const content =
      kind === "wayfinder"
        ? JSON.stringify(wayfinderReply)
        : kind === "builder"
          ? JSON.stringify(builderReply)
          : kind === "title"
            ? projectTitle
            : "ok"
    return completion(content, body.stream === true)
  },
})
const [controlPlanePort, controlPlaneProxyPort, webUIPort, desktopDebugPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
  freePort(),
])
if (new Set([providerServer.port, controlPlanePort, controlPlaneProxyPort, webUIPort, desktopDebugPort]).size !== 5) {
  await providerServer.stop(true)
  throw new Error("Dynamic ports must be unique.")
}
const providerURL = `http://127.0.0.1:${providerServer.port}`
const controlPlaneURL = `http://127.0.0.1:${controlPlanePort}`
const controlPlaneProxyURL = `http://127.0.0.1:${controlPlaneProxyPort}`
const webUIURL = `http://127.0.0.1:${webUIPort}`
let projectionFault: "none" | "delay" | "error" = "none"
let releaseProjectionDelay = () => undefined
let projectionDelayGate = Promise.resolve()
let projectionDelayHits = 0
const controlPlaneProxy = Bun.serve({
  hostname: "127.0.0.1",
  port: controlPlaneProxyPort,
  idleTimeout: 255,
  async fetch(request) {
    const source = new URL(request.url)
    const target = new URL(`${source.pathname}${source.search}`, controlPlaneURL)
    const projectionRequest = /^\/experience\/work\/[^/]+\/(organization|graph|validation|receipts)\b/.test(
      source.pathname,
    )
    if (projectionRequest && projectionFault === "error")
      return Response.json({ code: "b4_controlled_transport_failure" }, { status: 503 })
    if (projectionRequest && projectionFault === "delay") {
      projectionDelayHits += 1
      await projectionDelayGate
    }
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("content-length")
    headers.delete("accept-encoding")
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      signal: request.signal,
    }).catch((error) => Response.json({ code: "b4_proxy_failure", message: String(error) }, { status: 502 }))
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete("content-encoding")
    responseHeaders.delete("content-length")
    responseHeaders.delete("transfer-encoding")
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  },
})
const companyHome = path.join(temporaryRoot, "control-plane-home")
const controlPlaneEnvironment = {
  ...process.env,
  AGENTCOMPANY_HOME: companyHome,
  AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
  AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
  AGENTCOMPANY_DISABLE_MODELS_FETCH: "1",
  AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
  AGENTCOMPANY_PURE: "1",
  AGENTCOMPANY_SEED_GROW_ORCHESTRATION: "active",
  XDG_DATA_HOME: path.join(temporaryRoot, "xdg-data"),
  XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
  XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
  XDG_STATE_HOME: path.join(temporaryRoot, "xdg-state"),
}
const startControlPlane = () =>
  start(
    [
      process.execPath,
      "--no-orphans",
      "--conditions=browser",
      "./src/index.ts",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(controlPlanePort),
      "--no-auth=true",
    ],
    controlPlaneRoot,
    controlPlaneEnvironment,
  )
const webUIEnvironment = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(webUIPort),
  NUXT_DEVTOOLS: "false",
  BETTER_AUTH_URL: webUIURL,
  BETTER_AUTH_SECRET: "agent-company-seed-grow-local-preview-secret",
  INTERNAL_API_SECRET: "agent-company-seed-grow-local-preview-internal-secret",
  AGENT_COMPANY_CONTROL_PLANE_URL: controlPlaneProxyURL,
  AGENT_COMPANY_WEBUI_DATA_DIR: path.join(temporaryRoot, "webui-data"),
  AGENT_COMPANY_WEBUI_BUILD_DIR: path.join(webUIRuntimeRoot, "build"),
  AGENT_COMPANY_WEBUI_OUTPUT_DIR: path.join(webUIRuntimeRoot, "output"),
}

let controlPlane = startControlPlane()
let webUI: ReturnType<typeof start> | undefined
let browserClose: (() => Promise<void>) | undefined
let desktop: ReturnType<typeof start> | undefined
let result: Record<string, unknown> | undefined
let failure: unknown
const uncovered: string[] = []
let cleanup:
  | {
      providerPortClosed: boolean
      controlPlanePortClosed: boolean
      controlPlaneProxyPortClosed: boolean
      desktopDebugPortClosed: boolean
      webUIPortClosed: boolean
    }
  | undefined

try {
  const health = (await (await waitForResponse(`${controlPlaneURL}/global/health`, controlPlane, 180_000)).json()) as {
    healthy?: boolean
    version?: string
  }
  if (health.healthy !== true || typeof health.version !== "string")
    throw new Error("Real Control Plane health response is invalid.")
  const proxyHealth = await json<{ healthy?: boolean; version?: string }>(`${controlPlaneProxyURL}/global/health`)
  if (proxyHealth.healthy !== true || proxyHealth.version !== health.version)
    throw new Error(`Control Plane transport proxy is invalid: ${JSON.stringify(proxyHealth)}`)
  const readiness = await json<{ ready?: boolean; checks?: Array<{ status?: string }> }>(
    `${controlPlaneURL}/global/readiness`,
  )
  assertReadiness(readiness, "Real Control Plane readiness response is not ready.")
  const providerResponse = await fetch(`${controlPlaneURL}/company/provider`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "openai",
      base_url: `${providerURL}/v1`,
      api_key: "seed-grow-local-evidence-key",
      headers: {},
      provider_id: providerID,
      model_id: providerModelID,
    }),
  })
  if (!providerResponse.ok)
    throw new Error(`Real provider configuration returned ${providerResponse.status}: ${await providerResponse.text()}`)
  const companyBeforeRestart = durableCompanyIdentity(await providerResponse.json())

  for (const transition of [
    {
      idempotencyKey: "b4-real-surfaces-shadow",
      to: "shadow",
      reason: "prepare B4 automatic acceptance",
    },
    {
      idempotencyKey: "b4-real-surfaces-opt-in",
      to: "opt_in",
      reason: "enable B4 automatic acceptance",
    },
  ]) {
    await json(`${controlPlaneURL}/rollout/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transition),
    })
  }
  const rollout = await json<{
    state?: { phase?: string }
    executionMode?: string
    newProjectPolicy?: { seedOptInAllowed?: boolean }
  }>(`${controlPlaneURL}/rollout`)
  if (
    rollout.state?.phase !== "opt_in" ||
    rollout.executionMode !== "active" ||
    rollout.newProjectPolicy?.seedOptInAllowed !== true
  )
    throw new Error(`Seed-and-Grow rollout is not active: ${JSON.stringify(rollout)}`)

  webUI = start([process.execPath, "--no-orphans", "./script/production-e2e-server.ts"], appRoot, webUIEnvironment)
  await waitForResponse(`${webUIURL}/login`, webUI, 480_000)
  const browser = await chromium.launch()
  browserClose = () => browser.close()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "zh-CN",
  })
  const page = await context.newPage()
  let eventStreamRequests = 0
  page.on("request", (request: { url: () => string }) => {
    if (new URL(request.url()).pathname === "/api/agent-company/events") eventStreamRequests += 1
  })
  await page.goto(`${webUIURL}/login`, { waitUntil: "domcontentloaded" })
  await page.waitForURL((url: URL) => url.pathname === "/inbox", { timeout: 60_000 })
  const initialSnapshotResponse = await context.request.get(`${webUIURL}/api/agent-company/snapshot`)
  if (!initialSnapshotResponse.ok())
    throw new Error(`Initial WebUI snapshot returned ${initialSnapshotResponse.status()}.`)
  const initialSnapshot = asRecord(await initialSnapshotResponse.json(), "Initial WebUI snapshot is invalid.")
  if (initialSnapshot.connection !== "ready" || initialSnapshot.issue || !Array.isArray(initialSnapshot.work))
    throw new Error(`Initial WebUI snapshot is not ready: ${JSON.stringify(initialSnapshot)}`)
  await page.goto(`${webUIURL}/work`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: "Work", exact: true }).waitFor({ state: "visible" })
  await page.getByRole("heading", { name: "还没有可展示的工作", exact: true }).waitFor({ state: "visible" })

  const started = await json<{
    project?: { id?: string; execution_strategy?: string; seed_mode?: string }
    run_id?: string
  }>(`${controlPlaneURL}/company-project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: projectTitle,
      goal: projectGoal,
      provider_id: providerID,
      model_id: providerModelID,
      execution_strategy: "seed_and_grow",
      seed_policy: {
        risk_level: "medium",
        scope_defined: true,
        reversible: true,
        stable_sop: false,
        unfamiliar_workspace: true,
        cross_module: true,
        external_side_effect: false,
        blocking_unknowns: [],
        slice_candidates: [firstSlice],
      },
    }),
  })
  if (
    typeof started.project?.id !== "string" ||
    started.project.execution_strategy !== "seed_and_grow" ||
    started.project.seed_mode !== "seed_pair" ||
    typeof started.run_id !== "string"
  )
    throw new Error(`Product API did not create a Seed Pair: ${JSON.stringify(started)}`)
  const projectID = started.project.id
  const detail = await waitForValue(
    () =>
      json<{
        project?: { id?: string; status?: string; execution_strategy?: string; seed_mode?: string }
        work_items?: Array<{
          id?: string
          title?: string
          purpose?: string
          role?: string
          owner_agent_id?: string
          status?: string
        }>
        work_receipts?: Array<{ outcome?: string; summary?: string; unknowns?: string[] }>
      }>(`${controlPlaneURL}/company-project/${encodeURIComponent(projectID)}`),
    (value) => value.project?.status === "completed",
    120_000,
    "Seed Pair did not complete through the real provider",
  )
  const wayfinder = detail.work_items?.find((item) => item.purpose === "discovery")
  const builder = detail.work_items?.find((item) => item.purpose === "first_slice")
  if (
    detail.project?.execution_strategy !== "seed_and_grow" ||
    detail.project.seed_mode !== "seed_pair" ||
    wayfinder?.role !== "project-wayfinder" ||
    builder?.role !== "evidence analyst" ||
    !wayfinder.owner_agent_id ||
    !builder.owner_agent_id ||
    wayfinder.owner_agent_id === builder.owner_agent_id ||
    !detail.work_receipts?.some(
      (receipt) =>
        receipt.outcome === "completed" &&
        receipt.summary === wayfinderReply.summary &&
        receipt.unknowns?.includes("生产发布凭据未知"),
    ) ||
    !providerRequests.some((request) => request.kind === "wayfinder") ||
    !providerRequests.some((request) => request.kind === "builder")
  )
    throw new Error(
      `Real Seed Pair facts are incomplete: ${JSON.stringify({
        project: detail.project,
        workItems: detail.work_items,
        workReceipts: detail.work_receipts,
        providerRequests,
      })}`,
    )

  const initialWorkProjection = asRecord(
    await json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}`),
    "Initial Work projection is invalid.",
  )
  const workProjectionAvailable = initialWorkProjection.availability === "available"
  if (!workProjectionAvailable)
    uncovered.push(
      `Real Seed-and-Grow WorkProjection is unavailable: ${JSON.stringify({
        reason: initialWorkProjection.reason,
        diagnostics: initialWorkProjection.diagnostics,
      })}`,
    )

  await page.locator("a.ac-work-card").filter({ hasText: projectTitle }).waitFor({ state: "visible", timeout: 30_000 })
  const noResults = page.getByRole("heading", { name: "没有符合筛选条件的工作", exact: true })
  await page.getByRole("searchbox", { name: "搜索工作" }).fill("不存在的 B4 工作")
  await noResults.waitFor({ state: "visible" })
  await page.getByRole("button", { name: "清除筛选" }).click()

  const loadingPage = await context.newPage()
  await loadingPage.goto(`${webUIURL}/work`, { waitUntil: "domcontentloaded" })
  projectionDelayHits = 0
  projectionDelayGate = new Promise<void>((resolve) => {
    releaseProjectionDelay = resolve
  })
  projectionFault = "delay"
  const loadingNavigation = loadingPage.locator("a.ac-work-card").filter({ hasText: projectTitle }).click()
  await waitForValue(
    async () => projectionDelayHits,
    (hits) => hits > 0,
    15_000,
    "Controlled projection delay was not exercised",
  )
  await Bun.sleep(250)
  const loadingStateVisible = await loadingPage
    .getByRole("status")
    .filter({ hasText: "正在读取组织与 Graph 事实" })
    .isVisible()
  if (!loadingStateVisible)
    uncovered.push("Production WebUI keeps the previous route during a delayed Seed-and-Grow projection request.")
  releaseProjectionDelay()
  projectionFault = "none"
  await loadingNavigation
  await loadingPage.waitForURL((url: URL) => url.pathname === `/work/${encodeURIComponent(projectID)}`, {
    timeout: 30_000,
  })
  await loadingPage.close()

  const errorPage = await context.newPage()
  projectionFault = "error"
  await errorPage.goto(`${webUIURL}/work/${encodeURIComponent(projectID)}`, { waitUntil: "domcontentloaded" })
  const errorStateVisible = await errorPage.getByRole("alert").filter({ hasText: "无法读取动态组织投影" }).isVisible()
  if (!errorStateVisible)
    uncovered.push("Seed-and-Grow projection error is masked by the unavailable WorkProjection fallback.")
  projectionFault = "none"
  await errorPage.close()

  await page.goto(`${webUIURL}/work/${encodeURIComponent(projectID)}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: projectTitle, exact: true }).waitFor({ state: "visible" })
  if (workProjectionAvailable) {
    await page.getByRole("heading", { name: "动态组织进展", exact: true }).waitFor({ state: "visible" })
    await page.getByText("Wayfinder", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("First slice", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("evidence analyst", { exact: true }).first().waitFor({ state: "visible" })
    await page.getByRole("heading", { name: "发现与调整", exact: true }).waitFor({ state: "visible" })
    await page.getByText("Validation", { exact: true }).waitFor({ state: "visible" })
    const overviewTrace = page.getByText("加入依据", { exact: true }).first()
    await overviewTrace.focus()
    await overviewTrace.press("Enter")
    if (
      (await overviewTrace.evaluate(
        (element: Element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open,
      )) !== true
    )
      throw new Error("Assignment source trace did not open from the keyboard.")
    const overviewDetails = overviewTrace.locator("..")
    if (
      !(await overviewDetails.locator("p").first().textContent())?.trim() ||
      (await overviewDetails.locator("li").count()) === 0
    )
      throw new Error("Assignment selectionReason or sourceRefs are not visible.")

    const firstContextTab = page.getByRole("tab").first()
    await firstContextTab.focus()
    await firstContextTab.press("End")
    const diagnosticsTab = page.getByRole("tab", { name: "诊断", exact: true })
    if ((await diagnosticsTab.getAttribute("aria-selected")) !== "true")
      throw new Error("End did not select the diagnostics tab.")
    const diagnosticsPanel = page.getByRole("tabpanel")
    await diagnosticsPanel.getByText("Graph revision", { exact: true }).waitFor({ state: "visible" })
    await diagnosticsPanel.getByRole("heading", { name: "保留的尝试", exact: true }).waitFor({ state: "visible" })
    const diagnosticsTabID = await diagnosticsTab.getAttribute("id")
    if (!diagnosticsTabID || (await diagnosticsPanel.getAttribute("aria-labelledby")) !== diagnosticsTabID)
      throw new Error("Diagnostics tab and tabpanel ARIA relationship is invalid.")
    await diagnosticsTab.press("Home")
    if ((await firstContextTab.getAttribute("aria-selected")) !== "true")
      throw new Error("Home did not select the first context tab.")
    await diagnosticsTab.focus()
    await diagnosticsTab.press("Enter")
    await diagnosticsPanel.getByText("Graph revision", { exact: true }).waitFor({ state: "visible" })
  } else {
    await page.getByText("状态不可用", { exact: true }).first().waitFor({ state: "visible" })
    uncovered.push("Work cannot render Wayfinder, Builder, Graph, Validation, diagnostics, or Assignment source trace.")
  }

  await page.goto(`${webUIURL}/team`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: "Team", exact: true }).waitFor({ state: "visible" })
  const teamAssignmentVisible = await page.getByText("Assignment evidence", { exact: true }).first().isVisible()
  if (teamAssignmentVisible) {
    await page.getByText("加入原因", { exact: true }).first().waitFor({ state: "visible" })
    await page.getByText("evidence analyst", { exact: true }).first().waitFor({ state: "visible" })
    const teamTrace = page.getByText("查看选择事实", { exact: true }).first()
    await teamTrace.focus()
    await teamTrace.press("Enter")
    if (
      (await teamTrace.evaluate(
        (element: Element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open,
      )) !== true
    )
      throw new Error("Team Assignment source trace did not open from the keyboard.")
    if ((await teamTrace.locator("..").locator("li").count()) === 0)
      throw new Error("Team Assignment sourceRefs are not visible.")
  } else {
    uncovered.push("Team omits Assignment evidence because organization-list excludes unavailable Work projections.")
  }

  const directBefore = await Promise.all([
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/organization`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/graph`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/validation`),
  ])
  const beforeWatermarks = {
    work: watermark(directBefore[0], "Work projection"),
    organization: watermark(directBefore[1], "Organization projection"),
    graph: watermark(directBefore[2], "Graph projection"),
    validation: watermark(directBefore[3], "Validation projection"),
  }
  if (workProjectionAvailable)
    sourceRefs(asRecord(directBefore[0], "Work projection is invalid.").summary, "Work summary")
  directBefore.slice(1).forEach((projection, index) => {
    const label = ["Organization", "Graph", "Validation"][index] ?? "Projection"
    sourceRefs(availableProjection(projection, `${label} projection`), label)
  })
  const organization = availableProjection(directBefore[1], "Organization projection is invalid.")
  if (!Array.isArray(organization.assignments) || organization.assignments.length !== 2)
    throw new Error("Organization projection does not expose the two real Seed Pair Assignments.")
  const webSeedGrowResponse = await context.request.get(
    `${webUIURL}/api/agent-company/projects/${encodeURIComponent(projectID)}/seed-grow`,
  )
  if (!webSeedGrowResponse.ok()) throw new Error(`WebUI Seed-and-Grow proxy returned ${webSeedGrowResponse.status()}.`)
  const webSeedGrow = asRecord(await webSeedGrowResponse.json(), "WebUI Seed-and-Grow response is invalid.")
  const webBeforeWatermarks = {
    organization: watermark(webSeedGrow.organization, "WebUI Organization projection"),
    graph: watermark(webSeedGrow.graph, "WebUI Graph projection"),
    validation: watermark(webSeedGrow.validation, "WebUI Validation projection"),
  }
  if (
    webBeforeWatermarks.organization !== beforeWatermarks.organization ||
    webBeforeWatermarks.graph !== beforeWatermarks.graph ||
    webBeforeWatermarks.validation !== beforeWatermarks.validation
  )
    throw new Error("WebUI projections did not converge to Control Plane sourceWatermarks.")
  const snapshotResponse = await context.request.get(`${webUIURL}/api/agent-company/snapshot`)
  if (!snapshotResponse.ok()) throw new Error(`Real WebUI snapshot returned ${snapshotResponse.status()}.`)
  const snapshot = asRecord(await snapshotResponse.json(), "Real WebUI snapshot is invalid.")
  const snapshotCompany = asRecord(snapshot.company, "Real WebUI company snapshot is invalid.")
  if (snapshot.connection !== "ready" || snapshot.issue || snapshotCompany.id !== companyBeforeRestart.id)
    throw new Error(`Real WebUI did not connect to the candidate Control Plane: ${JSON.stringify(snapshot)}`)
  const snapshotWork = Array.isArray(snapshot.work)
    ? snapshot.work
        .map((item) => asRecord(item, "Snapshot work item is invalid."))
        .find((item) => workProjectionID(item, "Snapshot work item") === projectID)
    : undefined
  if (!snapshotWork || watermark(snapshotWork, "WebUI Work projection") !== beforeWatermarks.work)
    throw new Error("WebUI Work projection did not converge to the Control Plane sourceWatermark.")

  await page.goto(`${webUIURL}/work/${encodeURIComponent(projectID)}`, { waitUntil: "domcontentloaded" })
  if (workProjectionAvailable)
    await page.getByRole("heading", { name: "动态组织进展", exact: true }).waitFor({ state: "visible" })
  else await page.getByText("状态不可用", { exact: true }).first().waitFor({ state: "visible" })
  await freezeSurface(page)
  await page.locator(".ac-work3").screenshot({
    path: beforeScreenshot,
    animations: "disabled",
    caret: "hide",
  })

  const visualQA = start([process.execPath, "--no-orphans", "./script/visual-qa.ts"], appRoot, {
    ...webUIEnvironment,
    AGENT_COMPANY_QA_BASE_URL: webUIURL,
  })
  const visualQAExit = await visualQA.child.exited
  if (visualQAExit !== 0) {
    await Promise.allSettled([visualQA.stdout.completed, visualQA.stderr.completed])
    throw new Error(`Visual QA failed: ${visualQA.stderr.read()}\n${visualQA.stdout.read()}`)
  }
  await Promise.all([visualQA.stdout.completed, visualQA.stderr.completed])

  const eventRequestsBeforeRestart = eventStreamRequests
  await terminate(controlPlane)
  if (!(await portClosed(`${controlPlaneURL}/global/health`)))
    throw new Error("Control Plane port remained open after the restart stop point.")
  const offlineState = page.locator(".company-connection-state")
  const offlineSurfacedFromSSE = await offlineState
    .waitFor({
      state: "visible",
      timeout: 5_000,
    })
    .then(
      () => true,
      () => false,
    )
  if (!offlineSurfacedFromSSE) {
    uncovered.push("SSE disconnect did not surface the offline state until a page refresh.")
    await page.reload({ waitUntil: "domcontentloaded" })
  }
  await offlineState.waitFor({
    state: "visible",
    timeout: 30_000,
  })
  const offlineTitle = (await offlineState.getByRole("heading").textContent())?.trim()
  if (!offlineTitle) throw new Error("Offline connection state has no diagnostic title.")
  controlPlane = startControlPlane()
  const restartedHealth = await json<{ healthy?: boolean; version?: string }>(`${controlPlaneURL}/global/health`).catch(
    async () => {
      return (await (await waitForResponse(`${controlPlaneURL}/global/health`, controlPlane, 180_000)).json()) as {
        healthy?: boolean
        version?: string
      }
    },
  )
  if (restartedHealth.healthy !== true || restartedHealth.version !== health.version)
    throw new Error("Restarted Control Plane health does not match the initial candidate.")
  const restartedReadiness = await json<{ ready?: boolean; checks?: Array<{ status?: string }> }>(
    `${controlPlaneURL}/global/readiness`,
  )
  assertReadiness(restartedReadiness, "Restarted Control Plane readiness response is not ready.")
  const companyAfterRestart = durableCompanyIdentity(await json(`${controlPlaneURL}/company`))
  if (JSON.stringify(companyAfterRestart) !== JSON.stringify(companyBeforeRestart))
    throw new Error("Control Plane durable company identity changed across restart.")

  if (workProjectionAvailable)
    await page.getByRole("heading", { name: "动态组织进展", exact: true }).waitFor({
      state: "visible",
      timeout: 45_000,
    })
  else
    await page.getByText("状态不可用", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 45_000,
    })
  await waitForValue(
    async () => eventStreamRequests,
    (count) => count > eventRequestsBeforeRestart,
    30_000,
    "Browser EventSource did not reconnect after Control Plane restart",
  )
  const directAfterSSE = await Promise.all([
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/organization`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/graph`),
    json<unknown>(`${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/validation`),
  ])
  const afterSSEWatermarks = {
    work: watermark(directAfterSSE[0], "Restarted Work projection"),
    organization: watermark(directAfterSSE[1], "Restarted Organization projection"),
    graph: watermark(directAfterSSE[2], "Restarted Graph projection"),
    validation: watermark(directAfterSSE[3], "Restarted Validation projection"),
  }
  if (JSON.stringify(afterSSEWatermarks) !== JSON.stringify(beforeWatermarks))
    throw new Error("Control Plane sourceWatermarks changed across restart.")
  const recoveredSnapshotResponse = await context.request.get(`${webUIURL}/api/agent-company/snapshot`)
  if (!recoveredSnapshotResponse.ok())
    throw new Error(`Recovered WebUI snapshot returned ${recoveredSnapshotResponse.status()}.`)
  const recoveredSnapshot = asRecord(await recoveredSnapshotResponse.json(), "Recovered snapshot is invalid.")
  const recoveredWork = Array.isArray(recoveredSnapshot.work)
    ? recoveredSnapshot.work
        .map((item) => asRecord(item, "Recovered work item is invalid."))
        .find((item) => workProjectionID(item, "Recovered work item") === projectID)
    : undefined
  if (
    recoveredSnapshot.connection !== "ready" ||
    recoveredSnapshot.issue ||
    !recoveredWork ||
    watermark(recoveredWork, "Recovered WebUI Work projection") !== beforeWatermarks.work
  )
    throw new Error("WebUI SSE recovery did not converge to the persisted Work sourceWatermark.")

  await page.reload({ waitUntil: "domcontentloaded" })
  if (workProjectionAvailable)
    await page.getByRole("heading", { name: "动态组织进展", exact: true }).waitFor({ state: "visible" })
  else await page.getByText("状态不可用", { exact: true }).first().waitFor({ state: "visible" })
  const refreshedSeedGrowResponse = await context.request.get(
    `${webUIURL}/api/agent-company/projects/${encodeURIComponent(projectID)}/seed-grow`,
  )
  if (!refreshedSeedGrowResponse.ok())
    throw new Error(`Refreshed Seed-and-Grow proxy returned ${refreshedSeedGrowResponse.status()}.`)
  const refreshedSeedGrow = asRecord(await refreshedSeedGrowResponse.json(), "Refreshed Seed-and-Grow is invalid.")
  const afterRefreshWatermarks = {
    organization: watermark(refreshedSeedGrow.organization, "Refreshed Organization projection"),
    graph: watermark(refreshedSeedGrow.graph, "Refreshed Graph projection"),
    validation: watermark(refreshedSeedGrow.validation, "Refreshed Validation projection"),
  }
  if (
    afterRefreshWatermarks.organization !== beforeWatermarks.organization ||
    afterRefreshWatermarks.graph !== beforeWatermarks.graph ||
    afterRefreshWatermarks.validation !== beforeWatermarks.validation
  )
    throw new Error("Page refresh did not converge to persisted sourceWatermarks.")
  await freezeSurface(page)
  await page.locator(".ac-work3").screenshot({
    path: afterScreenshot,
    animations: "disabled",
    caret: "hide",
  })
  const deterministicScreenshot = await screenshotDiff(beforeScreenshot, afterScreenshot)

  const desktopBuild = start([process.execPath, "--no-orphans", "run", "build"], desktopRoot, {
    ...process.env,
    MODELS_DEV_API_JSON: modelsSnapshotPath,
    VITE_AGENTCOMPANY_WEB_URL: webUIURL,
  })
  if ((await desktopBuild.child.exited) !== 0) {
    await Promise.allSettled([desktopBuild.stdout.completed, desktopBuild.stderr.completed])
    throw new Error(`Desktop build failed: ${desktopBuild.stderr.read()}\n${desktopBuild.stdout.read()}`)
  }
  await Promise.all([desktopBuild.stdout.completed, desktopBuild.stderr.completed])
  await terminate(controlPlane)
  if (!(await portClosed(`${controlPlaneURL}/global/health`)))
    throw new Error("Control Plane port remained open before Desktop embedded takeover.")
  const desktopUserData = path.join(temporaryRoot, "desktop-user-data")
  await fs.mkdir(desktopUserData, { recursive: true })
  await fs.writeFile(
    path.join(desktopUserData, "agent-company.settings"),
    `${JSON.stringify({ companyHome }, null, 2)}\n`,
  )
  desktop = start(
    [electronPath, desktopRoot, "--disable-gpu", "--lang=zh-CN", `--remote-debugging-port=${desktopDebugPort}`],
    desktopRoot,
    {
      ...controlPlaneEnvironment,
      APPDATA: path.join(temporaryRoot, "desktop-app-data"),
      AGENTCOMPANY_USER_DATA: desktopUserData,
      AGENTCOMPANY_PORT: String(controlPlanePort),
      VITE_AGENTCOMPANY_WEB_URL: webUIURL,
    },
  )
  await waitForResponse(`${controlPlaneURL}/global/health`, desktop, 120_000)
  const desktopReadiness = await waitForValue(
    () =>
      json<{ ready?: boolean; checks?: Array<{ status?: string }> }>(`${controlPlaneURL}/global/readiness`).catch(
        () => null,
      ),
    (value) => value?.ready === true,
    120_000,
    "Desktop embedded Control Plane did not become ready",
  )
  if (!desktopReadiness) throw new Error("Desktop embedded Control Plane readiness is unavailable.")
  assertReadiness(desktopReadiness, "Desktop embedded Control Plane readiness response is not ready.")
  await waitForResponse(`http://127.0.0.1:${desktopDebugPort}/json/version`, desktop, 120_000)
  const desktopTarget = (
    await waitForValue(
      () => json<Array<{ type?: string; url?: string }>>(`http://127.0.0.1:${desktopDebugPort}/json/list`),
      (targets) => targets.some((target) => target.type === "page" && target.url?.startsWith(webUIURL)),
      120_000,
      "Desktop renderer did not navigate to the production WebUI",
    )
  ).find((target) => target.type === "page" && target.url?.startsWith(webUIURL))
  if (!desktopTarget?.url) throw new Error("Desktop production WebUI target is unavailable.")
  const desktopSnapshotResponse = await context.request.get(`${webUIURL}/api/agent-company/snapshot`)
  if (!desktopSnapshotResponse.ok())
    throw new Error(`Desktop-backed WebUI snapshot returned ${desktopSnapshotResponse.status()}.`)
  const desktopSnapshot = asRecord(await desktopSnapshotResponse.json(), "Desktop-backed WebUI snapshot is invalid.")
  const desktopSnapshotCompany = asRecord(desktopSnapshot.company, "Desktop-backed WebUI company snapshot is invalid.")
  const desktopSnapshotWork = Array.isArray(desktopSnapshot.work)
    ? desktopSnapshot.work
        .map((item) => asRecord(item, "Desktop-backed snapshot work item is invalid."))
        .find((item) => workProjectionID(item, "Desktop-backed snapshot work item") === projectID)
    : undefined
  if (
    desktopSnapshot.connection !== "ready" ||
    desktopSnapshot.issue ||
    desktopSnapshotCompany.id !== companyBeforeRestart.id ||
    !desktopSnapshotWork ||
    watermark(desktopSnapshotWork, "Desktop-backed WebUI Work projection") !== beforeWatermarks.work
  )
    throw new Error("Desktop-backed WebUI did not converge to the embedded Control Plane.")
  const desktopCompany = durableCompanyIdentity(await json(`${controlPlaneURL}/company`))
  if (JSON.stringify(desktopCompany) !== JSON.stringify(companyBeforeRestart))
    throw new Error("Desktop embedded Control Plane did not reuse the persisted Company Home.")
  const desktopDirectResponses = await Promise.all(
    [
      ["work", `${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}`],
      ["organization", `${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/organization`],
      ["graph", `${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/graph`],
      ["validation", `${controlPlaneURL}/experience/work/${encodeURIComponent(projectID)}/validation`],
    ].map(async ([name, url]) => {
      const response = await fetch(url)
      return { name, status: response.status, body: await response.text() }
    }),
  )
  const desktopDirectValues = desktopDirectResponses.every((response) => response.status === 200)
    ? (Object.fromEntries(
        desktopDirectResponses.map((response) => [response.name, JSON.parse(response.body) as unknown]),
      ) as Record<string, unknown>)
    : null
  const desktopDirectWatermarks = desktopDirectValues
    ? {
        work: watermark(desktopDirectValues.work, "Desktop embedded Work projection"),
        organization: watermark(desktopDirectValues.organization, "Desktop embedded Organization projection"),
        graph: watermark(desktopDirectValues.graph, "Desktop embedded Graph projection"),
        validation: watermark(desktopDirectValues.validation, "Desktop embedded Validation projection"),
      }
    : null
  const desktopDirectConverged =
    desktopDirectWatermarks !== null && JSON.stringify(desktopDirectWatermarks) === JSON.stringify(beforeWatermarks)
  if (!desktopDirectConverged)
    uncovered.push(
      `Desktop embedded Control Plane projections did not converge: ${JSON.stringify(
        desktopDirectResponses.map((response) => ({
          name: response.name,
          status: response.status,
          body: response.status === 200 ? undefined : response.body,
        })),
      )}`,
    )
  const desktopSeedGrowResponse = await context.request.get(
    `${webUIURL}/api/agent-company/projects/${encodeURIComponent(projectID)}/seed-grow`,
  )
  const desktopSeedGrowBody = await desktopSeedGrowResponse.text()
  const desktopSeedGrowConverged =
    desktopSeedGrowResponse.status() === 200 &&
    (() => {
      const projection = asRecord(JSON.parse(desktopSeedGrowBody), "Desktop-backed Seed-and-Grow response is invalid.")
      return (
        watermark(projection.organization, "Desktop-backed Organization projection") ===
          beforeWatermarks.organization &&
        watermark(projection.graph, "Desktop-backed Graph projection") === beforeWatermarks.graph &&
        watermark(projection.validation, "Desktop-backed Validation projection") === beforeWatermarks.validation
      )
    })()
  if (!desktopSeedGrowConverged)
    uncovered.push(
      `Desktop-backed production WebUI Seed-and-Grow projection did not converge: ${JSON.stringify({
        status: desktopSeedGrowResponse.status(),
        body: desktopSeedGrowBody,
      })}`,
    )
  await terminate(desktop)
  desktop = undefined
  if (!(await portClosed(`${controlPlaneURL}/global/health`)))
    throw new Error("Desktop embedded Control Plane port remained open after Desktop exit.")

  result = {
    result: uncovered.length === 0 ? "pass" : "fail",
    candidateSha,
    project: {
      id: projectID,
      executionStrategy: detail.project.execution_strategy,
      seedMode: detail.project.seed_mode,
      state: detail.project.status,
      workProjectionAvailability: initialWorkProjection.availability,
      wayfinder: wayfinder.role,
      builder: builder.role,
      independentAgents: wayfinder.owner_agent_id !== builder.owner_agent_id,
      realProviderCalls: providerRequests,
    },
    controlPlane: {
      healthy: health.healthy,
      version: health.version,
      readiness: readiness.ready,
      providerConfiguredThroughProductAPI: true,
      projectCreatedThroughProductAPI: true,
      restarted: true,
      persistentCompanyIdentity: true,
      sourceWatermarks: beforeWatermarks,
    },
    browser: {
      productionWebUI: true,
      seedPairVisible: workProjectionAvailable,
      assignmentReasonAndSourceRefs: workProjectionAvailable && teamAssignmentVisible,
      graphValidationDiagnostics: workProjectionAvailable,
      eventSourceRequests: eventStreamRequests,
      sseReconnected: true,
      refreshConverged: true,
      states: {
        loading: loadingStateVisible,
        empty: true,
        filteredEmpty: true,
        error: errorStateVisible,
        offline: true,
        offlineDiagnostic: offlineTitle,
      },
      accessibility: {
        contextTabsKeyboard: workProjectionAvailable,
        tabpanelRelationship: workProjectionAvailable,
        sourceTraceKeyboard: workProjectionAvailable && teamAssignmentVisible,
      },
    },
    desktop: {
      productionWebUI: true,
      embeddedControlPlane: true,
      persistedCompanyHome: true,
      sourceWatermarkConverged: desktopDirectConverged,
      productionWebUIProjectionConverged: desktopSeedGrowConverged,
      projectionStatuses: Object.fromEntries(
        desktopDirectResponses.map((response) => [response.name, response.status]),
      ),
      rendererURL: desktopTarget.url,
      seedPairVisible: workProjectionAvailable,
      assignmentEvidenceVisible: teamAssignmentVisible,
    },
    screenshotDiff: deterministicScreenshot,
    visualQA: "pass",
    evidence: {
      report: path.relative(root, evidenceReport),
      beforeScreenshot: path.relative(root, beforeScreenshot),
      afterScreenshot: path.relative(root, afterScreenshot),
    },
    uncovered,
  }
} catch (error) {
  failure = error
  result = {
    result: "error",
    candidateSha,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "UnknownError", message: String(error) },
    evidence: {
      report: path.relative(root, evidenceReport),
      beforeScreenshot: path.relative(root, beforeScreenshot),
      afterScreenshot: path.relative(root, afterScreenshot),
    },
    uncovered,
  }
} finally {
  if (desktop) await terminate(desktop)
  if (browserClose) await browserClose()
  if (webUI) await terminate(webUI)
  await terminate(controlPlane)
  await Promise.race([controlPlaneProxy.stop(true), Bun.sleep(5_000)])
  await Promise.race([providerServer.stop(true), Bun.sleep(5_000)])
  cleanup = {
    providerPortClosed: await portClosed(providerURL),
    controlPlanePortClosed: await portClosed(`${controlPlaneURL}/global/health`),
    controlPlaneProxyPortClosed: await portClosed(controlPlaneProxyURL),
    desktopDebugPortClosed: await portClosed(`http://127.0.0.1:${desktopDebugPort}/json/version`),
    webUIPortClosed: await portClosed(`${webUIURL}/login`),
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true })
  await fs.rm(webUIRuntimeRoot, { recursive: true, force: true })
  if (result) result.cleanup = cleanup
}

const cleanupPassed =
  cleanup?.providerPortClosed === true &&
  cleanup.controlPlanePortClosed &&
  cleanup.controlPlaneProxyPortClosed &&
  cleanup.desktopDebugPortClosed &&
  cleanup.webUIPortClosed
if (!cleanupPassed && result) {
  result.result = "error"
  result.cleanupFailure = cleanup
}
if (result) await fs.writeFile(evidenceReport, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (
  !cleanup?.providerPortClosed ||
  !cleanup.controlPlanePortClosed ||
  !cleanup.controlPlaneProxyPortClosed ||
  !cleanup.desktopDebugPortClosed ||
  !cleanup.webUIPortClosed
)
  throw new Error(`Real surface cleanup failed: ${JSON.stringify(cleanup)}`)
if (failure) throw failure
if (result && Array.isArray(result.uncovered) && result.uncovered.length > 0) process.exitCode = 1
