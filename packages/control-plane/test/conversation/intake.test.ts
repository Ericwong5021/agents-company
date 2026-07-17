import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CompanyAgentTable } from "../../src/company-agent/company-agent.sql"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import {
  BOARD_CHANNEL_ID,
  COMPANY_CHANNEL_ID,
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadMemberTable,
  ConversationThreadTable,
  LOCAL_USER_ID,
  RootNeedTable,
  ensureCompanyChannels,
} from "../../src/conversation/conversation.sql"
import { ChannelID, ChannelMessageID, ConversationThreadID } from "../../src/conversation/schema"
import { Conversation } from "../../src/conversation"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_local")
const user = { kind: "user" as const, id: LOCAL_USER_ID }
let requests = 0

function run<A, E>(fn: (conversation: Conversation.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(Conversation.Service.use(fn).pipe(Effect.provide(Conversation.layer)))
}

function requestID() {
  requests += 1
  return `00000000-0000-4000-8000-${requests.toString().padStart(12, "0")}`
}

function input(overrides: Partial<Conversation.SendMessageInput> = {}) {
  return {
    companyID,
    channelID: BOARD_CHANNEL_ID,
    principal: user,
    requestID: requestID(),
    body: "Ship the scoped board intake.",
    ...overrides,
  }
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
  ensureCompanyChannels({
    companyID,
    boardAgentIDs: ["board-ceo", "board-cto", "board-product-lead"],
    now: 1,
  })
}

beforeEach(async () => {
  requests = 0
  await resetDatabase()
  seed()
})

afterEach(resetDatabase)

describe.serial("M2 board message intake", () => {
  test.serial("persists a board root need, thread, members, message, and queued run in one accepted result", async () => {
    const accepted = await run((conversation) =>
      conversation.sendMessage(
        input({
          mentions: [{ kind: "role", role: "ceo" }],
        }),
      ),
    )

    expect(accepted.replayed).toBe(false)
    expect(accepted.rootNeedID).toBeString()
    expect(accepted.threadID).toBeString()
    expect(accepted.runID).toBeString()
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationThreadTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationThreadMemberTable).all())).toHaveLength(4)
    expect(Database.use((db) => db.select().from(ChannelMessageTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ChannelMessageTable).get()?.mentions)).toEqual([
      { kind: "role", role: "ceo" },
    ])
  })

  test.serial("replays the same request, conflicts on changed input, and reuses a referenced thread root need", async () => {
    const firstInput = input()
    const first = await run((conversation) => conversation.sendMessage(firstInput))
    const replay = await run((conversation) => conversation.sendMessage(firstInput))

    expect(replay).toMatchObject({ ...first, replayed: true })
    expect(Database.use((db) => db.select().from(ChannelMessageTable).all())).toHaveLength(1)
    await expect(
      run((conversation) => conversation.sendMessage({ ...firstInput, body: "A changed request payload." })),
    ).rejects.toMatchObject({ name: "ConversationRequestConflict" })

    const reply = await run((conversation) =>
      conversation.sendMessage(
        input({
          replyToID: first.messageID,
          referencedThreadID: first.threadID,
          body: "Continue the same board thread.",
        }),
      ),
    )
    expect(reply.rootNeedID).toBe(first.rootNeedID)
    expect(reply.threadID).toBe(first.threadID)
    expect(reply.runID).not.toBe(first.runID)
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationThreadTable).all())).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(2)
  })

  test.serial("rolls back the root need, thread, and run when the final message write fails", async () => {
    Database.Client().$client.exec(
      "CREATE TRIGGER intake_abort_message BEFORE INSERT ON channel_message BEGIN SELECT RAISE(ABORT, 'forced intake failure'); END;",
    )

    await expect(run((conversation) => conversation.sendMessage(input()))).rejects.toThrow("forced intake failure")
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationThreadTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationThreadMemberTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ChannelMessageTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(0)
  })

  test.serial("keeps company messages out of the board execution path and permits only server-created project channels", async () => {
    const companyMessage = await run((conversation) =>
      conversation.sendMessage(
        input({
          channelID: COMPANY_CHANNEL_ID,
          body: "Share this company-wide note without creating a project.",
        }),
      ),
    )
    expect(companyMessage).toMatchObject({ rootNeedID: undefined, threadID: undefined, runID: undefined })

    const project = await run((conversation) =>
      conversation.ensureProjectChannel({
        companyID,
        projectScopeID: "formal-project",
        title: "Formal project",
        members: [user, { kind: "agent", id: "board-cto" }],
      }),
    )
    const projectMessage = await run((conversation) =>
      conversation.sendMessage(
        input({
          channelID: project.id,
          body: "A project channel message is persisted but does not create a board run.",
        }),
      ),
    )
    expect(projectMessage).toMatchObject({ rootNeedID: undefined, threadID: undefined, runID: undefined })
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationRunTable).all())).toHaveLength(0)
  })

  test.serial("rejects invalid input and cross-scope references without partial board writes", async () => {
    await expect(
      run((conversation) =>
        conversation.sendMessage({
          ...input(),
          body: "   ",
        }),
      ),
    ).rejects.toMatchObject({ name: "ConversationMessageInvalidInput" })
    await expect(
      run((conversation) =>
        conversation.sendMessage({
          ...input(),
          body: "x".repeat(20_001),
        }),
      ),
    ).rejects.toMatchObject({ name: "ConversationMessageInvalidInput" })
    await expect(
      run((conversation) =>
        conversation.sendMessage(
          input({
            principal: { kind: "user", id: "usr_not_a_member" },
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "ConversationChannelNotVisible" })

    Database.use((db) => {
      db.insert(ChannelMessageTable)
        .values({
          id: ChannelMessageID.parse("cmsg_company_reply"),
          channel_id: COMPANY_CHANNEL_ID,
          author_kind: "user",
          author_id: LOCAL_USER_ID,
          body: "A company message cannot be replied to from board.",
          visibility: "channel",
          mentions: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ConversationThreadTable)
        .values({
          id: ConversationThreadID.parse("cth_company_scope"),
          company_id: companyID,
          channel_id: COMPANY_CHANNEL_ID,
          title: "Company thread",
          status: "active",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ConversationThreadMemberTable)
        .values({
          conversation_thread_id: ConversationThreadID.parse("cth_company_scope"),
          principal_kind: "user",
          principal_id: LOCAL_USER_ID,
          time_joined: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
    })

    await expect(
      run((conversation) =>
        conversation.sendMessage(
          input({
            replyToID: ChannelMessageID.parse("cmsg_company_reply"),
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "ConversationReplyNotVisible" })
    await expect(
      run((conversation) =>
        conversation.sendMessage(
          input({
            referencedThreadID: ConversationThreadID.parse("cth_company_scope"),
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "ConversationThreadNotVisible" })
    await expect(
      run((conversation) =>
        conversation.sendMessage(
          input({
            mentions: [{ kind: "agent", agent_id: "agent_not_a_board_member" }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "ConversationMentionNotVisible" })
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(0)
    expect(
      Database.use((db) =>
        db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.channel_id, BOARD_CHANNEL_ID)).all(),
      ),
    ).toHaveLength(0)
  })

  test.serial("rejects archived channels before creating any rows", async () => {
    Database.use((db) => db.update(ChannelTable).set({ time_archived: 2 }).where(eq(ChannelTable.id, BOARD_CHANNEL_ID)).run())

    await expect(run((conversation) => conversation.sendMessage(input()))).rejects.toMatchObject({
      name: "ConversationChannelNotVisible",
    })
    expect(Database.use((db) => db.select().from(RootNeedTable).all())).toHaveLength(0)
  })
})
