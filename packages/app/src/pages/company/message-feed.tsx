import { For, Show, type Accessor } from "solid-js"
import { Avatar } from "@agents-company/ui/avatar"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type {
  ConversationMessageItem,
  ConversationPendingMessage,
  SignalType,
} from "./company-model"

/**
 * Real main-channel message feed. Only high-signal messages (and the user's own
 * input) appear here; ordinary agent replies, tool logs and Bidding noise stay
 * in the Thread panel. Each high-signal message shows its signal type, author /
 * DRI, time and a source affordance that opens the originating Thread. Pending
 * messages are the only optimistic UI — they are the 202-confirmed user input
 * already persisted server-side, never a fabricated agent response.
 */

const HIGH_SIGNAL: ReadonlySet<SignalType> = new Set(["conclusion", "status", "risk", "intervention"])

function isHighSignal(type: SignalType | undefined): type is SignalType {
  return type !== undefined && HIGH_SIGNAL.has(type)
}

function authorName(author: ConversationMessageItem["author"], language: ReturnType<typeof useLanguage>): string {
  return author.kind === "user" ? language.t("company.feed.you") : author.id
}

function MessageAvatar(props: { label: string; kind: ConversationMessageItem["author"]["kind"] }) {
  return (
    <span class="company-avatar-wrap" data-author-kind={props.kind} aria-hidden="true">
      <Avatar
        fallback={props.label}
        size="large"
        background={props.kind === "user" ? "#dce8ff" : props.kind === "agent" ? "#e8e4ff" : "#eceef1"}
        foreground={props.kind === "user" ? "#3159b8" : props.kind === "agent" ? "#5b51aa" : "#656872"}
      />
      <span class="company-presence" />
    </span>
  )
}

function timeLabel(created: number, language: ReturnType<typeof useLanguage>): string {
  try {
    return new Date(created).toLocaleString(language.locale())
  } catch {
    return new Date(created).toISOString()
  }
}

export function MessageFeed(props: {
  messages: Accessor<ConversationMessageItem[]>
  pendingMessages: Accessor<ConversationPendingMessage[]>
  loading: Accessor<boolean>
  hasMore: Accessor<boolean>
  onLoadMore: () => void
  onOpenThread: (threadID: string) => void
}) {
  const language = useLanguage()

  return (
    <div class="company-feed" role="log" aria-live="polite" aria-busy={props.loading() ? "true" : "false"}>
      <Show when={props.loading() && props.messages().length === 0}>
        <div class="company-channel-placeholder" data-state="loading">
          <Icon name="bubble-5" size="large" />
          <p>{language.t("company.feed.loading")}</p>
        </div>
      </Show>

      <Show when={!props.loading() && props.messages().length === 0 && props.pendingMessages().length === 0}>
        <div class="company-channel-placeholder" data-state="empty">
          <Icon name="bubble-5" size="large" />
          <h2>{language.t("company.feed.empty.title")}</h2>
          <p>{language.t("company.feed.empty.body")}</p>
        </div>
      </Show>

      <Show when={props.hasMore()}>
        <button type="button" class="company-feed-load-more" onClick={() => props.onLoadMore()}>
          {language.t("company.feed.loadMore")}
        </button>
      </Show>

      <For each={props.messages()}>
        {(message) => (
          <MessageRow
            message={message}
            onOpenThread={props.onOpenThread}
          />
        )}
      </For>

      <For each={props.pendingMessages()}>
        {(pending) => (
          <article class="company-message" classList={{ bubble: true }} data-state="pending">
            <MessageAvatar label={language.t("company.feed.you")} kind="user" />
            <div class="company-message-body">
              <header>
                <strong>{language.t("company.feed.you")}</strong>
                <Show when={!pending.confirmed}>
                  <span class="company-message-pending">{language.t("company.feed.sending")}</span>
                </Show>
              </header>
              <div class="company-message-content">
                <p>{pending.body}</p>
              </div>
            </div>
          </article>
        )}
      </For>
    </div>
  )
}

function MessageRow(props: {
  message: ConversationMessageItem
  onOpenThread: (threadID: string) => void
}) {
  const language = useLanguage()
  const high = () => isHighSignal(props.message.signalType)
  const dri = () => props.message.dri

  return (
    <article
      class="company-message"
      classList={{ bubble: props.message.author.kind === "user" }}
      data-signal={high() ? props.message.signalType : undefined}
    >
      <MessageAvatar label={authorName(props.message.author, language)} kind={props.message.author.kind} />
      <div class="company-message-body">
        <header>
          <strong>{authorName(props.message.author, language)}</strong>
          <Show when={high()}>
            <span class="company-message-signal" data-signal={props.message.signalType}>
              {language.t(`company.signal.${props.message.signalType}`)}
            </span>
          </Show>
          <Show when={dri()}>
            {(principal) => (
              <span class="company-message-dri" aria-label={language.t("company.feed.dri")}>
                {principal().kind === "user" ? language.t("company.feed.you") : principal().id}
              </span>
            )}
          </Show>
          <time>{timeLabel(props.message.time.created, language)}</time>
        </header>
        <div class="company-message-content">
          <p>{props.message.body}</p>
        </div>
        <Show when={props.message.sourceThreadID}>
          <footer class="company-source-link">
            <button
              type="button"
              class="company-source-button"
              aria-label={language.t("company.feed.openThread")}
              onClick={() => props.onOpenThread(props.message.sourceThreadID!)}
            >
              <Icon name="models" size="small" /> {language.t("company.feed.openThread")}
              <Icon name="arrow-right" size="small" />
            </button>
          </footer>
        </Show>
      </div>
    </article>
  )
}
