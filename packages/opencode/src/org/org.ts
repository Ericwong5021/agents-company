import path from "path"
import fs from "fs/promises"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database, eq, or, isNull } from "../storage"
import { Global } from "../global"
import { Config } from "@/config"
import { resetWorkspace } from "../workspace/workspace"
import { GlobalBus } from "@/bus/global"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util"
import { InstanceState } from "@/effect"
import type { ProjectID } from "../project/schema"
import z from "zod"

import { CompanyAgentTable } from "../company-agent/company-agent.sql"
import { AgentMessageTable } from "../agent-message/agent-message.sql"
import { AuditEventTable } from "../audit-event/audit-event.sql"
import { ThreadTable } from "../thread/thread.sql"
import { SessionTable, MessageTable, PartTable, TodoTable, PermissionTable } from "../session/session.sql"
import { ExternalImportTable } from "../session/external-import.sql"
import {
  GroupSessionTable,
  GroupSessionMemberTable,
  GroupMessageTable,
} from "../group-session/group-session.sql"
import { TaskTable, TaskEventTable } from "../task/task.sql"
import { InboxTable } from "../inbox/inbox.sql"
import { WorkflowRunTable } from "../workflow/workflow.sql"
import { SessionShareTable } from "../share/share.sql"
import { ActorRegistryTable } from "../actor/actor.sql"

const log = Log.create({ service: "org" })

export const Event = {
  Disbanded: BusEvent.define("org.disbanded", z.object({})),
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const Counts = z.object({
  agents: z.number(),
  threads: z.number(),
  sessions: z.number(),
  groupSessions: z.number(),
  tasks: z.number(),
})

export type Counts = z.infer<typeof Counts>

export const Department = z.object({
  name: z.string(),
  clearance: z.string().optional(),
  roles: z.array(z.string()),
})

export const Info = z
  .object({
    name: z.string().optional(),
    departments: z.array(Department),
    counts: Counts,
  })
  .meta({ ref: "Org" })

export type Info = z.infer<typeof Info>

export const UpdateInput = z.object({
  org: z.any(),
})

export type UpdateInput = z.infer<typeof UpdateInput>

// ---------------------------------------------------------------------------
// Company-domain tables wiped on disband.
// NOTE: account*, project, workspace(control-plane), and sync event tables are
// intentionally preserved so login state and instance identity survive.
// ---------------------------------------------------------------------------

const COMPANY_TABLES = [
  AgentMessageTable,
  AuditEventTable,
  GroupMessageTable,
  GroupSessionMemberTable,
  GroupSessionTable,
  TaskEventTable,
  TaskTable,
  InboxTable,
  WorkflowRunTable,
  SessionShareTable,
  ExternalImportTable,
  PermissionTable,
  TodoTable,
  PartTable,
  MessageTable,
  ThreadTable,
  SessionTable,
  ActorRegistryTable,
  CompanyAgentTable,
] as const

// Tables to wipe without company_id filtering (everything except SessionTable).
const OTHER_TABLES = [
  AgentMessageTable,
  AuditEventTable,
  GroupMessageTable,
  GroupSessionMemberTable,
  GroupSessionTable,
  TaskEventTable,
  TaskTable,
  InboxTable,
  WorkflowRunTable,
  SessionShareTable,
  ExternalImportTable,
  PermissionTable,
  TodoTable,
  PartTable,
  MessageTable,
  ThreadTable,
  ActorRegistryTable,
  CompanyAgentTable,
] as const

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly update: (input: UpdateInput) => Effect.Effect<Info>
  readonly disband: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Org") {}

function countRows(table: (typeof COMPANY_TABLES)[number]): number {
  return Database.use((db) => {
    const row = db.select({ value: sql<number>`count(*)` }).from(table).get()
    return row?.value ?? 0
  })
}

function readOrgStructure(config: Config.Info): { name?: string; departments: Info["departments"] } {
  const org = (config as { org?: { departments?: Record<string, { clearance?: string; roles?: Record<string, unknown> }> } }).org
  const departments = Object.entries(org?.departments ?? {}).map(([name, dept]) => ({
    name,
    clearance: dept.clearance,
    roles: Object.keys(dept.roles ?? {}),
  }))
  return { departments }
}

async function clearConfigOrg(): Promise<void> {
  for (const file of ["agent-company.json", "agent-company.jsonc"]) {
    const full = path.join(Global.Path.config, file)
    const text = await Bun.file(full)
      .text()
      .catch(() => null)
    if (text === null) continue
    const parsed = JSON.parse(text)
    if (!("org" in parsed)) continue
    delete parsed.org
    await Bun.write(full, JSON.stringify(parsed, null, 2))
  }
}

export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const get = Effect.fn("Org.get")(function* () {
      const cfg = yield* config.get()
      const structure = readOrgStructure(cfg)
      const counts: Counts = yield* Effect.sync(() => ({
        agents: countRows(CompanyAgentTable),
        threads: countRows(ThreadTable),
        sessions: countRows(SessionTable),
        groupSessions: countRows(GroupSessionTable),
        tasks: countRows(TaskTable),
      }))
      return { name: structure.name, departments: structure.departments, counts } satisfies Info
    })

    const update = Effect.fn("Org.update")(function* (input: UpdateInput) {
      const cfg = yield* config.get()
      yield* config.update({ ...cfg, org: input.org })
      return yield* get()
    })

    const disband = Effect.fn("Org.disband")(function* () {
      log.warn("disbanding company — wiping all org/company data")
      // Delete each table independently so a virtual/FTS quirk on one table
      // does not abort the whole sweep.
      // SessionTable: delete by company_id so sessions in other projects survive.
      const project = yield* InstanceState.context.pipe(Effect.catch(() => Effect.succeed(undefined)))
      const projectId: ProjectID | undefined = project?.project?.id
      if (projectId) {
        yield* Effect.try({
          try: () =>
            Database.use((db) =>
              db
                .delete(SessionTable)
                .where(
                  or(
                    eq(SessionTable.company_id, projectId),
                    isNull(SessionTable.company_id),
                  ),
                )
                .run(),
            ),
          catch: (err) => log.error("failed to clear session table", { error: err }),
        }).pipe(Effect.catch(() => Effect.void))
      } else {
        // No instance context — fall back to full delete
        yield* Effect.try({
          try: () => Database.use((db) => db.delete(SessionTable).run()),
          catch: (err) => log.error("failed to clear session table", { error: err }),
        }).pipe(Effect.catch(() => Effect.void))
      }
      for (const table of OTHER_TABLES) {
        yield* Effect.try({
          try: () => Database.use((db) => db.delete(table).run()),
          catch: (err) => log.error("failed to clear table", { error: err }),
        }).pipe(Effect.catch(() => Effect.void))
      }
      yield* Effect.promise(() => resetWorkspace())
      yield* Effect.promise(() => clearConfigOrg().catch((err) => log.error("failed to clear config.org", { error: err })))
      // Clear storage directory (session diffs, etc.)
      yield* Effect.promise(() =>
        fs.rm(path.join(Global.Path.data, "storage"), { recursive: true, force: true }).catch((err) =>
          log.error("failed to clear storage directory", { error: err }),
        ),
      )
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Disbanded.type, properties: {} },
        }),
      )
      log.warn("company disbanded")
    })

    return { get, update, disband }
  }),
)

// Self-contained: Layer.mergeAll does not cross-wire siblings, so provide
// Config here. The shared memoMap dedupes the Config.defaultLayer reference
// with the one merged into AppLayer.
export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Org from "./org"
