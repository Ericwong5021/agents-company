import { NamedError } from "@agents-company/shared/util/error"
import { Cause, Context, Effect, Layer } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { RepositoryBindingTable } from "@/company/company.sql"
import { RepositoryInstance } from "@/company/repository-instance"
import { GroupSession } from "@/group-session"
import { GroupSessionID } from "@/group-session/schema"
import { GroupMessageTable } from "@/group-session/group-session.sql"
import { Instance } from "@/project/instance"
import { Event as ServerEvent } from "@/server/event"
import { Database, and, eq } from "@/storage"
import * as ConversationRecovery from "./recovery"
import * as SignalProjector from "./signal-projector"
import { ChannelMessageTable, ChannelTable, ConversationRunTable, ConversationThreadTable } from "./conversation.sql"
import { ConversationPrincipal, ConversationRunID } from "./schema"

const BOARD_ROLES = ["ceo", "cto", "product_lead"] as const

const SignalSynthesis = z
  .object({
    publish: z.boolean(),
    signal_type: z.enum(["conclusion", "status", "risk", "intervention"]).optional(),
    body: z.string().trim().min(1).max(10_000).optional(),
    dri: ConversationPrincipal.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.publish) return
    if (!value.signal_type) {
      context.addIssue({ code: "custom", message: "A published signal needs a signal type.", path: ["signal_type"] })
    }
    if (!value.body) {
      context.addIssue({ code: "custom", message: "A published signal needs a body.", path: ["body"] })
    }
  })

const SIGNAL_SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    publish: { type: "boolean" },
    signal_type: { type: "string", enum: ["conclusion", "status", "risk", "intervention"] },
    body: { type: "string", minLength: 1, maxLength: 10_000 },
    dri: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["user", "agent"] },
        id: { type: "string", minLength: 1 },
      },
      required: ["kind", "id"],
    },
  },
  required: ["publish"],
}

export const ConversationRunNotFound = NamedError.create(
  "ConversationRunNotFound",
  z.object({ run_id: ConversationRunID }).strict(),
)

export const ConversationRunNotRunnable = NamedError.create(
  "ConversationRunNotRunnable",
  z.object({ run_id: ConversationRunID, state: z.string() }).strict(),
)

export const ConversationRuntimeProjectMismatch = NamedError.create(
  "ConversationRuntimeProjectMismatch",
  z.object({ run_id: ConversationRunID, expected_project_id: z.string(), actual_project_id: z.string() }).strict(),
)

export const ConversationRuntimeBoardUnavailable = NamedError.create(
  "ConversationRuntimeBoardUnavailable",
  z.object({ run_id: ConversationRunID }).strict(),
)

export const Started = z
  .object({
    runID: ConversationRunID,
    groupSessionID: GroupSessionID.zod,
    roundNum: z.number(),
    userGroupMessageID: z.string(),
  })
  .strict()
export type Started = z.infer<typeof Started>

type RuntimeInput = {
  run: typeof ConversationRunTable.$inferSelect
  thread: typeof ConversationThreadTable.$inferSelect
  message: typeof ChannelMessageTable.$inferSelect
  projectID: string
  groupSessionID?: GroupSessionID
  boardAgentIDs: string[]
  productLeadAgentID: string
}

function loadRun(runID: ConversationRunID): RuntimeInput | undefined {
  return Database.use((db) => {
    const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get()
    if (!run) return
    const thread = db
      .select()
      .from(ConversationThreadTable)
      .where(eq(ConversationThreadTable.id, run.conversation_thread_id))
      .get()
    const message = db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, run.channel_message_id)).get()
    if (!thread || !message) return
    const channel = db.select().from(ChannelTable).where(eq(ChannelTable.id, thread.channel_id)).get()
    if (!channel || channel.kind !== "board" || message.channel_id !== channel.id) return
    const binding = db
      .select({ project_id: RepositoryBindingTable.project_id })
      .from(RepositoryBindingTable)
      .where(eq(RepositoryBindingTable.company_id, thread.company_id))
      .get()
    if (!binding) return

    const agents = db
      .select({ id: CompanyAgentTable.id, role: CompanyAgentTable.role_key })
      .from(CompanyAgentTable)
      .where(eq(CompanyAgentTable.company_id, thread.company_id))
      .all()
    const boardAgentIDs = BOARD_ROLES.map((role) => agents.find((agent) => agent.role === role)?.id).filter(
      (id): id is string => Boolean(id),
    )
    const productLeadAgentID = agents.find((agent) => agent.role === "product_lead")?.id
    if (boardAgentIDs.length !== BOARD_ROLES.length || !productLeadAgentID) return

    const persistedRuntimeID = run.runtime_id ??
      db
        .select({ runtime_id: ConversationRunTable.runtime_id })
        .from(ConversationRunTable)
        .where(eq(ConversationRunTable.conversation_thread_id, thread.id))
        .orderBy(ConversationRunTable.time_created, ConversationRunTable.id)
        .all()
        .find((item) => item.runtime_id)?.runtime_id

    return {
      run,
      thread,
      message,
      projectID: binding.project_id,
      groupSessionID: persistedRuntimeID ? GroupSessionID.zod.safeParse(persistedRuntimeID).data : undefined,
      boardAgentIDs,
      productLeadAgentID,
    }
  })
}

function markRunning(runID: ConversationRunID) {
  Database.use((db) => {
    const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get()
    if (!run || run.state === "completed" || run.state === "interrupted") return
    const now = Date.now()
    db
      .update(ConversationRunTable)
      .set({
        state: "running",
        attempt: run.state === "queued" ? run.attempt + 1 : run.attempt,
        safe_error_summary: null,
        retryable: false,
        time_started: run.time_started ?? now,
        time_finished: null,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, runID))
      .run()
  })
}

function bindRuntime(input: { runID: ConversationRunID; groupSessionID: GroupSessionID; roundNum?: number }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .update(ConversationRunTable)
      .set(
        input.roundNum === undefined
          ? { runtime_id: input.groupSessionID, time_updated: now }
          : { runtime_id: input.groupSessionID, runtime_round_num: input.roundNum, time_updated: now },
      )
      .where(eq(ConversationRunTable.id, input.runID))
      .run(),
  )
}

function markProjecting(input: { runID: ConversationRunID; sourceWatermark: string }) {
  return Database.use((db) => {
    const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, input.runID)).get()
    if (!run || run.state === "completed" || run.state === "interrupted") return false
    const now = Date.now()
    db
      .update(ConversationRunTable)
      .set({
        state: "projecting",
        source_watermark: input.sourceWatermark,
        retryable: false,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, input.runID))
      .run()
    return true
  })
}

function markCompletedWithoutSignal(input: { runID: ConversationRunID; sourceWatermark: string }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .update(ConversationRunTable)
      .set({
        state: "completed",
        source_watermark: input.sourceWatermark,
        safe_error_summary: null,
        retryable: false,
        time_finished: now,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, input.runID))
      .run(),
  )
}

function safeErrorSummary(error: unknown) {
  if (error instanceof SignalProjector.SignalProjectionRejected) {
    return "The board discussion could not be projected safely. Retry after reviewing the thread."
  }
  return "The board discussion could not complete. Check the configured provider and retry."
}

function markFailed(runID: ConversationRunID, error: unknown) {
  Database.use((db) => {
    const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get()
    if (!run || run.state === "completed" || run.state === "interrupted") return
    const now = Date.now()
    db
      .update(ConversationRunTable)
      .set({
        state: "failed",
        safe_error_summary: safeErrorSummary(error),
        retryable: true,
        time_finished: now,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, runID))
      .run()
  })
}

function sourceWatermark(groupSessionID: GroupSessionID, roundNum: number, sourceIDs: string[]) {
  return `${groupSessionID}:${roundNum}:${sourceIDs.join("|")}`
}

function synthesisPrompt(input: { title: string; messages: GroupSession.GroupMessage[] }) {
  return [
    "You are the Product Lead for a board discussion.",
    "Return publish=false when the discussion has no user-visible conclusion, status, risk, or intervention.",
    "When publish=true, report only a concise, factual high signal grounded in the transcript. Do not invent approvals, deliveries, plans, decisions, tool output, or private context.",
    `<board_thread title=${JSON.stringify(input.title)}>`,
    ...input.messages.map((message) => `${message.role}: ${message.content}`),
    "</board_thread>",
  ].join("\n")
}

export interface Interface {
  readonly start: (runID: ConversationRunID) => Effect.Effect<Started, Error>
  readonly recover: () => Effect.Effect<ConversationRunID[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConversationRuntime") {}

export const layer: Layer.Layer<Service, never, GroupSession.Service | Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const groupSessions = yield* GroupSession.Service
    const bus = yield* Bus.Service

    const publishRunState = Effect.fn("ConversationRuntime.publishRunState")(function* (input: {
      threadID: RuntimeInput["thread"]["id"]
      state: "queued" | "running" | "projecting" | "completed" | "failed" | "interrupted"
    }) {
      yield* bus
        .publish(ServerEvent.ConversationRunUpdated, { thread_id: input.threadID, state: input.state })
        .pipe(Effect.ignore)
    })

    const monitor = Effect.fn("ConversationRuntime.monitor")(function* (input: RuntimeInput & Started) {
      yield* Effect.sleep("200 millis")
      while (yield* groupSessions.isBusy(input.groupSessionID)) {
        yield* Effect.sleep("50 millis")
      }
      const current = yield* Effect.sync(() => loadRun(input.runID))
      if (!current || current.run.state === "completed" || current.run.state === "interrupted") return
      const messages = yield* groupSessions.messages(input.groupSessionID)
      const sourceMessages = messages.filter((message) => message.roundNum === input.roundNum)
      if (sourceMessages.length === 0) {
        return yield* Effect.fail(new SignalProjector.SignalProjectionRejected({ reason: "missing_source" }))
      }
      const watermark = sourceWatermark(
        input.groupSessionID,
        input.roundNum,
        sourceMessages.map((message) => message.id),
      )
      if (!(yield* Effect.sync(() => markProjecting({ runID: input.runID, sourceWatermark: watermark })))) return
      yield* publishRunState({ threadID: input.thread.id, state: "projecting" }).pipe(Effect.forkDetach)

      const response = yield* groupSessions.promptMember({
        groupSessionID: input.groupSessionID,
        companyAgentID: input.productLeadAgentID,
        text: synthesisPrompt({ title: input.thread.title, messages: sourceMessages }),
        format: { type: "json_schema", schema: SIGNAL_SYNTHESIS_SCHEMA, retryCount: 2 },
      })
      if (response.info.role !== "assistant") {
        return yield* Effect.fail(new SignalProjector.SignalProjectionRejected({ reason: "invalid_draft" }))
      }
      const synthesis = SignalSynthesis.safeParse(response.info.structured)
      if (!synthesis.success) return yield* Effect.fail(new SignalProjector.SignalProjectionRejected({ reason: "invalid_draft" }))
      if (!synthesis.data.publish) {
        yield* Effect.sync(() => markCompletedWithoutSignal({ runID: input.runID, sourceWatermark: watermark }))
        yield* publishRunState({ threadID: input.thread.id, state: "completed" }).pipe(Effect.forkDetach)
        return
      }

      const projection = yield* SignalProjector.project({
        runID: input.runID,
        draft: {
          signal_type: synthesis.data.signal_type!,
          body: synthesis.data.body!,
          author: { kind: "agent", id: input.productLeadAgentID },
          dri: synthesis.data.dri,
        },
        sources: [
          ...sourceMessages.map((message) => ({ kind: "group_message" as const, id: message.id })),
          { kind: "message" as const, id: response.info.id },
        ],
        sourceWatermark: watermark,
      })
      yield* Effect.all(
        [
          bus.publish(ServerEvent.ChannelInvalidated, { channel_id: input.thread.channel_id }).pipe(Effect.ignore),
          bus.publish(ServerEvent.ThreadInvalidated, { thread_id: input.thread.id }).pipe(Effect.ignore),
          bus
            .publish(ServerEvent.ConversationRunUpdated, { thread_id: input.thread.id, state: "completed" })
            .pipe(Effect.ignore),
        ],
        { discard: true },
      ).pipe(Effect.forkDetach)
      return projection
    })

    const startUnchecked = Effect.fn("ConversationRuntime.startUnchecked")(function* (runID: ConversationRunID) {
      const input = yield* Effect.sync(() => loadRun(runID))
      if (!input) return yield* Effect.fail(new ConversationRunNotFound({ run_id: runID }))
      if (input.run.state !== "queued" && input.run.state !== "running") {
        return yield* Effect.fail(new ConversationRunNotRunnable({ run_id: runID, state: input.run.state }))
      }
      if (input.run.state === "running" && input.run.runtime_id && input.run.runtime_round_num !== null) {
        const groupSessionID = GroupSessionID.zod.safeParse(input.run.runtime_id).data
        if (groupSessionID) {
          const userGroupMessageID = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select({ id: GroupMessageTable.id })
                .from(GroupMessageTable)
                .where(
                  and(
                    eq(GroupMessageTable.group_session_id, groupSessionID),
                    eq(GroupMessageTable.external_message_id, input.message.id),
                  ),
                )
                .get(),
            ),
          )
          if (userGroupMessageID) {
            return Started.parse({
              runID,
              groupSessionID,
              roundNum: input.run.runtime_round_num,
              userGroupMessageID: userGroupMessageID.id,
            })
          }
        }
      }

      yield* Effect.sync(() => markRunning(runID))
      const started = yield* RepositoryInstance.provide(input.thread.company_id)(
        Effect.gen(function* () {
          if (Instance.project.id !== input.projectID) {
            return yield* Effect.fail(
              new ConversationRuntimeProjectMismatch({
                run_id: runID,
                expected_project_id: input.projectID,
                actual_project_id: Instance.project.id,
              }),
            )
          }
          const group = input.groupSessionID
            ? yield* groupSessions.get(input.groupSessionID)
            : yield* groupSessions.create({
                title: input.thread.title,
                agentIDs: input.boardAgentIDs,
                contextPolicy: "work_scoped",
              })
          yield* Effect.sync(() => bindRuntime({ runID, groupSessionID: group.id }))
          const accepted = yield* groupSessions.chat({
            groupSessionID: group.id,
            text: input.message.body,
            externalMessageID: input.message.id,
          })
          if (input.run.runtime_id && input.run.runtime_round_num !== null && input.groupSessionID === group.id) {
            yield* groupSessions.resume({ groupSessionID: group.id, roundNum: accepted.roundNum })
          }
          return {
            runID,
            groupSessionID: group.id,
            roundNum: accepted.roundNum,
            userGroupMessageID: accepted.userGroupMessageID,
          }
        }),
      )
      const parsed = Started.parse(started)
      yield* Effect.sync(() => bindRuntime(parsed))
      yield* publishRunState({ threadID: input.thread.id, state: "running" }).pipe(Effect.forkDetach)
      yield* RepositoryInstance.provide(input.thread.company_id)(
        monitor({ ...input, ...parsed }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => markFailed(runID, Cause.squash(cause)))
              yield* publishRunState({ threadID: input.thread.id, state: "failed" }).pipe(Effect.forkDetach)
            }),
          ),
        ),
      ).pipe(Effect.forkDetach)
      return parsed
    })

    const start = Effect.fn("ConversationRuntime.start")(function* (runID: ConversationRunID) {
      return yield* startUnchecked(runID).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const input = yield* Effect.sync(() => loadRun(runID))
            yield* Effect.sync(() => markFailed(runID, error))
            if (input) yield* publishRunState({ threadID: input.thread.id, state: "failed" }).pipe(Effect.forkDetach)
          }),
        ),
      )
    })

    const recover = Effect.fn("ConversationRuntime.recover")(function* () {
      const runIDs = yield* ConversationRecovery.recover()
      yield* Effect.forEach(runIDs, (runID) => start(runID).pipe(Effect.catch(() => Effect.void)), {
        concurrency: 1,
        discard: true,
      })
      return runIDs
    })

    return Service.of({ start, recover })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Layer.mergeAll(GroupSession.defaultLayer, Bus.defaultLayer))),
)

export * as ConversationRuntime from "./runtime"
