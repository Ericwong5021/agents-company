import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import {
  BOARD_CHANNEL_ID,
  COMPANY_CHANNEL_ID,
  ChannelMemberTable,
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadMemberTable,
  ConversationThreadTable,
  LOCAL_USER_ID,
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
import { Conversation } from "../../src/conversation"
import { ProjectTable } from "../../src/project/project.sql"
import type { ProjectID } from "../../src/project/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_local")
const user = { kind: "user" as const, id: LOCAL_USER_ID }

function run<A, E>(fn: (conversation: Conversation.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(Conversation.Service.use(fn).pipe(Effect.provide(Conversation.layer)))
}

function insertMessage(id: string, time: number, sourceThreadID?: string) {
  Database.use((db) =>
    db
      .insert(ChannelMessageTable)
      .values({
        id: ChannelMessageID.parse(id),
        channel_id: COMPANY_CHANNEL_ID,
        source_thread_id: sourceThreadID ? ConversationThreadID.parse(sourceThreadID) : null,
        author_kind: "user",
        author_id: LOCAL_USER_ID,
        body: id,
        visibility: "channel",
        mentions: [],
        time_created: time,
        time_updated: time,
      })
      .run(),
  )
}

function seed() {
  Database.use((db) =>
    db
      .insert(CompanyTable)
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
      .run(),
  )
  ensureCompanyChannels({
    companyID,
    boardAgentIDs: ["board-ceo", "board-cto", "board-product-lead"],
    now: 1,
  })
}

beforeEach(async () => {
  await resetDatabase()
  seed()
})

afterEach(resetDatabase)

describe.serial("M2 conversation read model", () => {
  test.serial("lists only active channels visible to the principal and excludes archived channels", async () => {
    const hiddenChannelID = ChannelID.parse("chn_department")
    Database.use((db) => {
      db.insert(ChannelTable)
        .values({
          id: hiddenChannelID,
          company_id: companyID,
          kind: "department",
          title: "Engineering",
          retention_days: 0,
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ChannelMemberTable)
        .values({
          channel_id: hiddenChannelID,
          principal_kind: "agent",
          principal_id: "board-cto",
          role: "member",
          time_joined: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.update(ChannelTable).set({ time_archived: 2 }).where(eq(ChannelTable.id, BOARD_CHANNEL_ID)).run()
    })

    expect((await run((conversation) => conversation.listChannels({ companyID, principal: user }))).map((item) => item.id)).toEqual([
      COMPANY_CHANNEL_ID,
    ])
    await expect(
      run((conversation) =>
        conversation.pageMessages({
          companyID,
          channelID: hiddenChannelID,
          principal: user,
        }),
      ),
    ).rejects.toMatchObject({ name: "ConversationChannelNotVisible" })
  })

  test.serial("uses a time-and-id cursor to page equal-time messages without skips", async () => {
    insertMessage("cmsg_01", 10)
    insertMessage("cmsg_02", 10)
    insertMessage("cmsg_03", 10)

    const first = await run((conversation) =>
      conversation.pageMessages({
        companyID,
        channelID: COMPANY_CHANNEL_ID,
        principal: user,
        limit: 2,
      }),
    )
    expect(first.items.map((item) => item.id)).toEqual([
      ChannelMessageID.parse("cmsg_03"),
      ChannelMessageID.parse("cmsg_02"),
    ])
    expect(first.nextCursor).toBeString()

    const second = await run((conversation) =>
      conversation.pageMessages({
        companyID,
        channelID: COMPANY_CHANNEL_ID,
        principal: user,
        before: first.nextCursor,
        limit: 2,
      }),
    )
    expect(second.items.map((item) => item.id)).toEqual([ChannelMessageID.parse("cmsg_01")])
    expect(second.nextCursor).toBeUndefined()
  })

  test.serial("scopes thread entries and source evidence through the visible channel", async () => {
    const threadID = ConversationThreadID.parse("cth_board-need")
    Database.use((db) => {
      db.insert(ConversationThreadTable)
        .values({
          id: threadID,
          company_id: companyID,
          channel_id: COMPANY_CHANNEL_ID,
          title: "Board need",
          status: "active",
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.insert(ConversationThreadMemberTable)
        .values({
          conversation_thread_id: threadID,
          principal_kind: "user",
          principal_id: LOCAL_USER_ID,
          time_joined: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
    })
    insertMessage("cmsg_thread", 10, threadID)
    Database.use((db) => {
      db.insert(ConversationRunTable)
        .values({
          id: ConversationRunID.parse("crun_board-need"),
          conversation_thread_id: threadID,
          channel_message_id: ChannelMessageID.parse("cmsg_thread"),
          state: "completed",
          attempt: 1,
          retryable: false,
          time_created: 11,
          time_updated: 11,
        })
        .run()
      db.insert(SignalProjectionTable)
        .values({
          id: SignalProjectionID.parse("spr_board-need"),
          channel_message_id: ChannelMessageID.parse("cmsg_thread"),
          conversation_thread_id: threadID,
          conversation_run_id: ConversationRunID.parse("crun_board-need"),
          projector_version: 1,
          source_watermark: "round-1",
          time_created: 12,
          time_updated: 12,
        })
        .run()
      db.insert(SignalProjectionSourceTable)
        .values({
          signal_projection_id: SignalProjectionID.parse("spr_board-need"),
          ordinal: 0,
          source_kind: "group_message",
          source_id: "msg_group-evidence",
          time_created: 12,
          time_updated: 12,
        })
        .run()
    })

    expect((await run((conversation) => conversation.getThread({ companyID, threadID, principal: user }))).id).toBe(threadID)
    await expect(
      run((conversation) =>
        conversation.getThread({
          companyID,
          threadID,
          principal: { kind: "agent", id: "board-cto" },
        }),
      ),
    ).rejects.toMatchObject({ name: "ConversationThreadNotVisible" })
    expect((await run((conversation) => conversation.pageEntries({ companyID, threadID, principal: user }))).items).toHaveLength(1)
    expect(
      await run((conversation) =>
        conversation.getSource({
          companyID,
          threadID,
          sourceID: "msg_group-evidence",
          principal: user,
        }),
      ),
    ).toMatchObject({ kind: "group_message", sourceID: "msg_group-evidence" })
  })

  test.serial("creates project channels only through the explicit project-channel service", async () => {
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id: "legacy-project" as ProjectID,
          worktree: "/tmp/legacy-project",
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run(),
    )
    expect((await run((conversation) => conversation.listChannels({ companyID, principal: user }))).some((item) => item.kind === "project")).toBe(
      false,
    )

    const first = await run((conversation) =>
      conversation.ensureProjectChannel({
        companyID,
        projectScopeID: "formal-project",
        title: "Formal project",
        members: [user, { kind: "agent", id: "board-cto" }],
      }),
    )
    const second = await run((conversation) =>
      conversation.ensureProjectChannel({
        companyID,
        projectScopeID: "formal-project",
        title: "Changed title is ignored after creation",
        members: [user],
      }),
    )
    expect(second.id).toBe(first.id)
    expect(
      (await run((conversation) => conversation.listChannels({ companyID, principal: user }))).filter(
        (item) => item.kind === "project",
      ),
    ).toHaveLength(1)
  })
})
