import { Context, Effect, Layer } from "effect"
import { NamedError } from "@agents-company/shared/util/error"
import z from "zod"
import { CompanyAgentTable } from "@/company-agent/company-agent.sql"
import { RepositoryBindingTable } from "@/company/company.sql"
import { RepositoryInstance } from "@/company/repository-instance"
import { GroupSession } from "@/group-session"
import { GroupSessionID } from "@/group-session/schema"
import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage"
import { ChannelMessageTable, ChannelTable, ConversationRunTable, ConversationThreadTable } from "./conversation.sql"
import { ConversationRunID } from "./schema"

const BOARD_ROLES = ["ceo", "cto", "product_lead"] as const

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
    if (boardAgentIDs.length !== BOARD_ROLES.length) return

    const runtimeID = db
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
      groupSessionID: runtimeID ? GroupSessionID.zod.safeParse(runtimeID).data : undefined,
      boardAgentIDs,
    }
  })
}

function markRunning(runID: ConversationRunID) {
  Database.use((db) => {
    const run = db.select().from(ConversationRunTable).where(eq(ConversationRunTable.id, runID)).get()
    if (!run) return
    const now = Date.now()
    db
      .update(ConversationRunTable)
      .set({
        state: "running",
        attempt: run.state === "queued" ? run.attempt + 1 : run.attempt,
        retryable: false,
        time_started: run.time_started ?? now,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, runID))
      .run()
  })
}

function bindRuntime(input: { runID: ConversationRunID; groupSessionID: GroupSessionID; roundNum: number }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .update(ConversationRunTable)
      .set({
        runtime_id: input.groupSessionID,
        runtime_round_num: input.roundNum,
        time_updated: now,
      })
      .where(eq(ConversationRunTable.id, input.runID))
      .run(),
  )
}

export interface Interface {
  readonly start: (runID: ConversationRunID) => Effect.Effect<Started, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConversationRuntime") {}

export const layer: Layer.Layer<Service, never, GroupSession.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const groupSessions = yield* GroupSession.Service

    const start = Effect.fn("ConversationRuntime.start")(function* (runID: ConversationRunID) {
      const input = yield* Effect.sync(() => loadRun(runID))
      if (!input) return yield* Effect.fail(new ConversationRunNotFound({ run_id: runID }))
      if (input.run.state !== "queued" && input.run.state !== "running") {
        return yield* Effect.fail(new ConversationRunNotRunnable({ run_id: runID, state: input.run.state }))
      }
      if (!input.projectID) return yield* Effect.fail(new ConversationRuntimeBoardUnavailable({ run_id: runID }))

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
          const accepted = yield* groupSessions.chat({
            groupSessionID: group.id,
            text: input.message.body,
            externalMessageID: input.message.id,
          })
          return {
            runID,
            groupSessionID: group.id,
            roundNum: accepted.roundNum,
            userGroupMessageID: accepted.userGroupMessageID,
          }
        }),
      )
      yield* Effect.sync(() => bindRuntime(started))
      return Started.parse(started)
    })

    return Service.of({ start })
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(GroupSession.defaultLayer)))

export * as ConversationRuntime from "./runtime"
