import z from "zod"
import {
  FirstSliceCandidate,
  ProjectExecutionStrategy,
  SeedMode,
  SeedPolicyFacts,
} from "@agents-company/shared/project-orchestration"

export { FirstSliceCandidate, ProjectExecutionStrategy, SeedMode, SeedPolicyFacts }
export type {
  FirstSliceCandidate as FirstSliceCandidateValue,
  ProjectExecutionStrategy as ProjectExecutionStrategyValue,
  SeedMode as SeedModeValue,
  SeedPolicyFacts as SeedPolicyFactsValue,
} from "@agents-company/shared/project-orchestration"

export const SeedPolicyVerdict = z
  .object({
    mode: SeedMode,
    reason_codes: z.array(
      z.enum([
        "high_risk",
        "external_side_effect",
        "blocking_unknowns",
        "unapproved_scope",
        "simple_reversible_sop",
        "unfamiliar_workspace",
        "cross_module",
        "complex_or_ambiguous",
      ]),
    ),
    first_slice: FirstSliceCandidate,
  })
  .strict()
export type SeedPolicyVerdict = z.infer<typeof SeedPolicyVerdict>

export const WayfinderDependencyProposal = z
  .object({
    work_item_id: z.string().trim().min(1),
    depends_on_id: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(8_000),
  })
  .strict()

export const WayfinderReceipt = z
  .object({
    summary: z.string().trim().min(1).max(8_000),
    confirmed_facts: z.array(z.string().trim().min(1)).min(1).max(500),
    invalidated_assumptions: z.array(z.string().trim().min(1)).max(500),
    unknowns: z.array(z.string().trim().min(1)).max(500),
    blockers: z.array(z.string().trim().min(1)).max(500),
    capability_gaps: z.array(z.string().trim().min(1)).max(500),
    recommended_first_slice: FirstSliceCandidate,
    dependency_proposals: z.array(WayfinderDependencyProposal).max(500),
    questions: z.array(z.string().trim().min(1)).max(500),
  })
  .strict()
export type WayfinderReceipt = z.infer<typeof WayfinderReceipt>
