import { once } from "node:events"
import { createServer } from "node:http"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { finalizeNetworkAudit, installNetworkAudit } from "./network-audit"

const controlPlaneURL = "http://127.0.0.1:3311"
const navigation = [
  { label: "公司总览", heading: "Agent Company", path: "/company" },
  { label: "收件箱", heading: "收件箱", path: "/inbox" },
  { label: "工作", heading: "工作", path: "/work" },
  { label: "董事会", heading: "董事会", path: "/company/board" },
  { label: "团队", heading: "团队", path: "/team" },
  { label: "成果库", heading: "成果库", path: "/library" },
  { label: "设置", heading: "公司", path: "/settings" },
] as const
const forbiddenProductTerms = /投影诊断|Projection diagnostics/i

const legacyRoutes = [
  { from: "/company", to: "/company" },
  { from: "/company/board", to: "/company/board" },
  { from: "/company/employees", to: "/team" },
  { from: "/company/projects/legacy", to: "/work/legacy" },
  { from: "/chat", to: "/work" },
  { from: "/chat/legacy", to: "/work" },
  { from: "/settings/company", to: "/settings" },
] as const
const settingsRoutes = [
  { path: "/settings", heading: "公司" },
  { path: "/settings/profile", heading: "个人与记忆" },
  { path: "/settings/integrations", heading: "集成" },
] as const

async function enterWorkspace(page: Page, path = "/inbox") {
  await page.goto(`/login?redirect=${encodeURIComponent(path)}`)
  await page.waitForURL((url) => url.pathname === path)
}

async function chooseRealWorkspace(page: Page) {
  await page.getByRole("button", { name: /连接模型服务/ }).click()
}

async function enterGoalDraft(page: Page) {
  await enterWorkspace(page)
  await page.getByRole("button", { name: "跳过引导，直接进入空工作区" }).click()
  await expect(page.getByLabel("描述你希望团队交付的结果")).toBeVisible()
}

async function setControlPlaneMode(request: APIRequestContext, mode: string, reset = false) {
  const response = await request.put(`${controlPlaneURL}/__test/mode`, { data: { mode, reset } })
  expect(response.ok()).toBe(true)
}

async function screenshotFromTop(page: Page, path: string) {
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo(0, 0)
    document.querySelector(".ac-workspace-stage__main")?.scrollTo(0, 0)
  })
  await page.screenshot({ path, fullPage: true })
}

test.beforeEach(async ({ context, request }) => {
  await installNetworkAudit(context)
  await setControlPlaneMode(request, "ready", true)
})

test.afterEach(async ({ context }, testInfo) => {
  await finalizeNetworkAudit(context, testInfo)
})

test("@r0-shell rejects every unauthenticated Agent Company API route", async ({ request }) => {
  const responses = await Promise.all([
    request.get("/api/agent-company/snapshot"),
    request.get("/api/agent-company/board?thread_id=cth-board"),
    request.post("/api/agent-company/board", { data: {} }),
    request.post("/api/agent-company/board/decide", { data: {} }),
    request.put("/api/agent-company/provider", { data: {} }),
    request.get("/api/agent-company/projects/project-gate"),
    request.get("/api/agent-company/projects/project-gate/goal-brief"),
    request.get("/api/agent-company/projects/project-delivered/artifacts/artifact-report"),
    request.post("/api/agent-company/projects/project-gate/retry", { data: {} }),
    request.post("/api/agent-company/goal-brief/generate", { data: {} }),
  ])
  expect(responses.map((response) => response.status())).toEqual(Array(10).fill(401))
  const requests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(requests.items).toEqual([])
})

test("@r0-shell keeps critical Agent Company API paths available after login", async ({ page, request }) => {
  await enterWorkspace(page)
  const api = page.context().request
  const origin = new URL(page.url()).origin
  const responses = await Promise.all([
    api.get("/api/agent-company/snapshot"),
    api.get("/api/agent-company/board?thread_id=cth_auth"),
    api.post("/api/agent-company/board", {
      headers: { origin },
      data: {
        request_id: "4661f8a8-08b6-4b2b-a63b-35f59b997458",
        body: "验证登录后的董事会写入代理。",
      },
    }),
    api.post("/api/agent-company/board/decide", {
      headers: { origin },
      data: {
        thread_id: "cth_auth",
        request_id: "515f32ac-489f-47b4-ab3f-9d57b37b15c8",
        charter: {
          title: "认证边界验证",
          value: "验证登录后可下达董事会决策。",
          deliverables: ["认证验证结果"],
          acceptance_criteria: ["九个 Agent Company API 均可访问"],
          scope: ["本地 E2E"],
          non_goals: ["不访问外部服务"],
          constraints: ["仅使用 Fake Control Plane"],
          resources: [{ kind: "other", scope: "e2e", disposition: "retain" }],
          risks: [],
          dri_agent_id: "agent-1",
          milestones: ["完成认证验证"],
          open_decisions: [],
        },
      },
    }),
    api.put("/api/agent-company/provider", {
      headers: { origin },
      data: {
        format: "openai",
        base_url: "http://127.0.0.1:9",
        api_key: "local-e2e-key",
        headers: {},
        provider_id: "local-e2e",
        model_id: "local-e2e-model",
      },
    }),
    api.get("/api/agent-company/projects/project-gate"),
    api.get("/api/agent-company/projects/project-gate/goal-brief"),
    api.get("/api/agent-company/projects/project-delivered/artifacts/artifact-report"),
    api.post("/api/agent-company/projects/project-gate/retry", {
      headers: { origin },
      data: {},
    }),
    api.post("/api/agent-company/goal-brief/generate", {
      headers: { origin },
      data: {
        requestId: "d67ca6d1-16fe-4ee2-b302-d24311040ac4",
        goal: "验证登录后的只读目标摘要代理。",
      },
    }),
  ])
  expect(responses).toHaveLength(10)
  expect(responses.every((response) => response.ok())).toBe(true)
  const [snapshot, , , , , , brief, artifact] = responses
  expect((await snapshot.json()).connection).toBe("ready")
  expect((await brief.json()).brief.projectId).toBe("project-gate")
  expect((await artifact.json()).id).toBe("artifact-report")
  const requests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(requests.items).toContainEqual({
    method: "POST",
    path: "/company/channels/channel-board/messages",
  })
})

test("@r0-shell rejects same-site cross-origin writes and allows same-origin browser writes", async ({
  page,
  request,
}) => {
  await enterWorkspace(page)
  const appOrigin = new URL(page.url()).origin
  const boardWrites = async () => {
    const log = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
    return log.items.filter(
      (entry: { method: string; path: string }) =>
        entry.method === "POST" && entry.path === "/company/channels/channel-board/messages",
    ).length
  }
  const before = await boardWrites()
  const attacker = createServer((_incoming, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      connection: "close",
    })
    response.end(`
      <form method="post" action="${appOrigin}/api/agent-company/board">
        <input name="request_id" value="329b9f2f-69b0-42e4-b693-763890554cbf">
        <input name="body" value="cross-port form must not write">
        <button type="submit">submit</button>
      </form>
    `)
  })
  attacker.listen(0, "127.0.0.1")
  await once(attacker, "listening")
  const address = attacker.address()
  if (!address || typeof address === "string") throw new Error("Cross-origin test server did not start")

  try {
    await page.goto(`http://127.0.0.1:${address.port}`)
    const responsePromise = page.waitForResponse(
      (response) => response.url() === `${appOrigin}/api/agent-company/board` && response.request().method() === "POST",
    )
    await page.getByRole("button", { name: "submit" }).click()
    expect((await responsePromise).status()).toBe(403)
  } finally {
    attacker.close()
    await once(attacker, "close")
  }
  expect(await boardWrites()).toBe(before)

  await page.goto("/inbox")
  const allowed = await page.evaluate(async () => {
    const response = await fetch("/api/agent-company/board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "ce3b1016-8897-45ed-8393-396adf64bf55",
        body: "same-origin browser write",
      }),
    })
    return response.status
  })
  expect(allowed).toBe(200)
  expect(await boardWrites()).toBe(before + 1)
})

test("@r0-shell exposes one stable, branded navigation model", async ({ page, request }, testInfo) => {
  test.slow()
  const hydrationErrors: string[] = []
  page.on("console", (message) => {
    if (/hydration (?:text content |node )?mismatch|hydration completed but contains mismatches/i.test(message.text()))
      hydrationErrors.push(message.text())
  })
  await enterWorkspace(page)

  const primaryNav = page.getByRole("navigation", { name: "主导航" })
  await expect(primaryNav).toBeVisible()
  await expect(page.locator(".ac-app-rail").getByRole("button", { name: "本地账号菜单" })).toBeVisible()
  const contextResizeHandle = page.getByRole("separator", { name: "调整当前模块导航宽度" })
  await expect(contextResizeHandle).toHaveAttribute("aria-valuenow", "320")
  await contextResizeHandle.press("ArrowRight")
  await expect(contextResizeHandle).toHaveAttribute("aria-valuenow", "336")
  await contextResizeHandle.press("ArrowLeft")
  await expect(contextResizeHandle).toHaveAttribute("aria-valuenow", "320")
  await expect
    .poll(async () => (await primaryNav.getByRole("link").evaluateAll(links =>
      links.map(link => link.getAttribute("aria-label") ?? "")))
      .filter(label => navigation.some(item => item.label === label)))
    .toEqual(navigation.map(item => item.label))

  for (const item of navigation) {
    const link = primaryNav.getByRole("link", { name: item.label })
    await expect(link).toHaveAttribute("href", item.path)
    await page.goto(item.path)
    await expect(page).toHaveURL((url) => url.pathname === item.path)
    await expect(page.getByRole("heading", { level: 1, name: item.heading })).toBeVisible()
    await expect(primaryNav.getByRole("link", { name: item.label })).toHaveAttribute("aria-current", "page")
    await expect(page.locator("body")).not.toContainText(forbiddenProductTerms)
  }

  expect(hydrationErrors).toEqual([])

  const body = page.locator("body")
  for (const identity of ["Eve", "Slack", "iMessage", "Linear", "Source Protection"]) {
    await expect(body).not.toContainText(identity)
  }
  await expect(body).not.toContainText(/\bV\b/)

  const mark = await request.get("/agent-company-mark.svg")
  expect(mark.ok()).toBe(true)
  expect(await mark.text()).not.toMatch(/purple|#7c3aed|#8b5cf6/i)
  await screenshotFromTop(page, testInfo.outputPath("shell-desktop.png"))
})

test("@r0-shell never flashes duplicate navigation or legacy identity on slow first load", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __shellObservations?: { navCount: number; legacy: string[]; connection: string }[]
    }
    const identities = ["Eve", "Slack", "iMessage", "Linear", "Source Protection"]
    state.__shellObservations = []
    let last = ""
    const record = () => {
      const text = document.body?.innerText ?? ""
      const observation = {
        navCount: document.querySelectorAll('nav[aria-label="主导航"]').length,
        legacy: identities.filter((identity) => text.includes(identity)),
        connection: document.querySelector(".ac-connection-pill")?.getAttribute("data-connection") ?? "missing",
      }
      const key = `${observation.navCount}:${observation.legacy.join(",")}:${observation.connection}`
      if (key === last) return
      last = key
      state.__shellObservations?.push(observation)
    }
    new MutationObserver(record).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    document.addEventListener("DOMContentLoaded", record)
  })
  await setControlPlaneMode(request, "slow-ready")
  await enterWorkspace(page)
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible()
  await expect(page.getByRole("link", { name: /本地连接状态：已连接/ })).toBeVisible()

  const observations = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __shellObservations?: { navCount: number; legacy: string[]; connection: string }[]
        }
      ).__shellObservations ?? [],
  )
  expect(observations.length).toBeGreaterThan(0)
  expect(observations.every((observation) => observation.navCount <= 1)).toBe(true)
  expect(observations.every((observation) => observation.legacy.length === 0)).toBe(true)
  expect(observations.some((observation) => observation.connection === "connecting")).toBe(true)
  expect(observations.some((observation) => observation.connection === "ready")).toBe(true)
})

test("@r0-shell renders shared work and evidence projections without raw status", async ({
  page,
  request,
}, testInfo) => {
  test.slow()
  await enterWorkspace(page, "/work")
  await page.goto("/work?group=all")
  await expect(page.getByRole("link", { name: /准备本地发布/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /整理验收证据/ })).toBeVisible()
  const unavailableCard = page.getByRole("link", { name: /恢复未知工作/ })
  await expect(unavailableCard).toContainText("状态不可用")
  await expect(unavailableCard).toContainText("1 项诊断")
  await expect(unavailableCard.locator(".ac-progress")).toHaveCount(0)
  await expect(unavailableCard).not.toContainText("0%")
  await expect(unavailableCard).not.toContainText("项成果")

  const snapshot = await page
    .context()
    .request.get("/api/agent-company/snapshot")
    .then((response) => response.json())
  expect(snapshot.stats).not.toHaveProperty("activeProjects")
  await screenshotFromTop(page, testInfo.outputPath("work-projection.png"))

  await page.goto("/inbox")
  await expect(page.getByRole("link", { name: /补充发布凭据/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /验收体验审查报告/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /恢复未知工作/ })).toContainText("查看诊断")

  await page.goto("/work/project-running")
  await expect(page.getByRole("heading", { level: 1, name: "准备本地发布" })).toBeVisible()
  await expect(page.getByText("1 / 3 项工作已完成", { exact: true })).toBeVisible()
  await expect(page.getByText("33%")).toBeVisible()
  await expect(page.locator("body")).not.toContainText(forbiddenProductTerms)
  await screenshotFromTop(page, testInfo.outputPath("work-detail.png"))

  await page.goto("/work/project-unavailable")
  await expect(page.getByRole("heading", { level: 1, name: "恢复未知工作" })).toBeVisible()
  await expect(page.getByLabel("高信号工作流").getByText("状态不可用")).toBeVisible()
  await page.locator('.ac-app-titlebar__status[data-connection="ready"]').waitFor({ state: "attached" })
  await page.getByRole("button", { name: "查看诊断" }).click()
  await expect(page.locator(".ac-context-pane").getByRole("tab", { name: "诊断" })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".ac-context-pane").getByText("缺少决定当前状态所需的事实。")).toBeVisible()
  await expect(page.locator(".ac-progress")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: /交付/ })).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText(forbiddenProductTerms)

  await page.goto("/team")
  await expect(page.getByRole("heading", { level: 3, name: "小岚" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 3, name: "阿衡" })).toBeVisible()
  await expect(page.getByText(/责任分配证据暂时不可用/)).toBeVisible()
  await screenshotFromTop(page, testInfo.outputPath("team-projection.png"))

  await page.goto("/library")
  await expect(page.getByRole("button", { name: /交付成果/ })).toBeVisible()

  await page.goto("/work/project-delivered")
  await expect(page.getByRole("button", { name: /接受交付|要求修改/ })).toHaveCount(0)
  const artifactLink = page.locator("a.ac-artifact-link", { hasText: "体验审查报告" })
  await expect(artifactLink).toHaveAttribute("href", "/library/artifacts/project-delivered/artifact-report")
  await page.goto("/library/artifacts/project-delivered/artifact-report")
  await expect(page).toHaveURL((url) => url.pathname === "/library/artifacts/project-delivered/artifact-report")
  await expect(page.locator(".ac-workspace-header").getByRole("heading", { level: 1, name: "体验审查报告", exact: true })).toBeVisible()
  await expect(page.getByText("核心路径已完成审查，交付状态与证据来源均可追溯。")).toBeVisible()
  await expect(page.getByText("只读", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator(".ac-workspace-header").getByRole("heading", { level: 1, name: "体验审查报告", exact: true })).toBeVisible()
  const artifactRequests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(
    artifactRequests.items.some(
      (item: { method: string; path: string }) =>
        item.method === "GET" && item.path === "/experience/projects/project-delivered/artifacts/artifact-report",
    ),
  ).toBe(true)
})

test("@r0-shell shows a read-only goal brief and approval gate without mutation controls", async ({
  page,
  request,
}, testInfo) => {
  test.slow()
  await enterWorkspace(page, "/work/project-gate")
  await expect(page.getByRole("heading", { level: 1, name: "发布候选版本" })).toBeVisible()
  await expect(page.getByLabel("高信号工作流").getByText("等待审批", { exact: true })).toBeVisible()
  await page.locator('.ac-app-titlebar__status[data-connection="ready"]').waitFor({ state: "attached" })
  await page.getByRole("button", { name: "打开会话详情" }).last().click()
  const goalPanel = page.locator(".ac-context-pane")
  await expect(goalPanel.getByRole("tab", { name: "目标" })).toHaveAttribute("aria-selected", "true")
  await expect(goalPanel.getByText("用户确认", { exact: true })).toBeVisible()
  await expect(goalPanel.getByRole("definition").filter({ hasText: "2" })).toBeVisible()
  await expect(goalPanel.getByText("形成可审批的本地发布候选，并保留完整验证证据。")).toBeVisible()
  await expect(goalPanel.getByText("约束", { exact: true })).toBeVisible()
  await goalPanel.getByRole("tab", { name: "审批" }).click()
  await expect(goalPanel.getByText("发布前人工审批")).toBeVisible()
  const decisionGroup = goalPanel.getByRole("group", { name: "审批决策" })
  await expect(decisionGroup.getByRole("button")).toHaveCount(3)
  await expect(decisionGroup.getByRole("button", { name: "批准" })).toBeDisabled()
  await expect(decisionGroup.getByRole("button", { name: "驳回" })).toBeDisabled()
  await expect(decisionGroup.getByRole("button", { name: "请求修改" })).toBeDisabled()
  await screenshotFromTop(page, testInfo.outputPath("goal-brief-gate.png"))

  await page.goto("/work/project-blocked")
  await page.locator('.ac-app-titlebar__status[data-connection="ready"]').waitFor({ state: "attached" })
  await page.getByRole("button", { name: "打开会话详情" }).last().click()
  await expect(goalPanel.getByRole("tab", { name: "目标" })).toBeVisible()
  await expect(goalPanel.getByRole("definition").filter({ hasText: "旧项目范围" })).toBeVisible()
  await goalPanel.getByText("约束", { exact: true }).click()
  await expect(goalPanel.getByText("保持旧数据只读", { exact: true })).toBeVisible()
  await expect(goalPanel.getByText("整理旧项目的验收证据。")).toBeVisible()

  await setControlPlaneMode(request, "brief-invalid")
  await page.goto("/work/project-gate")
  await page.locator('.ac-app-titlebar__status[data-connection="ready"]').waitFor({ state: "attached" })
  await page.getByRole("button", { name: "打开会话详情" }).last().click()
  await expect(page.getByRole("heading", { level: 3, name: "目标摘要暂时不可用" })).toBeVisible()
  await expect(page.getByRole("button", { name: "重新读取" })).toBeVisible()
})

test("@r0-shell @scenario-s12 @criterion-s12-c1 @criterion-s12-c2 distinguishes first run from a quiet existing workspace", async ({
  page,
  request,
}, testInfo) => {
  await setControlPlaneMode(request, "empty-work")
  await enterWorkspace(page)
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "让本地 AI 团队接手第一个交付目标",
    }),
  ).toBeVisible()
  const onboarding = page.getByRole("group", { name: "选择开始方式" })
  await expect(onboarding.getByRole("button")).toHaveCount(2)
  const connectWorkspace = onboarding.getByRole("button", { name: /连接模型服务/ })
  await expect(connectWorkspace).toBeVisible()
  await expect(onboarding.getByRole("button", { name: /查看演示/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "跳过引导，直接进入空工作区" })).toBeVisible()
  await expect(page.getByText(/数据与执行均为示例/)).toBeVisible()
  await expect(page.locator(".ac-work-card, .ac-team-card, .ac-progress")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText(/小岚|阿衡|准备本地发布|输出体验审查报告/)
  await expect(page.getByRole("textbox", { name: "描述你希望团队交付的结果" })).toHaveCount(0)
  await connectWorkspace.focus()
  await expect(connectWorkspace).toBeFocused()
  await screenshotFromTop(page, testInfo.outputPath("first-run-empty.png"))
  await chooseRealWorkspace(page)
  await expect(page).toHaveURL((url) => url.pathname === "/settings")
  await expect(
    page.getByRole("link", {
      name: /本地连接状态：需要配置，还未连接模型服务/,
    }),
  ).toBeVisible()
  const snapshot = await page
    .context()
    .request.get("/api/agent-company/snapshot")
    .then((response) => response.json())
  expect(snapshot.connection).toBe("degraded")
  expect(snapshot.issue.kind).toBe("provider_required")
  expect(snapshot.issue.unavailable).toEqual([])
  expect(snapshot.company.providerConfigured).toBe(false)
  expect(snapshot.agents).toEqual([])
  expect(snapshot.work).toEqual([])
  expect(snapshot.messages).toEqual([])
  const requests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(requests.items.some((item: { path: string }) => item.path.endsWith("/messages"))).toBe(false)

  await setControlPlaneMode(request, "quiet-work")
  await page.goto("/inbox")
  await expect(page.getByRole("heading", { level: 2, name: "目前没有需要你处理的事项" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "用本地 AI 团队交付第一个目标" })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "描述你希望团队交付的结果" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "查看正在进行的工作" })).toHaveAttribute("href", "/work")
})

test("@r0-shell @scenario-s05 preserves an unsent goal draft and page context through disconnect and recovery", async ({
  page,
  request,
}) => {
  test.setTimeout(45_000)
  await setControlPlaneMode(request, "empty-work-ready")
  await enterGoalDraft(page)
  const draft = "整理本地研究材料，形成结论与来源逐项对应的报告。"
  const input = page.getByLabel("描述你希望团队交付的结果")
  await input.fill(draft)
  await expect(page.getByText("已保存到此设备", { exact: true })).toBeVisible()
  const storageBefore = await page.evaluate(() => localStorage.getItem("agent-company:inbox-goal-draft:v1"))
  await page.evaluate(() => {
    document.documentElement.dataset.r0DraftContext = "preserved"
  })

  await setControlPlaneMode(request, "health-timeout", true)
  await page.getByRole("button", { name: "刷新收件箱" }).click()
  await expect(page.getByRole("link", { name: /本地连接状态：正在恢复/ })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "无法连接本地 Control Plane" })).toBeVisible()
  await expect(page).toHaveURL((url) => url.pathname === "/inbox")
  await expect(input).toHaveValue(draft)

  await setControlPlaneMode(request, "empty-work-ready")
  await page.getByRole("button", { name: "重新连接" }).click()
  await expect(page.getByRole("link", { name: /本地连接状态：已连接/ })).toBeVisible()
  await expect(input).toHaveValue(draft)
  expect(await page.evaluate(() => document.documentElement.dataset.r0DraftContext)).toBe("preserved")
  expect(await page.evaluate(() => localStorage.getItem("agent-company:inbox-goal-draft:v1"))).toBe(storageBefore)
  const requests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(requests.items.length).toBeGreaterThan(0)
  expect(requests.items.every((item: { method: string }) => item.method === "GET")).toBe(true)
})

test("@r0-shell keeps the goal editable and reports truthfully when browser storage is unavailable", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    Object.defineProperties(window.localStorage, {
      getItem: {
        value(key: string) {
          if (key === "agent-company:inbox-goal-draft:v1") throw new DOMException("Storage unavailable")
          return Storage.prototype.getItem.call(this, key)
        },
      },
      setItem: {
        value(key: string, value: string) {
          if (key === "agent-company:inbox-goal-draft:v1") throw new DOMException("Storage unavailable")
          return Storage.prototype.setItem.call(this, key, value)
        },
      },
    })
  })
  await setControlPlaneMode(request, "empty-work-ready")
  await enterGoalDraft(page)
  const input = page.getByLabel("描述你希望团队交付的结果")
  await input.fill("形成一份可验证的本地报告。")
  await expect(input).toHaveValue("形成一份可验证的本地报告。")
  await expect(page.getByText("仅本页保留", { exact: true })).toBeVisible()
  await expect(page.getByText(/本地存储不可用，刷新或关闭页面会丢失草稿/)).toBeVisible()
})

test("@r0-shell generates an unbound Goal Brief and retries structured failure idempotently", async ({
  page,
  request,
}) => {
  await setControlPlaneMode(request, "empty-work-ready")
  await enterGoalDraft(page)
  const draft = "形成一份验收结论和证据来源都可追溯的本地报告。"
  const input = page.getByLabel("描述你希望团队交付的结果")
  await input.fill(draft)
  await setControlPlaneMode(request, "brief-generate-recover", true)

  await page.getByRole("button", { name: "生成目标摘要" }).click()
  await expect(page.getByRole("heading", { level: 3, name: "目标摘要未能生成" })).toBeVisible()
  await expect(page.getByText(/本地服务尝试 3 次/)).toBeVisible()
  await page.getByRole("button", { name: "手动修正" }).click()
  await expect(input).toBeFocused()
  await page.getByRole("button", { name: "重试" }).click()

  await expect(page.getByRole("heading", { level: 3, name: "系统理解的目标" })).toBeVisible()
  await expect(page.getByText("先看目标摘要", { exact: true })).toBeVisible()
  await expect(page.getByText(/摘要已保存在本地；开始后会绑定到唯一工作/)).toBeVisible()
  await expect(input).toHaveValue(draft)
  const generated = await request
    .get(`${controlPlaneURL}/__test/goal-brief-requests`)
    .then((response) => response.json())
  expect(generated.items).toHaveLength(2)
  expect(generated.items[0]).toEqual(generated.items[1])
  expect(generated.items[0].goal).toBe(draft)
  const requests = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(requests.items).toEqual([
    { method: "POST", path: "/experience/goal-brief/generate" },
    { method: "POST", path: "/experience/goal-brief/generate" },
  ])
})

test("@r0-shell keeps legacy aliases and settings routes loop-free", async ({ page }) => {
  await enterWorkspace(page)

  for (const route of legacyRoutes) {
    await page.goto(route.from)
    await expect(page).toHaveURL((url) => url.pathname === route.to)
  }

  for (const route of settingsRoutes) {
    await page.goto(route.path)
    await expect(page).toHaveURL((url) => url.pathname === route.path)
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible()
    await expect(page.getByText(/x-vercel-oidc-token|vc link/)).toHaveCount(0)
  }
})

test("@r0-shell preserves route context across direct access, refresh, back, and forward", async ({ page }) => {
  await enterWorkspace(page)

  for (const item of navigation) {
    await page.goto(item.path)
    await expect(page).toHaveURL((url) => url.pathname === item.path)
    await expect(page).toHaveTitle(`${item.label} · Agent Company`)
    await expect(page.getByRole("heading", { level: 1, name: item.heading })).toBeVisible()
    await page.reload()
    await expect(page).toHaveTitle(`${item.label} · Agent Company`)
    await expect(page.getByRole("heading", { level: 1, name: item.heading })).toBeVisible()
  }

  await page.goto("/work/project-gate")
  await expect(page.getByRole("heading", { level: 1, name: "发布候选版本" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "发布候选版本" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "工作" })).toHaveAttribute(
    "aria-current",
    "page",
  )

  await page.goto("/inbox")
  await page.goto("/work")
  await page.goBack()
  await expect(page).toHaveURL((url) => url.pathname === "/inbox")
  await expect(page.getByRole("heading", { level: 1, name: "收件箱" })).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL((url) => url.pathname === "/work")
  await expect(page.getByRole("heading", { level: 1, name: "工作" })).toBeVisible()
})

test("@r0-shell keeps keyboard access and 40px navigation targets", async ({ page }) => {
  await enterWorkspace(page)
  await page.reload()
  await page.keyboard.press("Tab")

  const skipLink = page.getByRole("link", { name: "跳到主要内容" })
  await expect(skipLink).toBeFocused()
  await expect(skipLink).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.locator("#main-content")).toBeFocused()

  for (const item of navigation) {
    const box = await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: item.label })
      .boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(40)
    expect(box?.width).toBeGreaterThanOrEqual(40)
  }

  await page.evaluate(() => history.replaceState(null, "", location.pathname))
  await page.reload()
  const inboxLink = page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "公司总览" })
  for (let tabIndex = 0; tabIndex < 16; tabIndex += 1) {
    await page.keyboard.press("Tab")
    if (await inboxLink.evaluate((element) => element === document.activeElement)) break
  }
  await expect(inboxLink).toBeFocused()
  for (const [index, item] of navigation.entries()) {
    const link = page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: item.label })
    if (!(await link.evaluate((element) => element === document.activeElement))) {
      await link.focus()
    }
    await expect(link).toBeFocused()
    if (index < navigation.length - 1) await page.keyboard.press("Tab")
  }
  for (const item of navigation) {
    await page.goto("/inbox")
    const link = page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: item.label })
    for (let tabIndex = 0; tabIndex < 12; tabIndex += 1) {
      await page.keyboard.press("Tab")
      if (await link.evaluate((element) => element === document.activeElement)) break
    }
    await expect(link).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL((url) => url.pathname === item.path)
  }
})

test("@r0-shell remains stable at 375px", async ({ page }, testInfo) => {
  test.slow()
  await page.setViewportSize({ width: 375, height: 812 })
  await enterWorkspace(page)

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)

  const mobileNav = page.getByRole("navigation", { name: "移动端主导航" })
  await expect(mobileNav).toBeVisible()
  await expect(mobileNav.getByRole("link")).toHaveCount(6)
  for (const item of [
    { name: /^公司/, path: "/company" },
    { name: /收件/, path: "/inbox" },
    { name: /^工作/, path: "/work" },
    { name: /^董事会/, path: "/company/board" },
    { name: /^团队/, path: "/team" },
    { name: /^成果/, path: "/library" },
  ])
    await expect(mobileNav.getByRole("link", { name: item.name })).toHaveAttribute("href", item.path)
  const moduleNavigationButton = page.getByRole("button", { name: "打开主导航" })
  await expect(moduleNavigationButton).toBeVisible()
  await moduleNavigationButton.click()
  await expect(page.locator(".ac-app-shell__sidebar[data-open='true']")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("shell-mobile-drawer.png"), fullPage: true })
  await page.getByRole("complementary", { name: "当前模块导航" }).getByRole("button", { name: "关闭当前模块导航" }).click()
  await expect(page.locator(".ac-app-shell__sidebar")).toHaveAttribute("data-open", "false")
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)
  await screenshotFromTop(page, testInfo.outputPath("shell-mobile.png"))
})

test("@r0-shell keeps long truthful content readable without horizontal overflow", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await setControlPlaneMode(request, "long-content")
  await enterWorkspace(page, "/work")
  const card = page.getByRole("link", { name: /准备本地发布并核验完整依赖关系/ })
  await expect(card).toBeVisible()
  await expect(card.locator(".ac-card-reason")).toContainText("本地执行证据")
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)
  await screenshotFromTop(page, testInfo.outputPath("long-content-mobile.png"))
})

test("@r0-shell keeps local auto-entry loopback-only", async ({ request }) => {
  const deniedAuthActions = await Promise.all([
    request.post("/api/auth/sign-in/email", {
      data: {
        email: "owner@agent-company.local",
        password: "agent-company-local-owner",
      },
    }),
    request.post("/api/auth/sign-up/email", {
      data: {
        email: "external@agent-company.local",
        password: "external-account-password",
        name: "External",
      },
    }),
    request.get("/api/auth/%67et-session"),
    request.get("/api/auth//get-session"),
    request.post("/api/auth/change-password", {
      data: {
        currentPassword: "agent-company-local-owner",
        newPassword: "external-account-password",
      },
    }),
  ])
  expect(deniedAuthActions.map((response) => response.status())).toEqual(Array(5).fill(403))
  expect(deniedAuthActions.every((response) => response.headers()["set-cookie"] === undefined)).toBe(true)

  const forgedHost = await request.post("/api/auth/local", {
    headers: {
      host: "example.test",
      origin: "http://127.0.0.1:3310",
    },
  })
  const forgedOrigin = await request.post("/api/auth/local", {
    headers: {
      origin: "http://example.test",
    },
  })
  const missingOrigin = await request.post("/api/auth/local")
  expect([forgedHost, forgedOrigin, missingOrigin].map((response) => response.status())).toEqual([403, 403, 403])

  const local = await request.post("/api/auth/local", {
    headers: { origin: "http://127.0.0.1:3310" },
  })
  expect(local.ok()).toBe(true)
  expect(local.headers()["set-cookie"]).toContain("better-auth.session_token")

  const session = await request.get("/api/auth/get-session")
  expect(session.ok()).toBe(true)
  expect((await session.json()).user.email).toBe("owner@agent-company.local")
  expect((await request.get("/api/agent-company/snapshot")).ok()).toBe(true)

  const signout = await request.post("/api/auth/sign-out", {
    headers: { origin: "http://127.0.0.1:3310" },
    data: {},
  })
  expect(signout.ok()).toBe(true)
  expect((await request.get("/api/agent-company/snapshot")).status()).toBe(401)
})

test("@r0-shell distinguishes partial resources from truthful empty data", async ({ page, request }) => {
  await enterWorkspace(page)

  for (const failure of [
    { mode: "work-500", resource: "work", stat: "activeProjects", path: "/work" },
    { mode: "work-invalid", resource: "work", stat: "activeProjects", path: "/inbox" },
    { mode: "agents-500", resource: "agents", stat: "online", path: "/team" },
    { mode: "messages-500", resource: "messages", stat: "boardMessages", path: "/inbox" },
  ]) {
    await setControlPlaneMode(request, failure.mode)
    const response = await page.context().request.get("/api/agent-company/snapshot")
    expect(response.ok()).toBe(true)
    const snapshot = await response.json()
    expect(snapshot.connection).toBe("degraded")
    expect(snapshot.issue.unavailable).toContain(failure.resource)
    expect(snapshot.stats).not.toHaveProperty(failure.stat)

    if (failure.resource === "messages") continue
    await page.goto(failure.path)
    await expect(page.getByRole("heading", { level: 2, name: "部分真实数据暂时不可用" })).toBeVisible()
    await expect(page.locator(".ac-empty-state")).toHaveCount(0)
  }
})

test("@r0-shell keeps one global degraded connection status across all primary routes", async ({ page, request }) => {
  await setControlPlaneMode(request, "messages-500", true)
  await enterWorkspace(page)
  await expect(page.getByRole("link", { name: /本地连接状态：部分可用/ })).toBeVisible()
  await page.evaluate(() => {
    const state = window as typeof window & { __connectionPillHistory?: string[] }
    state.__connectionPillHistory = []
    const record = () => {
      const value = document.querySelector(".ac-connection-pill")?.getAttribute("data-connection") ?? "missing"
      if (state.__connectionPillHistory?.at(-1) !== value) state.__connectionPillHistory?.push(value)
    }
    record()
    new MutationObserver(record).observe(document, { childList: true, subtree: true, attributes: true })
  })

  for (const item of navigation) {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: item.label }).click()
    await expect(page).toHaveURL((url) => url.pathname === item.path)
    await expect(page.getByRole("link", { name: /本地连接状态：部分可用/ })).toBeVisible()
  }

  const history = await page.evaluate(
    () => (window as typeof window & { __connectionPillHistory?: string[] }).__connectionPillHistory ?? [],
  )
  expect(history).toEqual(["degraded"])

  const log = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(log.items.filter((item: { path: string }) => item.path === "/global/health")).toHaveLength(1)
})

test("@r0-shell @scenario-s05 keeps disconnected facts unknown across 500, invalid JSON, and timeout", async ({
  page,
  request,
}) => {
  test.setTimeout(65_000)
  await enterWorkspace(page)

  for (const mode of ["health-500", "health-invalid-json", "health-timeout"]) {
    await setControlPlaneMode(request, mode)
    const response = await page.context().request.get("/api/agent-company/snapshot", { timeout: 10_000 })
    expect(response.ok()).toBe(true)
    const snapshot = await response.json()
    expect(snapshot.connection).toBe("disconnected")
    expect(snapshot.stats).toEqual({})
    expect(snapshot.company).not.toHaveProperty("providerConfigured")
    expect(JSON.stringify(snapshot)).not.toContain("e2e-control-plane-token")
  }
})

test("@r0-shell @scenario-s05 @criterion-s05-c1 @criterion-s05-c2 @criterion-s05-c3 exposes sanitized diagnostics and actionable startup instructions", async ({
  page,
  request,
}) => {
  test.setTimeout(35_000)
  await page.addInitScript(() => {
    const state = window as typeof window & { __copiedDiagnostic?: string }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          state.__copiedDiagnostic = value
        },
      },
    })
  })
  await setControlPlaneMode(request, "health-500")
  await enterWorkspace(page)
  await expect(page.locator(".ac-work-card, .ac-team-card, .ac-progress")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText(/小岚|阿衡|准备本地发布|输出体验审查报告|已成功/)
  await expect(page.getByText(/没有完成真实公司状态读取/)).toBeVisible()
  const disconnected = await page
    .context()
    .request.get("/api/agent-company/snapshot")
    .then((response) => response.json())
  expect(disconnected.agents).toEqual([])
  expect(disconnected.work).toEqual([])
  expect(disconnected.messages).toEqual([])
  await page.getByRole("button", { name: "复制诊断" }).click()
  await expect(page.getByRole("button", { name: "已复制诊断" })).toBeVisible()
  const copied = await page.evaluate(
    () => (window as typeof window & { __copiedDiagnostic?: string }).__copiedDiagnostic ?? "",
  )
  expect(copied).not.toContain("sk-sensitive-e2e-key")
  expect(copied).not.toContain("SYSTEM PROMPT: private customer instructions")
  expect(copied).not.toContain("/Users/private/customer/project")

  await setControlPlaneMode(request, "health-timeout")
  await page.getByRole("button", { name: "重新连接" }).click()
  await expect(page.getByRole("heading", { level: 2, name: "无法连接本地 Control Plane" })).toBeVisible()
  const instructions = page.locator('button[aria-controls="company-startup-instructions"]')
  await expect(instructions).toHaveAttribute("aria-expanded", "false")
  await instructions.click()
  await expect(instructions).toHaveAttribute("aria-expanded", "true")
  const disclosure = page.locator("#company-startup-instructions")
  await expect(disclosure).toContainText("仓库根目录")
  await expect(disclosure).toContainText("packages/control-plane")
  await expect(disclosure.getByText("bun run dev", { exact: true })).toHaveCount(2)
})

test("@r0-shell preserves unsaved settings through in-place recovery and retry", async ({ page, request }) => {
  await enterWorkspace(page, "/settings")
  await expect(page.getByRole("link", { name: /本地连接状态：已连接/ })).toBeVisible()
  const customPreset = page.getByRole("radio", { name: /自定义/ })
  await customPreset.click()
  const apiAddress = page.getByLabel("API 地址")
  const apiKey = page.getByLabel("API 密钥")
  const providerID = page.getByLabel("服务标识")
  await apiAddress.fill("https://provider.example.test/")
  await apiKey.fill("unsaved-local-key")
  await page.getByText("高级设置", { exact: true }).click()
  await providerID.fill("provider-under-edit")

  await setControlPlaneMode(request, "health-500", true)
  await page.getByRole("button", { name: "刷新本地运行状态" }).click()
  await expect(page.getByRole("heading", { level: 2, name: "Control Plane 返回服务错误" })).toBeVisible()
  await expect(customPreset).toHaveAttribute("aria-checked", "true")
  await expect(apiAddress).toHaveValue("https://provider.example.test/")
  await expect(apiKey).toHaveValue("unsaved-local-key")
  await expect(providerID).toHaveValue("provider-under-edit")
  await setControlPlaneMode(request, "ready")
  const retry = page.getByRole("button", { name: "重新连接" })
  await retry.evaluate((button) => {
    button.click()
    button.click()
  })

  await expect(page).toHaveURL((url) => url.pathname === "/settings")
  await expect(customPreset).toHaveAttribute("aria-checked", "true")
  await expect(apiAddress).toHaveValue("https://provider.example.test/")
  await expect(apiKey).toHaveValue("unsaved-local-key")
  await expect(providerID).toHaveValue("provider-under-edit")
  await expect(page.getByRole("link", { name: /本地连接状态：已连接/ })).toBeVisible()

  const log = await request.get(`${controlPlaneURL}/__test/requests`).then((response) => response.json())
  expect(log.items.length).toBeGreaterThan(0)
  expect(log.items.every((item: { method: string }) => item.method === "GET")).toBe(true)
})

test("@r0-shell exposes authorization, migration, version, and provider causes truthfully", async ({
  page,
  request,
}) => {
  await enterWorkspace(page)

  for (const failure of [
    { mode: "health-401", kind: "authorization_required" },
    { mode: "health-403", kind: "authorization_required" },
    { mode: "readiness-blocked", kind: "migration_required" },
    { mode: "health-404", kind: "version_mismatch" },
  ]) {
    await setControlPlaneMode(request, failure.mode)
    const snapshot = await page
      .context()
      .request.get("/api/agent-company/snapshot")
      .then((response) => response.json())
    expect(snapshot.connection).toBe("disconnected")
    expect(snapshot.issue.kind).toBe(failure.kind)
  }

  await setControlPlaneMode(request, "provider-required")
  const providerSnapshot = await page
    .context()
    .request.get("/api/agent-company/snapshot")
    .then((response) => response.json())
  expect(providerSnapshot.connection).toBe("degraded")
  expect(providerSnapshot.issue.kind).toBe("provider_required")
  expect(providerSnapshot.issue.unavailable).toEqual([])
  expect(providerSnapshot.company.providerConfigured).toBe(false)
  expect(providerSnapshot.work).not.toHaveLength(0)

  await page.goto("/work")
  await expect(page.getByRole("link", { name: /准备本地发布/ })).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "还没有可展示的工作" })).toHaveCount(0)
})

test("@r0-shell @scenario-s05 never enables fixture fallback through ordinary query parameters", async ({
  page,
  request,
}) => {
  await setControlPlaneMode(request, "health-500")
  await enterWorkspace(page)
  const snapshot = await page
    .context()
    .request.get("/api/agent-company/snapshot?fixture=1&demo=1")
    .then((response) => response.json())
  expect(snapshot.connection).toBe("disconnected")
  expect(snapshot.agents).toEqual([])
  expect(snapshot.work).toEqual([])
  expect(snapshot.messages).toEqual([])
})
