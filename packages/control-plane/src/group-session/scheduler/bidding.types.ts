export type BidLevel = "must" | "want" | "could" | "pass"

export type BidType = "objection" | "answer" | "question" | "claim" | "info" | "support"

export type AddressedAs = "direct" | "mention" | "none"

export interface Bid {
  level: BidLevel
  type: BidType
  addressedAs: AddressedAs
  reason: string
}
