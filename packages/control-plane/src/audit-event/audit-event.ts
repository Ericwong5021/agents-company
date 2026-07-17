import z from "zod"
import { Context, Effect, Layer } from "effect"
import { eq, desc } from "drizzle-orm"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { AuditEventTable } from "./audit-event.sql"

export const Kind = z.enum(["access", "message", "admission", "escalation"])
export type Kind = z.infer<typeof Kind>

export const Info = z.object({
  id: z.string(),
  rootNeedID: z.string().optional(),
  kind: Kind,
  action: z.string(),
  actorAgentID: z.string().optional(),
  targetAgentID: z.string().optional(),
  subjectID: z.string().optional(),
  subjectType: z.string().optional(),
  granted: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
})
export type Info = z.infer<typeof Info>

export const RecordInput = z.object({
  rootNeedID: z.string().optional(),
  kind: Kind,
  action: z.string().min(1),
  actorAgentID: z.string().optional(),
  targetAgentID: z.string().optional(),
  subjectID: z.string().optional(),
  subjectType: z.string().optional(),
  granted: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type RecordInput = z.infer<typeof RecordInput>

export const ListByRootNeedOpts = z.object({
  limit: z.number().int().positive().optional(),
})
export type ListByRootNeedOpts = z.infer<typeof ListByRootNeedOpts>

export const Event = {
  Recorded: BusEvent.define("audit_event.recorded", Info),
}

function fromRow(row: typeof AuditEventTable.$inferSelect): Info {
  return {
    id: row.id,
    rootNeedID: row.root_need_id ?? undefined,
    kind: row.kind as Kind,
    action: row.action,
    actorAgentID: row.actor_agent_id ?? undefined,
    targetAgentID: row.target_agent_id ?? undefined,
    subjectID: row.subject_id ?? undefined,
    subjectType: row.subject_type ?? undefined,
    granted: row.granted ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

export function record(input: RecordInput): Effect.Effect<Info> {
  return Effect.gen(function* () {
    const now = Date.now()
    const id = Identifier.ascending("event")

    yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .insert(AuditEventTable)
          .values({
            id,
            root_need_id: input.rootNeedID ?? null,
            kind: input.kind,
            action: input.action,
            actor_agent_id: input.actorAgentID ?? null,
            target_agent_id: input.targetAgentID ?? null,
            subject_id: input.subjectID ?? null,
            subject_type: input.subjectType ?? null,
            granted: input.granted ?? null,
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      ),
    )

    const row = yield* Effect.sync(() =>
      Database.use((db) => db.select().from(AuditEventTable).where(eq(AuditEventTable.id, id)).get()),
    )
    if (!row) yield* Effect.die(new Error(`AuditEvent.record: insert failed for id="${id}"`))
    const info = fromRow(row!)
    yield* Effect.sync(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: Event.Recorded.type, properties: info },
      }),
    )
    return info
  })
}

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<Info>
  readonly listByRootNeed: (rootNeedID: string, opts?: ListByRootNeedOpts) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/AuditEvent") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const listByRootNeed = Effect.fn("AuditEvent.listByRootNeed")(function* (
      rootNeedID: string,
      opts?: ListByRootNeedOpts,
    ) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(AuditEventTable)
            .where(eq(AuditEventTable.root_need_id, rootNeedID))
            .orderBy(desc(AuditEventTable.time_created))
            .limit(opts?.limit ?? 1000)
            .all(),
        ),
      )
      return rows.map(fromRow)
    })

    return { record, listByRootNeed }
  }),
)

export const defaultLayer = layer

export * as AuditEvent from "./audit-event"
