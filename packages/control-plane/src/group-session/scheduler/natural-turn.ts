import type { Bid } from "./bidding.types"

export const MAX_AGENT_TURNS = 6

export function shouldRespond(bid: Bid) {
  return bid.level === "must" || bid.level === "want"
}

export function idleReason(bids: Bid[]) {
  return bids.some((bid) => bid.level === "could") ? "no_bid_over_threshold" as const : "all_pass" as const
}

export function pickFallbackAgent(
  memberIDs: string[],
  decisions: Array<{ agentId: string; bid: Bid }>,
  lastSpeakerID?: string,
) {
  const addressed = decisions.find((decision) => decision.bid.addressedAs === "direct")
    ?? decisions.find((decision) => decision.bid.addressedAs === "mention")
  if (addressed) return addressed.agentId
  return memberIDs.find((agentID) => agentID !== lastSpeakerID) ?? memberIDs[0]
}

export function canPublish(input: { agentID: string; lastSpeakerID?: string; publishedTurns: number }) {
  return input.publishedTurns < MAX_AGENT_TURNS && input.agentID !== input.lastSpeakerID
}
