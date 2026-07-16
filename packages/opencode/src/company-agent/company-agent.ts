import z from "zod"
import fs from "fs/promises"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Database } from "../storage"
import { CompanyAgentTable } from "./company-agent.sql"
import { CompanyAgentID } from "./schema"
import {
  agentDir,
  agentPrivateDir,
  agentProfessionalDir,
  agentPublicDir,
  agentPublicProfilePath,
  agentSoulPath,
  agentSettingsPath,
  companyAgentMemoryPath,
  agentInstructPath,
  agentRelationshipsPath,
  agentKanbanPath,
  agentSkillsDir,
  agentMemoryDir,
  migrateAgentHome,
} from "@/session/checkpoint-paths"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"
import { generateAgentProfile } from "@/workspace/workspace"
import { parseFrontMatter, stringifyFrontMatter, type FrontMatter } from "@/workspace/front-matter"

// ---------------------------------------------------------------------------
// Info schema
// ---------------------------------------------------------------------------

export const Info = Schema.Struct({
  id: CompanyAgentID,
  lifecycle: Schema.Literals(["candidate", "employee"]),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  public_profile: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
  instruct: Schema.optional(Schema.String),
  relationships: Schema.optional(Schema.String),
  kanban: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  preferred_runtime: Schema.String,
  color: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  org_layer: Schema.optional(Schema.String),
  department: Schema.optional(Schema.String),
  reports_to: Schema.optional(Schema.String),
  responsibilities: Schema.optional(Schema.Array(Schema.String)),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})
  .annotate({ identifier: "CompanyAgent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const PublicInfo = z.object({
  id: CompanyAgentID.zod,
  lifecycle: z.enum(["candidate", "employee"]),
  name: z.string(),
  description: z.string().optional(),
  public_profile: z.string().optional(),
  skills: z.array(z.string()).optional(),
  model: z.string().optional(),
  preferred_runtime: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
  org_layer: z.string().optional(),
  department: z.string().optional(),
  reports_to: z.string().optional(),
  responsibilities: z.array(z.string()).optional(),
  time: z.object({ created: z.number(), updated: z.number() }),
})
export type PublicInfo = z.infer<typeof PublicInfo>

export function toPublicInfo(info: Info): PublicInfo {
  return PublicInfo.parse({
    id: info.id,
    lifecycle: info.lifecycle,
    name: info.name,
    description: info.description,
    public_profile: info.public_profile,
    skills: info.skills,
    model: info.model,
    preferred_runtime: info.preferred_runtime,
    color: info.color,
    icon: info.icon,
    org_layer: info.org_layer,
    department: info.department,
    reports_to: info.reports_to,
    responsibilities: info.responsibilities,
    time: info.time,
  })
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateInput = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with dashes"),
  name: z.string().min(1),
  lifecycle: z.enum(["candidate", "employee"]).optional(),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  instruct: z.string().optional(),
  model: z.string().optional(),
  preferred_runtime: z.enum(["pi", "claude-code", "codex"]).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  org_layer: z.enum(["board", "department", "project", "execution", "tool"]).optional(),
  department: z.string().optional(),
  reports_to: z.string().optional(),
  responsibilities: z.array(z.string()).optional(),
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
  preferred_runtime: z.enum(["pi", "claude-code", "codex"]).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  org_layer: z.enum(["board", "department", "project", "execution", "tool"]).optional(),
  department: z.string().optional(),
  reports_to: z.string().optional(),
  responsibilities: z.array(z.string()).optional(),
})
export type UpdateInput = z.infer<typeof UpdateInput>

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const Event = {
  Created: BusEvent.define("company_agent.created", PublicInfo),
  Updated: BusEvent.define("company_agent.updated", PublicInfo),
  Deleted: BusEvent.define("company_agent.deleted", z.object({ id: CompanyAgentID.zod })),
}

// ---------------------------------------------------------------------------
// Agent settings schema (settings.json)
// ---------------------------------------------------------------------------

const AgentSettings = z.object({
  model: z.string().optional(),
})
type AgentSettings = z.infer<typeof AgentSettings>

type AgentDocumentType = "soul" | "memory" | "instruct" | "relationships" | "kanban"

interface OrgContext {
  org_layer?: string
  department?: string
  reports_to?: string
  responsibilities?: string[]
}

function orgFrontMatter(org?: OrgContext): FrontMatter {
  if (!org?.org_layer) return {}
  return {
    org_layer: org.org_layer,
    department: org.department,
    reports_to: org.reports_to,
    responsibilities: org.responsibilities?.length ? org.responsibilities.join("; ") : undefined,
  }
}

function agentDocumentFrontMatter(
  id: CompanyAgentID,
  type: AgentDocumentType,
  existing?: FrontMatter,
  org?: OrgContext,
): FrontMatter {
  const base = { ...existing }
  if (type === "soul" && org?.org_layer) {
    delete base.org_layer
    delete base.department
    delete base.reports_to
    delete base.responsibilities
  }

  return {
    ...base,
    scope: existing?.scope ?? `agent:${id}`,
    classification: existing?.classification ?? "internal",
    owner: existing?.owner ?? id,
    updatedBy: existing?.updatedBy ?? "system",
    type: existing?.type ?? type,
    version: existing?.version ?? "1",
    ...(type === "soul" ? orgFrontMatter(org) : {}),
  }
}

function agentDocument(id: CompanyAgentID, type: AgentDocumentType, body: string, org?: OrgContext): string {
  return stringifyFrontMatter(agentDocumentFrontMatter(id, type, undefined, org), body)
}

async function readMarkdownBody(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const content = await file.text()
  const parsed = parseFrontMatter(content)
  return parsed.body.trim() || undefined
}

async function ensureAgentDocumentFrontMatter(
  id: CompanyAgentID,
  filePath: string,
  type: AgentDocumentType,
  org?: OrgContext,
): Promise<void> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return
  const parsed = parseFrontMatter(await file.text())
  const next = agentDocumentFrontMatter(id, type, parsed.frontMatter, org)
  const complete = next.scope && next.classification && next.owner && next.updatedBy && next.type && next.version
  if (complete && JSON.stringify(next) === JSON.stringify(parsed.frontMatter)) return
  await Bun.write(filePath, stringifyFrontMatter(next, parsed.body))
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = typeof CompanyAgentTable.$inferSelect

function orgContextFromRow(row: Row): OrgContext | undefined {
  if (!row.org_layer) return undefined
  return {
    org_layer: row.org_layer ?? undefined,
    department: row.department ?? undefined,
    reports_to: row.reports_to ?? undefined,
    responsibilities: row.responsibilities ? JSON.parse(row.responsibilities) : undefined,
  }
}

function fromRow(row: Row): Omit<Info, "system_prompt" | "model"> {
  return {
    id: row.id as CompanyAgentID,
    lifecycle: row.lifecycle === "candidate" ? "candidate" : "employee",
    name: row.name,
    description: row.description ?? undefined,
    preferred_runtime: row.preferred_runtime,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    org_layer: row.org_layer ?? undefined,
    department: row.department ?? undefined,
    reports_to: row.reports_to ?? undefined,
    responsibilities: row.responsibilities ? JSON.parse(row.responsibilities) : undefined,
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
  return readMarkdownBody(agentSoulPath(id))
}

async function readSettings(id: CompanyAgentID): Promise<AgentSettings> {
  const file = Bun.file(agentSettingsPath(id))
  if (!(await file.exists())) return {}
  const content = await file.text()
  return AgentSettings.parse(JSON.parse(content))
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  return readMarkdownBody(filePath)
}

async function ensurePublicProfile(id: CompanyAgentID, name: string, description?: string, org?: OrgContext): Promise<void> {
  const profile = Bun.file(agentPublicProfilePath(id))
  if (await profile.exists()) return
  await fs.mkdir(agentPublicDir(id), { recursive: true })
  await Bun.write(
    agentPublicProfilePath(id),
    [
      `# ${name}`,
      "",
      description ?? "Agent Company professional agent.",
      "",
      "## Public Role",
      "",
      `- Organization layer: ${org?.org_layer ?? "execution"}`,
      `- Department: ${org?.department ?? "Unassigned"}`,
      `- Responsibilities: ${org?.responsibilities?.join("; ") ?? "To be assigned"}`,
    ].join("\n") + "\n",
  )
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
  const org = orgContextFromRow(row)
  // Validate file bundle on every read — recreates any missing files
  await validateFileBundle(id, row.name, org)
  await ensurePublicProfile(id, row.name, row.description ?? undefined, org)
  const [soul, settings, instruct, relationships, kanban, skills, public_profile] = await Promise.all([
    readSoul(id),
    readSettings(id),
    readFileIfExists(agentInstructPath(id)),
    readFileIfExists(agentRelationshipsPath(id)),
    readFileIfExists(agentKanbanPath(id)),
    readSkillNames(id),
    readFileIfExists(agentPublicProfilePath(id)),
  ])
  return {
    ...fromRow(row),
    public_profile,
    system_prompt: soul,
    instruct,
    relationships,
    kanban,
    skills: skills.length > 0 ? skills : undefined,
    model: settings.model,
  }
}

// ---------------------------------------------------------------------------
// Org-aware template helpers
// ---------------------------------------------------------------------------

const WORK_STYLE_BY_LAYER: Record<string, string> = {
  board:
    "Set strategic direction. Review proposals from departments. Make high-level decisions on resource allocation and organizational priorities. Communicate decisions clearly with rationale.",
  department:
    "Coordinate across project teams within your department. Translate board-level strategy into actionable plans. Remove blockers for your project teams. Report progress and risks upward.",
  project:
    "Own delivery of a specific project or feature set. Coordinate execution agents. Break down work into tasks. Track progress and escalate blockers to your department lead.",
  execution:
    "Execute assigned tasks with precision. Report progress frequently. Ask for clarification when requirements are ambiguous. Escalate blockers after attempting 2 approaches.",
  tool: "Perform specific, well-defined operations. Return structured results. Report errors clearly. Do not make assumptions about intent — ask if unclear.",
}

function generateSoulTemplate(name: string, org: OrgContext): string {
  const lines: string[] = [`# ${name}`, ""]

  lines.push("## Identity")
  lines.push(`- **Role**: ${org.org_layer ? `Organization ${org.org_layer} layer agent` : "General-purpose agent"}`)
  if (org.org_layer) lines.push(`- **Organization Layer**: ${org.org_layer}`)
  if (org.department) lines.push(`- **Department**: ${org.department}`)
  if (org.reports_to) lines.push(`- **Reports To**: ${org.reports_to}`)
  lines.push("")

  if (org.responsibilities && org.responsibilities.length > 0) {
    lines.push("## Responsibilities")
    for (const r of org.responsibilities) {
      lines.push(`- ${r}`)
    }
    lines.push("")
  }

  lines.push("## Work Style")
  const workStyle = org.org_layer
    ? (WORK_STYLE_BY_LAYER[org.org_layer] ?? WORK_STYLE_BY_LAYER["execution"])
    : "Be helpful, thorough, and proactive. Adapt communication style to the situation."
  lines.push(workStyle)
  lines.push("")

  lines.push("## Core Principles")
  lines.push("- Follow organizational hierarchy — do not skip levels")
  lines.push("- Escalate failures after 2 approach attempts")
  lines.push("- Document decisions and reasoning")
  lines.push("- Respect scope boundaries — only access authorized information")
  lines.push("")

  return lines.join("\n")
}

function generateInstructTemplate(name: string, org: OrgContext): string {
  const lines: string[] = [
    `---`,
    `agent: ${name}`,
    `type: instruct`,
    `version: 2`,
    `---`,
    "",
    `# Instructions for ${name}`,
    "",
  ]

  lines.push("## Communication Protocol")
  lines.push("- When receiving a task: acknowledge, clarify requirements, estimate effort")
  lines.push("- When completing a task: report results, artifacts produced, any blockers encountered")
  lines.push("- When stuck: attempt 2 different approaches before escalating")
  lines.push("- When escalating: carry all findings and attempted approaches to superior")
  lines.push("")

  lines.push("## Decision Framework")
  if (org.org_layer === "board") {
    lines.push("- You have full authority within strategic decisions")
    lines.push("- Propose resource allocation changes with cost-benefit analysis")
    lines.push("- Critical safety/budget decisions: consult with peers before committing")
  } else if (org.org_layer === "department") {
    lines.push("- Within department authority: decide and execute")
    lines.push("- Cross-department: coordinate with peer department leads")
    lines.push("- Critical (safety/budget): escalate to board")
  } else if (org.org_layer === "project") {
    lines.push("- Within project scope: decide and execute")
  } else if (org.org_layer === "tool") {
    lines.push("- Execute exactly as specified; do not interpret or extrapolate")
    lines.push("- If instructions are ambiguous, ask for clarification before proceeding")
  } else {
    lines.push("- Within authority: decide and execute")
    lines.push("- Outside authority: propose to superior with recommendation")
    lines.push("- Critical (safety/budget): always escalate, never self-decide")
  }
  lines.push("")

  lines.push("## Collaboration Rules")
  lines.push("- Address colleagues by name")
  lines.push("- Keep messages focused and actionable")
  lines.push("- Respect others' scope — don't interfere with their tasks")
  lines.push("- Share relevant context proactively")
  lines.push("")

  lines.push("## Escalation Triggers")
  lines.push("- Task blocked after 2 fix attempts")
  lines.push("- Resource requirement exceeds budget")
  lines.push("- Scope conflict with another team")
  lines.push("- Safety or policy red line approached")
  lines.push("")

  return lines.join("\n")
}

/**
 * Initialize the agent directory and create any missing files.
 * Safe to call on every list/get — all writes are idempotent (no-overwrite).
 */
async function initAgentDir(id: CompanyAgentID, name: string, org?: OrgContext): Promise<void> {
  await Promise.all([
    fs.mkdir(agentDir(id), { recursive: true }),
    fs.mkdir(agentPrivateDir(id), { recursive: true }),
    fs.mkdir(agentProfessionalDir(id), { recursive: true }),
    fs.mkdir(agentPublicDir(id), { recursive: true }),
  ])

  // MEMORY.md — create placeholder if absent
  const memPath = companyAgentMemoryPath(id)
  const memExists = await Bun.file(memPath).exists()
  if (!memExists) {
    await fs.writeFile(
      memPath,
      agentDocument(
        id,
        "memory",
        `# ${name}\n\n_Long-term memory for this agent. Add cross-project facts, preferences, and learned patterns here._\n`,
      ),
      "utf-8",
    )
  }

  // settings.json — create empty config if absent
  const settingsPath = agentSettingsPath(id)
  const settingsExists = await Bun.file(settingsPath).exists()
  if (!settingsExists) {
    await fs.writeFile(settingsPath, "{}\n", "utf-8")
  }

  // SOUL.md — create from template if absent (org-aware when fields present)
  const soulPath = agentSoulPath(id)
  const soulExists = await Bun.file(soulPath).exists()
  if (!soulExists) {
    const soulContent = org?.org_layer
      ? generateSoulTemplate(name, org)
      : [
          `# ${name}`,
          "",
          `General-purpose agent. Edit this file to define the agent's identity, role, and behavior.`,
          "",
        ].join("\n")
    await fs.writeFile(soulPath, agentDocument(id, "soul", soulContent, org), "utf-8")
  }

  // INSTRUCT.md — evolvable instructions if absent (org-aware when fields present)
  const instructPath = agentInstructPath(id)
  const instructExists = await Bun.file(instructPath).exists()
  if (!instructExists) {
    const instructContent = org?.org_layer
      ? generateInstructTemplate(name, org)
      : [
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
        ].join("\n")
    await fs.writeFile(instructPath, agentDocument(id, "instruct", instructContent), "utf-8")
  }

  // relationships.md — colleague relationships if absent
  const relPath = agentRelationshipsPath(id)
  const relExists = await Bun.file(relPath).exists()
  if (!relExists) {
    await fs.writeFile(
      relPath,
      agentDocument(
        id,
        "relationships",
        [
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
      ),
      "utf-8",
    )
  }

  // kanban.md — personal task view if absent
  const kanbanPath = agentKanbanPath(id)
  const kanbanExists = await Bun.file(kanbanPath).exists()
  if (!kanbanExists) {
    await fs.writeFile(
      kanbanPath,
      agentDocument(
        id,
        "kanban",
        [
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
      ),
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
async function validateFileBundle(id: CompanyAgentID, name: string, org?: OrgContext): Promise<void> {
  await migrateAgentHome(id)
  const dir = agentDir(id)
  const dirExists = await fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
  if (!dirExists) {
    await initAgentDir(id, name, org)
  }

  // Check each required file; re-init missing ones
  const requiredPaths = [
    companyAgentMemoryPath(id),
    agentSettingsPath(id),
    agentSoulPath(id),
    agentInstructPath(id),
    agentRelationshipsPath(id),
    agentKanbanPath(id),
  ]
  const missing = (
    await Promise.all(requiredPaths.map(async (p) => (!(await Bun.file(p).exists()) ? p : null)))
  ).filter((p): p is string => p !== null)

  if (missing.length > 0) {
    // Re-run init to recreate missing files (idempotent — won't overwrite existing)
    await initAgentDir(id, name, org)
  }

  await Promise.all([
    ensureAgentDocumentFrontMatter(id, companyAgentMemoryPath(id), "memory"),
    ensureAgentDocumentFrontMatter(id, agentSoulPath(id), "soul", org),
    ensureAgentDocumentFrontMatter(id, agentInstructPath(id), "instruct"),
    ensureAgentDocumentFrontMatter(id, agentRelationshipsPath(id), "relationships"),
    ensureAgentDocumentFrontMatter(id, agentKanbanPath(id), "kanban"),
  ])

  // Ensure subdirectories exist
  await Promise.all([
    fs.mkdir(agentPrivateDir(id), { recursive: true }),
    fs.mkdir(agentProfessionalDir(id), { recursive: true }),
    fs.mkdir(agentPublicDir(id), { recursive: true }),
    fs.mkdir(agentSkillsDir(id), { recursive: true }),
    fs.mkdir(agentMemoryDir(id), { recursive: true }),
  ])
}

async function writeAgentFiles(
  id: CompanyAgentID,
  patch: { system_prompt?: string; instruct?: string; relationships?: string; kanban?: string; model?: string },
  org?: OrgContext,
): Promise<void> {
  await Promise.all([
    fs.mkdir(agentPrivateDir(id), { recursive: true }),
    fs.mkdir(agentProfessionalDir(id), { recursive: true }),
    fs.mkdir(agentPublicDir(id), { recursive: true }),
  ])

  if (patch.system_prompt !== undefined) {
    await Bun.write(agentSoulPath(id), agentDocument(id, "soul", patch.system_prompt, org))
  }

  if (patch.instruct !== undefined) {
    await Bun.write(agentInstructPath(id), agentDocument(id, "instruct", patch.instruct))
  }

  if (patch.relationships !== undefined) {
    await Bun.write(agentRelationshipsPath(id), agentDocument(id, "relationships", patch.relationships))
  }

  if (patch.kanban !== undefined) {
    await Bun.write(agentKanbanPath(id), agentDocument(id, "kanban", patch.kanban))
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
  readonly promote: (id: CompanyAgentID) => Effect.Effect<Info>
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
              lifecycle: input.lifecycle ?? "candidate",
              name: input.name,
              description: input.description ?? null,
              color: input.color ?? null,
              icon: input.icon ?? null,
              org_layer: input.org_layer ?? null,
              department: input.department ?? null,
              reports_to: input.reports_to ?? null,
              responsibilities: input.responsibilities ? JSON.stringify(input.responsibilities) : null,
              preferred_runtime: input.preferred_runtime ?? "pi",
              time_created: now,
              time_updated: now,
            })
            .run(),
        ),
      )
      const org: OrgContext | undefined = input.org_layer
        ? {
            org_layer: input.org_layer,
            department: input.department,
            reports_to: input.reports_to,
            responsibilities: input.responsibilities,
          }
        : undefined
      yield* Effect.promise(async () => {
        await initAgentDir(input.id as CompanyAgentID, input.name, org)
        await ensurePublicProfile(input.id as CompanyAgentID, input.name, input.description, org)
        await writeAgentFiles(
          input.id as CompanyAgentID,
          {
            system_prompt: input.system_prompt,
            instruct: input.instruct,
            model: input.model,
          },
          org,
        )
        await generateAgentProfile(input.id, input.name, "agent", "general", [
          input.description ?? "General-purpose agent",
        ])
      })
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, input.id)).get()),
      )
      if (!row) yield* Effect.die(new Error(`CompanyAgent.create: insert failed for id="${input.id}"`))
      const info = yield* Effect.promise(() => fromRowWithFiles(row!))
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Created.type, properties: toPublicInfo(info) },
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
      if (input.org_layer !== undefined) dbPatch.org_layer = input.org_layer
      if (input.department !== undefined) dbPatch.department = input.department
      if (input.reports_to !== undefined) dbPatch.reports_to = input.reports_to
      if (input.responsibilities !== undefined) dbPatch.responsibilities = JSON.stringify(input.responsibilities)
      if (input.preferred_runtime !== undefined) dbPatch.preferred_runtime = input.preferred_runtime

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
          writeAgentFiles(
            input.id,
            {
              ...(input.system_prompt !== undefined && { system_prompt: input.system_prompt }),
              ...(input.instruct !== undefined && { instruct: input.instruct }),
              ...(input.relationships !== undefined && { relationships: input.relationships }),
              ...(input.kanban !== undefined && { kanban: input.kanban }),
              ...(input.model !== undefined && { model: input.model }),
            },
            orgContextFromRow(row!),
          ),
        )
      }

      const info = yield* Effect.promise(() => fromRowWithFiles(row!))
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Updated.type, properties: toPublicInfo(info) },
        }),
      )
      return info
    })

    const promote = Effect.fn("CompanyAgent.promote")(function* (id: CompanyAgentID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(CompanyAgentTable).where(eq(CompanyAgentTable.id, id)).get()),
      )
      if (!row) throw new Error(`Company agent not found: ${id}`)
      if (row.lifecycle === "employee") return yield* Effect.promise(() => fromRowWithFiles(row))
      const info = yield* Effect.promise(() => fromRowWithFiles(row))
      if (!info.public_profile || !info.instruct || !info.system_prompt)
        throw new Error("Candidate needs a public profile, private SOUL, and instruction document before promotion")
      const updated = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(CompanyAgentTable)
            .set({ lifecycle: "employee", time_updated: Date.now() })
            .where(eq(CompanyAgentTable.id, id))
            .returning()
            .get(),
        ),
      )
      if (!updated) throw new Error(`Company agent promotion failed: ${id}`)
      const promoted = yield* Effect.promise(() => fromRowWithFiles(updated))
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: Event.Updated.type, properties: toPublicInfo(promoted) },
        }),
      )
      return promoted
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

    return { create, get, list, update, promote, remove }
  }),
)

export const defaultLayer = layer

export * as CompanyAgent from "./company-agent"
