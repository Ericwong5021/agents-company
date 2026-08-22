import { Context, Effect, Layer } from "effect"
import { and, desc, eq, isNull, ne, or } from "@/storage"
import * as Database from "@/storage/db"
import { Identifier } from "@/id/id"
import { Agent } from "@/agent/agent"
import { AgentRunSupervisor } from "@/agent-run/supervisor"
import { AgentTurn } from "@/agent-turn"
import { Bus } from "@/bus"
import { CompanyAgent } from "@/company-agent"
import type { CompanyAgentID } from "@/company-agent/schema"
import type { CompanyID } from "@/company/schema"
import { Config } from "@/config"
import { RepositoryInstance } from "@/company/repository-instance"
import { probeOne } from "@/group-session/scheduler/probe"
import { MAX_AGENT_TURNS, shouldRespond } from "@/group-session/scheduler/natural-turn"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider"
import { Event as ServerEvent } from "@/server/event"
import { LLM } from "@/session/llm"
import { ChannelMemberTable, ChannelMessageTable, ChannelTable, ConversationThreadTable } from "./conversation.sql"
import {
  ChannelDeliveryTable,
  ChannelMessageHoldTable,
  ChannelReactionTable,
  ChannelReadStateTable,
  claimChannelSequence,
} from "./room.sql"
import { ChannelMessageID, type ChannelID, type ConversationThreadID } from "./schema"

const DEBOUNCE_MS = 800
const HOLD_MS = 10_000

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

function transcript(channelID: ChannelID, agents: Map<string, CompanyAgent.Info>) {
  return Database.use((db) =>
    db
      .select()
      .from(ChannelMessageTable)
      .where(eq(ChannelMessageTable.channel_id, channelID))
      .orderBy(desc(ChannelMessageTable.sequence))
      .limit(30)
      .all()
      .reverse()
      .map((message) => {
        const author = message.author_kind === "user"
          ? "Founder"
          : message.author_kind === "agent"
            ? agents.get(message.author_id)?.name ?? message.author_id
            : "System"
        return `[${message.sequence}] ${author}: ${message.body}`
      })
      .join("\n"),
  )
}

function activeAgentIDs(channelID: ChannelID) {
  return Database.use((db) =>
    db
      .select({ id: ChannelMemberTable.principal_id })
      .from(ChannelMemberTable)
      .where(
        and(
          eq(ChannelMemberTable.channel_id, channelID),
          eq(ChannelMemberTable.principal_kind, "agent"),
          isNull(ChannelMemberTable.time_left),
        ),
      )
      .all()
      .map((row) => row.id),
  )
}

function insertDeliveries(
  db: Database.TxOrDb,
  message: typeof ChannelMessageTable.$inferSelect,
  agentIDs: string[],
  now: number,
) {
  const mentioned = new Set(
    message.mentions.flatMap((mention) => mention.kind === "agent" ? [mention.agent_id] : []),
  )
  const recipients = agentIDs.filter((agentID) => message.author_kind !== "agent" || message.author_id !== agentID)
  if (!recipients.length) return []
  db.insert(ChannelDeliveryTable)
    .values(
      recipients.map((agentID) => ({
        id: Identifier.ascending("channelDelivery"),
        channel_id: message.channel_id,
        message_id: message.id,
        agent_id: agentID,
        trigger_kind: mentioned.has(agentID)
          ? "mention" as const
          : message.author_kind === "user"
            ? "human" as const
            : message.author_kind === "agent"
              ? "agent" as const
              : "system" as const,
        status: "pending" as const,
        attempt: 0,
        max_attempts: 3,
        time_created: now,
        time_updated: now,
      })),
    )
    .onConflictDoNothing()
    .run()
  return recipients
}

function recentAgentTurns(channelID: ChannelID) {
  const messages = Database.use((db) =>
    db
      .select({ author_kind: ChannelMessageTable.author_kind })
      .from(ChannelMessageTable)
      .where(eq(ChannelMessageTable.channel_id, channelID))
      .orderBy(desc(ChannelMessageTable.sequence))
      .limit(MAX_AGENT_TURNS + 1)
      .all(),
  )
  return messages.findIndex((message) => message.author_kind === "user") === -1
    ? messages.filter((message) => message.author_kind === "agent").length
    : messages.slice(0, messages.findIndex((message) => message.author_kind === "user")).filter((message) => message.author_kind === "agent").length
}

export interface Interface {
  readonly enqueueMessage: (input: { companyID: CompanyID; messageID: ChannelMessageID }) => Effect.Effect<void>
  readonly interruptThread: (input: { companyID: CompanyID; threadID: ConversationThreadID }) => Effect.Effect<void>
  readonly recover: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ConversationRoomRuntime") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Agent.Service
  | AgentRunSupervisor.Service
  | Bus.Service
  | CompanyAgent.Service
  | Config.Service
  | LLM.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentService = yield* Agent.Service
    const supervisor = yield* AgentRunSupervisor.Service
    const bus = yield* Bus.Service
    const companyAgents = yield* CompanyAgent.Service
    const config = yield* Config.Service
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const scheduled = new Set<string>()
    const running = new Set<string>()
    type ScheduleInput = { companyID: CompanyID; agentID: string; delayMs?: number }
    let schedule: (input: ScheduleInput) => Effect.Effect<void> = () => Effect.void

    const drain: (input: ScheduleInput) => Effect.Effect<void> = Effect.fn("ConversationRoomRuntime.drain")(function* (
      input: ScheduleInput,
    ) {
      if (running.has(input.agentID)) return
      running.add(input.agentID)
      yield* RepositoryInstance.provide(input.companyID)(
        Effect.gen(function* () {
          const pending = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select({ delivery: ChannelDeliveryTable, message: ChannelMessageTable })
                .from(ChannelDeliveryTable)
                .innerJoin(ChannelMessageTable, eq(ChannelMessageTable.id, ChannelDeliveryTable.message_id))
                .where(
                  and(
                    eq(ChannelDeliveryTable.agent_id, input.agentID),
                    eq(ChannelDeliveryTable.status, "pending"),
                    or(isNull(ChannelDeliveryTable.next_attempt_at), ne(ChannelDeliveryTable.next_attempt_at, 0)),
                  ),
                )
                .orderBy(desc(ChannelMessageTable.sequence))
                .all()
                .filter((row) => !row.delivery.next_attempt_at || row.delivery.next_attempt_at <= Date.now()),
            ),
          )
          const latest = pending[0]
          if (!latest) return
          const now = Date.now()
          yield* Effect.sync(() =>
            Database.transaction((db) => {
              pending.slice(1).forEach((row) =>
                db
                  .update(ChannelDeliveryTable)
                  .set({ status: "passed", reason: "coalesced", time_finished: now, time_updated: now })
                  .where(eq(ChannelDeliveryTable.id, row.delivery.id))
                  .run(),
              )
              db.update(ChannelDeliveryTable)
                .set({ status: "triaging", attempt: latest.delivery.attempt + 1, time_started: now, time_updated: now })
                .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                .run()
              db.insert(ChannelReadStateTable)
                .values({
                  channel_id: latest.message.channel_id,
                  principal_kind: "agent",
                  principal_id: input.agentID,
                  last_read_sequence: latest.message.sequence,
                  last_shown_sequence: latest.message.sequence,
                  last_processed_sequence: 0,
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoUpdate({
                  target: [
                    ChannelReadStateTable.channel_id,
                    ChannelReadStateTable.principal_kind,
                    ChannelReadStateTable.principal_id,
                  ],
                  set: {
                    last_read_sequence: latest.message.sequence,
                    last_shown_sequence: latest.message.sequence,
                    time_updated: now,
                  },
                })
                .run()
              db.update(ChannelDeliveryTable)
                .set({ status: "cancelled", reason: "superseded", time_finished: now, time_updated: now })
                .where(
                  and(
                    eq(ChannelDeliveryTable.agent_id, input.agentID),
                    eq(ChannelDeliveryTable.channel_id, latest.message.channel_id),
                    eq(ChannelDeliveryTable.status, "held"),
                  ),
                )
                .run()
            }),
          )
          yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: latest.message.channel_id }).pipe(Effect.ignore)
          const info = yield* companyAgents.get(input.agentID as CompanyAgentID)
          if (!info || info.lifecycle !== "employee" || recentAgentTurns(latest.message.channel_id) >= MAX_AGENT_TURNS) {
            yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .update(ChannelDeliveryTable)
                  .set({ status: "passed", reason: "turn_budget", time_finished: Date.now(), time_updated: Date.now() })
                  .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                  .run(),
              ),
            )
            yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: latest.message.channel_id }).pipe(Effect.ignore)
            return
          }
          const agentInfos = new Map<string, CompanyAgent.Info>()
          for (const agentID of activeAgentIDs(latest.message.channel_id)) {
            const agent = yield* companyAgents.get(agentID as CompanyAgentID)
            if (agent) agentInfos.set(agentID, agent)
          }
          const probeAgent = yield* agentService.get("probe").pipe(Effect.orElseSucceed(() => undefined))
          const context = transcript(latest.message.channel_id, agentInfos)
          const decision = yield* probeOne(
            { agentSvc: agentService, provider, llm, probeAgent },
            {
              persona: { name: info.name, role: info.role_key ?? info.id, description: info.description ?? "" },
              brain: { big: info.model, small: info.small_model },
              lastEvent: `${latest.message.author_kind === "user" ? "Founder" : "Agent"}: ${latest.message.body}`,
              transcript: context,
              members: [...agentInfos.values()].map((agent) => ({
                name: agent.name,
                role: agent.description ?? agent.role_key ?? agent.id,
              })),
              groupSessionID: latest.message.channel_id,
              onPublicRationale: (reason) =>
                Effect.sync(() =>
                  Database.use((db) =>
                    db
                      .update(ChannelDeliveryTable)
                      .set({ reason, time_updated: Date.now() })
                      .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                      .run(),
                  ),
                ),
            },
          )
          const fallbackHuman = latest.delivery.trigger_kind === "human" && info.role_key === "ceo"
          if (latest.delivery.trigger_kind !== "mention" && !shouldRespond(decision) && !fallbackHuman) {
            yield* Effect.sync(() =>
              Database.transaction((db) => {
                db
                  .update(ChannelDeliveryTable)
                  .set({
                    status: "passed",
                    reason: decision.reason,
                    time_finished: Date.now(),
                    time_updated: Date.now(),
                  })
                  .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                  .run()
                if (!decision.reaction) return
                const reactedAt = Date.now()
                db.insert(ChannelReactionTable)
                  .values({
                    message_id: latest.message.id,
                    principal_kind: "agent",
                    principal_id: input.agentID,
                    emoji: decision.reaction,
                    time_created: reactedAt,
                    time_updated: reactedAt,
                  })
                  .onConflictDoNothing()
                  .run()
              }),
            )
            yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: latest.message.channel_id }).pipe(Effect.ignore)
            return
          }
          const turn = yield* AgentTurn.prepare({
            agentID: input.agentID as CompanyAgentID,
            transcript: context,
            message: latest.message.body,
            companyAgents,
            config,
          })
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(ChannelDeliveryTable)
                .set({ status: "running", reason: decision.reason, time_updated: Date.now() })
                .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                .run(),
            ),
          )
          yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: latest.message.channel_id }).pipe(Effect.ignore)
          const started = yield* supervisor.start({
            agentID: input.agentID,
            runtime: turn.runtime,
            lifecycle: "on_demand",
            permissionMode: "read_only",
            model: turn.brain.big,
            cwd: Instance.worktree,
            prompt: turn.prompt,
            capabilityPacks: [],
            requiredRuntimeCapabilities: ["structuredEvents", "toolCalls", "usageAccounting", "governanceSignals"],
            allowSignalPublishing: true,
            systemPrompt: [
              turn.systemPrompt,
              "This is a board group chat. Discussion never authorizes execution. Mark decisions, DRI, dissent and evidence clearly when relevant; Founder OS gates remain authoritative.",
            ].join("\n\n"),
          })
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(ChannelDeliveryTable)
                .set({ agent_run_id: started.runID, time_updated: Date.now() })
                .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                .run(),
            ),
          )
          const result = yield* Effect.promise(() => started.completion)
          const content = result.content.trim()
          if (result.exitCode !== 0 || !content) return yield* Effect.fail(new Error("Board agent run failed"))
          const publication = yield* Effect.sync(() =>
            Database.transaction((db) => {
              const current = db
                .select()
                .from(ChannelMessageTable)
                .where(
                  and(
                    eq(ChannelMessageTable.channel_id, latest.message.channel_id),
                    or(ne(ChannelMessageTable.author_kind, "agent"), ne(ChannelMessageTable.author_id, input.agentID)),
                  ),
                )
                .orderBy(desc(ChannelMessageTable.sequence))
                .limit(1)
                .get()
              const finished = Date.now()
              if (current && current.sequence > latest.message.sequence) {
                db.update(ChannelDeliveryTable)
                  .set({ status: "held", reason: "stale", time_finished: finished, time_updated: finished })
                  .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                  .run()
                db.insert(ChannelMessageHoldTable)
                  .values({
                    channel_id: latest.message.channel_id,
                    agent_id: input.agentID,
                    delivery_id: latest.delivery.id,
                    held_to_sequence: current.sequence,
                    expires_at: finished + HOLD_MS,
                    time_created: finished,
                    time_updated: finished,
                  })
                  .onConflictDoUpdate({
                    target: [ChannelMessageHoldTable.channel_id, ChannelMessageHoldTable.agent_id],
                    set: {
                      delivery_id: latest.delivery.id,
                      held_to_sequence: current.sequence,
                      expires_at: finished + HOLD_MS,
                      consumed_at: null,
                      time_updated: finished,
                    },
                  })
                  .run()
                return { type: "held" as const, recipients: [] }
              }
              if (current?.author_kind === "agent" && normalize(current.body) === normalize(content)) {
                db.update(ChannelDeliveryTable)
                  .set({ status: "passed", reason: "duplicate", time_finished: finished, time_updated: finished })
                  .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                  .run()
                return { type: "duplicate" as const, recipients: [] }
              }
              const messageID = ChannelMessageID.parse(Identifier.ascending("channelMessage"))
              const row = db
                .insert(ChannelMessageTable)
                .values({
                  id: messageID,
                  channel_id: latest.message.channel_id,
                  sequence: claimChannelSequence(db, latest.message.channel_id, finished),
                  kind: "text",
                  root_need_id: latest.message.root_need_id,
                  source_thread_id: latest.message.source_thread_id,
                  reply_to_id: latest.message.id,
                  request_id: null,
                  author_kind: "agent",
                  author_id: input.agentID,
                  body: content,
                  signal_type: null,
                  dri_principal_kind: null,
                  dri_principal_id: null,
                  visibility: "channel",
                  mentions: [],
                  resources: [],
                  time_created: finished,
                  time_updated: finished,
                })
                .returning()
                .get()!
              db.update(ChannelDeliveryTable)
                .set({
                  status: "responded",
                  response_message_id: messageID,
                  time_finished: finished,
                  time_updated: finished,
                })
                .where(eq(ChannelDeliveryTable.id, latest.delivery.id))
                .run()
              db.insert(ChannelReadStateTable)
                .values({
                  channel_id: row.channel_id,
                  principal_kind: "agent",
                  principal_id: input.agentID,
                  last_read_sequence: row.sequence,
                  last_shown_sequence: latest.message.sequence,
                  last_processed_sequence: latest.message.sequence,
                  time_created: finished,
                  time_updated: finished,
                })
                .onConflictDoUpdate({
                  target: [
                    ChannelReadStateTable.channel_id,
                    ChannelReadStateTable.principal_kind,
                    ChannelReadStateTable.principal_id,
                  ],
                  set: { last_processed_sequence: latest.message.sequence, time_updated: finished },
                })
                .run()
              return {
                type: "published" as const,
                recipients: insertDeliveries(db, row, activeAgentIDs(row.channel_id), finished),
              }
            }),
          )
          if (publication.type !== "published") return
          yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: latest.message.channel_id }).pipe(Effect.ignore)
          yield* Effect.forEach(
            publication.recipients,
            (agentID) => schedule({ companyID: input.companyID, agentID }),
            { discard: true },
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const delivery = Database.use((db) =>
                db
                  .select()
                  .from(ChannelDeliveryTable)
                  .where(
                    and(
                      eq(ChannelDeliveryTable.agent_id, input.agentID),
                      or(eq(ChannelDeliveryTable.status, "triaging"), eq(ChannelDeliveryTable.status, "running")),
                    ),
                  )
                  .orderBy(desc(ChannelDeliveryTable.time_updated))
                  .limit(1)
                  .get(),
              )
              if (!delivery) return
              const now = Date.now()
              const retry = delivery.attempt < delivery.max_attempts
              const limited = /(?:429|rate.?limit|too many requests)/i.test(String(cause))
              Database.use((db) =>
                db
                  .update(ChannelDeliveryTable)
                  .set({
                    status: retry ? "pending" : "failed",
                    reason: limited ? "rate_limit_cooldown" : String(cause).slice(0, 1200),
                    next_attempt_at: retry ? now + (limited ? 60_000 : Math.min(30_000, 2 ** delivery.attempt * 1_000)) : null,
                    time_finished: retry ? null : now,
                    time_updated: now,
                  })
                  .where(eq(ChannelDeliveryTable.id, delivery.id))
                  .run(),
              )
            }),
          ),
        ),
      ).pipe(Effect.catchCause(() => Effect.void))
      running.delete(input.agentID)
      const remaining = Database.use((db) =>
        db
          .select({ id: ChannelDeliveryTable.id, nextAttemptAt: ChannelDeliveryTable.next_attempt_at })
          .from(ChannelDeliveryTable)
          .where(and(eq(ChannelDeliveryTable.agent_id, input.agentID), eq(ChannelDeliveryTable.status, "pending")))
          .limit(1)
          .get(),
      )
      if (remaining) {
        yield* schedule({
          ...input,
          delayMs: Math.max(DEBOUNCE_MS, (remaining.nextAttemptAt ?? Date.now()) - Date.now()),
        })
      }
    })

    schedule = Effect.fn("ConversationRoomRuntime.schedule")(function* (input: ScheduleInput) {
      if (scheduled.has(input.agentID) || running.has(input.agentID)) return
      scheduled.add(input.agentID)
      yield* Effect.gen(function* () {
        yield* Effect.sleep(`${input.delayMs ?? DEBOUNCE_MS} millis`)
        scheduled.delete(input.agentID)
        yield* drain(input)
      }).pipe(Effect.forkDetach)
    })

    const enqueueMessage = Effect.fn("ConversationRoomRuntime.enqueueMessage")(function* (input: {
      companyID: CompanyID
      messageID: ChannelMessageID
    }) {
      const recipients = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const message = db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, input.messageID)).get()
          if (!message) return []
          const channel = db.select().from(ChannelTable).where(eq(ChannelTable.id, message.channel_id)).get()
          if (!channel || channel.kind !== "board") return []
          return insertDeliveries(db, message, activeAgentIDs(channel.id), Date.now())
        }),
      )
      yield* Effect.forEach(
        recipients,
        (agentID) =>
          Effect.gen(function* () {
            const active = yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({ runID: ChannelDeliveryTable.agent_run_id })
                  .from(ChannelDeliveryTable)
                  .where(
                    and(
                      eq(ChannelDeliveryTable.agent_id, agentID),
                      eq(ChannelDeliveryTable.status, "running"),
                    ),
                  )
                  .orderBy(desc(ChannelDeliveryTable.time_updated))
                  .limit(1)
                  .get(),
              ),
            )
            const message = yield* Effect.sync(() =>
              Database.use((db) => db.select().from(ChannelMessageTable).where(eq(ChannelMessageTable.id, input.messageID)).get()),
            )
            if (active?.runID && message) {
              yield* supervisor.deliver({
                runID: active.runID,
                content: `New board message [${message.sequence}] from ${message.author_kind}: ${message.body}`,
                priority: "steer",
              }).pipe(Effect.catch(() => Effect.void))
              return
            }
            yield* schedule({ companyID: input.companyID, agentID })
          }),
        { discard: true },
      )
    })

    const recover = Effect.fn("ConversationRoomRuntime.recover")(function* () {
      const pending = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const now = Date.now()
          db.update(ChannelDeliveryTable)
            .set({ status: "pending", next_attempt_at: null, time_updated: now })
            .where(or(eq(ChannelDeliveryTable.status, "triaging"), eq(ChannelDeliveryTable.status, "running")))
            .run()
          db.update(ChannelDeliveryTable)
            .set({ status: "cancelled", reason: "held_expired", time_finished: now, time_updated: now })
            .where(eq(ChannelDeliveryTable.status, "held"))
            .run()
          return db
            .select({ agentID: ChannelDeliveryTable.agent_id, companyID: ChannelTable.company_id })
            .from(ChannelDeliveryTable)
            .innerJoin(ChannelTable, eq(ChannelTable.id, ChannelDeliveryTable.channel_id))
            .where(eq(ChannelDeliveryTable.status, "pending"))
            .all()
        }),
      )
      const unique = [...new Map(pending.map((row) => [row.agentID, row])).values()]
      yield* Effect.forEach(
        unique,
        (row) => schedule({ companyID: row.companyID, agentID: row.agentID }),
        { discard: true },
      )
      return pending.length
    })

    const interruptThread = Effect.fn("ConversationRoomRuntime.interruptThread")(function* (input: {
      companyID: CompanyID
      threadID: ConversationThreadID
    }) {
      const interrupted = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const thread = db
            .select({ channelID: ConversationThreadTable.channel_id })
            .from(ConversationThreadTable)
            .innerJoin(ChannelTable, eq(ChannelTable.id, ConversationThreadTable.channel_id))
            .where(
              and(
                eq(ConversationThreadTable.id, input.threadID),
                eq(ConversationThreadTable.company_id, input.companyID),
                eq(ChannelTable.kind, "board"),
              ),
            )
            .get()
          if (!thread) return { channelID: undefined, runIDs: [] }
          const now = Date.now()
          const deliveries = db
            .select({ id: ChannelDeliveryTable.id, runID: ChannelDeliveryTable.agent_run_id })
            .from(ChannelDeliveryTable)
            .innerJoin(ChannelMessageTable, eq(ChannelMessageTable.id, ChannelDeliveryTable.message_id))
            .where(
              and(
                eq(ChannelMessageTable.source_thread_id, input.threadID),
                or(
                  eq(ChannelDeliveryTable.status, "pending"),
                  eq(ChannelDeliveryTable.status, "triaging"),
                  eq(ChannelDeliveryTable.status, "running"),
                  eq(ChannelDeliveryTable.status, "held"),
                ),
              ),
            )
            .all()
          deliveries.forEach((delivery) =>
            db.update(ChannelDeliveryTable)
              .set({ status: "cancelled", reason: "human_interrupt", time_finished: now, time_updated: now })
              .where(eq(ChannelDeliveryTable.id, delivery.id))
              .run(),
          )
          db.update(ConversationThreadTable)
            .set({ status: "interrupted", time_updated: now })
            .where(eq(ConversationThreadTable.id, input.threadID))
            .run()
          return {
            channelID: thread.channelID,
            runIDs: deliveries.flatMap((delivery) => delivery.runID ? [delivery.runID] : []),
          }
        }),
      )
      yield* Effect.forEach(interrupted.runIDs, (runID) => supervisor.stop(runID).pipe(Effect.ignore), { discard: true })
      if (interrupted.channelID) {
        yield* bus.publish(ServerEvent.ChannelInvalidated, { channel_id: interrupted.channelID }).pipe(Effect.ignore)
        yield* bus.publish(ServerEvent.ThreadInvalidated, { thread_id: input.threadID }).pipe(Effect.ignore)
      }
    })

    return Service.of({ enqueueMessage, interruptThread, recover })
  }),
)

export * as ConversationRoomRuntime from "./room-runtime"
