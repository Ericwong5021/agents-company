import { addons, types } from "storybook/manager-api"
import { ThemeTool } from "./theme-tool"

addons.register("agent-company/theme-toggle", () => {
  addons.add("agent-company/theme-toggle/tool", {
    type: types.TOOL,
    title: "Theme",
    match: ({ viewMode }) => viewMode === "story" || viewMode === "docs",
    render: ThemeTool,
  })
})
