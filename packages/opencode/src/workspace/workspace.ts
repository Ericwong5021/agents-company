/**
 * Workspace bootstrap — creates the three-layer file tree on first run.
 *
 * Directory structure:
 *   public/
 *     org/profiles/        — per-agent profile .md files
 *     org/structure.md     — org chart & reporting lines
 *     policy/safety-redlines.md
 *     policy/collaboration.md
 *     facilities/skills.md
 *     board/strategy.md
 *     board/projects.md
 *     minutes/             — meeting notes (empty)
 *   groups/                — populated on team formation
 *   agents/                — populated by company-agent module
 *
 * Each .md file gets YAML front-matter with scope, classification, owner.
 */

import fs from "fs/promises"
import path from "path"
import { stringifyFrontMatter, type FrontMatter } from "./front-matter"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Workspace root — set once by initWorkspace(), read thereafter. */
let _root: string | undefined

/** Workspace root at `<data>/workspace/`. Must call initWorkspace() first. */
export function workspaceRoot(): string {
  if (!_root) throw new Error("Workspace not initialised — call initWorkspace(dataPath) first")
  return _root
}

function ws(...segments: string[]): string {
  return path.join(workspaceRoot(), ...segments)
}

// ---------------------------------------------------------------------------
// File definitions
// ---------------------------------------------------------------------------

interface FileDef {
  path: string[]
  frontMatter: FrontMatter
  title: string
  body: string
}

const FILES: FileDef[] = [
  {
    path: ["public", "org", "structure.md"],
    frontMatter: { scope: "org", classification: "internal", owner: "system" },
    title: "Organization Structure",
    body: `_Org chart, departments, roles, and reporting lines._\n\n## Departments\n\n_Update this file to reflect the current organization._\n`,
  },
  {
    path: ["public", "policy", "safety-redlines.md"],
    frontMatter: { scope: "public", classification: "internal", owner: "system" },
    title: "Safety Red Lines",
    body: `_Non-negotiable safety constraints that all agents must follow._\n\n## Rules\n\n1. Never expose credentials or secrets in output.\n2. Never execute destructive commands without explicit user confirmation.\n3. Always respect file access boundaries defined by clearance level.\n`,
  },
  {
    path: ["public", "policy", "collaboration.md"],
    frontMatter: { scope: "public", classification: "internal", owner: "system" },
    title: "Collaboration Policy",
    body: `_Guidelines for inter-agent collaboration._\n\n## Principles\n\n- Communicate intent before taking action.\n- Share relevant context with collaborating agents.\n- Respect thread boundaries and budget limits.\n`,
  },
  {
    path: ["public", "facilities", "skills.md"],
    frontMatter: { scope: "public", classification: "public", owner: "system" },
    title: "Shared Skills Registry",
    body: `_Catalog of shared skills available to all agents._\n\n## Available Skills\n\n_Add skills here as they are developed._\n`,
  },
  {
    path: ["public", "board", "strategy.md"],
    frontMatter: { scope: "org", classification: "confidential", owner: "system" },
    title: "Company Strategy",
    body: `_High-level strategic direction and goals._\n\n## Vision\n\n_Update with current strategic priorities._\n`,
  },
  {
    path: ["public", "board", "projects.md"],
    frontMatter: { scope: "org", classification: "internal", owner: "system" },
    title: "Active Projects",
    body: `_Overview of active projects and their status._\n\n## Projects\n\n_Add projects as they are initiated._\n`,
  },
]

// ---------------------------------------------------------------------------
// Init & Bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialise the workspace root path and create the three-layer directory
 * structure with seed files. Idempotent: existing files and directories
 * are left untouched.
 *
 * Call once at startup from global/index.ts.
 */
export async function initWorkspace(dataPath: string): Promise<void> {
  _root = path.join(dataPath, "workspace")

  // Create all directories
  const dirs = [
    ws("public", "org", "profiles"),
    ws("public", "policy"),
    ws("public", "facilities"),
    ws("public", "board"),
    ws("public", "minutes"),
    ws("groups"),
    ws("agents"),
  ]
  await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })))

  // Seed .md files (no-overwrite)
  await Promise.all(
    FILES.map(async (def) => {
      const filePath = ws(...def.path)
      const exists = await Bun.file(filePath).exists()
      if (exists) return
      const content = stringifyFrontMatter(def.frontMatter, `# ${def.title}\n\n${def.body}`)
      await Bun.write(filePath, content)
    }),
  )
}

// ---------------------------------------------------------------------------
// Agent profile generation
// ---------------------------------------------------------------------------

/**
 * Generate a profile .md file for an agent in `public/org/profiles/`.
 * Idempotent: skips if the file already exists.
 */
export async function generateAgentProfile(
  agentId: string,
  name: string,
  role: string,
  department: string,
  capabilities: string[],
): Promise<void> {
  const filePath = ws("public", "org", "profiles", `${agentId}.md`)
  const exists = await Bun.file(filePath).exists()
  if (exists) return

  const frontMatter: FrontMatter = {
    scope: "org",
    classification: "internal",
    owner: agentId,
  }

  const body = [
    `# ${name}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| **ID** | \`${agentId}\` |`,
    `| **Role** | ${role} |`,
    `| **Department** | ${department} |`,
    "",
    "## Capabilities",
    "",
    ...capabilities.map((c) => `- ${c}`),
    "",
  ].join("\n")

  await Bun.write(filePath, stringifyFrontMatter(frontMatter, body))
}

export * as Workspace from "./workspace"
