import { For, Show, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type {
  ConversationThreadDetail,
  ConversationThreadEntryItem,
  ConversationThreadSource,
} from "./company-model"

/**
 * Real Thread panel. Thread entries are the authorized projection of the board
 * runtime — ordinary agent replies, tool summaries and intermediate reasoning
 * live here, never in the main feed. Tool/source detail is loaded on demand via
 * the source callback rather than rendered into the initial DOM, so long tool
 * output never ships in the first paint. The only structured M2 action,
 * interrupt, is exposed here with an accessible status that is not color-only.
 */

function entryAuthorName(entry: ConversationThreadEntryItem): string {
  if (entry.type === "agent_message") return entry.message.agentID
  const author = entry.message.author
  return author.kind === "user" ? "local-user" : author.id
}

function sourceBody(source: ConversationThreadSource) {
  if (source.detail.type === "unavailable") return source.detail.reason
  return source.detail.body
}

export function ThreadPanel(props: {
  thread: Accessor<ConversationThreadDetail | null>
  entries: Accessor<ConversationThreadEntryItem[]>
  loading: Accessor<boolean>
  hasMore: Accessor<boolean>
  interrupting: Accessor<boolean>
  threadSources: Accessor<Record<string, ConversationThreadSource>>
  loadingSourceIDs: Accessor<string[]>
  onClose: () => void
  onInterrupt: () => void
  onLoadMore: () => void
  onLoadSource: (sourceID: string) => void
}) {
  const language = useLanguage()
  const thread = props.thread

  return (
    <aside class="company-thread" aria-label={language.t("company.thread.label")} data-open={thread() ? "true" : "false"}>
      <Show when={thread()}>
        {(th) => (
          <>
            <header class="company-thread-header">
              <div>
                <strong>{th().title}</strong>
                <span class="company-thread-status" data-status={th().status}>
                  {language.t(`company.thread.status.${th().status}`)}
                </span>
                <Show when={th().run}>
                  {(run) => (
                    <div class="company-thread-run" data-run-state={run().state}>
                      <span>{language.t(`company.thread.run.${run().state}`)}</span>
                      <Show when={run().safeErrorSummary}>
                        {(summary) => <p role="alert">{summary()}</p>}
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
              <button
                type="button"
                class="company-icon-button"
                aria-label={language.t("company.thread.close")}
                onClick={props.onClose}
              >
                <Icon name="close" />
              </button>
            </header>

            <div class="company-thread-meta">
              <span class="company-thread-members" aria-label={language.t("company.thread.members")}>
                <For each={th().members}>
                  {(member) => <span>{member.principal.kind === "user" ? language.t("company.feed.you") : member.principal.id}</span>}
                </For>
              </span>
              <button
                type="button"
                class="company-thread-interrupt"
                disabled={props.interrupting() || th().status === "interrupted" || th().status === "completed"}
                aria-busy={props.interrupting() ? "true" : "false"}
                onClick={props.onInterrupt}
              >
                <Icon name="close" size="small" /> {language.t("company.thread.interrupt")}
              </button>
            </div>

            <div class="company-thread-scroll" aria-busy={props.loading() ? "true" : "false"}>
              <Show when={props.hasMore()}>
                <button type="button" class="company-feed-load-more" onClick={() => props.onLoadMore()}>
                  {language.t("company.thread.loadMore")}
                </button>
              </Show>
              <For each={props.entries()}>
                {(entry) => (
                  <article class="company-thread-event">
                    <div>
                      <header>
                        <strong>{entryAuthorName(entry)}</strong>
                        <time>{new Date(entry.message.time.created).toLocaleString(language.locale())}</time>
                      </header>
                      <p>{entry.message.body}</p>
                      <Show when={entry.type === "agent_message" ? entry.message.status : undefined}>
                        {(status) => <span class="company-thread-agent-status">{status()}</span>}
                      </Show>
                      <Show when={entry.type === "message" ? entry : undefined}>
                        {(messageEntry) => (
                          <>
                            <Show when={messageEntry().message.signalType}>
                              <span class="company-message-signal" data-signal={messageEntry().message.signalType}>
                                {language.t(`company.signal.${messageEntry().message.signalType}`)}
                              </span>
                            </Show>
                            <For each={messageEntry().sources ?? []}>
                              {(source) => (
                                <div class="company-thread-source">
                                  <button
                                    type="button"
                                    aria-expanded={props.threadSources()[source.sourceID] ? "true" : "false"}
                                    aria-busy={props.loadingSourceIDs().includes(source.sourceID) ? "true" : "false"}
                                    onClick={() => props.onLoadSource(source.sourceID)}
                                  >
                                    {language.t("company.thread.source.open")} · {source.kind}
                                  </button>
                                  <Show when={props.threadSources()[source.sourceID]}>
                                    {(loaded) => <p class="company-thread-source-detail">{sourceBody(loaded())}</p>}
                                  </Show>
                                </div>
                              )}
                            </For>
                          </>
                        )}
                      </Show>
                    </div>
                  </article>
                )}
              </For>
              <Show when={!props.loading() && props.entries().length === 0}>
                <p class="company-thread-empty">{language.t("company.thread.empty")}</p>
              </Show>
            </div>
          </>
        )}
      </Show>
    </aside>
  )
}
