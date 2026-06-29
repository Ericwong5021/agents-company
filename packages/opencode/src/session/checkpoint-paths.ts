import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import type { ProjectID } from "@/project/schema"
import type { CompanyAgentID } from "@/company-agent/schema"
import { SessionID } from "./schema"

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Session memory root. Houses checkpoint artifacts, task narratives, and
 * other per-session memory files under `<data>/memory/sessions/<sid>/`.
 */
export function metaDir(sessionID: SessionID): string {
  return path.join(Global.Path.data, "sessions", sessionID)
}

/**
 * v5 single-file checkpoint at `<sid>/checkpoint.md` (no subdir).
 */
export function checkpointPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "checkpoint.md")
}

/**
 * v5 per-project memory file at `<data>/memory/projects/<pid>/MEMORY.md`.
 * Shared across all company agents (project-level, agent-agnostic).
 */
export function memoryPath(projectID: ProjectID): string {
  return path.join(Global.Path.data, "projects", projectID, "MEMORY.md")
}

/**
 * Root directory for a company agent at `<data>/workspace/agents/<aid>/`.
 * Houses SOUL.md, settings.json, MEMORY.md, and per-project memory.
 */
export function agentDir(agentID: CompanyAgentID): string {
  return path.join(Global.Path.data, "workspace", "agents", agentID)
}

/**
 * Agent persona file at `<data>/workspace/agents/<aid>/SOUL.md`.
 * Contains the raw system_prompt text; edit directly to change agent personality.
 */
export function agentSoulPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "SOUL.md")
}

/**
 * Agent config file at `<data>/workspace/agents/<aid>/settings.json`.
 * Stores model override, and will expand to include skills and MCP config.
 */
export function agentSettingsPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "settings.json")
}

/**
 * Per-company-agent memory at `<data>/workspace/agents/<aid>/MEMORY.md`.
 * Cross-project long-term memory scoped to one company agent.
 */
export function companyAgentMemoryPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "MEMORY.md")
}

/**
 * Agent instruct file at `<data>/workspace/agents/<aid>/INSTRUCT.md`.
 * Evolvable instructions: how to judge, communicate, when to escalate.
 */
export function agentInstructPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "INSTRUCT.md")
}

/**
 * Agent relationships file at `<data>/workspace/agents/<aid>/relationships.md`.
 * Colleague relationships: collaboration preferences, communication style, trust level.
 */
export function agentRelationshipsPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "relationships.md")
}

/**
 * Agent kanban file at `<data>/workspace/agents/<aid>/kanban.md`.
 * Personal task view: current projects, todos, progress.
 */
export function agentKanbanPath(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "kanban.md")
}

/**
 * Agent skills directory at `<data>/workspace/agents/<aid>/skills/`.
 * Private skills: reusable capabilities crystallized from experience.
 */
export function agentSkillsDir(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "skills")
}

/**
 * Agent memory directory at `<data>/workspace/agents/<aid>/memory/`.
 * Houses per-agent memory files indexed by the FTS5 search system.
 */
export function agentMemoryDir(agentID: CompanyAgentID): string {
  return path.join(agentDir(agentID), "memory")
}

/**
 * Per-company-agent × per-project memory at
 * `<data>/workspace/agents/<aid>/projects/<pid>/MEMORY.md`.
 * Captures knowledge this agent accumulated specifically within one project.
 */
export function companyAgentProjectMemoryPath(agentID: CompanyAgentID, projectID: ProjectID): string {
  return path.join(agentDir(agentID), "projects", projectID, "MEMORY.md")
}

/**
 * Single global memory file at `<data>/memory/global/MEMORY.md`. User-level
 * cross-project preferences. Read-only from the agent side; no auto-create.
 */
export function globalMemoryPath(): string {
  return path.join(Global.Path.data, "memory", "MEMORY.md")
}

/**
 * One-shot rename of a legacy `projects/<pid>/memory.md` to the canonical
 * `MEMORY.md`. Idempotent: no-op when the uppercase file already exists or
 * when neither exists. The rename is atomic, so concurrent readers see either
 * the old or new name, never a missing file. Call before reading/writing
 * project memory so the uppercase path is authoritative.
 */
export async function migrateProjectMemory(projectID: ProjectID): Promise<void> {
  const upper = memoryPath(projectID)
  const lower = path.join(path.dirname(upper), "memory.md")
  if (await Bun.file(upper).exists()) return
  if (await Bun.file(lower).exists())
    // Two migrators (e.g. concurrent sessions/writers on the same project) can
    // both pass the exists() checks; the loser's rename then sees lower already
    // gone. ENOENT means the peer won — treat as success. Re-throw real FS
    // errors (permissions, disk).
    await fs.rename(lower, upper).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    })
}

/**
 * v8 session-scoped notes file at `<sid>/notes.md`. Main-agent-only
 * scratchpad; writer reconciles entries at checkpoint events.
 */
export function notesPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "notes.md")
}

/**
 * Per-session tasks directory at `<sid>/tasks/`. Houses per-task progress
 * journals authored either by subagents (Spec ②) or by the splitover
 * plugin (when main checkpoint.md grows past caps).
 */
export function tasksDir(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "tasks")
}

/**
 * Per-task progress journal at `<sid>/tasks/<TID>/progress.md`. Authored
 * by subagents (Spec ② actor.postStop) and read by the checkpoint writer's
 * reconcile preprocessor (Spec ② Chain 2).
 */
export function progressPath(sessionID: SessionID, taskID: string): string {
  return path.join(tasksDir(sessionID), taskID, "progress.md")
}
