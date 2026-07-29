import { CapabilityCatalog } from "@/capability/catalog"
import { missingRuntimeCapabilities } from "@/runtime/capability-matrix"
import { RuntimeID, type RuntimeCapabilities } from "@/runtime/interface"

// Verified evidence decays back to "expired" when the latest success is older
// than this window, so stale wins never read as current capability (TEAM-02).
export const CAPABILITY_VERIFICATION_TTL_MS = 30 * 24 * 60 * 60_000

export type CapabilityEvidenceFacts = {
  capability_pack: string
  declared_at: number
  last_verified_at?: number
  last_success_selection_id?: string
  failure_count: number
  last_failure_at?: number
}

export function evidenceStatus(facts: CapabilityEvidenceFacts, now: number) {
  if (!facts.last_verified_at) return "declared" as const
  if (now - facts.last_verified_at > CAPABILITY_VERIFICATION_TTL_MS) return "expired" as const
  return "verified" as const
}

// Resolves a pack reference without throwing so retired/unknown packs read as
// unavailable evidence instead of crashing projections.
function resolvePack(reference: string) {
  try {
    return CapabilityCatalog.resolve(reference)
  } catch {
    return undefined
  }
}

// Selection-time hard gate: only packs the catalog can resolve contribute
// runtime requirements. Unresolved references stay neutral here — retirement
// of a pack affects evidence availability, not whether an agent may be picked
// for work described with ad-hoc pack names.
export function runtimeCompatibility(preferredRuntime: string, capabilityPacks: string[]) {
  const runtime = RuntimeID.safeParse(preferredRuntime)
  if (!runtime.success)
    return {
      compatible: false,
      missing: [] as Array<keyof RuntimeCapabilities>,
      unresolved: [] as string[],
      reasons: [`未知 Runtime：${preferredRuntime}`],
    }
  const resolved = capabilityPacks.map((reference) => ({ reference, pack: resolvePack(reference) }))
  const unresolved = resolved.filter((item) => !item.pack).map((item) => item.reference)
  const missing = missingRuntimeCapabilities(
    runtime.data,
    resolved.flatMap((item) => item.pack?.requiredRuntimeCapabilities ?? []),
  )
  return {
    compatible: missing.length === 0,
    missing,
    unresolved,
    reasons: missing.length ? [`Runtime ${runtime.data} 缺少能力：${missing.join("、")}`] : [],
  }
}

// A capability is "available" only when its pack still exists in the catalog and
// the agent's preferred runtime satisfies the pack requirements; evidence status
// (declared/verified/expired) stays orthogonal to availability.
export function capabilityAvailability(facts: CapabilityEvidenceFacts, preferredRuntime: string) {
  const pack = resolvePack(facts.capability_pack)
  if (!pack) return { available: false, reasons: [`能力包不可用：${facts.capability_pack}`] }
  const compatibility = runtimeCompatibility(preferredRuntime, [facts.capability_pack])
  if (!compatibility.compatible) return { available: false, reasons: compatibility.reasons }
  return { available: true, reasons: [] as string[] }
}

// Maps agent profile facts (responsibilities, skills, role) onto catalog packs to
// seed initial declared capabilities for pre-existing agents (TEAM-02 migration).
export function declaredPacksFromProfile(profile: {
  role_key?: string
  description?: string
  skills?: string[]
  responsibilities?: string[]
}) {
  const corpus = [
    profile.role_key ?? "",
    profile.description ?? "",
    ...(profile.skills ?? []),
    ...(profile.responsibilities ?? []),
  ]
    .join(" ")
    .toLowerCase()
  return CapabilityCatalog.list()
    .filter((pack) => {
      const reference = `${pack.id}@${pack.version}`
      if (corpus.includes(reference)) return true
      if (corpus.includes(pack.id)) return true
      return corpus.includes(pack.role.toLowerCase())
    })
    .map((pack) => `${pack.id}@${pack.version}`)
    .toSorted()
}
