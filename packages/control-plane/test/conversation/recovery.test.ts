import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CompanyTable } from "../../src/company/company.sql"
import { CompanyID } from "../../src/company/schema"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadTable,
} from "../../src/conversation/conversation.sql"
import { ConversationRecovery } from "../../src/conversation/recovery"
import { ChannelID, ChannelMessageID, ConversationRunID, ConversationThreadID } from "../../src/conversation/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { eq } from "../../src/storage"
import * as Database from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

const companyID = CompanyID.parse("cmp_recovery")
const channelID = ChannelID.parse("chn_recovery")
const threadID = ConversationThreadID.parse("cth_recovery")

function seedRun(id: string, state: "queued" | "running" | "projecting" | "completed" | "interrupted", time: number) {
  const messageID = ChannelMessageID.parse(`cmsg_${id}`)
  const runID = ConversationRunID.parse(`crun_${id}`)
  Database.use((db) => {
    db.insert(ChannelMessageTable)
      .values({
        id: messageID,
        channel_id: channelID,
        source_thread_id: threadID,
        author_kind: "user",
        author_id: "usr_local",
        body: id,
        visibility: "channel",
        mentions: [],
        time_created: time,
        time_updated: time,
      })
      .run()
    db.insert(ConversationRunTable)
      .values({
        id: runID,
        conversation_thread_id: threadID,
        channel_message_id: messageID,
        state,
        attempt: 2,
        runtime_id: "ses_recovery-runtime",
        runtime_round_num: 3,
        source_watermark: "round-3-source",
        retryable: false,
        time_started: time,
        time_finished: state === "completed" || state === "interrupted" ? time : null,
        time_created: time,
        time_updated: time,
      })
      .run()
  })
  return runID
}

function seed() {
  Database.use((db) => {
    db.insert(CompanyTable)
      .values({
        id: companyID,
        name: "Recovery Company",
        data_version: 1,
        default_provider_id: ProviderID.zod.parse("test"),
        default_model_id: ModelID.zod.parse("test"),
        bootstrap_request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344d2",
        bootstrap_input_path: "/tmp/recovery-company",
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
        title: "Recovery need",
        status: "active",
        time_created: 1,
        time_updated: 1,
      })
      .run()
  })
}

beforeEach(async () => {
  await resetDatabase()
  seed()
})

afterEach(resetDatabase)

describe.serial("M2 conversation recovery", () => {
  test.serial("queues pending work and normalizes crashed-before-projection states while preserving idempotency bindings", async () => {
    const queued = seedRun("queued", "queued", 9)
    const running = seedRun("running", "running", 10)
    const projecting = seedRun("projecting", "projecting", 11)
    const completed = seedRun("completed", "completed", 12)
    const interrupted = seedRun("interrupted", "interrupted", 13)

    expect(await Effect.runPromise(ConversationRecovery.recover())).toEqual([queued, running, projecting])
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, queued)).get())).toMatchObject({
      state: "queued",
      runtime_id: "ses_recovery-runtime",
      runtime_round_num: 3,
      source_watermark: "round-3-source",
      retryable: false,
    })
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, running)).get())).toMatchObject({
      state: "queued",
      runtime_id: "ses_recovery-runtime",
      runtime_round_num: 3,
      source_watermark: "round-3-source",
      retryable: false,
    })
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, projecting)).get())).toMatchObject({
      state: "queued",
      runtime_id: "ses_recovery-runtime",
      runtime_round_num: 3,
      source_watermark: "round-3-source",
      retryable: false,
    })
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, completed)).get()?.state)).toBe(
      "completed",
    )
    expect(Database.use((db) => db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, interrupted)).get()?.state)).toBe(
      "interrupted",
    )
  })
})
