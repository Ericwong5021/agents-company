import { describe, expect, test } from "bun:test"
import type {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import {
  assignmentsForAgent,
  diagnosticsCount,
  discoverySignalCount,
  graphOperationTotal,
  receiptIDs,
  sourceRefLabel,
} from "../modules/agent-company/runtime/shared/seed-grow-view"

const organization = {
  availability: "available",
  assignments: [
    { availability: "available", assignmentId: "a1", agent: { id: "agent-1" } },
    { availability: "available", assignmentId: "a2", agent: { id: "agent-2" } },
    { availability: "unavailable", assignmentId: "a3" },
  ],
} as unknown as OrganizationProjection

const graph = {
  availability: "available",
  changes: [
    {
      triggerReceiptId: "r1",
      operationCounts: {
        addedWorkItems: 2,
        addedDependencies: 1,
        removedDependencies: 0,
        supersededWorkItems: 0,
        addedValidationGates: 1,
        requestedCapabilities: 0,
        requestedUserDecisions: 0,
      },
    },
    {
      triggerReceiptId: "r1",
      operationCounts: {
        addedWorkItems: 0,
        addedDependencies: 0,
        removedDependencies: 0,
        supersededWorkItems: 0,
        addedValidationGates: 0,
        requestedCapabilities: 0,
        requestedUserDecisions: 0,
      },
    },
  ],
} as unknown as GraphChangeSummary

describe("seed grow experience view", () => {
  test("按 Agent 汇总真实可用 Assignment", () => {
    expect(assignmentsForAgent([organization], "agent-1").map((item) => item.assignmentId)).toEqual(["a1"])
  })

  test("Receipt 去重并保留首次出现顺序", () => {
    expect(receiptIDs(graph)).toEqual(["r1"])
  })

  test("Graph operation 数量使用确定性字段求和", () => {
    if (graph.availability !== "available") throw new Error("Expected graph")
    expect(graphOperationTotal(graph.changes[0]!)).toBe(4)
  })

  test("Discovery signal 覆盖所有结构化事实类别", () => {
    expect(
      discoverySignalCount({
        availability: "available",
        confirmedFacts: ["a"],
        invalidatedAssumptions: ["b"],
        unknowns: ["c"],
        blockers: ["d"],
        capabilityGaps: ["e"],
        questions: ["f"],
      } as unknown as DiscoverySummary),
    ).toBe(6)
  })

  test("不可用投影进入诊断计数而不是零结果", () => {
    expect(
      diagnosticsCount(
        { availability: "unavailable" } as GraphChangeSummary,
        { availability: "unavailable" } as ValidationSummary,
      ),
    ).toBe(2)
  })

  test("证据来源标签保持事实 ID", () => {
    expect(sourceRefLabel({ kind: "work_receipt", id: "receipt-1" })).toBe("Receipt · receipt-1")
  })
})
