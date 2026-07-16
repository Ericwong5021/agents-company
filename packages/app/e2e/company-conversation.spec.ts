import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

/**
 * Task 10 M2 conversation vertical. The shared M1 E2E server has already
 * bootstrapped a ready company, so this spec exercises the trusted loopback
 * Board Channel contract end-to-end through the Control Plane API: send a board
 * goal (202 + persisted), read it back from the message page, open the source
 * thread, and interrupt it. The Control Plane uses the production-default
 * enabled board_messages capability, so both the server authority check and
 * the real composer are covered by this release gate.
 *
 * The UI side asserts that the ready workspace renders the real channel sidebar
 * and message feed from the SDK snapshot, with no fixture approval/delivery
 * cards. Waiting for a live model high-signal projection is covered by the
 * restart/runtime tests with a scripted LLM; this spec stays deterministic.
 */

const serverUrl = "http://127.0.0.1:4096"

async function companyID(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.get(serverUrl + "/company")
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as {
    state: string
    company?: { id: string }
    capabilities?: { board_messages: boolean }
  }
  expect(body.state).toBe("ready")
  expect(body.capabilities?.board_messages).toBe(true)
  return body.company!.id
}

async function boardChannel(request: import("@playwright/test").APIRequestContext, cid: string): Promise<string> {
  const res = await request.get(`${serverUrl}/company/channels?company_id=${cid}`)
  expect(res.ok()).toBe(true)
  const channels = (await res.json()) as Array<{ id: string; kind: string }>
  const board = channels.find((channel) => channel.kind === "board")
  expect(board).toBeTruthy()
  return board!.id
}

test.describe("M2 company conversation vertical", () => {
  test("sends a board goal and reads it back through the real contract", async ({ request }) => {
    const cid = await companyID(request)
    const channelID = await boardChannel(request, cid)

    const requestID = randomUUID()
    const send = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { "content-type": "application/json" },
      data: { request_id: requestID, body: "Define the M2 real-IM scope and project the conclusion" },
    })
    expect(send.status()).toBe(202)
    const accepted = (await send.json()) as { messageID: string; threadID?: string; runID?: string; replayed: boolean }
    expect(accepted.messageID).toBeTruthy()
    expect(accepted.threadID).toBeTruthy()

    // Read the message back from the main feed page.
    const messages = await request.get(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}&limit=50`)
    expect(messages.ok()).toBe(true)
    const page = (await messages.json()) as {
      items: Array<{ id: string; body: string; requestID?: string; sourceThreadID?: string }>
    }
    const sent = page.items.find((item) => item.id === accepted.messageID)
    expect(sent).toBeTruthy()
    expect(sent!.body).toBe("Define the M2 real-IM scope and project the conclusion")
    expect(sent!.sourceThreadID).toBe(accepted.threadID)

    // Open the source thread detail and its entries.
    const thread = await request.get(`${serverUrl}/company/threads/${accepted.threadID}?company_id=${cid}`)
    expect(thread.ok()).toBe(true)
    const threadDetail = (await thread.json()) as { id: string; status: string; members: unknown[] }
    expect(threadDetail.id).toBe(accepted.threadID)

    const entries = await request.get(
      `${serverUrl}/company/threads/${accepted.threadID}/entries?company_id=${cid}&limit=50`,
    )
    expect(entries.ok()).toBe(true)

    // Interrupt is the only structured M2 thread action.
    const interrupt = await request.post(
      `${serverUrl}/company/threads/${accepted.threadID}/actions?company_id=${cid}`,
      {
        headers: { "content-type": "application/json" },
        data: { kind: "interrupt" },
      },
    )
    expect(interrupt.status()).toBe(200)
    const interrupted = (await interrupt.json()) as { status: string }
    expect(interrupted.status).toBe("interrupted")
  })

  test("replays the same request id idempotently without duplicating", async ({ request }) => {
    const cid = await companyID(request)
    const channelID = await boardChannel(request, cid)

    const requestID = randomUUID()
    const first = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { "content-type": "application/json" },
      data: { request_id: requestID, body: "Idempotent replay target" },
    })
    expect(first.status()).toBe(202)
    const firstAccepted = (await first.json()) as { messageID: string; replayed: boolean }

    const replay = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { "content-type": "application/json" },
      data: { request_id: requestID, body: "Idempotent replay target" },
    })
    expect(replay.status()).toBe(202)
    const replayAccepted = (await replay.json()) as { messageID: string; replayed: boolean }
    expect(replayAccepted.messageID).toBe(firstAccepted.messageID)
    expect(replayAccepted.replayed).toBe(true)

    // A conflicting body on the same request id is rejected.
    const conflict = await request.post(`${serverUrl}/company/channels/${channelID}/messages?company_id=${cid}`, {
      headers: { "content-type": "application/json" },
      data: { request_id: requestID, body: "Different body" },
    })
    expect(conflict.status()).toBe(409)
  })

  test("allows trusted loopback access and still rejects cross-scope reads", async ({ request }) => {
    const cid = await companyID(request)
    const channelID = await boardChannel(request, cid)

    expect((await request.get(`${serverUrl}/company/channels?company_id=${cid}`)).status()).toBe(200)

    const missing = await request.get(`${serverUrl}/company/channels/chn_unknown/messages?company_id=${cid}`)
    expect([403, 404]).toContain(missing.status())

    const wrongScope = await request.get(`${serverUrl}/company/channels/${channelID}/messages?company_id=cmp_unknown`)
    expect([403, 404]).toContain(wrongScope.status())
  })

  test("ready workspace renders the real channel sidebar and no fixture cards", async ({ page, request }) => {
    expect((await request.get(serverUrl + "/company")).status()).toBe(200)
    await page.goto("/")

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
