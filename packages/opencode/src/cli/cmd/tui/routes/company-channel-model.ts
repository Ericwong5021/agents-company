import type {
  CompanyChannelMessagesResponse,
  CompanyThreadEntriesResponse,
  CompanyThreadResponse,
  CompanyThreadSourceResponse,
  MessageAuthor,
  SignalType,
} from "@agents-company/sdk/v2"

/**
 * Pure view-model helpers for the TUI company-channel route. The route component
 * stays a thin SDK caller; dedup/merge/ordering and thread-summary logic lives
 * here so it is unit-testable without rendering OpenTUI.
 *
 * The aliases below come from the generated SDK. Keeping the route on the
 * contract types prevents a new entry variant from silently becoming an unsafe
 * cast in the TUI.
 */
export type ChannelMessage = CompanyChannelMessagesResponse["items"][number]
export type ThreadDetail = CompanyThreadResponse
export type ThreadEntry = CompanyThreadEntriesResponse["items"][number]
export type ThreadSource = CompanyThreadSourceResponse

export interface ThreadActionInput {
  kind: "interrupt"
}

/**
 * Merge a freshly fetched page into the existing message list, deduplicating by
 * id and keeping stable `(time_created, id)` ordering. Re-fetches after a send
 * or SSE invalidation must never duplicate or reorder already-shown messages.
 */
export function mergeMessages(existing: ChannelMessage[], next: ChannelMessage[]): ChannelMessage[] {
  const byId = new Map<string, ChannelMessage>()
  for (const msg of existing) byId.set(msg.id, msg)
  for (const msg of next) byId.set(msg.id, msg)
  return [...byId.values()].sort((a, b) => {
    if (a.time.created !== b.time.created) return a.time.created - b.time.created
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Short, readable label for a message author. User messages are localized by the
 * caller (the TUI passes the localized "You"); agents and system actors show id.
 */
export function authorLabel(author: MessageAuthor, youLabel: string): string {
  if (author.kind === "user") return youLabel
  return author.id
}

/** All board send surfaces fail closed when the capability is absent. */
export function boardMessagesEnabled(capabilities: { board_messages: boolean } | undefined): boolean {
  return capabilities?.board_messages === true
}

/**
 * Only high-signal messages carry a signal type the main feed should badge. The
 * TUI renders the bracketed type for these; ordinary agent replies (no signal
 * type) stay unbadged, matching the M2 high-signal protocol.
 */
export function signalBadge(signalType: SignalType | undefined): string | undefined {
  return signalType
}

export function threadEntryAuthor(entry: ThreadEntry, youLabel: string): string {
  if (entry.type === "agent_message") return entry.message.agentID
  return authorLabel(entry.message.author, youLabel)
}

export function threadEntryBody(entry: ThreadEntry): string {
  return entry.message.body
}

export function threadEntrySources(entry: ThreadEntry) {
  if (entry.type === "agent_message") return []
  return entry.sources ?? []
}

export function threadSourceBody(source: ThreadSource): string {
  if (source.detail.type === "unavailable") return source.detail.reason
  return source.detail.body
}

/**
 * One-line thread summary for the thread panel header: title plus status. Keeps
 * the component's JSX free of formatting logic.
 */
export function threadSummary(thread: ThreadDetail): string {
  return `${thread.title} (${thread.status})`
}

/**
 * Members of a thread as a stable, deduplicated id list for display. Members are
 * recorded from actual runtime participants, not inferred from channel members.
 */
export function threadMemberIds(thread: ThreadDetail): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const m of thread.members) {
    if (seen.has(m.principal.id)) continue
    seen.add(m.principal.id)
    ids.push(m.principal.id)
  }
  return ids
}

/** Construct the interrupt action body — the only structured M2 thread action. */
export function interruptAction(): ThreadActionInput {
  return { kind: "interrupt" }
}
