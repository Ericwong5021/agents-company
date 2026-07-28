import { describe, expect, test } from "bun:test"
import {
  compareCandidates,
  evidenceStrength,
  hardGaps,
  selectionScore,
  softGaps,
  unverifiedRequiredPacks,
  type CandidateFacts,
} from "../../src/company-recruitment/selection-policy"

const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  agent_id: "agent-a",
  lifecycle: "candidate",
  excluded: false,
  compatibility: { compatible: true, reasons: [] },
  capability_match: 2,
  evidence: [],
  required_packs: ["software-implementation@1"],
  risk_level: "medium",
  state: { active: 0, quality: 50, reliability: 50, cost: 50, speed: 50 },
  ...over,
})

describe("selection policy", () => {
  test("weights evidence by best available status per required pack", () => {
    const packs = ["a@1", "b@1"]
    expect(evidenceStrength([], packs)).toBe(0)
    expect(evidenceStrength([{ capability_pack: "a@1", status: "verified", available: true }], packs)).toBe(50)
    expect(
      evidenceStrength(
        [
          { capability_pack: "a@1", status: "verified", available: true },
          { capability_pack: "b@1", status: "declared", available: true },
        ],
        packs,
      ),
    ).toBe(80)
    expect(evidenceStrength([{ capability_pack: "a@1", status: "expired", available: true }], ["a@1"])).toBe(30)
    // Unavailable evidence (retired pack / incompatible runtime) contributes nothing.
    expect(evidenceStrength([{ capability_pack: "a@1", status: "verified", available: false }], ["a@1"])).toBe(0)
    // Verified beats a coexisting expired record for the same pack.
    expect(
      evidenceStrength(
        [
          { capability_pack: "a@1", status: "expired", available: true },
          { capability_pack: "a@1", status: "verified", available: true },
        ],
        ["a@1"],
      ),
    ).toBe(100)
  })

  test("hard constraints are independent of score and cover exclusion, runtime and capability", () => {
    expect(hardGaps(facts())).toEqual([])
    expect(hardGaps(facts({ excluded: true }))).toEqual(["与当前任务的独立执行或复核约束冲突"])
    expect(
      hardGaps(facts({ compatibility: { compatible: false, reasons: ["Runtime pi 缺少能力：workspaceWrite"] } })),
    ).toEqual(["Runtime pi 缺少能力：workspaceWrite"])
    expect(hardGaps(facts({ capability_match: 0 }))).toEqual(["对所需能力包既无可用能力证据，也无可验证的画像匹配"])
    // Available evidence substitutes for profile term matching: rejection is no
    // longer decided by string overlap alone.
    expect(
      hardGaps(
        facts({
          capability_match: 0,
          evidence: [{ capability_pack: "software-implementation@1", status: "verified", available: true }],
        }),
      ),
    ).toEqual([])
    // A single candidate can violate several hard constraints at once.
    expect(
      hardGaps(
        facts({
          excluded: true,
          capability_match: 0,
          compatibility: { compatible: false, reasons: ["未知 Runtime：legacy-cli"] },
        }),
      ),
    ).toHaveLength(3)
  })

  test("verified evidence raises the score and unverified required packs stay visible as gaps", () => {
    const withEvidence = selectionScore(
      facts({ evidence: [{ capability_pack: "software-implementation@1", status: "verified", available: true }] }),
    )
    const withoutEvidence = selectionScore(facts())
    expect(withEvidence.evidence_strength).toBe(100)
    expect(withoutEvidence.evidence_strength).toBe(0)
    expect(withEvidence.total - withoutEvidence.total).toBe(50)
    expect(unverifiedRequiredPacks(facts())).toEqual(["software-implementation@1"])
    expect(
      unverifiedRequiredPacks(
        facts({ evidence: [{ capability_pack: "software-implementation@1", status: "verified", available: true }] }),
      ),
    ).toEqual([])
  })

  test("ranking is deterministic across input permutations and ties fall back to stable rules", () => {
    const candidates = [
      { agent_id: "c-agent", score: selectionScore(facts({ agent_id: "c-agent" })) },
      { agent_id: "a-agent", score: selectionScore(facts({ agent_id: "a-agent" })) },
      {
        agent_id: "b-agent",
        score: selectionScore(
          facts({
            agent_id: "b-agent",
            evidence: [{ capability_pack: "software-implementation@1", status: "verified", available: true }],
          }),
        ),
      },
      { agent_id: "d-agent", score: selectionScore(facts({ agent_id: "d-agent", state: { active: 1, quality: 50, reliability: 50, cost: 50, speed: 50 } })) },
    ]
    const expected = ["b-agent", "a-agent", "c-agent", "d-agent"]
    const permutations = [
      candidates,
      [...candidates].reverse(),
      [candidates[2]!, candidates[0]!, candidates[3]!, candidates[1]!],
    ]
    for (const permutation of permutations) {
      expect(permutation.toSorted(compareCandidates).map((item) => item.agent_id)).toEqual(expected)
    }
  })

  test("soft gaps describe factual dimension deficits against the chosen candidate", () => {
    const chosen = {
      score: selectionScore(
        facts({ evidence: [{ capability_pack: "software-implementation@1", status: "verified", available: true }] }),
      ),
    }
    const loser = {
      score: selectionScore(
        facts({ capability_match: 1, state: { active: 2, quality: 30, reliability: 50, cost: 50, speed: 50 } }),
      ),
    }
    const gaps = softGaps(loser, chosen)
    expect(gaps).toContain("能力证据强度 0 低于入选者 100")
    expect(gaps).toContain("能力匹配 1 项低于入选者 2 项")
    expect(gaps).toContain("当前负载可用性 30 低于入选者 100")
    expect(gaps).toContain("历史质量 30 低于入选者 50")
    expect(softGaps(chosen, chosen)).toEqual([])
  })
})
