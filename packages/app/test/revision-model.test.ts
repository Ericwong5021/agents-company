import { describe, expect, test } from "bun:test"
import {
  canTransition,
  hasDisplayableDelta,
  isActionableRevision,
  nextStatesFor,
  revisionOriginLabels,
} from "../modules/agent-company/runtime/shared/revision-model"

test("revisionOriginLabels distinguish user and reviewer origins", () => {
  expect(revisionOriginLabels.user_request_change).toBe("用户请求修改")
  expect(revisionOriginLabels.reviewer_reject).toBe("复核退回")
})

describe("state machine", () => {
  test("delivered can go to revision or accepted only", () => {
    expect(nextStatesFor("delivered")).toEqual(["revision", "accepted"])
    expect(canTransition("delivered", "revision")).toBe(true)
    expect(canTransition("delivered", "reviewing")).toBe(false)
  })

  test("revision → reviewing → delivered chain, accepted is terminal", () => {
    expect(canTransition("revision", "reviewing")).toBe(true)
    expect(canTransition("reviewing", "delivered")).toBe(true)
    expect(nextStatesFor("accepted")).toEqual([])
  })
})

describe("isActionableRevision", () => {
  test("requires a concrete target and a note", () => {
    expect(isActionableRevision({ targetRefs: [], note: "fix" })).toBe(false)
    expect(isActionableRevision({ targetRefs: ["c1"], note: "   " })).toBe(false)
    expect(isActionableRevision({ targetRefs: ["c1"], note: "补充证据" })).toBe(true)
  })
})

describe("hasDisplayableDelta", () => {
  test("needs a version bump and at least one change entry", () => {
    expect(hasDisplayableDelta({ fromVersion: 1, toVersion: 1, resolved: ["x"], remainingLimitations: [], newRisks: [] })).toBe(false)
    expect(hasDisplayableDelta({ fromVersion: 1, toVersion: 2, resolved: [], remainingLimitations: [], newRisks: [] })).toBe(false)
    expect(hasDisplayableDelta({ fromVersion: 1, toVersion: 2, resolved: ["修复A"], remainingLimitations: [], newRisks: [] })).toBe(true)
  })
})
