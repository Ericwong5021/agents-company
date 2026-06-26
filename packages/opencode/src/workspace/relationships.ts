/**
 * Relationship edges & group membership for inter-agent clearance modifiers.
 *
 * RelationshipEdge kinds:
 *   - channel     (+1 clearance boost) — private channel between agents
 *   - delegation  (grants delegate access) — target inherits source's scope
 *   - external    (-1 clearance penalty) — cross-org relationship
 *
 * Group membership tracks which agents belong to project groups,
 * enabling scope resolution for `group:<groupId>` patterns.
 */

import type { OrgStructure } from "./clearance"
import { ClearanceLevel, getAgentClearance } from "./clearance"

// ---------------------------------------------------------------------------
// Relationship edge types
// ---------------------------------------------------------------------------

export type RelationshipKind = "channel" | "delegation" | "external"

export interface RelationshipEdge {
  fromAgentId: string
  toAgentId: string
  kind: RelationshipKind
  clearanceModifier: number
}

/** Default modifiers for each relationship kind. */
export const DefaultModifiers: Record<RelationshipKind, number> = {
  channel: 1,
  delegation: 0,
  external: -1,
}

// ---------------------------------------------------------------------------
// In-memory edge store
// ---------------------------------------------------------------------------

const edges: RelationshipEdge[] = []

/**
 * Add a relationship edge to the store.
 * If no clearanceModifier is provided, uses the default for that kind.
 */
export function addEdge(edge: Omit<RelationshipEdge, "clearanceModifier"> & { clearanceModifier?: number }): RelationshipEdge {
  const full: RelationshipEdge = {
    ...edge,
    clearanceModifier: edge.clearanceModifier ?? DefaultModifiers[edge.kind],
  }
  edges.push(full)
  return full
}

/**
 * Remove edges matching the given from/to pair.
 * Returns the number of edges removed.
 */
export function removeEdge(fromAgentId: string, toAgentId: string): number {
  const before = edges.length
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].fromAgentId === fromAgentId && edges[i].toAgentId === toAgentId) {
      edges.splice(i, 1)
    }
  }
  return before - edges.length
}

/**
 * List all edges, optionally filtered by agent (as source or target).
 */
export function listEdges(agentId?: string): RelationshipEdge[] {
  if (!agentId) return [...edges]
  return edges.filter(
    (e) => e.fromAgentId === agentId || e.toAgentId === agentId,
  )
}

/**
 * Clear all stored edges. Primarily useful for testing.
 */
export function clearEdges(): void {
  edges.length = 0
}

// ---------------------------------------------------------------------------
// Effective clearance computation
// ---------------------------------------------------------------------------

/**
 * Compute an agent's effective clearance by summing their base org clearance
 * with the clearanceModifier of every edge that targets this agent.
 *
 * The result is clamped to [0, restricted] so it never falls below public
 * or exceeds the maximum level.
 */
export function getEffectiveClearance(
  agentId: string,
  baseOrg: OrgStructure,
  edgeList?: RelationshipEdge[],
): number {
  const base = getAgentClearance(agentId, baseOrg)
  const incoming = (edgeList ?? edges).filter((e) => e.toAgentId === agentId)
  const modifier = incoming.reduce((sum, e) => sum + e.clearanceModifier, 0)
  const effective = base + modifier
  return Math.max(ClearanceLevel.public, Math.min(ClearanceLevel.restricted, effective))
}

// ---------------------------------------------------------------------------
// GroupMembership type & snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of group membership data, useful for passing around a
 * self-contained view of the store (e.g. for serialization or testing).
 */
export interface GroupMembership {
  [groupId: string]: string[]
}

// ---------------------------------------------------------------------------
// In-memory group membership store
// ---------------------------------------------------------------------------

/** Map of groupId -> set of agent IDs. */
const groupStore: Map<string, Set<string>> = new Map()

/**
 * Add an agent to a group. Creates the group if it does not exist.
 */
export function addGroupMember(groupId: string, agentId: string): void {
  let members = groupStore.get(groupId)
  if (!members) {
    members = new Set()
    groupStore.set(groupId, members)
  }
  members.add(agentId)
}

/**
 * Remove an agent from a group.
 * Returns true if the agent was a member, false otherwise.
 */
export function removeGroupMember(groupId: string, agentId: string): boolean {
  const members = groupStore.get(groupId)
  if (!members) return false
  return members.delete(agentId)
}

/**
 * Check whether an agent is a member of a group against the in-memory store.
 */
export function isGroupMember(groupId: string, agentId: string): boolean {
  return groupStore.get(groupId)?.has(agentId) ?? false
}

/**
 * Check whether an agent is a member of a group using an explicit
 * GroupMembership snapshot (does not read the global store).
 */
export function isMemberOf(groupId: string, agentId: string, membership: GroupMembership): boolean {
  const members = membership[groupId]
  if (!members) return false
  return members.includes(agentId)
}

/**
 * List all members of a group. Returns an empty array if the group does not exist.
 */
export function listGroupMembers(groupId: string): string[] {
  return Array.from(groupStore.get(groupId) ?? [])
}

/**
 * List all known group IDs.
 */
export function listGroups(): string[] {
  return Array.from(groupStore.keys())
}

/**
 * Clear all group memberships. Primarily useful for testing.
 */
export function clearGroups(): void {
  groupStore.clear()
}

/**
 * Export the current group store as a plain object snapshot.
 */
export function exportGroupMembership(): GroupMembership {
  const result: GroupMembership = {}
  for (const [groupId, members] of groupStore) {
    result[groupId] = Array.from(members)
  }
  return result
}

/**
 * Import a group membership snapshot, replacing the current store.
 */
export function importGroupMembership(data: GroupMembership): void {
  groupStore.clear()
  for (const [groupId, members] of Object.entries(data)) {
    const memberSet = new Set(members)
    groupStore.set(groupId, memberSet)
  }
}

