import { For, Show, createMemo, createSignal, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type { ChannelKind, CompanyProjectSummary, ConversationChannelItem } from "./company-model"

export type CompanyWorkspaceView = "conversation" | "new" | "office" | "project"

type ChannelGroup = {
  kind: ChannelKind
  labelKey: string
  icon: Parameters<typeof Icon>[0]["name"]
}

const GROUPS: readonly ChannelGroup[] = [
  { kind: "company", labelKey: "company.sidebar.group.company", icon: "bubble-5" },
  { kind: "board", labelKey: "company.sidebar.group.board", icon: "speech-bubble" },
]

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
  projects: Accessor<CompanyProjectSummary[]>
  activeProjectID: Accessor<string | null>
  loading: Accessor<boolean>
  onSelect: (channelID: string) => void
  onOpenProject: (projectID: string) => void
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
  const visibleProjects = createMemo(() => {
    const normalized = query().trim().toLocaleLowerCase()
    if (!normalized) return props.projects()
    return props.projects().filter((project) =>
      `${project.title} ${project.goal}`.toLocaleLowerCase().includes(normalized),
    )
  })

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
          <Icon name="plus-small" size="small" />
          <span>新建目标</span>
        </button>
      </nav>

      <div class="company-sidebar-section-label">公司协作</div>
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

        <section class="company-channel-section" aria-label="项目">
          <div class="company-channel-list">
            <For each={visibleProjects()}>
              {(project) => (
                <button
                  type="button"
                  class="company-channel company-project-channel"
                  classList={{ active: props.activeView() === "project" && project.id === props.activeProjectID() }}
                  aria-current={
                    props.activeView() === "project" && project.id === props.activeProjectID() ? "page" : undefined
                  }
                  onClick={() => props.onOpenProject(project.id)}
                >
                  <Icon name="folder" size="small" />
                  <span class="company-channel-copy">
                    <span class="company-channel-name">{project.title}</span>
                    <span class="company-channel-preview">{project.status === "completed" ? "已交付" : "项目室"}</span>
                  </span>
                  <span class="company-project-channel-dot" data-status={project.status} aria-hidden="true" />
                </button>
              )}
            </For>
            <For each={visible("project")}>
              {(channel) => (
                <button
                  type="button"
                  class="company-channel"
                  classList={{
                    active: props.activeView() === "conversation" && channel.id === props.activeChannelID(),
                  }}
                  onClick={() => props.onSelect(channel.id)}
                >
                  <Icon name="folder" size="small" />
                  <span class="company-channel-copy">
                    <span class="company-channel-name">{channel.title}</span>
                    <span class="company-channel-preview">项目群聊</span>
                  </span>
                </button>
              )}
            </For>
            <Show when={visibleProjects().length === 0 && visible("project").length === 0}>
              <span class="company-channel-empty">暂无项目</span>
            </Show>
          </div>
        </section>
      </div>

      <div class="company-sidebar-profile">
        <span class="company-profile-dot" aria-hidden="true" />
        <span>本地用户</span>
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
