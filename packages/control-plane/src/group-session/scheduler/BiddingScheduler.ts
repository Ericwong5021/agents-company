import type { Bid, RightsState, SchedulerState, ArbitrationResult } from "./bidding.types"
import { arbitrate, settleAfterSpeak, initialRights, pickFallbackSpeaker } from "./scoring"
import type { ScoringConfig } from "./scheduler.config"
import { DEFAULT_CONFIG } from "./scheduler.config"

/**
 * Decides what a round's result means and whether the scheduler should continue.
 * Returns the winner (if any) and whether to yield/idle/continue.
 */
export interface RoundOutcome {
  winnerId: string | null
  scored: ArbitrationResult["scored"]
  idleReason?: "all_pass" | "none_over_threshold"
}

export interface YieldCheck {
  yielded: boolean
  reason: "budget_K_reached" | null
}

export interface HumanFallbackResult {
  speakerId: string
  reason: "human_fallback"
}

export type SpeakerSelection =
  | { type: "winner"; agentId: string }
  | { type: "idle"; reason: "all_pass" | "none_over_threshold" }
  | { type: "yielded"; reason: "budget_K_reached" }
  | { type: "human_fallback"; agentId: string }

/**
 * Pure state machine for the bidding scheduler.
 * Holds rights state and round counters.
 * All state transitions are deterministic pure functions.
 */
export class BiddingScheduler {
  public state: SchedulerState
  private config: ScoringConfig
  /** Stores the last arbitration result for external consumption (e.g. event emission). */
  private _lastArbitration: ArbitrationResult | null = null

  /** The most recent arbitration result, or null if no round has completed. */
  get lastArbitration(): ArbitrationResult | null {
    return this._lastArbitration
  }

  constructor(channelId: string, memberIds: string[], config?: Partial<ScoringConfig>) {
    const fullConfig = { ...DEFAULT_CONFIG, ...config }
    this.config = fullConfig
    const rights: Record<string, RightsState> = {}
    for (const id of memberIds) {
      rights[id] = initialRights()
    }
    this.state = {
      channelId,
      consecutiveAgentTurns: 0,
      currentSpeaker: undefined,
      phase: "idle",
      rights,
      round: 0,
      taskBoard: [],
    }
  }

  /** Members in position order */
  get memberIds(): string[] {
    return Object.keys(this.state.rights)
  }

  /** Whether the scheduler is still actively running bidding rounds */
  get isActive(): boolean {
    return this.state.phase === "bidding" || this.state.phase === "speaking"
  }

  /**
   * Process bids from all members and select the next speaker.
   * Mutates state (sets phase, round, currentSpeaker).
   * Returns the selection result.
   */
  decide(bids: Array<{ agentId: string; bid: Bid }>): SpeakerSelection {
    // Check K budget first
    if (this.state.consecutiveAgentTurns >= this.config.maxConsecutiveAgentTurns) {
      this.state.phase = "idle"
      return { type: "yielded", reason: "budget_K_reached" }
    }

    this.state.round++
    this.state.phase = "bidding"

    const entries = bids.map((b) => ({
      agentId: b.agentId,
      bid: b.bid,
      rights: this.state.rights[b.agentId] ?? initialRights(),
    }))

    const result = arbitrate(entries, this.config)
    this._lastArbitration = result

    if (result.winnerId === null) {
      this.state.currentSpeaker = undefined
      this.state.phase = "idle"
      return { type: "idle", reason: result.idleReason ?? "all_pass" }
    }

    this.state.currentSpeaker = result.winnerId
    this.state.phase = "speaking"
    return { type: "winner", agentId: result.winnerId }
  }

  /**
   * Human fallback — pick the member most overdue to speak.
   * Used when all agents pass after a human message.
   */
  decideFallback(): { type: "human_fallback"; agentId: string } {
    const speakerId = pickFallbackSpeaker(this.memberIds, this.state.rights)
    this.state.currentSpeaker = speakerId
    this.state.phase = "speaking"
    return { type: "human_fallback", agentId: speakerId }
  }

  /**
   * Finalize after a speaker has finished.
   * Settles rights (cooldown/staleness) and increments consecutive turns.
   */
  afterSpeak(speakerId: string): void {
    this.state.rights = settleAfterSpeak(this.state.rights, speakerId, this.config)
    this.state.consecutiveAgentTurns++
    this.state.currentSpeaker = undefined
    this.state.phase = "bidding"
  }

  /** Reset the consecutive agent turns counter (e.g. after a user messages or task completion) */
  resetConsecutiveTurns(): void {
    this.state.consecutiveAgentTurns = 0
  }

  /** Reset the scheduler back to idle for a new user input cycle */
  resetForUserInput(): void {
    this.state.consecutiveAgentTurns = 0
    this.state.currentSpeaker = undefined
    this.state.phase = "idle"
    this.state.round = 0
  }

  /** Partial reset — keeps rights state but resets the round counter for a new user turn */
  startNewUserTurn(): void {
    this.state.consecutiveAgentTurns = 0
    this.state.currentSpeaker = undefined
    this.state.phase = "idle"
    this.state.round = 0
  }
}
