import { CapabilityCatalog } from "@/capability"
import type { CompanyAgent } from "@/company-agent"
import {
  RuntimeCapabilityMatrix,
  RuntimeID,
  type RuntimePermissionMode,
} from "@/runtime"
import { SelectionScore, type CapabilityNeed, type TeamSelection } from "./schema"

const permissionRank = {
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
} satisfies Record<RuntimePermissionMode, number>

const packs = new Map(
  CapabilityCatalog.list().map((pack) => [`${pack.id}@${pack.version}`, pack]),
)

const requirements = (need: CapabilityNeed) => {
  const resolved = need.capability_packs
    .map((reference) => packs.get(reference))
    .filter((pack) => pack !== undefined)
  const requiredPermission = resolved
    .map((pack) => pack.permissionMode)
    .toSorted((left, right) => permissionRank[right] - permissionRank[left])[0] ?? "read_only"
  return {
    missingPacks: need.capability_packs.filter((reference) => !packs.has(reference)),
    capabilities: [
      ...new Set([
        ...need.required_runtime_capabilities,
        ...resolved.flatMap((pack) => pack.requiredRuntimeCapabilities),
      ]),
    ],
    tools: [...new Set([...need.required_tools, ...resolved.flatMap((pack) => pack.tools)])],
    availableTools: new Set(resolved.flatMap((pack) => pack.tools)),
    permissionMode: need.allowed_permission_modes
      .filter((mode) => permissionRank[mode] >= permissionRank[requiredPermission])
      .toSorted((left, right) => permissionRank[left] - permissionRank[right])[0],
  }
}

export function evaluateSelectionConstraints(
  need: CapabilityNeed,
  agent: CompanyAgent.Info,
): {
  eligible: boolean
  permissionMode?: RuntimePermissionMode
  results: TeamSelection["constraint_results"]
} {
  const required = requirements(need)
  const runtime = RuntimeID.safeParse(agent.preferred_runtime)
  const missingCapabilities = runtime.success
    ? required.capabilities.filter((capability) => !RuntimeCapabilityMatrix[runtime.data][capability])
    : required.capabilities
  const missingTools = required.tools.filter((tool) => !required.availableTools.has(tool))
  const results: TeamSelection["constraint_results"] = [
    {
      kind: "runtime",
      passed: runtime.success && missingCapabilities.length === 0,
      reason: runtime.success
        ? missingCapabilities.length
          ? `Runtime ${runtime.data} lacks ${missingCapabilities.join(", ")}`
          : `Runtime ${runtime.data} satisfies required capabilities`
        : `Unknown runtime ${agent.preferred_runtime}`,
    },
    {
      kind: "tool",
      passed: missingTools.length === 0,
      reason: missingTools.length
          ? `Required tools are unavailable: ${missingTools.join(", ")}`
          : required.missingPacks.length
            ? `Unresolved capability packs remain evidence-neutral: ${required.missingPacks.join(", ")}`
            : "Capability packs provide every required tool",
    },
    {
      kind: "permission",
      passed: Boolean(required.permissionMode),
      reason: required.permissionMode
        ? `Permission mode ${required.permissionMode} satisfies the capability packs`
        : "Allowed permission modes cannot satisfy the capability packs",
    },
    {
      kind: "workspace",
      passed: agent.company_id === need.company_id,
      reason:
        agent.company_id === need.company_id
          ? `Agent is inside the ${need.company_id ? "company" : "standalone"} workspace boundary`
          : "Agent belongs to another workspace boundary",
    },
    {
      kind: "independence",
      passed: !need.independent_from_agent_ids.includes(agent.id),
      reason: need.independent_from_agent_ids.includes(agent.id)
        ? "Agent conflicts with the persisted independence boundary"
        : "Agent satisfies the persisted independence boundary",
    },
  ]
  return {
    eligible: results.every((result) => result.passed),
    permissionMode: required.permissionMode,
    results,
  }
}

export function compatibleRuntimeForNeed(need: CapabilityNeed) {
  const required = requirements(need)
  if (!required.permissionMode) return undefined
  if (required.tools.some((tool) => !required.availableTools.has(tool))) return undefined
  return RuntimeID.options.find((runtime) =>
    required.capabilities.every((capability) => RuntimeCapabilityMatrix[runtime][capability]),
  )
}

export function permissionModeForNeed(need: CapabilityNeed) {
  return requirements(need).permissionMode
}

// TEAM-04: selection is a two-stage rule layer. Hard constraints (independence,
// runtime/tool compatibility, verifiable capability) gate eligibility before any
// soft score is compared, so a high score can never buy back a missing hard
// requirement. Everything here is pure and deterministic for the same snapshot.

export type EvidenceFact = {
  capability_pack: string
  status: "declared" | "verified" | "expired"
  available: boolean
}

export type CandidateFacts = {
  agent_id: string
  lifecycle: "candidate" | "assigned" | "employee" | "archived"
  excluded: boolean
  compatibility: { compatible: boolean; reasons: string[] }
  capability_match: number
  evidence: EvidenceFact[]
  required_packs: string[]
  risk_level: "low" | "medium" | "high"
  state: { active: number; quality: number; reliability: number; cost: number; speed: number }
}

// Best-available evidence per required pack: verified beats declared beats
// expired; unavailable evidence contributes nothing.
const packWeight = (evidence: EvidenceFact[], pack: string) => {
  const usable = evidence.filter((item) => item.capability_pack === pack && item.available)
  if (usable.some((item) => item.status === "verified")) return 100
  if (usable.some((item) => item.status === "declared")) return 60
  if (usable.some((item) => item.status === "expired")) return 30
  return 0
}

export function evidenceStrength(evidence: EvidenceFact[], requiredPacks: string[]) {
  if (!requiredPacks.length) return 0
  return Math.round(requiredPacks.reduce((sum, pack) => sum + packWeight(evidence, pack), 0) / requiredPacks.length)
}

// Hard constraints: violating any of these makes the candidate ineligible
// regardless of score. Each gap is a factual, user-visible sentence.
export function hardGaps(facts: CandidateFacts) {
  const gaps: string[] = []
  if (facts.excluded) gaps.push("与当前任务的独立执行或复核约束冲突")
  if (!facts.compatibility.compatible) gaps.push(...facts.compatibility.reasons)
  if (facts.capability_match === 0 && !facts.evidence.some((item) => item.available))
    gaps.push("对所需能力包既无可用能力证据，也无可验证的画像匹配")
  return gaps
}

export function selectionScore(facts: CandidateFacts) {
  const strength = evidenceStrength(facts.evidence, facts.required_packs)
  const availability = Math.max(0, 100 - facts.state.active * 35)
  const riskFit =
    facts.risk_level === "high"
      ? facts.lifecycle === "employee"
        ? 100
        : facts.state.quality >= 80 && facts.state.reliability >= 80
          ? 80
          : 40
      : 80
  return SelectionScore.parse({
    capability_match: facts.capability_match,
    evidence_strength: strength,
    availability,
    historical_quality: facts.state.quality,
    historical_reliability: facts.state.reliability,
    cost_efficiency: facts.state.cost,
    speed: facts.state.speed,
    risk_fit: riskFit,
    reuse_value: facts.lifecycle === "candidate" ? 100 : facts.lifecycle === "employee" ? 70 : 40,
    total:
      facts.capability_match * 30 +
      Math.round(strength / 2) +
      availability +
      Math.round(facts.state.quality / 3) +
      Math.round(facts.state.reliability / 4) +
      Math.round(facts.state.cost / 10) +
      Math.round(facts.state.speed / 10) +
      Math.round(riskFit / 5) +
      (facts.lifecycle === "candidate" ? 20 : facts.lifecycle === "employee" ? 10 : 0),
  })
}

// Deterministic total order: same input snapshot always yields the same
// ranking. Ties fall through evidence, capability, load and finally agent ID.
export const compareCandidates = (
  left: { agent_id: string; score: SelectionScore },
  right: { agent_id: string; score: SelectionScore },
) =>
  right.score.total - left.score.total ||
  right.score.evidence_strength - left.score.evidence_strength ||
  right.score.capability_match - left.score.capability_match ||
  right.score.availability - left.score.availability ||
  left.agent_id.localeCompare(right.agent_id)

export const verifiedPacks = (facts: CandidateFacts) =>
  facts.required_packs.filter((pack) =>
    facts.evidence.some((item) => item.capability_pack === pack && item.available && item.status === "verified"),
  )

// Known gaps recorded for the winner: required packs whose evidence is not yet
// verified stay visible instead of being silently absorbed by the score.
export const unverifiedRequiredPacks = (facts: CandidateFacts) =>
  facts.required_packs.filter(
    (pack) =>
      !facts.evidence.some((item) => item.capability_pack === pack && item.available && item.status === "verified"),
  )

// Factual dimension deficits for eligible-but-not-chosen candidates, so a
// rejection is never just an opaque string-match score.
export function softGaps(item: { score: SelectionScore }, chosen: { score: SelectionScore }) {
  const gaps: string[] = []
  if (item.score.evidence_strength < chosen.score.evidence_strength)
    gaps.push(`能力证据强度 ${item.score.evidence_strength} 低于入选者 ${chosen.score.evidence_strength}`)
  if (item.score.capability_match < chosen.score.capability_match)
    gaps.push(`能力匹配 ${item.score.capability_match} 项低于入选者 ${chosen.score.capability_match} 项`)
  if (item.score.availability < chosen.score.availability)
    gaps.push(`当前负载可用性 ${item.score.availability} 低于入选者 ${chosen.score.availability}`)
  if (item.score.historical_quality < chosen.score.historical_quality)
    gaps.push(`历史质量 ${item.score.historical_quality} 低于入选者 ${chosen.score.historical_quality}`)
  return gaps
}
