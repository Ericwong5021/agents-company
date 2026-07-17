import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"

const id = "internal:nav-project-management"

function ProjectManagementView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={4} paddingRight={4}>
      <text fg={theme.textMuted}>{t("tui.shell.placeholder.projects")}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "project-management",
      render: () => <ProjectManagementView />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
