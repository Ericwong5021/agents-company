/**
 * ContextResolver — resolves the workspace context visible to a specific agent.
 *
 * Given an agent ID and the org structure config, it:
 *   1. Scans public/ and groups/ directories for .md files
 *   2. Filters by scope (covers agent) AND clearance (agent.level >= doc.classification)
 *   3. Builds a standing summary of accessible docs
 *   4. Returns structured context for system-prompt injection
 */

import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { parseFrontMatter, type FrontMatter } from "./front-matter"
import { canSeeDoc, canSeeDocEnhanced, getAgentClearance, clearanceLevelName, type OrgStructure } from "./clearance"
import { workspaceRoot } from "./workspace"
import { Log } from "@/util"

const log = Log.create({ service: "context-resolver" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisibleDoc {
  /** Workspace-relative path (e.g. "public/policy/safety-redlines.md") */
  path: string
  /** Front-matter scope */
  scope: string
  /** Front-matter classification */
  classification: string
  /** First paragraph or heading summary of the document body */
  summary: string
}

export interface ResolvedContext {
  /** Always-injected text: directory overview, safety redline, current project */
  standingSummary: string
  /** Docs the agent can access */
  visibleDocs: VisibleDoc[]
  /** Agent's own profile summary, if accessible */
  agentProfile: string | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a short summary from a markdown body: first non-empty line
 * after stripping headings and front-matter.
 */
function extractSummary(body: string): string {
  const lines = body.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    // Skip empty lines, headings, and metadata lines
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue
    // Strip markdown emphasis
    const clean = trimmed.replace(/^[*_`]+|[*_`]+$/g, "")
    if (clean.length > 0) return clean.length > 120 ? clean.slice(0, 117) + "..." : clean
  }
  return "(no summary)"
}

/**
 * Recursively scan a directory for .md files, returning workspace-relative paths.
 */
async function scanMdFiles(dir: string, relativeTo: string): Promise<string[]> {
  const results: string[] = []
  const exists = await Bun.file(dir).exists()
  if (!exists) return results

  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await scanMdFiles(fullPath, relativeTo)
      results.push(...sub)
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(relativeTo, fullPath))
    }
  }
  return results
}

/**
 * Read a workspace doc and return its front-matter + body.
 * Returns undefined if the file doesn't exist or can't be read.
 */
async function readWorkspaceDoc(relativePath: string): Promise<{
  frontMatter: FrontMatter
  body: string
} | undefined> {
  const fullPath = path.join(workspaceRoot(), relativePath)
  const file = Bun.file(fullPath)
  if (!(await file.exists())) return undefined
  const content = await file.text()
  return parseFrontMatter(content)
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace context for a given agent.
 *
 * @param agentId - The agent identifier (matches keys in org.agents config)
 * @param org - Optional org structure from config. When omitted, all docs
 *              are treated as publicly accessible.
 */
export function resolve(
  agentId: string,
  org?: OrgStructure,
  relationshipModifier?: number,
  isGroupMember?: (groupId: string) => boolean,
): Effect.Effect<ResolvedContext, Error> {
  return Effect.gen(function* () {
    const root = workspaceRoot()
    const publicDir = path.join(root, "public")
    const groupsDir = path.join(root, "groups")

    // 1. Scan public/ for .md files
    const publicFiles = yield* Effect.promise(() => scanMdFiles(publicDir, root))

    // 2. Scan groups/ for .md files (project-level docs)
    const groupFiles = yield* Effect.promise(() => scanMdFiles(groupsDir, root))

    // 3. Filter and build visible docs
    const allFiles = [...publicFiles, ...groupFiles]
    const visibleDocs: VisibleDoc[] = []

    for (const relPath of allFiles) {
      const doc = yield* Effect.promise(() => readWorkspaceDoc(relPath))
      if (!doc) continue

      const scope = doc.frontMatter.scope ?? "public"
      const classification = doc.frontMatter.classification ?? "public"

      // If org is provided, check access; otherwise treat as public
      if (org) {
        const hasEnhancedArgs = relationshipModifier !== undefined || isGroupMember !== undefined
        const visible = hasEnhancedArgs
          ? canSeeDocEnhanced(agentId, doc.frontMatter, org, relationshipModifier ?? 0, isGroupMember)
          : canSeeDoc(agentId, doc.frontMatter, org)
        if (!visible) continue
      }

      visibleDocs.push({
        path: relPath,
        scope,
        classification,
        summary: extractSummary(doc.body),
      })
    }

    // 4. Build agent profile summary
    const profilePath = path.join("public", "org", "profiles", `${agentId}.md`)
    const profileDoc = yield* Effect.promise(() => readWorkspaceDoc(profilePath))
    const agentProfile = profileDoc ? extractSummary(profileDoc.body) : undefined

    // 5. Build standing summary
    const standingSummary = buildStandingSummary(agentId, visibleDocs, org)

    log.info("context resolved", {
      agentId,
      visibleCount: visibleDocs.length,
      totalCount: allFiles.length,
      hasProfile: !!agentProfile,
    })

    return { standingSummary, visibleDocs, agentProfile }
  })
}

// ---------------------------------------------------------------------------
// Standing summary builder
// ---------------------------------------------------------------------------

function buildStandingSummary(agentId: string, docs: VisibleDoc[], org?: OrgStructure): string {
  const parts: string[] = []

  // Agent identity
  parts.push(`## Agent Context: ${agentId}`)

  // Clearance info
  if (org) {
    const clearance = getAgentClearance(agentId, org)
    const name = clearanceLevelName(clearance) ?? "unknown"
    parts.push(`Clearance level: ${name} (${clearance})`)
  }

  // Directory overview of visible docs
  parts.push("")
  parts.push("## Visible Workspace Documents")
  parts.push("")

  // Group by top-level directory
  const byDir = new Map<string, VisibleDoc[]>()
  for (const doc of docs) {
    const topDir = doc.path.split(path.sep)[0] ?? "root"
    const existing = byDir.get(topDir)
    if (existing) existing.push(doc)
    else byDir.set(topDir, [doc])
  }

  for (const [dir, dirDocs] of byDir) {
    parts.push(`### ${dir}/`)
    for (const doc of dirDocs) {
      const relPath = doc.path.split(path.sep).slice(1).join("/")
      parts.push(`- \`${relPath}\` [${doc.classification}] — ${doc.summary}`)
    }
    parts.push("")
  }

  // Safety redline highlight
  const safetyDoc = docs.find((d) => d.path.includes("safety-redlines"))
  if (safetyDoc) {
    parts.push("## Safety Red Lines (always apply)")
    parts.push(safetyDoc.summary)
    parts.push("")
  }

  return parts.join("\n")
}
