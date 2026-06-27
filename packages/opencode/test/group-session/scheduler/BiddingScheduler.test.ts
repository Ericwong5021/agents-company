import { describe, expect, test } from "bun:test"
import { BiddingScheduler } from "../../../src/group-session/scheduler/BiddingScheduler"
import { DEFAULT_CONFIG } from "../../../src/group-session/scheduler/scheduler.config"
import type { Bid } from "../../../src/group-session/scheduler/bidding.types"

const passBid: Bid = { level: "pass", type: "info", addressedAs: "none", reason: "" }
const mustBid: Bid = { level: "must", type: "objection", addressedAs: "direct", reason: "disagree" }
const wantBid: Bid = { level: "want", type: "answer", addressedAs: "mention", reason: "can answer" }

describe("BiddingScheduler — construction", () => {
  test("initializes with idle phase and zero rounds", () => {
    const s = new BiddingScheduler("room-1", ["a", "b", "c"])
    expect(s.state.phase).toBe("idle")
    expect(s.state.round).toBe(0)
    expect(s.state.consecutiveAgentTurns).toBe(0)
    expect(s.state.currentSpeaker).toBeUndefined()
    expect(s.memberIds).toEqual(["a", "b", "c"])
    expect(s.isActive).toBe(false)
  })

  test("all members start with initial rights", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    expect(s.state.rights.a).toEqual({ cooldown: 0, idleRounds: 0 })
    expect(s.state.rights.b).toEqual({ cooldown: 0, idleRounds: 0 })
  })
})

describe("BiddingScheduler — decide", () => {
  test("returns winner when a bid is eligible", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    const result = s.decide([
      { agentId: "a", bid: mustBid },
      { agentId: "b", bid: passBid },
    ])
    expect(result.type).toBe("winner")
    expect(result).toHaveProperty("agentId", "a")
    expect(s.state.phase).toBe("speaking")
    expect(s.state.currentSpeaker).toBe("a")
    expect(s.state.round).toBe(1)
  })

  test("returns idle when all pass", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    const result = s.decide([
      { agentId: "a", bid: passBid },
      { agentId: "b", bid: passBid },
    ])
    expect(result.type).toBe("idle")
    expect(result).toHaveProperty("reason", "all_pass")
    expect(s.state.phase).toBe("idle")
    expect(s.state.currentSpeaker).toBeUndefined()
  })

  test("returns idle when no bid meets threshold", () => {
    const s = new BiddingScheduler("room-1", ["a"], {
      ...DEFAULT_CONFIG,
      tau: 1000,
    })
    const result = s.decide([{ agentId: "a", bid: mustBid }])
    expect(result.type).toBe("idle")
    expect(result).toHaveProperty("reason", "none_over_threshold")
  })

  test("increments round on each decide call", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    expect(s.state.round).toBe(1)
    s.afterSpeak("a")
    s.decide([{ agentId: "a", bid: passBid }, { agentId: "b", bid: wantBid }])
    expect(s.state.round).toBe(2)
  })

  test("yields when maxConsecutiveAgentTurns is reached", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"], {
      ...DEFAULT_CONFIG,
      maxConsecutiveAgentTurns: 2,
    })
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    s.afterSpeak("a")
    s.decide([{ agentId: "b", bid: mustBid }, { agentId: "a", bid: passBid }])
    s.afterSpeak("b")
    const result = s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: mustBid }])
    expect(result.type).toBe("yielded")
    expect(result).toHaveProperty("reason", "budget_K_reached")
    expect(s.state.phase).toBe("idle")
  })

  test("stores lastArbitration after decide", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    expect(s.lastArbitration).not.toBeNull()
    expect(s.lastArbitration!.winnerId).toBe("a")
  })
})

describe("BiddingScheduler — afterSpeak", () => {
  test("speaker gets cooldown, others decay", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: wantBid }])
    s.afterSpeak("a")
    expect(s.state.rights.a.cooldown).toBe(DEFAULT_CONFIG.cooldownInitial)
    expect(s.state.rights.a.idleRounds).toBe(0)
    expect(s.state.rights.b.cooldown).toBe(0)
    expect(s.state.rights.b.idleRounds).toBe(1)
    expect(s.state.consecutiveAgentTurns).toBe(1)
    expect(s.state.phase).toBe("bidding")
    expect(s.state.currentSpeaker).toBeUndefined()
  })
})

describe("BiddingScheduler — decideFallback", () => {
  test("picks the most overdue member", () => {
    const s = new BiddingScheduler("room-1", ["a", "b", "c"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }, { agentId: "c", bid: passBid }])
    s.afterSpeak("a")
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }, { agentId: "c", bid: passBid }])
    s.afterSpeak("a")
    const result = s.decideFallback()
    expect(result.type).toBe("human_fallback")
    expect(["b", "c"]).toContain(result.agentId)
    expect(s.state.currentSpeaker).toBe(result.agentId)
    expect(s.state.phase).toBe("speaking")
  })
})

describe("BiddingScheduler — reset methods", () => {
  test("resetConsecutiveTurns zeros the counter", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    s.afterSpeak("a")
    expect(s.state.consecutiveAgentTurns).toBe(1)
    s.resetConsecutiveTurns()
    expect(s.state.consecutiveAgentTurns).toBe(0)
  })

  test("resetForUserInput resets everything to initial state", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    s.afterSpeak("a")
    s.resetForUserInput()
    expect(s.state.consecutiveAgentTurns).toBe(0)
    expect(s.state.currentSpeaker).toBeUndefined()
    expect(s.state.phase).toBe("idle")
    expect(s.state.round).toBe(0)
  })

  test("startNewUserTurn resets counters but keeps rights", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"])
    s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: passBid }])
    s.afterSpeak("a")
    expect(s.state.rights.a.cooldown).toBe(DEFAULT_CONFIG.cooldownInitial)
    s.startNewUserTurn()
    expect(s.state.consecutiveAgentTurns).toBe(0)
    expect(s.state.round).toBe(0)
    expect(s.state.phase).toBe("idle")
    expect(s.state.rights.a.cooldown).toBe(DEFAULT_CONFIG.cooldownInitial)
  })
})

describe("BiddingScheduler — multi-round scenario", () => {
  test("full cycle: decide → speak → decide → yield", () => {
    const s = new BiddingScheduler("room-1", ["a", "b"], {
      ...DEFAULT_CONFIG,
      maxConsecutiveAgentTurns: 2,
    })

    const r1 = s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: wantBid }])
    expect(r1.type).toBe("winner")
    s.afterSpeak("a")

    const r2 = s.decide([{ agentId: "a", bid: wantBid }, { agentId: "b", bid: mustBid }])
    expect(r2.type).toBe("winner")
    expect(r2).toHaveProperty("agentId", "b")
    s.afterSpeak("b")

    const r3 = s.decide([{ agentId: "a", bid: mustBid }, { agentId: "b", bid: mustBid }])
    expect(r3.type).toBe("yielded")
    expect(s.isActive).toBe(false)
  })
})
