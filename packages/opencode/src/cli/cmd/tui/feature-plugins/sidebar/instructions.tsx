import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@tui/context/language"
import { Card } from "../../component/card"

const id = "internal:sidebar-instructions"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const list = createMemo(() => props.api.state.instructions())

  return (
    <Show when={list().length > 0}>
      <Card title={<text fg={theme().textMuted}><b>{t("tui.sidebar.instructions")}</b></text>}>
        <For each={list()}>
          {(file) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().primary}>
                •
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {file}
              </text>
            </box>
          )}
        </For>
      </Card>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Just below Context (100) so loaded instruction files sit near the top.
    order: 150,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
