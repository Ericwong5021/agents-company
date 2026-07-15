import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

/**
 * Task 10 M2 conversation vertical. The shared M1 E2E server has already
 * bootstrapped a ready company, so this spec pairs a fresh browser credential
 * and exercises the real Board Channel contract end-to-end through the Control
 * Plane API: send a board goal (202 + persisted), read it back from the message
 * page, open the source thread, and interrupt it. The Control Plane uses the
 * production-default enabled board_messages capability, so both the server
 * authority check and the real composer are covered by this release gate.
 *
 * The UI side asserts that the ready workspace renders the real channel sidebar
 * and message feed from the SDK snapshot, with no fixture approval/delivery
 * cards. Waiting for a live model high-signal projection is covered by the
 * restart/runtime tests with a scripted LLM; this spec stays deterministic.
 */

const serverUrl = "http://127.0.0.1:4096"
const basic = "Basic " + Buffer.from("agentcompany:m1-e2e-secret").toString("base64")

async function createPair(request: import("@playwright/test").APIRequestContext, label: string) {
  const pairing = await request.post(serverUrl + "/local-auth/pairings", {
    headers: { authorization: basic },
    data: { label },
  })
  expect(pairing.ok()).toBe(true)
  return (await pairing.json()) as { code: string }
}

async function pairBearer(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const pair = await createPair(request, "Playwright M2 API")
  const exchange = await request.post(serverUrl + "/local-auth/exchange", {
    data: { code: pair.code, label: "Playwright M2 API" },
  })
  expect(exchange.ok()).toBe(true)
  const issued = (await exchange.json()) as { token: string }
  return "Bearer " + issued.token
}

async function companyID(request: import("@playwright/test").APIRequestContext, bearer: string): Promise<string> {
  const res = await request.get(serverUrl + "/company", { headers: { authorization: bearer } })
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { state: string; company?: { id: string }; capabilities?: { board_messages: boolean } }
  expect(body.state).toBe("ready")
  expect(body.capabilities?.board_messages).toBe(true)
  return body.company!.id
}

async function boardChannel(request: import("@playwright/test").APIRequestContext, bearer: string, cid: string): Promise<string> {
  const res = await request.get(`${serverUrl}/company/channels?company_id=${cid}`, { headers: { authorization: bearer } })
  expect(res.ok()).toBe(true)
  const channels = (await res.json()) as Array<{ id: string; kind: string }>
  const board = channels.find((channel) => channel.kind === "board")
  expect(board).toBeTruthy()
  return board!.id
}

test.describe("M2 company conversation vertical", () => {
  test("sends a board goal and reads it back through the real contract", async ({ request }) => {
    const bearer = await pairBearer(request)
    const cid = await companyID(request, bearer)
    const channelID = await boardChannel(request, bearer, cid)

    const requestID = randomUUID()
    const send = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { authorization: bearer, "content-type": "application/json" },
      data: { request_id: requestID, body: "Define the M2 real-IM scope and project the conclusion" },
    })
    expect(send.status()).toBe(202)
    const accepted = (await send.json()) as { messageID: string; threadID?: string; runID?: string; replayed: boolean }
    expect(accepted.messageID).toBeTruthy()
    expect(accepted.threadID).toBeTruthy()

    // Read the message back from the main feed page.
    const messages = await request.get(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}&limit=50`, {
      headers: { authorization: bearer },
    })
    expect(messages.ok()).toBe(true)
    const page = (await messages.json()) as { items: Array<{ id: string; body: string; requestID?: string; sourceThreadID?: string }> }
    const sent = page.items.find((item) => item.id === accepted.messageID)
    expect(sent).toBeTruthy()
    expect(sent!.body).toBe("Define the M2 real-IM scope and project the conclusion")
    expect(sent!.sourceThreadID).toBe(accepted.threadID)

    // Open the source thread detail and its entries.
    const thread = await request.get(`${serverUrl}/company/threads/${accepted.threadID}?company_id=${cid}`, {
      headers: { authorization: bearer },
    })
    expect(thread.ok()).toBe(true)
    const threadDetail = (await thread.json()) as { id: string; status: string; members: unknown[] }
    expect(threadDetail.id).toBe(accepted.threadID)

    const entries = await request.get(`${serverUrl}/company/threads/${accepted.threadID}/entries?company_id=${cid}&limit=50`, {
      headers: { authorization: bearer },
    })
    expect(entries.ok()).toBe(true)

    // Interrupt is the only structured M2 thread action.
    const interrupt = await request.post(`${serverUrl}/company/threads/${accepted.threadID}/actions?company_id=${cid}`, {
      headers: { authorization: bearer, "content-type": "application/json" },
      data: { kind: "interrupt" },
    })
    expect(interrupt.status()).toBe(200)
    const interrupted = (await interrupt.json()) as { status: string }
    expect(interrupted.status).toBe("interrupted")
  })

  test("replays the same request id idempotently without duplicating", async ({ request }) => {
    const bearer = await pairBearer(request)
    const cid = await companyID(request, bearer)
    const channelID = await boardChannel(request, bearer, cid)

    const requestID = randomUUID()
    const first = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { authorization: bearer, "content-type": "application/json" },
      data: { request_id: requestID, body: "Idempotent replay target" },
    })
    expect(first.status()).toBe(202)
    const firstAccepted = (await first.json()) as { messageID: string; replayed: boolean }

    const replay = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { authorization: bearer, "content-type": "application/json" },
      data: { request_id: requestID, body: "Idempotent replay target" },
    })
    expect(replay.status()).toBe(202)
    const replayAccepted = (await replay.json()) as { messageID: string; replayed: boolean }
    expect(replayAccepted.messageID).toBe(firstAccepted.messageID)
    expect(replayAccepted.replayed).toBe(true)

    // A conflicting body on the same request id is rejected.
    const conflict = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { authorization: bearer, "content-type": "application/json" },
      data: { request_id: requestID, body: "Different body" },
    })
    expect(conflict.status()).toBe(409)
  })

  test("rejects unauthenticated and cross-scope access", async ({ request }) => {
    const cid = "cmp_local"
    // No credentials → 401
    const noAuth = await request.get(`${serverUrl}/company/channels?company_id=${cid}`)
    expect(noAuth.status()).toBe(401)

    const bearer = await pairBearer(request)
    // An unknown channel is not found, not leaked
    const missing = await request.get(`${serverUrl}/company/channels/chn_unknown/messages?company_id=${cid}`, {
      headers: { authorization: bearer },
    })
    expect([403, 404]).toContain(missing.status())
  })

  test("ready workspace renders the real channel sidebar and no fixture cards", async ({ page, request }) => {
    // A pairing code is single-use, so the browser receives a fresh code that
    // has not already been exchanged by the API helper.
    const pair = await createPair(request, "Playwright M2 browser")
    await page.goto("/?pair=" + encodeURIComponent(pair.code))
    await page.getByLabel("浏览器名称").fill("Playwright M2 browser")
    await page.getByRole("button", { name: "安全连接" }).click()

    // Ready state: real channel sidebar from the SDK, no fixture approval/delivery.
    await expect(page.locator(".company-channels")).toBeVisible()
    await expect(page.locator(".company-approval, .company-delivery")).toHaveCount(0)
    await expect(page.locator(".company-composer")).toBeVisible()
    await expect(page.locator('[data-capability="board-messages-disabled"]')).toHaveCount(0)

    const body = "Playwright UI sends a real M2 board goal"
    await page.getByLabel("发送消息").fill(body)
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const message = page.locator(".company-message", { hasText: body })
    await expect(message).toBeVisible()
    await message.getByRole("button", { name: "查看来源 Thread" }).click()
    await expect(page.getByRole("complementary", { name: "Thread" })).toBeVisible()

    // A document reload has no in-memory event history. The persisted message
    // and its source Thread must be rebuilt from the snapshot APIs.
    await page.reload()
    await expect(message).toBeVisible()
    await message.getByRole("button", { name: "查看来源 Thread" }).click()
    await expect(page.getByRole("complementary", { name: "Thread" })).toBeVisible()
  })
})
