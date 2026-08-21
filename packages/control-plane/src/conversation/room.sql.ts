import { eq, sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { TxOrDb } from "@/storage/db"
import { ChannelMessageTable, ChannelTable } from "./conversation.sql"
import type { ChannelID, ChannelMessageID } from "./schema"

export const ChannelCounterTable = sqliteTable("channel_counter", {
  channel_id: text()
    .$type<ChannelID>()
    .primaryKey()
    .references(() => ChannelTable.id, { onDelete: "cascade" }),
  next_sequence: integer().notNull().default(1),
  ...Timestamps,
})

export const ChannelDeliveryTable = sqliteTable(
  "channel_delivery",
  {
    id: text().primaryKey(),
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    message_id: text()
      .$type<ChannelMessageID>()
      .notNull()
      .references(() => ChannelMessageTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id, { onDelete: "cascade" }),
    trigger_kind: text().$type<"human" | "mention" | "agent" | "system">().notNull(),
    status: text()
      .$type<"pending" | "triaging" | "running" | "held" | "responded" | "passed" | "failed" | "cancelled">()
      .notNull()
      .default("pending"),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull().default(3),
    reason: text(),
    agent_run_id: text(),
    response_message_id: text().$type<ChannelMessageID>(),
    next_attempt_at: integer(),
    time_started: integer(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [
    check(
      "channel_delivery_trigger_kind_check",
      sql.raw("trigger_kind in ('human', 'mention', 'agent', 'system')"),
    ),
    check(
      "channel_delivery_status_check",
      sql.raw("status in ('pending', 'triaging', 'running', 'held', 'responded', 'passed', 'failed', 'cancelled')"),
    ),
    uniqueIndex("channel_delivery_message_agent_idx").on(table.message_id, table.agent_id),
    index("channel_delivery_agent_status_idx").on(table.agent_id, table.status, table.next_attempt_at, table.time_created),
    index("channel_delivery_channel_status_idx").on(table.channel_id, table.status, table.time_created),
  ],
)

export const ChannelReadStateTable = sqliteTable(
  "channel_read_state",
  {
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    principal_kind: text().$type<"user" | "agent">().notNull(),
    principal_id: text().notNull(),
    last_read_sequence: integer().notNull().default(0),
    last_shown_sequence: integer().notNull().default(0),
    last_processed_sequence: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.channel_id, table.principal_kind, table.principal_id] }),
    check("channel_read_state_principal_kind_check", sql.raw("principal_kind in ('user', 'agent')")),
    check("channel_read_state_read_check", sql.raw("last_read_sequence >= 0")),
    check("channel_read_state_shown_check", sql.raw("last_shown_sequence >= 0")),
    check("channel_read_state_processed_check", sql.raw("last_processed_sequence >= 0")),
    index("channel_read_state_principal_idx").on(table.principal_kind, table.principal_id, table.channel_id),
  ],
)

export const ChannelMessageHoldTable = sqliteTable(
  "channel_message_hold",
  {
    channel_id: text()
      .$type<ChannelID>()
      .notNull()
      .references(() => ChannelTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .notNull()
      .references(() => CompanyAgentTable.id, { onDelete: "cascade" }),
    delivery_id: text()
      .notNull()
      .references(() => ChannelDeliveryTable.id, { onDelete: "cascade" }),
    held_to_sequence: integer().notNull(),
    expires_at: integer().notNull(),
    consumed_at: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.channel_id, table.agent_id] }),
    index("channel_message_hold_expiry_idx").on(table.expires_at),
  ],
)

export const ChannelReactionTable = sqliteTable(
  "channel_reaction",
  {
    message_id: text()
      .$type<ChannelMessageID>()
      .notNull()
      .references(() => ChannelMessageTable.id, { onDelete: "cascade" }),
    principal_kind: text().$type<"user" | "agent">().notNull(),
    principal_id: text().notNull(),
    emoji: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.principal_kind, table.principal_id, table.emoji] }),
    check("channel_reaction_principal_kind_check", sql.raw("principal_kind in ('user', 'agent')")),
    index("channel_reaction_message_idx").on(table.message_id, table.time_created),
  ],
)

export const ChannelPollVoteTable = sqliteTable(
  "channel_poll_vote",
  {
    message_id: text()
      .$type<ChannelMessageID>()
      .notNull()
      .references(() => ChannelMessageTable.id, { onDelete: "cascade" }),
    option_id: text().notNull(),
    principal_kind: text().$type<"user" | "agent">().notNull(),
    principal_id: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.option_id, table.principal_kind, table.principal_id] }),
    check("channel_poll_vote_principal_kind_check", sql.raw("principal_kind in ('user', 'agent')")),
    index("channel_poll_vote_message_idx").on(table.message_id, table.time_created),
  ],
)

export function claimChannelSequence(db: TxOrDb, channelID: ChannelID, now = Date.now()) {
  db.insert(ChannelCounterTable)
    .values({ channel_id: channelID, next_sequence: 1, time_created: now, time_updated: now })
    .onConflictDoNothing()
    .run()
  const counter = db
    .update(ChannelCounterTable)
    .set({ next_sequence: sql`${ChannelCounterTable.next_sequence} + 1`, time_updated: now })
    .where(eq(ChannelCounterTable.channel_id, channelID))
    .returning({ next_sequence: ChannelCounterTable.next_sequence })
    .get()
  if (!counter) throw new Error(`Channel counter is unavailable for ${channelID}`)
  return counter.next_sequence - 1
}
