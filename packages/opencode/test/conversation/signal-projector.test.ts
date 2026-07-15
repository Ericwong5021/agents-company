import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
} from "../../src/conversation/conversation.sql"
import {
  ChannelID,
  ChannelMessageID,
  ConversationRunID,
  ConversationThreadID,
} from "../../src/conversation/schema"
import { SignalProjector } from "../../src/conversation/signal-projector"
import { GroupMessageTable, GroupSessionTable } from "../../src/group-session/group-session.sql"
import { GroupSessionID } from "../../src/group-session/schema"
import { ProjectTable } from "../../src/project/project.sql"
import type { ProjectID } from "../../src/project/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { and, eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_projector")
const channelID = ChannelID.parse("chn_projector")
const threadID = ConversationThreadID.parse("cth_projector")
const runID = ConversationRunID.parse("crun_projector")
const userMessageID = ChannelMessageID.parse("cmsg_projector-user")
const groupSessionID = GroupSessionID.ascending()
const groupMessageID = "msg_projector-source"

function seed() {
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: "projector-project" as ProjectID,
        worktree: "/tmp/projector-project",
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(CompanyTable)
      .values({
        id: companyID,
        name: "Projector Company",
        data_version: 1,
        default_provider_id: ProviderID.zod.parse("test"),
        default_model_id: ModelID.zod.parse("test"),
        bootstrap_request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344d1",
        bootstrap_input_path: "/tmp/projector-company",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(ChannelTable)
      .values({
        id: channelID,
        company_id: companyID,
        kind: "board",
        title: "Board",
        retention_days: 0,
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(ConversationThreadTable)
      .values({
        id: threadID,
        company_id: companyID,
        channel_id: channelID,
        title: "Projector need",
        status: "active",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(ChannelMessageTable)
      .values({
        id: userMessageID,
        channel_id: channelID,
        source_thread_id: threadID,
        author_kind: "user",
        author_id: "usr_local",
        body: "Assess the release risk.",
        visibility: "channel",
        mentions: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(ConversationRunTable)
      .values({
        id: runID,
        conversation_thread_id: threadID,
        channel_message_id: userMessageID,
        state: "projecting",
        attempt: 1,
        runtime_id: groupSessionID,
        runtime_round_num: 0,
        retryable: false,
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(GroupSessionTable)
      .values({
        id: groupSessionID,
        project_id: "projector-project" as ProjectID,
        title: "Projector board",
        context_policy: "work_scoped",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    db.insert(GroupMessageTable)
      .values({
        id: groupMessageID,
        group_session_id: groupSessionID,
        round_num: 0,
        role: "user",
        content: "Assess the release risk.",
        external_message_id: userMessageID,
        time_created: 1,
        time_updated: 1,
      })
      .run()
  })
}

function project(input: Partial<SignalProjector.ProjectInput> = {}) {
  return Effect.runPromise(
    SignalProjector.project({
      runID,
      draft: {
        signal_type: "risk",
        body: "The release needs a provider smoke test before it can proceed.",
        author: { kind: "agent", id: "board-product-lead" },
      },
      sources: [{ kind: "group_message", id: groupMessageID }],
      sourceWatermark: "round-0-group-source",
      ...input,
    }),
  )
}

beforeEach(async () => {
  await resetDatabase()
  seed()
})

afterEach(resetDatabase)

describe.serial("M2 signal projector", () => {
  test.serial("rejects source-less, unsupported, and ungrounded high-signal drafts", async () => {
    await expect(project({ sources: [] })).rejects.toMatchObject({
      name: "ConversationSignalProjectionRejected",
      data: { reason: "missing_source" },
    })
    await expect(
      project({
        draft: {
          signal_type: "plan",
          body: "Create a delivery plan.",
          author: { kind: "agent", id: "board-product-lead" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConversationSignalProjectionRejected", data: { reason: "unsupported_signal" } })
    await expect(
      project({
        draft: {
          signal_type: "decision",
          body: "Approve the direction.",
          author: { kind: "agent", id: "board-product-lead" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConversationSignalProjectionRejected", data: { reason: "invalid_draft" } })
    await expect(
      project({
        draft: {
          signal_type: "decision",
          body: "Assign a DRI only after the M3 governance model exists.",
          author: { kind: "agent", id: "board-product-lead" },
          dri: { kind: "agent", id: "board-ceo" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConversationSignalProjectionRejected", data: { reason: "unsupported_signal" } })
    await expect(
      project({
        draft: {
          signal_type: "approval",
          body: "The release is approved.",
          author: { kind: "agent", id: "board-product-lead" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConversationSignalProjectionRejected", data: { reason: "approval_requires_fact" } })
    await expect(
      project({
        draft: {
          signal_type: "delivery",
          body: "The delivery is complete.",
          author: { kind: "agent", id: "board-product-lead" },
        },
      }),
    ).rejects.toMatchObject({ name: "ConversationSignalProjectionRejected", data: { reason: "delivery_requires_fact" } })
  })

  test.serial("writes the channel message, projection, and ordered sources atomically after a committed response is lost", async () => {
    const first = await project()
    expect(first.replayed).toBe(false)

    const highSignal = Database.use((db) =>
      db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, first.channelMessageID)).get(),
    )
    expect(highSignal).toMatchObject({
      channel_id: channelID,
      source_thread_id: threadID,
      author_kind: "agent",
      author_id: "board-product-lead",
      signal_type: "risk",
      visibility: "company",
    })
    expect(
      Database.use((db) =>
        db
          .select()
          .from(SignalProjectionTable)
          .where(and(eq(SignalProjectionTable.conversation_run_id, runID), eq(SignalProjectionTable.channel_message_id, first.channelMessageID)))
          .all(),
      ),
    ).toHaveLength(1)
    expect(
      Database.use((db) =>
        db
          .select()
          .from(SignalProjectionSourceTable)
          .where(eq(SignalProjectionSourceTable.signal_projection_id, first.projectionID))
          .orderBy(SignalProjectionSourceTable.ordinal)
          .all(),
      ).map((source) => [source.source_kind, source.source_id]),
    ).toEqual([["group_message", groupMessageID]])

    const replay = await project({
      draft: {
        signal_type: "risk",
        body: "This replacement body must not create another high signal.",
        author: { kind: "agent", id: "board-product-lead" },
      },
    })
    expect(replay).toEqual({ ...first, replayed: true })
    expect(Database.use((db) => db.select().from(SignalProjectionTable).all())).toHaveLength(1)
    expect(
      Database.use((db) => db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.signal_type, "risk")).all()),
    ).toHaveLength(1)
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get())).toMatchObject({
      state: "completed",
      source_watermark: "round-0-group-source",
      retryable: false,
    })
  })

  test.serial("never overwrites an interrupted run or thread with a completed projection", async () => {
    Database.use((db) => {
      db.update(ConversationRunTable)
        .set({ state: "interrupted", time_finished: 2, time_updated: 2 })
        .where(eq(ConversationRunTable.id, runID))
        .run()
      db.update(ConversationThreadTable)
        .set({ status: "interrupted", time_updated: 2 })
        .where(eq(ConversationThreadTable.id, threadID))
        .run()
    })

    await expect(project()).rejects.toMatchObject({
      name: "ConversationSignalProjectionRejected",
      data: { reason: "run_not_projecting" },
    })
    expect(Database.use((db) => db.select().from(SignalProjectionTable).all())).toHaveLength(0)
    expect(
      Database.use((db) => db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.signal_type, "risk")).all()),
    ).toHaveLength(0)
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get())).toMatchObject({
      state: "interrupted",
    })
  })
})
