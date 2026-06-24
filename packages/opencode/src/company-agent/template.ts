import { AGENT_TEMPLATES, TEMPLATE_DIVISIONS } from "./templates-index"
import type { AgentTemplate, AgentTemplateDivision } from "./templates-index"

export type { AgentTemplate, AgentTemplateDivision }

// ---------------------------------------------------------------------------
// Search index — built once at module load, O(1) lookups thereafter
// ---------------------------------------------------------------------------

// Map: division → agents
const byDivision = new Map<string, AgentTemplate[]>()
for (const agent of AGENT_TEMPLATES) {
  const list = byDivision.get(agent.division) ?? []
  list.push(agent)
  byDivision.set(agent.division, list)
}

// Map: "division/slug" → agent
const byKey = new Map<string, AgentTemplate>()
for (const agent of AGENT_TEMPLATES) {
  byKey.set(`${agent.division}/${agent.slug}`, agent)
}

// Searchable corpus: name + description + vibe (lowercase, pre-joined for fast scan)
const corpus = AGENT_TEMPLATES.map((a) => ({
  agent: a,
  text: [a.name, a.description, a.vibe, a.division].join(" ").toLowerCase(),
}))

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const TemplateService = {
  /** All divisions with agent counts. */
  divisions(): AgentTemplateDivision[] {
    return TEMPLATE_DIVISIONS
  },

  /** All agents in a division, or undefined if the division doesn't exist. */
  byDivision(division: string): AgentTemplate[] | undefined {
    return byDivision.get(division)
  },

  /** Single agent by division + slug, or undefined if not found. */
  get(division: string, slug: string): AgentTemplate | undefined {
    return byKey.get(`${division}/${slug}`)
  },

  /**
   * Full-text search across name, description, vibe, and division.
   * Returns agents ranked by relevance (number of query terms matched).
   * If query is empty, returns all agents sorted by division + name.
   */
  search(query: string, opts?: { division?: string; limit?: number }): AgentTemplate[] {
    const limit = opts?.limit ?? 50
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)

    let candidates = opts?.division ? (byDivision.get(opts.division) ?? []) : AGENT_TEMPLATES

    if (terms.length === 0) return candidates.slice(0, limit)

    const scored: { agent: AgentTemplate; score: number }[] = []
    for (const { agent, text } of corpus) {
      if (opts?.division && agent.division !== opts.division) continue
      const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0)
      if (score > 0) scored.push({ agent, score })
    }

    scored.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
    return scored.slice(0, limit).map((s) => s.agent)
  },
} as const

export * as AgentTemplates from "./template"
