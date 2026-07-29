import { CapabilityCatalog } from "@/capability"
import type { CompanyAgent } from "@/company-agent"
import {
  RuntimeCapabilityMatrix,
  RuntimeID,
  type RuntimePermissionMode,
} from "@/runtime"
import type { CapabilityNeed, TeamSelection } from "./schema"

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
      passed: required.missingPacks.length === 0 && missingTools.length === 0,
      reason: required.missingPacks.length
        ? `Unknown capability packs: ${required.missingPacks.join(", ")}`
        : missingTools.length
          ? `Required tools are unavailable: ${missingTools.join(", ")}`
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
  if (required.missingPacks.length || !required.permissionMode) return undefined
  if (required.tools.some((tool) => !required.availableTools.has(tool))) return undefined
  return RuntimeID.options.find((runtime) =>
    required.capabilities.every((capability) => RuntimeCapabilityMatrix[runtime][capability]),
  )
}

export function permissionModeForNeed(need: CapabilityNeed) {
  return requirements(need).permissionMode
}
