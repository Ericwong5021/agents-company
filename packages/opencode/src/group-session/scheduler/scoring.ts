import type { Bid, BidLevel, RightsState, ScoredBid, ArbitrationResult } from "./bidding.types"
import type { ScoringConfig } from "./scheduler.config"
import { DEFAULT_CONFIG } from "./scheduler.config"

const LEVEL_ORDER: BidLevel[] = ["pass", "could", "want", "must"]

function base(level: BidLevel, config: ScoringConfig): number | null {
  if (level === "pass") return null
  return config.base[level]
}

function addressBonus(bid: Bid, config: ScoringConfig): number {
  return config.addressBonus[bid.addressedAs]
}

function typePriority(bid: Bid, config: ScoringConfig): number {
  return config.typePriority[bid.type]
}

function staleness(idleRounds: number, config: ScoringConfig): number {
  return Math.min(idleRounds * config.stalenessPerRound, config.stalenessCap)
}

function scoreBid(
  agentId: string,
  bid: Bid,
  rights: RightsState,
  config: ScoringConfig,
): ScoredBid {
  const b = base(bid.level, config)
  if (b === null || b < config.tau) {
    return { agentId, bid, eligible: false, score: 0 }
  }

  const intentLayer = b + addressBonus(bid, config) + typePriority(bid, config)
  const rightsLayer = -rights.cooldown + staleness(rights.idleRounds, config)
  const score = intentLayer + rightsLayer

  return { agentId, bid, eligible: true, score }
}

export function arbitrate(
  entries: Array<{ agentId: string; bid: Bid; rights: RightsState }>,
  config: ScoringConfig = DEFAULT_CONFIG,
): ArbitrationResult {
  const scored = entries
    .map((e) => scoreBid(e.agentId, e.bid, e.rights, config))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
      const scoreDiff = b.score - a.score
      if (scoreDiff !== 0) return scoreDiff
      const aIdle = entries.find((e) => e.agentId === a.agentId)?.rights.idleRounds ?? 0
      const bIdle = entries.find((e) => e.agentId === b.agentId)?.rights.idleRounds ?? 0
      return bIdle - aIdle
    })

  const eligible = scored.filter((s) => s.eligible)
  if (eligible.length === 0) {
    const allPass = entries.every((e) => e.bid.level === "pass")
    return {
      scored,
      winnerId: null,
      idleReason: allPass ? "all_pass" : "none_over_threshold",
    }
  }

  const winner = eligible[0]
  return { scored, winnerId: winner.agentId }
}

export function markSpoke(config: ScoringConfig = DEFAULT_CONFIG): RightsState {
  return { cooldown: config.cooldownInitial, idleRounds: 0 }
}

export function decayRights(rights: RightsState, config: ScoringConfig = DEFAULT_CONFIG): RightsState {
  return {
    cooldown: Math.max(0, rights.cooldown - config.cooldownRecoverPerRound),
    idleRounds: rights.idleRounds + 1,
  }
}

export function settleAfterSpeak(
  rights: Record<string, RightsState>,
  speakerId: string,
  config: ScoringConfig = DEFAULT_CONFIG,
): Record<string, RightsState> {
  const result: Record<string, RightsState> = {}
  for (const [id, r] of Object.entries(rights)) {
    result[id] = id === speakerId ? markSpoke(config) : decayRights(r, config)
  }
  return result
}

export function initialRights(): RightsState {
  return { cooldown: 0, idleRounds: 0 }
}

/**
 * Pick the member most overdue to speak (idleRounds - cooldown wins).
 * Used as human fallback when all agents pass after a human message.
 */
export function pickFallbackSpeaker(
  memberIds: string[],
  rights: Record<string, RightsState>,
): string {
  return memberIds.reduce((best, id) => {
    const score = rights[id].idleRounds - rights[id].cooldown
    const bestScore = rights[best].idleRounds - rights[best].cooldown
    return score > bestScore ? id : best
  })
}
