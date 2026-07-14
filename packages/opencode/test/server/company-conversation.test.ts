import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { authorization, Server } from "../../src/server/server"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  BOARD_CHANNEL_ID,
  COMPANY_CHANNEL_ID,
  ChannelMessageTable,
  LOCAL_USER_ID,
  ensureCompanyChannels,
} from "../../src/conversation/conversation.sql"
import { ChannelID } from "../../src/conversation/schema"
import * as Database from "../../src/storage/db"
import { eq } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_local")
const credentials = { username: "agentcompany", password: "secret" }

let requestCounter = 0
function requestID() {
  requestCounter += 1
  return `00000000-0000-4000-8000-${requestCounter.toString().padStart(12, "0")}`
}

function seed() {
  Database.use((db) => {
    db.insert(CompanyTable)
      .values({
        id: companyID,
        name: "Agent Company",
        data_version: 1,
        default_provider_id: ProviderID.zod.parse("test"),
        default_model_id: ModelID.zod.parse("test"),
        bootstrap_request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
        bootstrap_input_path: "/tmp/company",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(CompanyAgentTable)
      .values([
        { id: "board-ceo", company_id: companyID, role_key: "ceo", name: "CEO", time_created: 1, time_updated: 1 },
        { id: "board-cto", company_id: companyID, role_key: "cto", name: "CTO", time_created: 1, time_updated: 1 },
        {
          id: "board-product-lead",
          company_id: companyID,
          role_key: "product_lead",
          name: "Product Lead",
          time_created: 1,
          time_updated: 1,
        },
      ])
      .run()
  })
  ensureCompanyChannels({ companyID, boardAgentIDs: ["board-ceo", "board-cto", "board-product-lead"], now: 1 })
}

function send(channelID: string, body: string, requestIDValue = requestID(), headers: Record<string, string> = {}) {
  return Server.Default().app.request(
    `/company/channels/${channelID}/messages?company_id=${companyID}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ request_id: requestIDValue, body }),
    },
  )
}

beforeEach(async () => {
  requestCounter = 0
  await resetDatabase()
  seed()
})

afterEach(async () => {
  await Server.Default().app.request("/company/providers/openai/credentials", { method: "DELETE" })
  await resetDatabase()
})

describe.serial("/company/channels and /company/threads HTTP contract", () => {
  test.serial("lists visible channels for the local user", async () => {
    const response = await Server.Default().app.request(`/company/channels?company_id=${companyID}`)
    expect(response.status).toBe(200)
    const channels = await response.json()
    const ids = channels.map((channel: { id: string }) => channel.id)
    expect(ids).toContain(COMPANY_CHANNEL_ID)
    expect(ids).toContain(BOARD_CHANNEL_ID)
  })

  test.serial("returns 401 without credentials under network auth", async () => {
    const built = Server.create({ auth: { mode: "network", basic: credentials } })
    const response = await built.app.request(`/company/channels?company_id=${companyID}`)
    expect(response.status).toBe(401)
    const withBasic = await built.app.request(`/company/channels?company_id=${companyID}`, {
      headers: { authorization: authorization(credentials) },
    })
    expect(withBasic.status).toBe(200)
  })

  test.serial("rejects an invisible channel with 403", async () => {
    const stranger = ChannelID.parse("chn_stranger")
    const response = await Server.Default().app.request(
      `/company/channels/${stranger}/messages?company_id=${companyID}`,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: "ConversationChannelNotVisible" })
  })

  test.serial("accepts a board message and returns 202 with persisted ids", async () => {
    const response = await send(BOARD_CHANNEL_ID, "Ship the scoped board intake.", requestID())
    expect(response.status).toBe(202)
    const accepted = await response.json()
    expect(accepted.messageID).toMatch(/^cmsg_/)
    expect(accepted.rootNeedID).toMatch(/^need_/)
    expect(accepted.threadID).toMatch(/^cth_/)
    expect(accepted.runID).toMatch(/^crun_/)
    expect(accepted.replayed).toBe(false)

    // The user message is persisted before the 202 is returned.
    const persisted = Database.use((db) =>
      db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, accepted.messageID)).get(),
    )
    expect(persisted).toBeDefined()
    expect(persisted?.body).toBe("Ship the scoped board intake.")
  })

  test.serial("replays an identical request idempotently and 409s on a different body", async () => {
    const id = requestID()
    const first = await send(BOARD_CHANNEL_ID, "Original board goal.", id)
    expect(first.status).toBe(202)
    const firstBody = await first.json()

    const replay = await send(BOARD_CHANNEL_ID, "Original board goal.", id)
    expect(replay.status).toBe(202)
    const replayBody = await replay.json()
    expect(replayBody).toEqual({ ...firstBody, replayed: true })

    const conflict = await send(BOARD_CHANNEL_ID, "A different goal.", id)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ name: "ConversationRequestConflict" })
  })

  test.serial("validates request body with a 400 product error", async () => {
    const tooLong = "x".repeat(20_001)
    const response = await send(BOARD_CHANNEL_ID, tooLong, requestID())
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(["ProductValidationError", "ConversationMessageInvalidInput"]).toContain(body.name)
  })

  test.serial("requires a uuid request_id", async () => {
    const response = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages?company_id=${companyID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: "not-a-uuid", body: "hello" }),
      },
    )
    expect(response.status).toBe(400)
  })

  test.serial("pages main-feed channel messages with a stable cursor", async () => {
    await send(BOARD_CHANNEL_ID, "first goal", requestID())
    await send(BOARD_CHANNEL_ID, "second goal", requestID())

    const first = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages?company_id=${companyID}&limit=1`,
    )
    expect(first.status).toBe(200)
    const firstPage = await first.json()
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).toBeDefined()

    const second = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages?company_id=${companyID}&limit=1&before=${firstPage.nextCursor}`,
    )
    expect(second.status).toBe(200)
    const secondPage = await second.json()
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id)

    const badCursor = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages?company_id=${companyID}&before=not-a-cursor`,
    )
    expect(badCursor.status).toBe(400)
  })

  test.serial("returns thread detail, entries, and a 404 for an unknown source", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Discuss the M2 scope.", requestID())
    const { threadID } = await accepted.json()

    const detail = await Server.Default().app.request(`/company/threads/${threadID}?company_id=${companyID}`)
    expect(detail.status).toBe(200)
    const thread = await detail.json()
    expect(thread.id).toBe(threadID)
    expect(thread.status).toBe("active")
    expect(thread.members.some((member: { principal: { id: string } }) => member.principal.id === LOCAL_USER_ID)).toBe(true)

    const entries = await Server.Default().app.request(`/company/threads/${threadID}/entries?company_id=${companyID}`)
    expect(entries.status).toBe(200)
    const entryPage = await entries.json()
    expect(Array.isArray(entryPage.items)).toBe(true)

    const missingSource = await Server.Default().app.request(
      `/company/threads/${threadID}/sources/msg_does-not-exist?company_id=${companyID}`,
    )
    expect(missingSource.status).toBe(404)
    expect(await missingSource.json()).toMatchObject({ name: "ConversationSourceNotFound" })
  })

  test.serial("rejects an invisible thread with 403", async () => {
    const response = await Server.Default().app.request(`/company/threads/cth_missing?company_id=${companyID}`)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: "ConversationThreadNotVisible" })
  })

  test.serial("applies an interrupt action and returns updated thread detail", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "A goal to interrupt.", requestID())
    const { threadID } = await accepted.json()

    const response = await Server.Default().app.request(`/company/threads/${threadID}/actions?company_id=${companyID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interrupt" }),
    })
    expect(response.status).toBe(200)
    const thread = await response.json()
    expect(thread.id).toBe(threadID)
  })

  test.serial("rejects a non-interrupt action as a 400 product error", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "A goal.", requestID())
    const { threadID } = await accepted.json()
    const response = await Server.Default().app.request(`/company/threads/${threadID}/actions?company_id=${companyID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "delegate" }),
    })
    expect(response.status).toBe(400)
  })

  test.serial("company channel messages do not create a root need", async () => {
    const response = await send(COMPANY_CHANNEL_ID, "A company-wide note.", requestID())
    expect(response.status).toBe(202)
    const accepted = await response.json()
    expect(accepted.rootNeedID).toBeUndefined()
    expect(accepted.threadID).toBeUndefined()
    expect(accepted.runID).toBeUndefined()
  })

  test.serial("declares complete success/error schemas for every M2 conversation operation", async () => {
    const spec = await Server.openapi()
    const operations = [
      { method: "get", path: "/company/channels", statuses: ["200", "400", "401", "500"] },
      { method: "get", path: "/company/channels/{channelID}/messages", statuses: ["200", "400", "401", "403", "500"] },
      { method: "post", path: "/company/channels/{channelID}/messages", statuses: ["202", "400", "401", "403", "404", "409", "500"] },
      { method: "get", path: "/company/threads/{threadID}", statuses: ["200", "400", "401", "403", "500"] },
      { method: "get", path: "/company/threads/{threadID}/entries", statuses: ["200", "400", "401", "403", "500"] },
      { method: "get", path: "/company/threads/{threadID}/sources/{sourceID}", statuses: ["200", "400", "401", "403", "404", "500"] },
      { method: "post", path: "/company/threads/{threadID}/actions", statuses: ["200", "400", "401", "403", "500"] },
    ] as const
    for (const item of operations) {
      const operation = spec.paths?.[item.path]?.[item.method]
      expect(operation).toBeDefined()
      expect(operation?.operationId).toBeDefined()
      for (const status of item.statuses) {
        const response = operation?.responses?.[status]
        expect(response).toBeDefined()
        if (!response || !("content" in response))
          throw new Error(`Missing JSON response schema for ${item.method} ${item.path} ${status}`)
        const schema = response.content?.["application/json"]?.schema
        expect(schema).toBeDefined()
        // No product operation response may be the OpenAPI `unknown` catch-all.
        const json = JSON.stringify(schema)
        expect(json).not.toMatch(/"unknown"/)
      }
    }
  })
})
