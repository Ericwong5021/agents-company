import { NamedError } from "@agents-company/shared/util/error"
import { Effect } from "effect"
import z from "zod"
import { Identifier } from "@/id/id"
import { and, eq } from "@/storage"
import * as Database from "@/storage/db"
import { GroupMessageTable, GroupSessionMemberTable } from "@/group-session/group-session.sql"
import { GroupSessionID } from "@/group-session/schema"
import { MessageID, PartID } from "@/session/schema"
import { MessageTable, PartTable } from "@/session/session.sql"
import {
  ChannelMessageTable,
  ChannelTable,
  ConversationRunTable,
  ConversationThreadTable,
  SignalProjectionSourceTable,
  SignalProjectionTable,
} from "./conversation.sql"
import {
  ChannelMessageID,
  ConversationRunID,
  HighSignalDraft,
  SignalProjectionID,
  SignalProjectionSource,
} from "./schema"

const PROJECTOR_VERSION = 1
const M2_SIGNAL_TYPES = new Set(["conclusion", "status", "risk", "intervention"])

export const SignalProjectionRejected = NamedError.create(
  "ConversationSignalProjectionRejected",
  z
    .object({
      reason: z.enum([
        "invalid_draft",
        "missing_source",
        "duplicate_source",
        "unsupported_signal",
        "approval_requires_fact",
        "delivery_requires_fact",
        "run_not_found",
        "source_not_found",
      ]),
    })
    .strict(),
)

export const ProjectInput = z
  .object({
    runID: ConversationRunID,
    draft: HighSignalDraft,
    sources: z.array(SignalProjectionSource).max(100),
    sourceWatermark: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
export type ProjectInput = z.input<typeof ProjectInput>

export const Projected = z
  .object({
    projectionID: SignalProjectionID,
    channelMessageID: ChannelMessageID,
    sourceWatermark: z.string().min(1),
    replayed: z.boolean(),
  })
  .strict()
export type Projected = z.infer<typeof Projected>

type ParsedProjectInput = z.output<typeof ProjectInput>
type RejectionReason = z.input<typeof SignalProjectionRejected.Schema>["data"]["reason"]

function reject(reason: RejectionReason) {
  return Effect.fail(new SignalProjectionRejected({ reason }))
}

function watermark(input: ParsedProjectInput) {
  return input.sourceWatermark ?? input.sources.map((source) => `${source.kind}:${source.id}`).join("|")
}

function isFactSource(input: ParsedProjectInput) {
  return input.sources.some((source) => source.kind === "artifact" || source.kind === "gate")
}

function hasDuplicateSource(input: ParsedProjectInput) {
  return new Set(input.sources.map((source) => `${source.kind}:${source.id}`)).size !== input.sources.length
}

function validateDraft(input: ParsedProjectInput): RejectionReason | undefined {
  if (input.sources.length === 0) return "missing_source"
  if (hasDuplicateSource(input)) return "duplicate_source"
  if (input.draft.signal_type === "approval" && !isFactSource(input)) return "approval_requires_fact"
  if (input.draft.signal_type === "delivery" && !isFactSource(input)) return "delivery_requires_fact"
  if (!M2_SIGNAL_TYPES.has(input.draft.signal_type)) return "unsupported_signal"
}

function sourceBelongsToRun(
  db: Database.TxOrDb,
  run: typeof ConversationRunTable.$inferSelect,
  source: ParsedProjectInput["sources"][number],
) {
  if (!run.runtime_id) return false
  const groupSessionID = GroupSessionID.zod.safeParse(run.runtime_id).data
  if (!groupSessionID) return false
  if (source.kind === "group_message") {
    return Boolean(
      db
        .select({ id: GroupMessageTable.id })
        .from(GroupMessageTable)
        .where(and(eq(GroupMessageTable.id, source.id), eq(GroupMessageTable.group_session_id, groupSessionID)))
        .get(),
    )
  }

  const sessionIDs = new Set(
    db
      .select({ session_id: GroupSessionMemberTable.session_id })
      .from(GroupSessionMemberTable)
      .where(eq(GroupSessionMemberTable.group_session_id, groupSessionID))
      .all()
      .map((member) => member.session_id),
  )
  if (sessionIDs.size === 0) return false
  if (source.kind === "message") {
    const messageID = MessageID.zod.safeParse(source.id).data
    if (!messageID) return false
    const message = db.select({ session_id: MessageTable.session_id }).from(MessageTable).where(eq(MessageTable.id, messageID)).get()
    return Boolean(message && sessionIDs.has(message.session_id))
  }
  if (source.kind === "part") {
    const partID = PartID.zod.safeParse(source.id).data
    if (!partID) return false
    const part = db.select({ session_id: PartTable.session_id }).from(PartTable).where(eq(PartTable.id, partID)).get()
    return Boolean(part && sessionIDs.has(part.session_id))
  }
  return false
}

function write(input: ParsedProjectInput): Projected | RejectionReason {
  const sourceWatermark = watermark(input)
  return Database.transaction(
    (db) => {
      const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, input.runID)).get()
      if (!run) return "run_not_found"
      const thread = db
        .select()
        .from(ConversationThreadTable)
        .where(eq(ConversationThreadTable.id, run.conversation_thread_id))
        .get()
      const channel = thread
        ? db.select().from(ChannelTable).where(eq(ChannelTable.id, thread.channel_id)).get()
        : undefined
      if (!thread || !channel) return "run_not_found"

      const existing = db
        .select()
        .from(SignalProjectionTable)
        .where(
          and(
            eq(SignalProjectionTable.conversation_thread_id, thread.id),
            eq(SignalProjectionTable.projector_version, PROJECTOR_VERSION),
            eq(SignalProjectionTable.source_watermark, sourceWatermark),
          ),
        )
        .get()
      if (existing) {
        const now = Date.now()
        db.update(ConversationRunTable)
          .set({
            state: "completed",
            source_watermark: sourceWatermark,
            safe_error_summary: null,
            retryable: false,
            time_finished: now,
            time_updated: now,
          })
          .where(eq(ConversationRunTable.id, input.runID))
          .run()
        return {
          projectionID: existing.id,
          channelMessageID: existing.channel_message_id,
          sourceWatermark,
          replayed: true,
        }
      }

      if (!input.sources.every((source) => sourceBelongsToRun(db, run, source))) return "source_not_found"

      const now = Date.now()
      const channelMessageID = ChannelMessageID.parse(Identifier.ascending("channelMessage"))
      const projectionID = SignalProjectionID.parse(Identifier.ascending("signalProjection"))
      db.insert(ChannelMessageTable)
        .values({
          id: channelMessageID,
          channel_id: channel.id,
          root_need_id: thread.root_need_id ?? null,
          source_thread_id: thread.id,
          reply_to_id: null,
          request_id: null,
          author_kind: input.draft.author.kind,
          author_id: input.draft.author.id,
          body: input.draft.body,
          signal_type: input.draft.signal_type,
          dri_principal_kind: input.draft.dri?.kind ?? null,
          dri_principal_id: input.draft.dri?.id ?? null,
          visibility: "company",
          mentions: [],
          time_created: now,
          time_updated: now,
        })
        .run()
      db.insert(SignalProjectionTable)
        .values({
          id: projectionID,
          channel_message_id: channelMessageID,
          conversation_thread_id: thread.id,
          conversation_run_id: run.id,
          projector_version: PROJECTOR_VERSION,
          source_watermark: sourceWatermark,
          time_created: now,
          time_updated: now,
        })
        .run()
      db.insert(SignalProjectionSourceTable)
        .values(
          input.sources.map((source, ordinal) => ({
            signal_projection_id: projectionID,
            ordinal,
            source_kind: source.kind,
            source_id: source.id,
            time_created: now,
            time_updated: now,
          })),
        )
        .run()
      db.update(ConversationRunTable)
        .set({
          state: "completed",
          source_watermark: sourceWatermark,
          safe_error_summary: null,
          retryable: false,
          time_finished: now,
          time_updated: now,
        })
        .where(eq(ConversationRunTable.id, input.runID))
        .run()
      return {
        projectionID,
        channelMessageID,
        sourceWatermark,
        replayed: false,
      }
    },
    { behavior: "immediate" },
  )
}

export function project(raw: ProjectInput): Effect.Effect<Projected, InstanceType<typeof SignalProjectionRejected>> {
  return Effect.gen(function* () {
    const parsed = ProjectInput.safeParse(raw)
    if (!parsed.success) return yield* reject("invalid_draft")
    const invalid = validateDraft(parsed.data)
    if (invalid) return yield* reject(invalid)
    const result = yield* Effect.sync(() => write(parsed.data))
    if (typeof result === "string") return yield* reject(result)
    return Projected.parse(result)
  })
}

export * as SignalProjector from "./signal-projector"
