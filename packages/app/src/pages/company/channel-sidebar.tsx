import { For, Show, createMemo, createSignal, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type { ChannelKind, ConversationChannelItem } from "./company-model"

export type CompanyWorkspaceView = "conversation" | "new" | "office"

type ChannelGroup = {
  kind: ChannelKind
  labelKey: string
  icon: Parameters<typeof Icon>[0]["name"]
}

const GROUPS: readonly ChannelGroup[] = [
  { kind: "company", labelKey: "company.sidebar.group.company", icon: "bubble-5" },
  { kind: "board", labelKey: "company.sidebar.group.board", icon: "speech-bubble" },
  { kind: "project", labelKey: "company.sidebar.group.project", icon: "folder" },
]

const KNOWLEDGE_NAV = [
  { label: "应用", icon: "dot-grid" },
  { label: "文档", icon: "folder" },
  { label: "图库", icon: "photo" },
] satisfies ReadonlyArray<{ label: string; icon: Parameters<typeof Icon>[0]["name"] }>

function groupChannels(channels: ConversationChannelItem[]): Record<ChannelKind, ConversationChannelItem[]> {
  const byKind: Record<ChannelKind, ConversationChannelItem[]> = {
    company: [],
    board: [],
    department: [],
    project: [],
    direct: [],
  }
  channels.forEach((channel) => byKind[channel.kind].push(channel))
  return byKind
}

export function ChannelSidebar(props: {
  channels: Accessor<ConversationChannelItem[]>
  activeChannelID: Accessor<string | null>
  activeView: Accessor<CompanyWorkspaceView>
  loading: Accessor<boolean>
  onSelect: (channelID: string) => void
  onNewConversation: () => void
  onOpenOffice: () => void
  onOpenSettings: () => void
}) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const grouped = createMemo(() => groupChannels(props.channels()))
  const visible = (kind: ChannelKind) => {
    const normalized = query().trim().toLocaleLowerCase()
    if (!normalized) return grouped()[kind]
    return grouped()[kind].filter((channel) => channel.title.toLocaleLowerCase().includes(normalized))
  }

  return (
    <aside class="company-channels" aria-label={language.t("company.sidebar.label")}>
      <div class="company-window-controls" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div class="company-brand">Agent Company</div>

      <label class="company-sidebar-search">
        <Icon name="magnifying-glass" size="small" />
        <input
          value={query()}
          aria-label="搜索频道"
          placeholder="搜索"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>

      <nav class="company-primary-nav" aria-label="快捷入口">
        <button
          type="button"
          class="company-nav-item"
          classList={{ active: props.activeView() === "new" }}
          onClick={props.onNewConversation}
        >
          <Icon name="new-session" size="small" />
          <span>新建对话</span>
        </button>
        <button type="button" class="company-nav-item" aria-disabled="true">
          <Icon name="task" size="small" />
          <span>自动任务</span>
        </button>
        <button type="button" class="company-nav-item" aria-disabled="true">
          <Icon name="brain" size="small" />
          <span>技能广场</span>
        </button>
      </nav>

      <div class="company-sidebar-section-label">本地知识库</div>
      <nav class="company-primary-nav" aria-label="本地知识库">
        <For each={KNOWLEDGE_NAV}>
          {(item) => (
            <button type="button" class="company-nav-item" aria-disabled="true">
              <Icon name={item.icon} size="small" />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>

      <div class="company-sidebar-section-label">对话</div>
      <div class="company-channel-scroll">
        <button
          type="button"
          class="company-nav-item company-office-link"
          classList={{ active: props.activeView() === "office" }}
          onClick={props.onOpenOffice}
        >
          <Icon name="prompt" size="small" />
          <span>办公室</span>
        </button>

        <For each={GROUPS}>
          {(group) => (
            <section class="company-channel-section" aria-label={language.t(group.labelKey)}>
              <div class="company-channel-list">
                <For each={visible(group.kind)}>
                  {(channel) => (
                    <button
                      type="button"
                      class="company-channel"
                      classList={{
                        active: props.activeView() === "conversation" && channel.id === props.activeChannelID(),
                      }}
                      aria-current={
                        props.activeView() === "conversation" && channel.id === props.activeChannelID()
                          ? "true"
                          : undefined
                      }
                      onClick={() => props.onSelect(channel.id)}
                    >
                      <Icon name={group.icon} size="small" />
                      <span class="company-channel-copy">
                        <span class="company-channel-name">{channel.title}</span>
                      </span>
                    </button>
                  )}
                </For>
                <Show when={visible(group.kind).length === 0}>
                  <span class="company-channel-empty">{language.t("company.sidebar.empty")}</span>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>

      <div class="company-sidebar-profile">
        <span class="company-profile-dot" aria-hidden="true" />
        <span>大东</span>
        <button type="button" aria-label="打开设置" onClick={props.onOpenSettings}>
          <Icon name="settings-gear" size="small" />
        </button>
      </div>
      <Show when={props.loading()}>
        <span class="company-sidebar-loading" aria-live="polite">
          {language.t("company.sidebar.loading")}
        </span>
      </Show>
    </aside>
  )
}
