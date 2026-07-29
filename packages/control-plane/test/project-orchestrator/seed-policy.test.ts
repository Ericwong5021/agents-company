import { describe, expect, test } from "bun:test"
import { evaluateSeedPolicy, selectFirstSlice } from "../../src/project-orchestrator/seed-policy"
import type { SeedPolicyFactsValue } from "../../src/project-orchestrator/schema"

const candidate = (
  id: string,
  overrides: Partial<SeedPolicyFactsValue["slice_candidates"][number]> = {},
): SeedPolicyFactsValue["slice_candidates"][number] => ({
  id,
  title: `First Slice ${id}`,
  description: `验证 ${id}`,
  work_type: "analysis",
  role: "evidence analyst",
  capability_packs: ["research-analysis@1"],
  decision_scope: ["证据含义"],
  resource_scope: ["artifacts"],
  acceptance_criteria: ["结论可由证据复核"],
  reality_contact: 2,
  information_gain: 2,
  user_value: 2,
  reversible: true,
  dependency_count: 0,
  reality_anchor: "本地运行时",
  within_authorized_scope: true,
  external_side_effect: false,
  ...overrides,
})

const facts = (overrides: Partial<SeedPolicyFactsValue> = {}): SeedPolicyFactsValue => ({
  risk_level: "medium",
  scope_defined: true,
  reversible: true,
  stable_sop: false,
  unfamiliar_workspace: false,
  cross_module: false,
  external_side_effect: false,
  blocking_unknowns: [],
  slice_candidates: [candidate("default")],
  ...overrides,
})

describe("Seed Policy", () => {
  test("selects direct_single only for a low-risk reversible stable SOP", () => {
    expect(
      evaluateSeedPolicy(
        facts({
          risk_level: "low",
          stable_sop: true,
        }),
      ),
    ).toMatchObject({
      mode: "direct_single",
      reason_codes: ["simple_reversible_sop"],
    })
  })

  test("selects seed_pair for unfamiliar or cross-module work", () => {
    expect(evaluateSeedPolicy(facts({ unfamiliar_workspace: true, cross_module: true }))).toMatchObject({
      mode: "seed_pair",
      reason_codes: ["unfamiliar_workspace", "cross_module"],
    })
  })

  test("selects discovery_first when any hard boundary is present", () => {
    expect(
      evaluateSeedPolicy(
        facts({
          risk_level: "high",
          external_side_effect: true,
          blocking_unknowns: ["生产凭据未知"],
          slice_candidates: [
            candidate("unsafe", {
              within_authorized_scope: false,
              external_side_effect: true,
            }),
          ],
        }),
      ),
    ).toMatchObject({
      mode: "discovery_first",
      reason_codes: ["high_risk", "external_side_effect", "blocking_unknowns", "unapproved_scope"],
    })
  })

  test("selects the highest-scoring First Slice with a stable id tie break", () => {
    const input = facts({
      slice_candidates: [
        candidate("z-last", { reality_contact: 3 }),
        candidate("a-first", { reality_contact: 3 }),
        candidate("lower", { dependency_count: 2 }),
      ],
    })
    expect(selectFirstSlice(input).id).toBe("a-first")
    expect(evaluateSeedPolicy(input).first_slice.id).toBe("a-first")
  })
})
