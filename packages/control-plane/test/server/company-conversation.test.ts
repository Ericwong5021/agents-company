import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { authorization, Server } from "../../src/server/server"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { CompanyAgentID } from "../../src/company-agent/schema"
import { ApprovalPolicyTable, CompanyTable, RepositoryBindingTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  BOARD_CHANNEL_ID,
  COMPANY_CHANNEL_ID,
  ChannelMessageTable,
  ConversationRunTable,
  ConversationThreadTable,
  LOCAL_USER_ID,
  RootNeedTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
  ensureCompanyChannels,
} from "../../src/conversation/conversation.sql"
import {
  ChannelID,
  ChannelMessageID,
  ConversationRunID,
  ConversationThreadID,
  SignalProjectionID,
} from "../../src/conversation/schema"
import { GroupMessageTable, GroupSessionTable } from "../../src/group-session/group-session.sql"
import { ChannelDeliveryTable, ChannelPollVoteTable, ChannelReactionTable, ChannelReadStateTable } from "../../src/conversation/room.sql"
import { GroupSessionID } from "../../src/group-session/schema"
import { Identifier } from "../../src/id/id"
import { ProjectTable } from "../../src/project/project.sql"
import type { ProjectID } from "../../src/project/schema"
import * as Database from "../../src/storage/db"
import { eq } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_local")
const credentials = { username: "agentcompany", password: "secret" }
const boardMessagesOverride = process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES

let requestCounter = 0
function requestID() {
  requestCounter += 1
  return `00000000-0000-4000-8000-${requestCounter.toString().padStart(12, "0")}`
}

function seed() {
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: "conversation-server-project" as ProjectID, worktree: "/tmp/company", sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
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
    db.insert(RepositoryBindingTable)
      .values({
        id: "rbd_primary",
        company_id: companyID,
        project_id: "conversation-server-project" as ProjectID,
        root_path: "/tmp/company",
        default_branch: "main",
        bootstrap_head_commit: null,
        bootstrap_dirty: false,
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(CompanyAgentTable)
      .values([
        {
          id: "board-ceo",
          company_id: companyID,
          role_key: "ceo",
          lifecycle: "employee",
          name: "CEO",
          org_layer: "board",
          reports_to: null,
          responsibilities: JSON.stringify(["公司目标与最终取舍"]),
          time_created: 1,
          time_updated: 1,
        },
        {
          id: "board-cto",
          company_id: companyID,
          role_key: "cto",
          lifecycle: "employee",
          name: "CTO",
          org_layer: "board",
          reports_to: "board-ceo",
          responsibilities: JSON.stringify(["技术方向与工程质量"]),
          time_created: 1,
          time_updated: 1,
        },
        {
          id: "board-product-lead",
          company_id: companyID,
          role_key: "product_lead",
          lifecycle: "employee",
          name: "Product Lead",
          org_layer: "board",
          reports_to: "board-ceo",
          responsibilities: JSON.stringify(["用户价值与验收"]),
          time_created: 1,
          time_updated: 1,
        },
      ])
      .run()
    db.insert(ApprovalPolicyTable)
      .values({ company_id: companyID, preset: "balanced", time_created: 1, time_updated: 1 })
      .run()
  })
  ensureCompanyChannels({ companyID, boardAgentIDs: ["board-ceo", "board-cto", "board-product-lead"], now: 1 })
}

function seedProjectedBoardSignal(input: { threadID: ConversationThreadID; runID: ConversationRunID }) {
  const projectID = "m2-conversation-project" as ProjectID
  const groupSessionID = GroupSessionID.ascending()
  const groupMessageID = Identifier.ascending("message")
  const channelMessageID = ChannelMessageID.parse(Identifier.ascending("channelMessage"))
  const projectionID = SignalProjectionID.parse(Identifier.ascending("signalProjection"))
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: projectID, worktree: "/tmp/m2-conversation", sandboxes: [], time_created: now, time_updated: now })
      .run()
    db.insert(GroupSessionTable)
      .values({
        id: groupSessionID,
        project_id: projectID,
        title: "M2 Board thread",
        context_policy: "work_scoped",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(GroupMessageTable)
      .values({
        id: groupMessageID,
        group_session_id: groupSessionID,
        round_num: 0,
        role: "agent",
        company_agent_id: CompanyAgentID.zod.parse("board-cto"),
        content: "The CTO identified a release race in the runtime transition.",
        status_summary: "done",
        time_created: now + 1,
        time_updated: now + 1,
      })
      .run()
    db.update(ConversationRunTable)
      .set({ runtime_id: groupSessionID, runtime_round_num: 0, time_updated: now + 1 })
      .where(eq(ConversationRunTable.id, input.runID))
      .run()
    db.insert(ChannelMessageTable)
      .values({
        id: channelMessageID,
        channel_id: BOARD_CHANNEL_ID,
        source_thread_id: input.threadID,
        author_kind: "agent",
        author_id: "board-product-lead",
        body: "The Board identified a release race that must be closed.",
        signal_type: "risk",
        visibility: "company",
        mentions: [],
        time_created: now + 2,
        time_updated: now + 2,
      })
      .run()
    db.insert(SignalProjectionTable)
      .values({
        id: projectionID,
        channel_message_id: channelMessageID,
        conversation_thread_id: input.threadID,
        conversation_run_id: input.runID,
        projector_version: 1,
        source_watermark: `${groupSessionID}:0:${groupMessageID}`,
        time_created: now + 2,
        time_updated: now + 2,
      })
      .run()
    db.insert(SignalProjectionSourceTable)
      .values({
        signal_projection_id: projectionID,
        ordinal: 0,
        source_kind: "group_message",
        source_id: groupMessageID,
        time_created: now + 2,
        time_updated: now + 2,
      })
      .run()
  })
  return { groupMessageID, channelMessageID }
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
  delete process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES
  requestCounter = 0
  await resetDatabase()
  seed()
})

afterEach(async () => {
  if (boardMessagesOverride === undefined) delete process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES
  else process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES = boardMessagesOverride
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

  test.serial("enforces the board_messages capability before creating any conversation rows", async () => {
    process.env.AGENTCOMPANY_DISABLE_BOARD_MESSAGES = "true"

    const response = await send(BOARD_CHANNEL_ID, "This must remain read-only.", requestID())
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: "ConversationBoardMessagesDisabled" })
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationThreadTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(0)
  })

  test.serial("accepts a board message and returns 202 with persisted ids", async () => {
    const response = await send(BOARD_CHANNEL_ID, "Ship the scoped board intake.", requestID())
    expect(response.status).toBe(202)
    const accepted = await response.json()
    expect(accepted.messageID).toMatch(/^cmsg_/)
    expect(accepted.rootNeedID).toMatch(/^need_/)
    expect(accepted.threadID).toMatch(/^cth_/)
    expect(accepted.runID).toBeUndefined()
    expect(accepted.replayed).toBe(false)

    // The user message is persisted before the 202 is returned.
    const persisted = Database.use((db) =>
      db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, accepted.messageID)).get(),
    )
    expect(persisted).toBeDefined()
    expect(persisted?.body).toBe("Ship the scoped board intake.")
  })

  test.serial("creates one durable delivery per board agent without a centralized conversation run", async () => {
    const response = await send(BOARD_CHANNEL_ID, "Dispatch immediately.", requestID())
    expect(response.status).toBe(202)
    const { messageID, runID } = await response.json()
    expect(runID).toBeUndefined()
    expect(
      Database.use((db) =>
        db.select().from(ChannelDeliveryTable).where(eq(ChannelDeliveryTable.message_id, messageID)).all(),
      ).map((delivery) => delivery.agent_id).sort(),
    ).toEqual(["board-ceo", "board-cto", "board-product-lead"])
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(0)
  })

  test.serial("persists reactions, poll votes, and the user read watermark", async () => {
    const messageResponse = await send(BOARD_CHANNEL_ID, "Discuss the release options.", requestID())
    const message = await messageResponse.json()
    const reaction = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages/${message.messageID}/reactions?company_id=${companyID}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emoji: "✅" }) },
    )
    expect(reaction.status).toBe(200)
    expect(Database.use((db) => db.select().from(ChannelReactionTable).all())).toHaveLength(1)

    const poll = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages?company_id=${companyID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestID(),
          body: "Which release window?",
          kind: "poll",
          poll: {
            question: "Which release window?",
            options: [{ id: "today", label: "Today" }, { id: "tomorrow", label: "Tomorrow" }],
            multiple: false,
          },
          intent_override: "discuss",
        }),
      },
    )
    expect(poll.status).toBe(202)
    const pollMessage = await poll.json()
    const vote = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/messages/${pollMessage.messageID}/votes?company_id=${companyID}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option_id: "today" }) },
    )
    expect(vote.status).toBe(200)
    expect(Database.use((db) => db.select().from(ChannelPollVoteTable).all())).toHaveLength(1)

    const read = await Server.Default().app.request(
      `/company/channels/${BOARD_CHANNEL_ID}/read-state?company_id=${companyID}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: 2 }) },
    )
    expect(read.status).toBe(204)
    expect(Database.use((db) => db.select().from(ChannelReadStateTable).get())?.last_read_sequence).toBe(2)
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

  test.serial("returns run state, runtime entries, hydrated evidence, and a 404 for an unknown source", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Create an M2 scope thread with hydrated evidence.", requestID())
    const acceptedBody = await accepted.json()
    expect(accepted.status).toBe(202)
    const threadID = ConversationThreadID.parse(acceptedBody.threadID)
    const runID = ConversationRunID.parse(acceptedBody.runID)
    Database.use((db) =>
      db.update(ConversationRunTable)
        .set({
          state: "failed",
          attempt: 2,
          retryable: true,
          safe_error_summary: "The Board runtime needs a retry.",
          time_finished: Date.now(),
          time_updated: Date.now(),
        })
        .where(eq(ConversationRunTable.id, runID))
        .run(),
    )
    const projected = seedProjectedBoardSignal({ threadID, runID })

    const detail = await Server.Default().app.request(`/company/threads/${threadID}?company_id=${companyID}`)
    expect(detail.status).toBe(200)
    const thread = await detail.json()
    expect(thread.id).toBe(threadID)
    expect(thread.status).toBe("active")
    expect(thread.run).toMatchObject({
      id: runID,
      state: "failed",
      attempt: 2,
      retryable: true,
      safeErrorSummary: "The Board runtime needs a retry.",
    })
    expect(thread.members.some((member: { principal: { id: string } }) => member.principal.id === LOCAL_USER_ID)).toBe(true)

    const entries = await Server.Default().app.request(`/company/threads/${threadID}/entries?company_id=${companyID}`)
    expect(entries.status).toBe(200)
    const entryPage = await entries.json()
    expect(entryPage.items).toContainEqual(
      expect.objectContaining({
        type: "agent_message",
        message: expect.objectContaining({
          id: projected.groupMessageID,
          agentID: "board-cto",
          body: "The CTO identified a release race in the runtime transition.",
          status: "done",
        }),
      }),
    )

    const source = await Server.Default().app.request(
      `/company/threads/${threadID}/sources/${projected.groupMessageID}?company_id=${companyID}`,
    )
    expect(source.status).toBe(200)
    expect(await source.json()).toMatchObject({
      kind: "group_message",
      sourceID: projected.groupMessageID,
      detail: {
        type: "group_message",
        agentID: "board-cto",
        body: "The CTO identified a release race in the runtime transition.",
        status: "done",
      },
    })

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
    const accepted = await send(BOARD_CHANNEL_ID, "Create a goal to interrupt.", requestID())
    expect(accepted.status).toBe(202)
    const { runID, threadID } = await accepted.json()
    Database.use((db) =>
      db
        .update(ConversationRunTable)
        .set({ state: "queued", runtime_id: null, runtime_round_num: null })
        .where(eq(ConversationRunTable.id, runID))
        .run(),
    )

    const response = await Server.Default().app.request(`/company/threads/${threadID}/actions?company_id=${companyID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interrupt" }),
    })
    expect(response.status).toBe(200)
    const thread = await response.json()
    expect(thread.id).toBe(threadID)
    expect(thread.status).toBe("interrupted")
    expect(
      Database.use((db) => db.select().from(ConversationThreadTable).where(eq(ConversationThreadTable.id, threadID)).get())
        ?.status,
    ).toBe("interrupted")
    expect(
      Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get())
        ?.state,
    ).toBe("interrupted")
  })

  test.serial("formally decides a completed Board thread through the global HTTP route", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Create a verifiable delivery project.", requestID())
    const { runID, threadID, rootNeedID } = await accepted.json()
    Database.use((db) =>
      db
        .update(ConversationRunTable)
        .set({
          state: "completed",
          retryable: false,
          time_finished: Date.now(),
          time_updated: Date.now(),
        })
        .where(eq(ConversationRunTable.id, runID))
        .run(),
    )

    const response = await Server.Default().app.request(
      `/company/threads/${threadID}/actions?company_id=${companyID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "decide",
          request_id: requestID(),
          charter: {
            title: "Verifiable delivery project",
            value: "Prove the Board decision reaches executable project state.",
            deliverables: ["A persisted project plan"],
            acceptance_criteria: ["The HTTP response contains the project and planning work item"],
            scope: ["Formal Board task issuance"],
            non_goals: ["No unrelated product work"],
            constraints: ["Use the company-bound repository"],
            resources: [{ kind: "repository", scope: "company repository", disposition: "retain" }],
            risks: [{ description: "Runtime context may be absent", mitigation: "Enter the bound repository instance" }],
            dri_agent_id: "board-cto",
            milestones: ["Project planning starts"],
            open_decisions: [],
          },
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      kind: "decide",
      project: {
        company_id: companyID,
        root_need_id: rootNeedID,
        source_thread_id: threadID,
        owner_agent_id: "board-cto",
      },
      charter: { title: "Verifiable delivery project", dri_agent_id: "board-cto" },
      plan: { phase: "planning" },
      work_item: { kind: "planner", status: "pending" },
      project_channel: { kind: "project" },
      replayed: false,
    })
  })

  test.serial("includes company-visible Board signals in the company feed", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Create a company-visible Board risk.", requestID())
    expect(accepted.status).toBe(202)
    const { threadID, runID } = await accepted.json()
    const projected = seedProjectedBoardSignal({ threadID, runID })

    const response = await Server.Default().app.request(
      `/company/channels/${COMPANY_CHANNEL_ID}/messages?company_id=${companyID}`,
    )
    expect(response.status).toBe(200)
    expect((await response.json()).items).toContainEqual(
      expect.objectContaining({
        id: projected.channelMessageID,
        channelID: BOARD_CHANNEL_ID,
        visibility: "company",
        signalType: "risk",
      }),
    )
  })

  test.serial("rejects an invisible interrupt before mutating its thread or run", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Create a protected goal.", requestID())
    expect(accepted.status).toBe(202)
    const { runID, threadID } = await accepted.json()
    Database.use((db) =>
      db
        .update(ConversationRunTable)
        .set({ state: "queued", runtime_id: null, runtime_round_num: null })
        .where(eq(ConversationRunTable.id, runID))
        .run(),
    )

    const response = await Server.Default().app.request(`/company/threads/${threadID}/actions?company_id=cmp_other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interrupt" }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: "ConversationThreadNotVisible" })
    expect(
      Database.use((db) => db.select().from(ConversationThreadTable).where(eq(ConversationThreadTable.id, threadID)).get())
        ?.status,
    ).toBe("active")
    expect(
      Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get())
        ?.state,
    ).toBe("queued")
  })

  test.serial("rejects a non-interrupt action as a 400 product error", async () => {
    const accepted = await send(BOARD_CHANNEL_ID, "Create a goal for invalid action validation.", requestID())
    expect(accepted.status).toBe(202)
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
