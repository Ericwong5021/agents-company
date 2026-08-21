import { describe, expect, test } from "bun:test"
import { canPublish, idleReason, pickFallbackAgent, shouldRespond } from "../../../src/group-session/scheduler/natural-turn"
import type { Bid } from "../../../src/group-session/scheduler/bidding.types"

const bid = (level: Bid["level"], addressedAs: Bid["addressedAs"] = "none"): Bid => ({
  level,
  type: "answer",
  addressedAs,
  reason: "",
})

describe("natural group turns", () => {
  test("only material or required contributions become replies", () => {
    expect(shouldRespond(bid("must"))).toBe(true)
    expect(shouldRespond(bid("want"))).toBe(true)
    expect(shouldRespond(bid("could"))).toBe(false)
    expect(shouldRespond(bid("pass"))).toBe(false)
  })

  test("directly addressed agents own the human fallback", () => {
    expect(
      pickFallbackAgent(
        ["ceo", "cto", "product"],
        [
          { agentId: "ceo", bid: bid("pass") },
          { agentId: "cto", bid: bid("pass", "direct") },
          { agentId: "product", bid: bid("pass", "mention") },
        ],
      ),
    ).toBe("cto")
  })

  test("fallback avoids an immediate monologue", () => {
    expect(
      pickFallbackAgent(
        ["ceo", "cto"],
        [
          { agentId: "ceo", bid: bid("pass") },
          { agentId: "cto", bid: bid("pass") },
        ],
        "ceo",
      ),
    ).toBe("cto")
  })

  test("publishing stops consecutive self replies and caps a turn", () => {
    expect(canPublish({ agentID: "cto", lastSpeakerID: "ceo", publishedTurns: 5 })).toBe(true)
    expect(canPublish({ agentID: "ceo", lastSpeakerID: "ceo", publishedTurns: 1 })).toBe(false)
    expect(canPublish({ agentID: "cto", lastSpeakerID: "ceo", publishedTurns: 6 })).toBe(false)
  })

  test("non-essential interest stays silent without being treated as a full pass", () => {
    expect(idleReason([bid("pass"), bid("could")])).toBe("no_bid_over_threshold")
    expect(idleReason([bid("pass"), bid("pass")])).toBe("all_pass")
  })
})
