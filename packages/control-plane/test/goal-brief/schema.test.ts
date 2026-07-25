import { describe, expect, test } from "bun:test"
import {
  ExperienceArtifactRef,
  ExperienceArtifactView,
  GoalBrief,
  GoalBriefDraft,
} from "@agents-company/shared/experience"
import { GoalBriefStore } from "../../src/goal-brief"

function draft() {
  return {
    goal: "交付一个可验证的本地产品改进",
    deliverables: [
      {
        id: "delivery-1",
        title: "产品改进",
        description: "实现并验证目标产品改进",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        description: "用户路径可完成",
        verification: "运行自动验收并保留证据",
      },
    ],
    constraints: ["仅修改授权范围"],
    nonGoals: ["不改变无关产品能力"],
    assumptions: [
      {
        id: "assumption-1",
        description: "本地 Control Plane 可用",
        confirmed: true,
      },
    ],
    openQuestions: [],
    riskLevel: "medium" as const,
    recommendedPlan: {
      summary: "先建立契约，再实施并验证",
      steps: [
        {
          id: "step-1",
          title: "实现",
          outcome: "形成可验证实现",
        },
      ],
    },
    approvalMode: "balanced" as const,
    sourceRefs: [{ kind: "user" as const, id: "user-local" }],
  }
}

describe("Goal Brief schema", () => {
  test("accepts the same strict domain shape from structured provider values", () => {
    const openAI = GoalBriefDraft.parse(draft())
    const anthropic = GoalBriefDraft.parse(structuredClone(draft()))

    expect(openAI).toEqual(anthropic)
  })

  test("rejects missing, mistyped, oversized, unknown, and old-version fields", () => {
    expect(GoalBriefDraft.safeParse({ ...draft(), deliverables: undefined }).success).toBe(false)
    expect(GoalBriefDraft.safeParse({ ...draft(), riskLevel: "unknown" }).success).toBe(false)
    expect(GoalBriefDraft.safeParse({ ...draft(), goal: "x".repeat(8_001) }).success).toBe(false)
    expect(GoalBriefDraft.safeParse({ ...draft(), markdown: "**Goal**" }).success).toBe(false)
    expect(
      GoalBrief.safeParse({
        ...draft(),
        id: "brief-1",
        version: 0,
        source: "user_input",
        createdAt: new Date(0).toISOString(),
      }).success,
    ).toBe(false)
  })

  test("rejects plain text, truncated JSON, duplicate fields, and unknown fields from model output", () => {
    expect(() => GoalBriefStore.parseModelOutput("这是一个目标")).toThrow(/valid JSON/)
    expect(() => GoalBriefStore.parseModelOutput('{"goal":"截断"')).toThrow(/valid JSON/)
    expect(() => GoalBriefStore.parseModelOutput(JSON.stringify(draft()).replace("{", '{"goal":"冲突目标",'))).toThrow(
      /duplicate fields/,
    )
    expect(() => GoalBriefStore.parseModelOutput(JSON.stringify({ ...draft(), markdown: "**Goal**" }))).toThrow()
  })

  test("accepts only project-bound read-only Artifact targets without local paths", () => {
    const reference = ExperienceArtifactRef.parse({
      id: "artifact-1",
      projectId: "project-1",
      kind: "product",
      title: "结果.txt",
      href: "/experience/projects/project-1/artifacts/artifact-1",
    })

    expect(
      ExperienceArtifactView.parse({
        ...reference,
        source: "inline",
        mediaType: "text/plain",
        encoding: "utf8",
        presentation: "text",
        content: "可读取成果",
        byteLength: 15,
        createdAt: new Date(0).toISOString(),
      }),
    ).not.toHaveProperty("path")
    expect(
      ExperienceArtifactRef.safeParse({
        ...reference,
        href: "file:///Users/example/secret.txt",
      }).success,
    ).toBe(false)
    expect(
      ExperienceArtifactRef.safeParse({
        ...reference,
        href: "/experience/projects/project-1/artifacts/../secret",
      }).success,
    ).toBe(false)
  })
})
