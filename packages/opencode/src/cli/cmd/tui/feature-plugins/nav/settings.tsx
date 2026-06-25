import type { TuiPlugin, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useCommandDialog } from "../../component/dialog-command"
import { useRightSidebar } from "../../context/right-sidebar"

const id = "internal:nav-settings"

interface SettingEntry {
  value: string
  label: string
  description?: string
}

interface SettingGroup {
  label: string
  entries: SettingEntry[]
}

function SettingsView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const command = useCommandDialog()
  const rightSidebar = useRightSidebar()

  const groups: SettingGroup[] = [
    {
      label: t("tui.settings.group.appearance"),
      entries: [
        { value: "theme.switch", label: "Themes", description: "Switch color theme" },
        { value: "theme.switch_mode.dark", label: "Dark mode" },
        { value: "theme.switch_mode.light", label: "Light mode" },
        { value: "brand_color.switch", label: "Brand color" },
        { value: "background.switch", label: "Background image" },
        { value: "logo.switch", label: "Logo design" },
        { value: "theme.mode.lock", label: "Lock theme mode" },
      ],
    },
    {
      label: t("tui.settings.group.interface"),
      entries: [
        { value: "app.toggle.animations", label: "Toggle animations" },
        { value: "app.toggle.diffwrap", label: "Toggle diff word-wrap" },
        { value: "terminal.title.toggle", label: "Toggle terminal title" },
        { value: "language.switch", label: "Language" },
      ],
    },
    {
      label: t("tui.settings.group.tools"),
      entries: [
        { value: "mcp.list", label: "MCP servers" },
        { value: "worktree.list", label: "Worktrees" },
      ],
    },
    {
      label: t("tui.settings.group.system"),
      entries: [
        { value: "opencode.status", label: "Status" },
        { value: "help.show", label: "Help" },
      ],
    },
  ]

  // Right sidebar: the settings menu list.
  createMemo(() => {
    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{t("tui.shell.right.settings")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={groups}>
              {(group, gi) => (
                <>
                  <Show when={gi() > 0}>
                    <box flexShrink={0} paddingTop={1} paddingBottom={1}>
                      <text fg={theme.border}>{"─".repeat(20)}</text>
                    </box>
                  </Show>
                  <box flexShrink={0} paddingBottom={1}>
                    <text fg={theme.textMuted}>{group.label}</text>
                  </box>
                  <For each={group.entries}>
                    {(e) => (
                      <box flexShrink={0} onMouseUp={() => command.trigger(e.value)}>
                        <text fg={theme.text}>{e.label}</text>
                      </box>
                    )}
                  </For>
                </>
              )}
            </For>
          </box>
        </scrollbox>
      </box>
    ))
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text}>
          <b>{t("tui.shell.route.settings")}</b>
        </text>
      </box>
      <scrollbox flexGrow={1}>
        <box flexDirection="column" paddingTop={1}>
          <For each={groups}>
            {(group, gi) => (
              <>
                <Show when={gi() > 0}>
                  <box flexShrink={0} paddingTop={1} paddingBottom={1}>
                    <text fg={theme.border}>{"─".repeat(40)}</text>
                  </box>
                </Show>
                <box flexShrink={0} paddingBottom={1}>
                  <text fg={theme.accent}>
                    <b>{group.label}</b>
                  </text>
                </box>
                <For each={group.entries}>
                  {(e) => (
                    <box
                      flexShrink={0}
                      flexDirection="row"
                      justifyContent="space-between"
                      alignItems="center"
                      paddingTop={1}
                      paddingBottom={1}
                      paddingLeft={1}
                      onMouseUp={() => command.trigger(e.value)}
                    >
                      <box flexDirection="column">
                        <text fg={theme.text}>{e.label}</text>
                        <Show when={e.description}>
                          <text fg={theme.textMuted}>{e.description}</text>
                        </Show>
                      </box>
                      <text fg={theme.textMuted}>›</text>
                    </box>
                  )}
                </For>
              </>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "settings",
      render: () => <SettingsView />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
