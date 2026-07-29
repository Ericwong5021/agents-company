import z from "zod"

export const ProjectExecutionStrategy = z.enum(["legacy_full_plan", "seed_and_grow"])
export type ProjectExecutionStrategy = z.infer<typeof ProjectExecutionStrategy>

export const SeedMode = z.enum(["direct_single", "seed_pair", "discovery_first"])
export type SeedMode = z.infer<typeof SeedMode>

export const SeedWorkType = z.enum(["coding", "decision", "research", "writing", "design", "analysis"])
export type SeedWorkType = z.infer<typeof SeedWorkType>

export const FirstSliceCandidate = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(8_000),
    work_type: SeedWorkType,
    role: z.string().trim().min(1).max(160),
    capability_packs: z.array(z.string().trim().min(1)).max(100).default([]),
    decision_scope: z.array(z.string().trim().min(1)).max(200).default([]),
    resource_scope: z.array(z.string().trim().min(1)).max(200).default([]),
    acceptance_criteria: z.array(z.string().trim().min(1)).min(1).max(200),
    reality_contact: z.number().int().min(0).max(3),
    information_gain: z.number().int().min(0).max(3),
    user_value: z.number().int().min(0).max(3),
    reversible: z.boolean(),
    dependency_count: z.number().int().nonnegative().max(100),
    reality_anchor: z.string().trim().min(1).max(2_000),
    within_authorized_scope: z.boolean(),
    external_side_effect: z.boolean(),
  })
  .strict()
export type FirstSliceCandidate = z.infer<typeof FirstSliceCandidate>

export const SeedPolicyFacts = z
  .object({
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    scope_defined: z.boolean(),
    reversible: z.boolean(),
    stable_sop: z.boolean(),
    unfamiliar_workspace: z.boolean(),
    cross_module: z.boolean(),
    external_side_effect: z.boolean(),
    blocking_unknowns: z.array(z.string().trim().min(1)).max(100),
    slice_candidates: z.array(FirstSliceCandidate).min(1).max(100),
  })
  .strict()
export type SeedPolicyFacts = z.infer<typeof SeedPolicyFacts>
