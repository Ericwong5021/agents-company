import z from "zod"
import { randomBytes } from "crypto"

const prefixes = {
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
  workflow: "wf",
  thread: "thr",
  reputation: "rep",
  companyProject: "cprj",
  companyPlan: "cpln",
  companyWorkItem: "cwi",
  workAttempt: "wat",
  dispatchClaim: "dcl",
  workReceipt: "wrc",
  acceptanceCriterion: "acrt",
  acceptanceFact: "afct",
  outcomeSignal: "osig",
  outcomeTransition: "otrn",
  receiptClaim: "rclm",
  graphDecision: "gdec",
  graphMutation: "gmut",
  validationGate: "vgat",
  validationRepair: "vrep",
  projectCharter: "cchr",
  worktreeRun: "wrun",
  artifact: "art",
  commonsSource: "csrc",
  commonsChunk: "cchk",
  interpretation: "intp",
  belief: "blf",
  beliefEvidence: "blev",
  experiment: "exp",
  learningPatch: "lpatch",
  patchBenchmark: "pbench",
  patchCanary: "pcan",
  patchEvent: "pevt",
  patchTargetVersion: "ptver",
  learningBenchmarkTarget: "lbtarget",
  learningBenchmarkSelection: "lbsel",
  learningInterestTarget: "litarget",
  learningInterestSelection: "lisel",
  learningWorkflowTarget: "lwtarget",
  learningWorkflowSelection: "lwsel",
  skillCandidateSnapshot: "scsnap",
  readingAssignment: "rasn",
  gate: "gate",
  localCredential: "lcr",
  channel: "chn",
  rootNeed: "need",
  conversationThread: "cth",
  channelMessage: "cmsg",
  channelDelivery: "cdlv",
  conversationRun: "crun",
  signalProjection: "spr",
  agentRun: "arun",
  agentRunEvent: "arev",
  executionMessage: "exmsg",
  runtimeHome: "rhome",
  skillSnapshot: "ssnap",
  capabilityNeed: "cneed",
  teamSelection: "tsel",
  projectAssignment: "pasn",
  agentPerformance: "aperf",
  agentCapability: "acap",
  employmentReview: "erev",
  department: "dept",
  attention: "attn",
  projectAction: "pact",
  rolloutTransition: "rtrn",
  rolloutJournal: "rjnl",
  rolloutShadow: "rshd",
  founderDecision: "fdec",
  founderDecisionTransition: "fdtr",
} as const

export function schema(prefix: keyof typeof prefixes) {
  return z.string().startsWith(prefixes[prefix])
}

const LENGTH = 26

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
