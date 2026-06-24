import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { createSignal } from "solid-js"
import path from "path"
import { InstallationVersion, InstallationChannel } from "@/installation/version"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    await props.onBeforeExit?.()
    renderer.setTerminalTitle("")
    renderer.destroy()
    win32FlushInputBuffer()
    await props.onExit()
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      void handleExit()
    }
  })

  // Crash state may itself be partially initialized when the error fired, so
  // every read here is best-effort and degrades gracefully.
  const routeSummary = (() => {
    try {
      return JSON.stringify(useRoute().data, null, 2)
    } catch {
      return "(unavailable)"
    }
  })()

  const projectDirectory = (() => {
    try {
      return useProject().instance.directory() || "(unavailable)"
    } catch {
      return "(unavailable)"
    }
  })()

  const crashedAt = new Date().toISOString()
  const crashFile = path.join(Global.Path.log, `crash-${crashedAt.replace(/[:.]/g, "-")}.txt`)

  const report = [
    "agent-company TUI crash report",
    "==============================",
    "",
    `Timestamp:        ${crashedAt}`,
    `Version:          ${InstallationVersion} (channel: ${InstallationChannel})`,
    `Platform:         ${process.platform} ${process.arch}`,
    `Runtime:          ${process.version}`,
    `Working directory:${process.cwd()}`,
    `Project directory:${projectDirectory}`,
    "",
    "TUI route at crash:",
    routeSummary,
    "",
    "Error:",
    `  name:    ${props.error.name}`,
    `  message: ${props.error.message}`,
    "",
    "Stack:",
    props.error.stack ?? "(no stack)",
    "",
  ].join("\n")

  const [status, setStatus] = createSignal<"idle" | "done" | "error">("idle")
  const [savedPath, setSavedPath] = createSignal("")
  const [failure, setFailure] = createSignal("")

  const exportReport = async () => {
    // 1. Persist to disk first so the clipboard copy and the on-screen hint
    //    can both reference the real file path.
    try {
      await Filesystem.write(crashFile, report)
      setSavedPath(crashFile)
    } catch (e: any) {
      setStatus("error")
      setFailure(e?.message ?? String(e))
      return
    }

    // 2. Copy to clipboard.
    try {
      await Clipboard.copy(report)
      setStatus("done")
    } catch (e: any) {
      setStatus("error")
      setFailure(e?.message ?? String(e))
    }
  }

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          A fatal error occurred — error log exported.
        </text>
        <box onMouseUp={() => void exportReport()} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            Copy error log (exception info + state)
          </text>
        </box>
        {status() === "done" && (
          <text fg={colors.muted}>Copied to clipboard · saved to {savedPath()}</text>
        )}
        {status() === "error" && <text fg={colors.muted}>Failed to export log: {failure()}</text>}
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={handleExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)} scrollAcceleration={getScrollAcceleration()}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
