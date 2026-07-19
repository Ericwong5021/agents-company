import { Menu, shell } from "electron"

import { UPDATER_ENABLED } from "./constants"
import { PRODUCT_BRAND } from "../shared/brand"
import { createMainWindow } from "./windows"

type Deps = {
  checkForUpdates: () => void
  reload: () => void
  relaunch: () => void
}

export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") return

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_BRAND.names.prod,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          enabled: UPDATER_ENABLED,
          click: () => deps.checkForUpdates(),
        },
        {
          label: "Reload Webview",
          click: () => deps.reload(),
        },
        {
          label: "Restart",
          click: () => deps.relaunch(),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "Cmd+Shift+N",
          click: () => createMainWindow(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Agent Company Documentation", click: () => shell.openExternal("https://github.com/Ericwong5021/agents-company") },
        { type: "separator" },
        {
          label: "Share Feedback",
          click: () => shell.openExternal("https://github.com/Ericwong5021/agents-company/issues/new?template=feature_request.yml"),
        },
        {
          label: "Report a Bug",
          click: () => shell.openExternal("https://github.com/Ericwong5021/agents-company/issues/new?template=bug_report.yml"),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
