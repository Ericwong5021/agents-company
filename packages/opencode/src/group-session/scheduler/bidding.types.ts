export type BidLevel = "must" | "want" | "could" | "pass"

export type BidType = "objection" | "answer" | "question" | "claim" | "info" | "support"

export type AddressedAs = "direct" | "mention" | "none"

export interface Bid {
  level: BidLevel
  type: BidType
  addressedAs: AddressedAs
  reason: string
}

export interface RightsState {
  cooldown: number
  idleRounds: number
}

export interface ScoredBid {
  agentId: string
  bid: Bid
  eligible: boolean
  score: number
}

export interface ArbitrationResult {
  scored: ScoredBid[]
  winnerId: string | null
  idleReason?: "all_pass" | "none_over_threshold"
}

export type SchedulerPhase = "idle" | "bidding" | "speaking"

export interface TaskBoardEntry {
  taskId: string
  agentId: string
  title: string
  status: "running" | "completed" | "abandoned"
}

export interface SchedulerState {
  channelId: string
  consecutiveAgentTurns: number
  currentSpeaker?: string
  phase: SchedulerPhase
  rights: Record<string, RightsState>
  round: number
  taskBoard: TaskBoardEntry[]
}

export type BiddingEvent =
  | { type: "bidding.opened"; round: number; eligibleAgentIds: string[] }
  | { type: "bid.submitted"; agentId: string; bid: Bid; finalScore: number }
  | { type: "speaker.elected"; agentId: string; round: number; finalScore: number }
  | { type: "room.idle"; reason: "no_bid_over_threshold" | "all_pass" }
  | { type: "turn.yielded"; reason: "budget_K_reached" }
