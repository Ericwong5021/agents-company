import z from "zod"
import fs from "fs/promises"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Database } from "../storage"
import { CompanyAgentTable } from "./company-agent.sql"
import { CompanyAgentID } from "./schema"
import {
  agentDir,
  agentSoulPath,
  agentSettingsPath,
  companyAgentMemoryPath,
} from "@/session/checkpoint-paths"
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
// Agent settings schema (settings.json)
// ---------------------------------------------------------------------------

const AgentSettings = z.object({
  model: z.string().optional(),
})
type AgentSettings = z.infer<typeof AgentSettings>

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = typeof CompanyAgentTable.$inferSelect

function fromRow(row: Row): Omit<Info, "system_prompt" | "model"> {
  return {
    id: row.id as CompanyAgentID,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function readSoul(id: CompanyAgentID): Promise<string | undefined> {
  try {
    const content = await fs.readFile(agentSoulPath(id), "utf-8")
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

async function readSettings(id: CompanyAgentID): Promise<AgentSettings> {
  try {
    const content = await fs.readFile(agentSettingsPath(id), "utf-8")
    return AgentSettings.parse(JSON.parse(content))
  } catch {
    return {}
  }
}

async function fromRowWithFiles(row: Row): Promise<Info> {
  const id = row.id as CompanyAgentID
  const [soul, settings] = await Promise.all([readSoul(id), readSettings(id)])
  return {
    ...fromRow(row),
    system_prompt: soul,
    model: settings.model,
  }
}

/**
 * Initialize the agent directory and create any missing files.
 * Safe to call on every list/get — all writes are idempotent (no-overwrite).
 */
async function initAgentDir(id: CompanyAgentID, name: string): Promise<void> {
  await fs.mkdir(agentDir(id), { recursive: true })

  // MEMORY.md — create placeholder if absent
  const memPath = companyAgentMemoryPath(id)
  const memExists = await fs.access(memPath).then(() => true).catch(() => false)
  if (!memExists) {
    await fs.writeFile(
      memPath,
      `# ${name}\n\n_Long-term memory for this agent. Add cross-project facts, preferences, and learned patterns here._\n`,
      "utf-8",
    )
  }

  // settings.json — create empty config if absent
  const settingsPath = agentSettingsPath(id)
  const settingsExists = await fs.access(settingsPath).then(() => true).catch(() => false)
  if (!settingsExists) {
    await fs.writeFile(settingsPath, "{}\n", "utf-8")
  }
}

async function writeAgentFiles(
  id: CompanyAgentID,
  patch: { system_prompt?: string; model?: string },
): Promise<void> {
  await fs.mkdir(agentDir(id), { recursive: true })

  if (patch.system_prompt !== undefined) {
    await fs.writeFile(agentSoulPath(id), patch.system_prompt, "utf-8")
  }

  if (patch.model !== undefined) {
    const current = await readSettings(id)
    const updated: AgentSettings = { ...current, model: patch.model || undefined }
    if (!updated.model) delete updated.model
    await fs.writeFile(agentSettingsPath(id), JSON.stringify(updated, null, 2) + "\n", "utf-8")
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
              color: input.color ?? null,
              icon: input.icon ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )
      yield* Effect.promise(() =>
        Promise.all([
          initAgentDir(input.id as CompanyAgentID, input.name),
          writeAgentFiles(input.id as CompanyAgentID, {
            system_prompt: input.system_prompt,
            model: input.model,
          }),
        ]),
      )
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, input.id)).get()),
      )
      if (!row) yield* Effect.die(new Error(`CompanyAgent.create: insert failed for id="${input.id}"`))
      const info = yield* Effect.promise(() => fromRowWithFiles(row!))
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
      if (!row) return undefined
      return yield* Effect.promise(() => fromRowWithFiles(row))
    })

    const list = Effect.fn("CompanyAgent.list")(function* () {
      const rows = yield* Effect.sync(() => Database.use((db) => db.select().from(CompanyAgentTable).all()))
      const infos = yield* Effect.promise(() => Promise.all(rows.map((row) => fromRowWithFiles(row))))
      return infos
    })

    const update = Effect.fn("CompanyAgent.update")(function* (input: UpdateInput) {
      const now = Date.now()
      const dbPatch: Record<string, unknown> = { time_updated: now }
      if (input.name !== undefined) dbPatch.name = input.name
      if (input.description !== undefined) dbPatch.description = input.description
      if (input.color !== undefined) dbPatch.color = input.color
      if (input.icon !== undefined) dbPatch.icon = input.icon

      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(CompanyAgentTable).set(dbPatch).where(eq(CompanyAgentTable.id, input.id)).returning().get(),
        ),
      )
      if (!row) yield* Effect.die(new Error(`CompanyAgent.update: not found id="${input.id}"`))

      if (input.system_prompt !== undefined || input.model !== undefined) {
        yield* Effect.promise(() =>
          writeAgentFiles(input.id, {
            ...(input.system_prompt !== undefined && { system_prompt: input.system_prompt }),
            ...(input.model !== undefined && { model: input.model }),
          }),
        )
      }

      const info = yield* Effect.promise(() => fromRowWithFiles(row!))
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
