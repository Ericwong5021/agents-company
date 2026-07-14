import { For, Show, createMemo, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type { ChannelKind, ConversationChannelItem } from "./company-model"

/**
 * Real channel sidebar. Channels come only from the SDK `company.channels`
 * snapshot — there is no client-side channel creation, no fabricated project
 * channels, and no Direct/department section (those stay closed until M5).
 * Channels are grouped by kind; empty groups still render their heading so the
 * user sees the real organizational structure rather than a fake populated tree.
 */

type ChannelGroup = {
  kind: ChannelKind
  labelKey: string
  icon: Parameters<typeof Icon>[0]["name"]
}

const GROUPS: readonly ChannelGroup[] = [
  { kind: "company", labelKey: "company.sidebar.group.company", icon: "bubble-5" },
  { kind: "board", labelKey: "company.sidebar.group.board", icon: "providers" },
  { kind: "project", labelKey: "company.sidebar.group.project", icon: "folder" },
]

function groupChannels(channels: ConversationChannelItem[]): Record<ChannelKind, ConversationChannelItem[]> {
  const byKind: Record<ChannelKind, ConversationChannelItem[]> = {
    company: [],
    board: [],
    department: [],
    project: [],
    direct: [],
  }
  for (const channel of channels) byKind[channel.kind].push(channel)
  return byKind
}

export function ChannelSidebar(props: {
  channels: Accessor<ConversationChannelItem[]>
  activeChannelID: Accessor<string | null>
  loading: Accessor<boolean>
  onSelect: (channelID: string) => void
}) {
  const language = useLanguage()
  const grouped = createMemo(() => groupChannels(props.channels()))

  return (
    <aside class="company-channels" aria-label={language.t("company.sidebar.label")}>
      <div class="company-channels-header">
        <strong>{language.t("company.sidebar.title")}</strong>
        <Show when={props.loading()}>
          <span class="company-sidebar-loading" aria-live="polite">
            {language.t("company.sidebar.loading")}
          </span>
        </Show>
      </div>
      <div class="company-channel-scroll">
        <For each={GROUPS}>
          {(group) => (
            <section class="company-channel-section">
              <div class="company-section-heading">
                <span>{language.t(group.labelKey)}</span>
              </div>
              <div class="company-channel-list">
                <For each={grouped()[group.kind]}>
                  {(channel) => (
                    <button
                      type="button"
                      class="company-channel"
                      classList={{ active: channel.id === props.activeChannelID() }}
                      aria-current={channel.id === props.activeChannelID() ? "true" : undefined}
                      onClick={() => props.onSelect(channel.id)}
                    >
                      <Icon name={group.icon} size="small" />
                      <span class="company-channel-copy">
                        <span class="company-channel-name">{channel.title}</span>
                      </span>
                    </button>
                  )}
                </For>
                <Show when={grouped()[group.kind].length === 0}>
                  <span class="company-channel-empty">{language.t("company.sidebar.empty")}</span>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </aside>
  )
}
