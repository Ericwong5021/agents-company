/**
 * Delegation primitives — re-exports org-layer hierarchy utilities and
 * the core delegation/message functions from agent-message/primitives.
 *
 * These functions live in agent-message/primitives.ts because they operate
 * on the AgentMessage data model. This module re-exports them under the
 * delegation namespace for convenience.
 */
export {
  messageAgent,
  delegate,
  reply,
  drainUnread,
  OrgLayer,
  parseOrgLayer,
  canDelegate,
  MAX_DELEGATION_DEPTH,
} from "@/agent-message/primitives"
export type { MessageAgentInput, DelegateInput, ReplyInput, OrgLayerName } from "@/agent-message/primitives"
