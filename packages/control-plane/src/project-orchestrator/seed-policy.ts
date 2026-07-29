import { SeedPolicyFacts, type FirstSliceCandidateValue, type SeedPolicyVerdict } from "./schema"

const score = (candidate: FirstSliceCandidateValue) =>
  candidate.reality_contact * 7 +
  candidate.information_gain * 6 +
  candidate.user_value * 5 +
  (candidate.reversible ? 8 : 0) +
  (candidate.reality_anchor ? 5 : 0) -
  candidate.dependency_count * 4

export function selectFirstSlice(input: unknown) {
  const facts = SeedPolicyFacts.parse(input)
  return facts.slice_candidates.toSorted(
    (left, right) => score(right) - score(left) || left.id.localeCompare(right.id),
  )[0]
}

export function evaluateSeedPolicy(input: unknown): SeedPolicyVerdict {
  const facts = SeedPolicyFacts.parse(input)
  const first_slice = selectFirstSlice(facts)
  const reason_codes: SeedPolicyVerdict["reason_codes"] = [
    ...(["high", "critical"].includes(facts.risk_level) ? (["high_risk"] as const) : []),
    ...(facts.external_side_effect || facts.slice_candidates.some((candidate) => candidate.external_side_effect)
      ? (["external_side_effect"] as const)
      : []),
    ...(facts.blocking_unknowns.length ? (["blocking_unknowns"] as const) : []),
    ...(facts.slice_candidates.some((candidate) => !candidate.within_authorized_scope)
      ? (["unapproved_scope"] as const)
      : []),
  ]
  if (reason_codes.length) return { mode: "discovery_first", reason_codes, first_slice }
  if (
    facts.risk_level === "low" &&
    facts.scope_defined &&
    facts.reversible &&
    facts.stable_sop &&
    !facts.unfamiliar_workspace &&
    !facts.cross_module
  )
    return { mode: "direct_single", reason_codes: ["simple_reversible_sop"], first_slice }
  return {
    mode: "seed_pair",
    reason_codes: [
      ...(facts.unfamiliar_workspace ? (["unfamiliar_workspace"] as const) : []),
      ...(facts.cross_module ? (["cross_module"] as const) : []),
      ...(!facts.unfamiliar_workspace && !facts.cross_module ? (["complex_or_ambiguous"] as const) : []),
    ],
    first_slice,
  }
}
