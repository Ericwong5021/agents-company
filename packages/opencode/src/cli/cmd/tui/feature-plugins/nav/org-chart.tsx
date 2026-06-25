import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { TEMPLATE_DIVISIONS, type AgentTemplate, type AgentTemplateDivision } from "@/company-agent/templates-index"

const id = "internal:nav-org-chart"

interface AgentTemplateView {
  slug: string
  name: string
  description: string
  emoji: string
  color: string
  vibe: string
  division: string
}

function OrgChartView(props: { params?: Record<string, unknown> }) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()

  const division = createMemo(() => (props.params?.division as string) ?? null)
  const slug = createMemo(() => (props.params?.slug as string) ?? null)

  const [agentsInDivision] = createResource(division, async (d) => {
    if (!d) return [] as AgentTemplateView[]
    const res = await sdk.fetch(`${sdk.url}/company-agent/templates/${encodeURIComponent(d)}`)
    if (!res.ok) return [] as AgentTemplateView[]
    return (await res.json()) as AgentTemplateView[]
  })

  const selectedAgent = createMemo(() => {
    const s = slug()
    const list = agentsInDivision() ?? []
    return list.find((a) => a.slug === s) ?? null
  })

  // Publish a right-sidebar list of agents in the current division (or all
  // divisions when none selected).
  createMemo(() => {
    const d = division()
    const list = agentsInDivision() ?? []
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{d ?? t("tui.shell.nav.org-chart")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <Show when={d}>
              <For each={list}>
                {(a) => (
                  <box
                    flexShrink={0}
                    onMouseUp={() =>
                      route.navigate({ type: "plugin", id: "org-chart", data: { division: d, slug: a.slug } })
                    }
                  >
                    <text fg={a.slug === slug() ? theme.accent : theme.text}>
                      {a.emoji} {a.name}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        </scrollbox>
      </box>
    ))
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <Show
        when={division()}
        fallback={
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              <For each={TEMPLATE_DIVISIONS}>
                {(d: AgentTemplateDivision) => (
                  <box
                    border={["left"]}
                    borderColor={d.color}
                    onMouseUp={() => route.navigate({ type: "plugin", id: "org-chart", data: { division: d.slug } })}
                    flexShrink={0}
                  >
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
                      <text fg={theme.text}>
                        <b>{d.label}</b>
                        <span style={{ fg: theme.textMuted }}>  ·  {d.count} agents</span>
                      </text>
                      <text fg={theme.textMuted}>{d.slug}</text>
                    </box>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        }
      >
        {(d) => (
          <box flexDirection="column" flexGrow={1} gap={1}>
            <box flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
              <box
                onMouseUp={() => route.navigate({ type: "plugin", id: "org-chart" })}
              >
                <text fg={theme.accent}>← {t("tui.shell.nav.org-chart")}</text>
              </box>
              <text fg={theme.textMuted}> / </text>
              <text fg={theme.text}>
                <b>{d()}</b>
              </text>
            </box>
            <Show
              when={selectedAgent()}
              fallback={
                <scrollbox flexGrow={1}>
                  <box flexDirection="column" gap={1} paddingTop={1}>
                    <For each={agentsInDivision() ?? []}>
                      {(a) => (
                        <box
                          border={["left"]}
                          borderColor={a.color}
                          flexShrink={0}
                          onMouseUp={() =>
                            route.navigate({ type: "plugin", id: "org-chart", data: { division: d(), slug: a.slug } })
                          }
                        >
                          <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
                            <text fg={theme.text}>
                              {a.emoji} <b>{a.name}</b>
                            </text>
                            <text fg={theme.textMuted}>{a.description}</text>
                          </box>
                        </box>
                      )}
                    </For>
                  </box>
                </scrollbox>
              }
            >
              {(agent) => (
                <scrollbox flexGrow={1}>
                  <box flexDirection="column" gap={1} paddingTop={1}>
                    <box flexShrink={0}>
                      <text fg={theme.text}>
                        {agent().emoji} <b>{agent().name}</b>
                      </text>
                      <text fg={theme.textMuted}>{agent().description}</text>
                    </box>
                    <Show when={agent().vibe}>
                      <box flexShrink={0} paddingLeft={2}>
                        <text fg={theme.textMuted}>{agent().vibe}</text>
                      </box>
                    </Show>
                  </box>
                </scrollbox>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "org-chart",
      render: (input) => <OrgChartView params={input.params} />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
