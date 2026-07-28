import { describe, expect, test } from "bun:test"
import { orchestrationPlan, verificationStrengths, type OrchestrationInput } from "../../src/company-project/orchestration"

describe("orchestrationPlan", () => {
  test("low-risk reversible task runs with a single agent and self check", () => {
    const plan = orchestrationPlan({ work_type: "analysis", declared_risk: "low", approval_preset: "balanced" })
    expect(plan).toMatchObject({ risk_level: "low", strength: "self_check", reviewer: false, gate: false })
    expect(plan.reasons.join("")).toContain("自检")
  })

  test("normal task uses structured auto verification without an unconditional reviewer", () => {
    const plan = orchestrationPlan({ work_type: "research", declared_risk: "medium", approval_preset: "balanced" })
    expect(plan).toMatchObject({ risk_level: "medium", strength: "auto_verify", reviewer: false, gate: false })
  })

  test("undeclared risk defaults to medium for non-coding and high for coding", () => {
    expect(orchestrationPlan({ work_type: "writing", approval_preset: "balanced" }).risk_level).toBe("medium")
    expect(orchestrationPlan({ work_type: "coding", approval_preset: "autonomous" }).risk_level).toBe("high")
  })

  test("high-value conclusions get an independent reviewer without a gate", () => {
    const plan = orchestrationPlan({ work_type: "analysis", declared_risk: "high", approval_preset: "balanced" })
    expect(plan).toMatchObject({ risk_level: "high", strength: "independent_review", reviewer: true, gate: false })
  })

  test("high-risk external actions require reviewer plus user gate under non-autonomous presets", () => {
    for (const approval_preset of ["balanced", "strict"]) {
      const plan = orchestrationPlan({ work_type: "coding", declared_risk: "high", approval_preset })
      expect(plan).toMatchObject({ strength: "review_with_gate", reviewer: true, gate: true })
    }
  })

  test("autonomous preset keeps independent review for high-risk coding but drops the gate", () => {
    const plan = orchestrationPlan({ work_type: "coding", declared_risk: "high", approval_preset: "autonomous" })
    expect(plan).toMatchObject({ strength: "independent_review", reviewer: true, gate: false })
  })

  test("mislabeled low-risk coding is raised by the rule-layer floor and cannot bypass review", () => {
    const plan = orchestrationPlan({ work_type: "coding", declared_risk: "low", approval_preset: "balanced" })
    expect(plan).toMatchObject({ risk_level: "high", strength: "review_with_gate", reviewer: true, gate: true })
    expect(plan.reasons.join("")).toContain("规则层提升")
  })

  test("strict preset raises verification strength one level but never lowers it", () => {
    expect(orchestrationPlan({ work_type: "analysis", declared_risk: "low", approval_preset: "strict" }).strength).toBe(
      "auto_verify",
    )
    expect(
      orchestrationPlan({ work_type: "analysis", declared_risk: "medium", approval_preset: "strict" }),
    ).toMatchObject({ strength: "independent_review", reviewer: true })
    expect(
      orchestrationPlan({ work_type: "analysis", declared_risk: "high", approval_preset: "strict" }).strength,
    ).toBe("independent_review")
  })

  test("policy matrix always records reasons and rejected or allowed alternatives", () => {
    const workTypes: OrchestrationInput["work_type"][] = ["coding", "decision", "research", "writing", "design", "analysis"]
    const risks = ["low", "medium", "high"] as const
    for (const work_type of workTypes)
      for (const declared_risk of risks)
        for (const approval_preset of ["autonomous", "balanced", "strict"]) {
          const plan = orchestrationPlan({ work_type, declared_risk, approval_preset })
          expect(plan.reasons.length).toBeGreaterThan(0)
          expect(plan.alternatives).toHaveLength(verificationStrengths.length - 1)
          for (const alternative of plan.alternatives)
            expect(alternative).toMatch(/被规则层拒绝|允许，但/)
          const reviewerRequired = plan.strength === "independent_review" || plan.strength === "review_with_gate"
          expect(plan.reviewer).toBe(reviewerRequired)
          if (plan.risk_level === "high") expect(plan.reviewer).toBe(true)
          if (work_type === "coding") expect(plan.risk_level).toBe("high")
        }
  })
})
