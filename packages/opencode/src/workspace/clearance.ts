/**
 * Clearance & Access Control for the three-layer workspace.
 *
 * ClearanceLevel hierarchy:  public(0) < internal(1) < confidential(2) < restricted(3)
 *
 * Access is granted when the agent's clearance level >= the document's
 * classification level AND the document's scope is visible to the agent.
 */

import type { FrontMatter } from "./front-matter"

// ---------------------------------------------------------------------------
// Clearance levels
// ---------------------------------------------------------------------------

export const ClearanceLevel = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const

export type ClearanceLevelName = keyof typeof ClearanceLevel

/**
 * Parse a clearance name into its numeric level.
 * Returns undefined for unrecognised names.
 */
export function parseClearanceLevel(name: string): number | undefined {
  return ClearanceLevel[name as ClearanceLevelName]
}

/**
 * Get the name for a numeric clearance level.
 */
export function clearanceLevelName(level: number): ClearanceLevelName | undefined {
  for (const [name, value] of Object.entries(ClearanceLevel)) {
    if (value === level) return name as ClearanceLevelName
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Org structure types (mirrors config schema)
// ---------------------------------------------------------------------------

export interface OrgRole {
  clearance: ClearanceLevelName
  department?: string
}

export interface OrgDepartment {
  clearance?: ClearanceLevelName
  roles: Record<string, OrgRole>
}

export interface OrgStructure {
  departments: Record<string, OrgDepartment>
  agents: Record<string, { department: string; role: string }>
}

// ---------------------------------------------------------------------------
// Access checks
// ---------------------------------------------------------------------------

/**
 * Derive an agent's clearance level from the org structure config.
 * Falls back to "internal" if the agent is not found in the org tree.
 */
export function getAgentClearance(agentId: string, org: OrgStructure): number {
  const assignment = org.agents[agentId]
  if (!assignment) return ClearanceLevel.internal

  const dept = org.departments[assignment.department]
  if (!dept) return ClearanceLevel.internal

  const role = dept.roles[assignment.role]
  if (role?.clearance) return ClearanceLevel[role.clearance]

  // Department-level default
  if (dept.clearance) return ClearanceLevel[dept.clearance]

  return ClearanceLevel.internal
}

/**
 * Check whether a clearance level can access a document classification.
 * Access is granted when agent clearance >= document classification.
 */
export function canAccess(agentClearance: number, docClassification: string): boolean {
  const docLevel = parseClearanceLevel(docClassification)
  if (docLevel === undefined) return true // unknown classification = permissive
  return agentClearance >= docLevel
}

/**
 * Full access check: scope AND clearance.
 *
 * Scope rules:
 *   - "public"   — visible to everyone
 *   - "org"      — visible to any agent in the org structure
 *   - "dept:<X>" — visible only to agents in department X
 *   - "agent:<X> — visible only to agent X
 */
export function canSeeDoc(agentId: string, doc: FrontMatter, org: OrgStructure): boolean {
  // 1. Clearance check
  const classification = doc.classification ?? "public"
  const agentClearance = getAgentClearance(agentId, org)
  if (!canAccess(agentClearance, classification)) return false

  // 2. Scope check
  const scope = doc.scope ?? "public"
  if (scope === "public") return true
  if (scope === "org") return agentId in org.agents

  if (scope.startsWith("dept:")) {
    const dept = scope.slice(5)
    const assignment = org.agents[agentId]
    return assignment?.department === dept
  }

  if (scope.startsWith("agent:")) {
    return scope.slice(6) === agentId
  }

  // Unknown scope — deny by default
  return false
}
