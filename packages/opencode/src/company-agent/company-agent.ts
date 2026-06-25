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
  agentInstructPath,
  agentRelationshipsPath,
  agentKanbanPath,
  agentSkillsDir,
  agentMemoryDir,
} from "@/session/checkpoint-paths"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"
import { generateAgentProfile } from "@/workspace/workspace"

// ---------------------------------------------------------------------------
// Info schema
// ---------------------------------------------------------------------------

export const Info = Schema.Struct({
  id: CompanyAgentID,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
  instruct: Schema.optional(Schema.String),
  relationships: Schema.optional(Schema.String),
  kanban: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(Schema.String)),
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
  instruct: z.string().optional(),
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
  instruct: z.string().optional(),
  relationships: z.string().optional(),
  kanban: z.string().optional(),
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
  const file = Bun.file(agentSoulPath(id))
  if (!(await file.exists())) return undefined
  const content = await file.text()
  return content.trim() || undefined
}

async function readSettings(id: CompanyAgentID): Promise<AgentSettings> {
  const file = Bun.file(agentSettingsPath(id))
  if (!(await file.exists())) return {}
  const content = await file.text()
  return AgentSettings.parse(JSON.parse(content))
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const content = await file.text()
  return content.trim() || undefined
}

async function readSkillNames(id: CompanyAgentID): Promise<string[]> {
  const dir = agentSkillsDir(id)
  const exists = await Bun.file(dir).exists()
  if (!exists) return []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isFile()).map((e) => e.name)
}

async function fromRowWithFiles(row: Row): Promise<Info> {
  const id = row.id as CompanyAgentID
  // Validate file bundle on every read — recreates any missing files
  await validateFileBundle(id, row.name)
  const [soul, settings, instruct, relationships, kanban, skills] = await Promise.all([
    readSoul(id),
    readSettings(id),
    readFileIfExists(agentInstructPath(id)),
    readFileIfExists(agentRelationshipsPath(id)),
    readFileIfExists(agentKanbanPath(id)),
    readSkillNames(id),
  ])
  return {
    ...fromRow(row),
    system_prompt: soul,
    instruct,
    relationships,
    kanban,
    skills: skills.length > 0 ? skills : undefined,
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
  const memExists = await Bun.file(memPath).exists()
  if (!memExists) {
    await fs.writeFile(
      memPath,
      `# ${name}\n\n_Long-term memory for this agent. Add cross-project facts, preferences, and learned patterns here._\n`,
      "utf-8",
    )
  }

  // settings.json — create empty config if absent
  const settingsPath = agentSettingsPath(id)
  const settingsExists = await Bun.file(settingsPath).exists()
  if (!settingsExists) {
    await fs.writeFile(settingsPath, "{}\n", "utf-8")
  }

  // INSTRUCT.md — evolvable instructions if absent
  const instructPath = agentInstructPath(id)
  const instructExists = await Bun.file(instructPath).exists()
  if (!instructExists) {
    await fs.writeFile(
      instructPath,
      [
        `---`,
        `agent: ${id}`,
        `type: instruct`,
        `version: 1`,
        `---`,
        ``,
        `# ${name} — Instructions`,
        ``,
        `_How to judge, communicate, and when to escalate. Edit this file to evolve agent behavior._`,
        ``,
        `## Communication Style`,
        ``,
        `- Be concise and direct`,
        `- Explain reasoning briefly before actions`,
        `- Ask clarifying questions when requirements are ambiguous`,
        ``,
        `## Decision Framework`,
        ``,
        `- Prioritize correctness over speed`,
        `- Prefer existing patterns in the codebase`,
        `- Escalate to the user when assumptions would be risky`,
        ``,
        `## Escalation Rules`,
        ``,
        `- When in doubt, ask the user`,
        `- If a task requires permissions you don't have, request them`,
        `- If blocked by missing information, state what's needed`,
        ``,
      ].join("\n"),
      "utf-8",
    )
  }

  // relationships.md — colleague relationships if absent
  const relPath = agentRelationshipsPath(id)
  const relExists = await Bun.file(relPath).exists()
  if (!relExists) {
    await fs.writeFile(
      relPath,
      [
        `---`,
        `agent: ${id}`,
        `type: relationships`,
        `version: 1`,
        `---`,
        ``,
        `# ${name} — Relationships`,
        ``,
        `_Colleague relationships: collaboration preferences, communication style, trust level._`,
        ``,
        `## Format`,
        ``,
        `<!-- Add entries like:`,
        ``,
        `### Agent Name`,
        `- **Collaboration style**: ...`,
        `- **Communication preference**: ...`,
        `- **Trust level**: ...`,
        `-->`,
        ``,
      ].join("\n"),
      "utf-8",
    )
  }

  // kanban.md — personal task view if absent
  const kanbanPath = agentKanbanPath(id)
  const kanbanExists = await Bun.file(kanbanPath).exists()
  if (!kanbanExists) {
    await fs.writeFile(
      kanbanPath,
      [
        `---`,
        `agent: ${id}`,
        `type: kanban`,
        `version: 1`,
        `---`,
        ``,
        `# ${name} — Kanban`,
        ``,
        `_Personal task view: current projects, todos, progress._`,
        ``,
        `## In Progress`,
        ``,
        `## Todo`,
        ``,
        `## Done`,
        ``,
      ].join("\n"),
      "utf-8",
    )
  }

  // skills/ — private skills directory
  await fs.mkdir(agentSkillsDir(id), { recursive: true })

  // memory/ — per-agent memory directory for FTS5 indexed memories
  await fs.mkdir(agentMemoryDir(id), { recursive: true })
}

/**
 * Validate and repair an agent's file bundle.
 * Ensures all required files exist with valid content. Recovers from
 * partial corruption or manual deletion.
 */
async function validateFileBundle(id: CompanyAgentID, name: string): Promise<void> {
  const dir = agentDir(id)
  const dirExists = await Bun.file(dir).exists()
  if (!dirExists) {
    await initAgentDir(id, name)
    return
  }

  // Check each required file; re-init missing ones
  const requiredPaths = [
    companyAgentMemoryPath(id),
    agentSettingsPath(id),
    agentInstructPath(id),
    agentRelationshipsPath(id),
    agentKanbanPath(id),
  ]
  const missing = (await Promise.all(requiredPaths.map(async (p) => (!(await Bun.file(p).exists()) ? p : null)))).filter(
    (p): p is string => p !== null,
  )

  if (missing.length > 0) {
    // Re-run init to recreate missing files (idempotent — won't overwrite existing)
    await initAgentDir(id, name)
  }

  // Ensure subdirectories exist
  await Promise.all([fs.mkdir(agentSkillsDir(id), { recursive: true }), fs.mkdir(agentMemoryDir(id), { recursive: true })])
}

async function writeAgentFiles(
  id: CompanyAgentID,
  patch: { system_prompt?: string; instruct?: string; relationships?: string; kanban?: string; model?: string },
): Promise<void> {
  await fs.mkdir(agentDir(id), { recursive: true })

  if (patch.system_prompt !== undefined) {
    await Bun.write(agentSoulPath(id), patch.system_prompt)
  }

  if (patch.instruct !== undefined) {
    await Bun.write(agentInstructPath(id), patch.instruct)
  }

  if (patch.relationships !== undefined) {
    await Bun.write(agentRelationshipsPath(id), patch.relationships)
  }

  if (patch.kanban !== undefined) {
    await Bun.write(agentKanbanPath(id), patch.kanban)
  }

  if (patch.model !== undefined) {
    const current = await readSettings(id)
    const updated: AgentSettings = { ...current, model: patch.model || undefined }
    if (!updated.model) delete updated.model
    await Bun.write(agentSettingsPath(id), JSON.stringify(updated, null, 2) + "\n")
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
            instruct: input.instruct,
            model: input.model,
          }),
          generateAgentProfile(input.id, input.name, "agent", "general", [
            input.description ?? "General-purpose agent",
          ]),
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

      const hasFileUpdates =
        input.system_prompt !== undefined ||
        input.instruct !== undefined ||
        input.relationships !== undefined ||
        input.kanban !== undefined ||
        input.model !== undefined
      if (hasFileUpdates) {
        yield* Effect.promise(() =>
          writeAgentFiles(input.id, {
            ...(input.system_prompt !== undefined && { system_prompt: input.system_prompt }),
            ...(input.instruct !== undefined && { instruct: input.instruct }),
            ...(input.relationships !== undefined && { relationships: input.relationships }),
            ...(input.kanban !== undefined && { kanban: input.kanban }),
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
