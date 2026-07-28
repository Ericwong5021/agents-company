import { describe, expect, test } from "bun:test"
import type { DeliverySummary, GoalBriefAcceptanceCriterion } from "@agents-company/shared/experience"
import {
  acceptanceChecklist,
  acceptanceStateLabels,
  deliveryPackageView,
  deliveryStage,
  hasConsumableOutput,
} from "../modules/agent-company/runtime/shared/delivery-package"

const delivery = (overrides: Partial<DeliverySummary>) =>
  ({
    id: "d1",
    workId: "w1",
    version: 2,
    acceptanceState: "pending",
    artifacts: [{ id: "a1" }],
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  }) as unknown as DeliverySummary

describe("deliveryStage", () => {
  test("maps acceptance state to lifecycle stage", () => {
    expect(deliveryStage("pending")).toBe("delivered")
    expect(deliveryStage("accepted")).toBe("accepted")
    expect(deliveryStage("revision_requested")).toBe("revision")
  })
})

test("acceptanceStateLabels cover all states", () => {
  expect(acceptanceStateLabels.pending).toBe("待验收")
  expect(acceptanceStateLabels.accepted).toBe("已验收")
  expect(acceptanceStateLabels.revision_requested).toBe("已请求修改")
})

test("hasConsumableOutput requires at least one artifact", () => {
  expect(hasConsumableOutput({ artifacts: [] as unknown as DeliverySummary["artifacts"] })).toBe(false)
  expect(hasConsumableOutput({ artifacts: [{ id: "a1" }] as unknown as DeliverySummary["artifacts"] })).toBe(true)
})

describe("acceptanceChecklist", () => {
  test("keeps criteria unverified until backend sends per-item verdicts", () => {
    const criteria = [
      { id: "c1", description: "d1", verification: "v1" },
      { id: "c2", description: "d2", verification: "v2" },
    ] as unknown as GoalBriefAcceptanceCriterion[]
    const checklist = acceptanceChecklist(criteria)
    expect(checklist).toHaveLength(2)
    expect(checklist.every((item) => item.verdict === "unverified")).toBe(true)
    expect(checklist[0]?.description).toBe("d1")
  })
})

describe("deliveryPackageView", () => {
  test("delivered state awaits user decision", () => {
    const view = deliveryPackageView(delivery({ acceptanceState: "pending" }))
    expect(view.stage).toBe("delivered")
    expect(view.stateLabel).toBe("待验收")
    expect(view.awaitingUserDecision).toBe(true)
    expect(view.hasOutput).toBe(true)
    expect(view.artifactCount).toBe(1)
  })

  test("accepted state no longer awaits decision", () => {
    const view = deliveryPackageView(delivery({ acceptanceState: "accepted" }))
    expect(view.stage).toBe("accepted")
    expect(view.awaitingUserDecision).toBe(false)
  })
})
