export { Service, layer, defaultLayer, MAX_APPROACH_ATTEMPTS } from "./delegation"
export type {
  Interface,
  DecomposeInput,
  DelegateSubtasksInput,
  AdmitResultInput,
  EscalateInput,
  EscalateResult,
  ApproachAttempt,
  HandleFailureInput,
  HandleFailureResult,
  FailureBubbleInput,
  BubbleDecision,
  FullChainReport,
  ChainNode,
  LevelSummary,
  EscalationEvent,
  ChainOutcome,
} from "./delegation"
export { SubTask, DelegationChain, DelegationResult, AdmissionResult } from "./schema"
export type { SubTask as SubTaskType, DelegationResult as DelegationResultType, AdmissionResult as AdmissionResultType } from "./schema"
export {
  messageAgent,
  delegate,
  reply,
  drainUnread,
  OrgLayer,
  parseOrgLayer,
  canDelegate,
  MAX_DELEGATION_DEPTH,
} from "./primitives"
export type { MessageAgentInput, DelegateInput, ReplyInput, OrgLayerName } from "./primitives"
