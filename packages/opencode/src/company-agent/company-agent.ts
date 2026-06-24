import z from "zod"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Database } from "../storage"
import { CompanyAgentTable } from "./company-agent.sql"
import { CompanyAgentID } from "./schema"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

// ---------------------------------------------------------------------------
// Info schema
// ---------------------------------------------------------------------------

export const Info = Schema.Struct({
  id: CompanyAgentID,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})
  .annotate({ identifier: "CompanyAgent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateInput = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with dashes"),
  name: z.string().min(1),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
})
export type CreateInput = z.infer<typeof CreateInput>

export const UpdateInput = z.object({
  id: CompanyAgentID.zod,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
})
export type UpdateInput = z.infer<typeof UpdateInput>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const Event = {
  Created: BusEvent.define("company_agent.created", Info.zod),
  Updated: BusEvent.define("company_agent.updated", Info.zod),
  Deleted: BusEvent.define("company_agent.deleted", z.object({ id: CompanyAgentID.zod })),
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = typeof CompanyAgentTable.$inferSelect

function fromRow(row: Row): Info {
  return {
    id: row.id as CompanyAgentID,
    name: row.name,
    description: row.description ?? undefined,
    system_prompt: row.system_prompt ?? undefined,
    model: row.model ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly get: (id: CompanyAgentID) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly update: (input: UpdateInput) => Effect.Effect<Info>
  readonly remove: (id: CompanyAgentID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CompanyAgent") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const create = Effect.fn("CompanyAgent.create")(function* (input: CreateInput) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(CompanyAgentTable)
            .values({
              id: input.id,
              name: input.name,
              description: input.description ?? null,
              system_prompt: input.system_prompt ?? null,
              model: input.model ?? null,
              color: input.color ?? null,
              icon: input.icon ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, input.id)).get()),
      )
      if (!row) yield* Effect.die(new Error(`CompanyAgent.create: insert failed for id="${input.id}"`))
      const info = fromRow(row!)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Created.type, properties: info },
        }),
      )
      return info
    })

    const get = Effect.fn("CompanyAgent.get")(function* (id: CompanyAgentID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, id)).get()),
      )
      return row ? fromRow(row) : undefined
    })

    const list = Effect.fn("CompanyAgent.list")(function* () {
      const rows = yield* Effect.sync(() => Database.use((db) => db.select().from(CompanyAgentTable).all()))
      return rows.map(fromRow)
    })

    const update = Effect.fn("CompanyAgent.update")(function* (input: UpdateInput) {
      const now = Date.now()
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyAgentTable)
            .set({
              ...(input.name !== undefined && { name: input.name }),
              ...(input.description !== undefined && { description: input.description }),
              ...(input.system_prompt !== undefined && { system_prompt: input.system_prompt }),
              ...(input.model !== undefined && { model: input.model }),
              ...(input.color !== undefined && { color: input.color }),
              ...(input.icon !== undefined && { icon: input.icon }),
              time_updated: now,
            })
            .where(eq(CompanyAgentTable.id, input.id))
            .returning()
            .get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`CompanyAgent.update: not found id="${input.id}"`))
      const info = fromRow(row!)
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Updated.type, properties: info },
        }),
      )
      return info
    })

    const remove = Effect.fn("CompanyAgent.remove")(function* (id: CompanyAgentID) {
      if (id === ("assistant" as CompanyAgentID))
        yield* Effect.die(new Error("CompanyAgent.remove: cannot delete the default assistant agent"))
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(CompanyAgentTable).where(eq(CompanyAgentTable.id, id)).run()),
      )
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Deleted.type, properties: { id } },
        }),
      )
    })

    return { create, get, list, update, remove }
  }),
)

export const defaultLayer = layer

export * as CompanyAgent from "./company-agent"
