export interface ScoringConfig {
  base: { must: number; want: number; could: number }
  addressBonus: { direct: number; mention: number; none: number }
  typePriority: {
    objection: number
    answer: number
    question: number
    claim: number
    info: number
    support: number
  }
  cooldownInitial: number
  cooldownRecoverPerRound: number
  stalenessPerRound: number
  stalenessCap: number
  tau: number
  maxConsecutiveAgentTurns: number
}

export const DEFAULT_CONFIG: ScoringConfig = {
  base: { must: 100, want: 60, could: 30 },
  addressBonus: { direct: 40, mention: 15, none: 0 },
  typePriority: {
    objection: 15,
    answer: 10,
    question: 6,
    claim: 4,
    info: 2,
    support: 0,
  },
  cooldownInitial: 50,
  cooldownRecoverPerRound: 15,
  stalenessPerRound: 5,
  stalenessCap: 30,
  tau: 30,
  maxConsecutiveAgentTurns: 6,
}
