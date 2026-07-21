import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type { ConversationThreadDetail, ConversationThreadEntryItem, ConversationThreadSource } from "./company-model"

function entryAuthorName(entry: ConversationThreadEntryItem): string {
  if (entry.type === "agent_message") return entry.message.agentID
  return entry.message.author.kind === "user" ? "local-user" : entry.message.author.id
}

function sourceBody(source: ConversationThreadSource) {
  if (source.detail.type === "unavailable") return source.detail.reason
  return source.detail.body
}

type ThreadTab = "worklog" | "outputs" | "preview"
const threadPanelMemory = new Map<string, { tab: ThreadTab; selectedSourceID?: string }>()

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
  const [tab, setTab] = createSignal<ThreadTab>("worklog")
  const [selectedSourceID, setSelectedSourceID] = createSignal<string>()
  const thread = props.thread
  const runState = createMemo(() => thread()?.run?.state)
  const panelStatus = createMemo(() => {
    if (runState() === "completed") return "已完成"
    if (runState() === "failed") return "已失败"
    if (runState() === "interrupted" || thread()?.status === "interrupted") return "已中断"
    if (thread()?.status === "active") return "执行中"
    return "空闲中"
  })
  const artifacts = createMemo(() =>
    props.entries().flatMap((entry) =>
      entry.type === "message" ? (entry.sources ?? []).filter((source) => source.kind === "artifact") : [],
    ),
  )
  const selectedSource = createMemo(() => {
    const id = selectedSourceID()
    if (!id) return undefined
    return props.threadSources()[id]
  })

  const selectSource = (sourceID: string) => {
    setSelectedSourceID(sourceID)
    props.onLoadSource(sourceID)
    setTab("preview")
  }

  let activeThreadID: string | undefined
  createEffect(() => {
    const nextThreadID = thread()?.id
    if (nextThreadID === activeThreadID) return
    if (activeThreadID) threadPanelMemory.set(activeThreadID, { tab: tab(), selectedSourceID: selectedSourceID() })
    activeThreadID = nextThreadID
    const remembered = nextThreadID ? threadPanelMemory.get(nextThreadID) : undefined
    setTab(remembered?.tab ?? "worklog")
    setSelectedSourceID(remembered?.selectedSourceID)
  })
  onCleanup(() => {
    if (activeThreadID) threadPanelMemory.set(activeThreadID, { tab: tab(), selectedSourceID: selectedSourceID() })
  })

  return (
    <aside
      class="company-thread"
      aria-label={language.t("company.thread.label")}
      data-open="true"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        props.onClose()
      }}
    >
      <header class="company-work-panel-header">
        <button type="button" class="company-panel-collapse" aria-label="收起侧边栏" onClick={props.onClose}>
          <Icon name="prompt" size="small" />
        </button>
        <div class="company-work-tabs" role="tablist" aria-label="线程面板">
          <button id="company-thread-tab-worklog" type="button" role="tab" aria-controls="company-thread-panel-worklog" aria-selected={tab() === "worklog"} tabindex={tab() === "worklog" ? 0 : -1} onClick={() => setTab("worklog")}>
            工作日志
          </button>
          <button id="company-thread-tab-outputs" type="button" role="tab" aria-controls="company-thread-panel-outputs" aria-selected={tab() === "outputs"} tabindex={tab() === "outputs" ? 0 : -1} onClick={() => setTab("outputs")}>
            产出物
          </button>
          <button id="company-thread-tab-preview" type="button" role="tab" aria-controls="company-thread-panel-preview" aria-selected={tab() === "preview"} tabindex={tab() === "preview" ? 0 : -1} onClick={() => setTab("preview")}>
            预览
          </button>
        </div>
      </header>

      <Switch>
        <Match when={tab() === "worklog"}>
          <div id="company-thread-panel-worklog" role="tabpanel" aria-labelledby="company-thread-tab-worklog">
          <div class="company-work-summary">
            <article>
              <strong>{panelStatus()}</strong>
              <span>当前线程</span>
            </article>
            <article>
              <strong>{props.entries().length}</strong>
              <span>协作事件</span>
            </article>
          </div>

          <Show
            when={thread()}
            fallback={
              <div class="company-panel-empty" data-context="worklog">
                <span>
                  <Icon name="task" />
                </span>
                <strong>任务尚未开始</strong>
                <p>开始任务后，工作日志会显示在这里</p>
              </div>
            }
          >
            {(th) => (
              <>
                <header class="company-thread-header">
                  <div>
                    <strong>{th().title}</strong>
                    <span class="company-thread-status" data-status={runState() ?? th().status}>
                      {runState() === "completed"
                        ? language.t("company.thread.status.completed")
                        : runState() === "interrupted"
                          ? language.t("company.thread.status.interrupted")
                          : language.t(`company.thread.status.${th().status}`)}
                    </span>
                    <Show when={th().run}>
                      {(run) => (
                        <div class="company-thread-run" data-run-state={run().state}>
                          <span>{language.t(`company.thread.run.${run().state}`)}</span>
                          <Show when={run().safeErrorSummary}>{(summary) => <p role="alert">{summary()}</p>}</Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </header>

                <Show when={th().run && ["failed", "interrupted"].includes(th().run!.state)}>
                  <article class="company-attempt-card" data-state={th().run!.state}>
                    <header>
                      <span>Attempt {Math.max(1, th().run!.attempt)}</span>
                      <strong>{th().run!.state === "failed" ? "执行失败" : "执行被中断"}</strong>
                    </header>
                    <p>{th().run!.safeErrorSummary ?? "现场已保留，可从当前 Thread 继续分析或恢复。"}</p>
                    <footer>
                      <span>影响：当前目标尚未形成可验证交付</span>
                      <span>{th().run!.retryable ? "可重试" : "需要人工介入"}</span>
                    </footer>
                  </article>
                </Show>

                <div class="company-thread-meta">
                  <span class="company-thread-members" aria-label={language.t("company.thread.members")}>
                    <For each={th().members}>
                      {(member) => (
                        <span>
                          {member.principal.kind === "user" ? language.t("company.feed.you") : member.principal.id}
                        </span>
                      )}
                    </For>
                  </span>
                  <button
                    type="button"
                    class="company-thread-interrupt"
                    disabled={
                      props.interrupting() ||
                      th().status === "interrupted" ||
                      th().status === "completed" ||
                      th().run?.state === "completed" ||
                      th().run?.state === "failed" ||
                      th().run?.state === "interrupted"
                    }
                    aria-busy={props.interrupting() ? "true" : "false"}
                    onClick={props.onInterrupt}
                  >
                    <Icon name="stop" size="small" /> {language.t("company.thread.interrupt")}
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
                      <article class="company-thread-event" data-entry-type={entry.type}>
                        <div class="company-thread-event-icon">
                          <Icon name={entry.type === "agent_message" ? "brain" : "speech-bubble"} size="small" />
                        </div>
                        <div>
                          <header>
                            <strong>{entryAuthorName(entry)}</strong>
                            <time>{new Date(entry.message.time.created).toLocaleString(language.locale())}</time>
                          </header>
                          <p>{entry.message.body}</p>
                          <Show when={entry.type === "agent_message" ? entry.message.status : undefined}>
                            {(status) => <span class="company-thread-agent-status">{status()}</span>}
                          </Show>
                          <Show when={entry.type === "agent_message" ? entry.message.skills : undefined}>
                            {(skills) => (
                              <span class="company-thread-agent-status" data-skill="true">
                                使用 Skill · {skills().join("、")}
                              </span>
                            )}
                          </Show>
                          <Show when={entry.type === "agent_message" ? entry.message.tools : undefined}>
                            {(tools) => <span class="company-thread-agent-status">工具 · {tools().join("、")}</span>}
                          </Show>
                          <Show when={entry.type === "agent_message" ? entry.message.model : undefined}>
                            {(model) => <span class="company-thread-agent-status">模型 · {model()}</span>}
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
                                        aria-busy={
                                          props.loadingSourceIDs().includes(source.sourceID) ? "true" : "false"
                                        }
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
          </div>
        </Match>

        <Match when={tab() === "outputs"}>
          <div id="company-thread-panel-outputs" class="company-output-list" role="tabpanel" aria-labelledby="company-thread-tab-outputs">
            <For each={artifacts()}>
              {(source) => (
                <button type="button" class="company-output-row" onClick={() => selectSource(source.sourceID)}>
                  <span>
                    <Icon name="folder" />
                  </span>
                  <span>
                    <strong>{source.kind}</strong>
                    <small>线程产出 · {source.sourceID}</small>
                  </span>
                </button>
              )}
            </For>
            <Show when={artifacts().length === 0}>
              <div class="company-panel-empty" data-context="outputs">
                <span>
                  <Icon name="folder" />
                </span>
                <strong>暂无产出物</strong>
                <p>线程产生的文件会显示在这里</p>
              </div>
            </Show>
          </div>
        </Match>

        <Match when={tab() === "preview"}>
          <div id="company-thread-panel-preview" role="tabpanel" aria-labelledby="company-thread-tab-preview">
          <Show
            when={selectedSource()}
            fallback={
              <div class="company-panel-empty" data-context="preview">
                <span>
                  <Icon name="photo" />
                </span>
                <strong>未选择要预览的文件</strong>
              </div>
            }
          >
            {(source) => (
              <div class="company-source-preview">
                <header>{selectedSourceID()}</header>
                <pre>{sourceBody(source())}</pre>
              </div>
            )}
          </Show>
          </div>
        </Match>
      </Switch>
    </aside>
  )
}
