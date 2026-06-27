import { describe, expect, test } from "bun:test"
import {
  arbitrate,
  markSpoke,
  decayRights,
  settleAfterSpeak,
  initialRights,
  pickFallbackSpeaker,
} from "../../../src/group-session/scheduler/scoring"
import { DEFAULT_CONFIG } from "../../../src/group-session/scheduler/scheduler.config"
import type { Bid, RightsState } from "../../../src/group-session/scheduler/bidding.types"

const passBid: Bid = { level: "pass", type: "info", addressedAs: "none", reason: "" }
const mustBid: Bid = { level: "must", type: "objection", addressedAs: "direct", reason: "disagree" }
const wantBid: Bid = { level: "want", type: "answer", addressedAs: "mention", reason: "can answer" }
const couldBid: Bid = { level: "could", type: "info", addressedAs: "none", reason: "context" }

describe("scoring — initialRights", () => {
  test("returns zero cooldown and zero idleRounds", () => {
    const r = initialRights()
    expect(r.cooldown).toBe(0)
    expect(r.idleRounds).toBe(0)
  })
})

describe("scoring — markSpoke", () => {
  test("sets cooldown to config.cooldownInitial and resets idleRounds", () => {
    const r = markSpoke(DEFAULT_CONFIG)
    expect(r.cooldown).toBe(DEFAULT_CONFIG.cooldownInitial)
    expect(r.idleRounds).toBe(0)
  })
})

describe("scoring — decayRights", () => {
  test("reduces cooldown by cooldownRecoverPerRound", () => {
    const r: RightsState = { cooldown: 50, idleRounds: 3 }
    const d = decayRights(r, DEFAULT_CONFIG)
    expect(d.cooldown).toBe(50 - DEFAULT_CONFIG.cooldownRecoverPerRound)
  })

  test("does not let cooldown go negative", () => {
    const r: RightsState = { cooldown: 5, idleRounds: 3 }
    const d = decayRights(r, DEFAULT_CONFIG)
    expect(d.cooldown).toBe(0)
  })

  test("increments idleRounds", () => {
    const r: RightsState = { cooldown: 50, idleRounds: 3 }
    const d = decayRights(r, DEFAULT_CONFIG)
    expect(d.idleRounds).toBe(4)
  })
})

describe("scoring — settleAfterSpeak", () => {
  test("speaker gets markSpoke, others get decayRights", () => {
    const rights: Record<string, RightsState> = {
      a: { cooldown: 20, idleRounds: 2 },
      b: { cooldown: 50, idleRounds: 0 },
      c: { cooldown: 0, idleRounds: 5 },
    }
    const result = settleAfterSpeak(rights, "b", DEFAULT_CONFIG)
    expect(result.b.cooldown).toBe(DEFAULT_CONFIG.cooldownInitial)
    expect(result.b.idleRounds).toBe(0)
    expect(result.a.cooldown).toBe(20 - DEFAULT_CONFIG.cooldownRecoverPerRound)
    expect(result.a.idleRounds).toBe(3)
    expect(result.c.cooldown).toBe(0)
    expect(result.c.idleRounds).toBe(6)
  })
})

describe("scoring — arbitrate", () => {
  test("returns winner with highest score among eligible bids", () => {
    const entries = [
      { agentId: "a", bid: wantBid, rights: initialRights() },
      { agentId: "b", bid: mustBid, rights: initialRights() },
      { agentId: "c", bid: passBid, rights: initialRights() },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBe("b")
    expect(result.scored).toHaveLength(3)
  })

  test("pass bids are not eligible", () => {
    const entries = [
      { agentId: "a", bid: passBid, rights: initialRights() },
      { agentId: "b", bid: passBid, rights: initialRights() },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBeNull()
    expect(result.idleReason).toBe("all_pass")
  })

  test("idleReason is none_over_threshold when some bid but none eligible", () => {
    const entries = [
      { agentId: "a", bid: passBid, rights: initialRights() },
      { agentId: "b", bid: couldBid, rights: initialRights() },
    ]
    const result = arbitrate(entries, { ...DEFAULT_CONFIG, tau: 1000 })
    expect(result.winnerId).toBeNull()
    expect(result.idleReason).toBe("none_over_threshold")
  })

  test("eligible bids sort before ineligible ones", () => {
    const entries = [
      { agentId: "a", bid: passBid, rights: initialRights() },
      { agentId: "b", bid: mustBid, rights: initialRights() },
    ]
    const result = arbitrate(entries)
    expect(result.scored[0].agentId).toBe("b")
    expect(result.scored[0].eligible).toBe(true)
    expect(result.scored[1].agentId).toBe("a")
    expect(result.scored[1].eligible).toBe(false)
  })

  test("cooldown penalty lowers score", () => {
    const entries = [
      { agentId: "fresh", bid: wantBid, rights: { cooldown: 0, idleRounds: 0 } },
      { agentId: "cooling", bid: wantBid, rights: { cooldown: 50, idleRounds: 0 } },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBe("fresh")
  })

  test("staleness bonus raises score for idle agents", () => {
    const entries = [
      { agentId: "recent", bid: wantBid, rights: { cooldown: 0, idleRounds: 0 } },
      { agentId: "idle", bid: wantBid, rights: { cooldown: 0, idleRounds: 6 } },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBe("idle")
  })

  test("addressedAs direct beats none with same bid level", () => {
    const directBid: Bid = { level: "want", type: "answer", addressedAs: "direct", reason: "" }
    const noneBid: Bid = { level: "want", type: "answer", addressedAs: "none", reason: "" }
    const entries = [
      { agentId: "none", bid: noneBid, rights: initialRights() },
      { agentId: "direct", bid: directBid, rights: initialRights() },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBe("direct")
  })

  test("tie-breaker prefers higher idleRounds", () => {
    const bidA: Bid = { level: "want", type: "answer", addressedAs: "none", reason: "" }
    const bidB: Bid = { level: "want", type: "answer", addressedAs: "none", reason: "" }
    const entries = [
      { agentId: "a", bid: bidA, rights: { cooldown: 0, idleRounds: 1 } },
      { agentId: "b", bid: bidB, rights: { cooldown: 0, idleRounds: 5 } },
    ]
    const result = arbitrate(entries)
    expect(result.winnerId).toBe("b")
  })
})

describe("scoring — pickFallbackSpeaker", () => {
  test("picks the member with highest idleRounds - cooldown", () => {
    const rights: Record<string, RightsState> = {
      a: { cooldown: 0, idleRounds: 1 },
      b: { cooldown: 10, idleRounds: 5 },
      c: { cooldown: 0, idleRounds: 3 },
    }
    const result = pickFallbackSpeaker(["a", "b", "c"], rights)
    expect(result).toBe("c")
  })

  test("with single member returns that member", () => {
    const rights: Record<string, RightsState> = {
      only: { cooldown: 0, idleRounds: 0 },
    }
    const result = pickFallbackSpeaker(["only"], rights)
    expect(result).toBe("only")
  })
})
