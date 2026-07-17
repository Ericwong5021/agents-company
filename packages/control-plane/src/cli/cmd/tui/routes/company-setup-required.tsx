import { TextAttributes, type RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useLanguage } from "@tui/context/language"
import { useTheme } from "@tui/context/theme"
import type { ParentProps } from "solid-js"

type CompanyEntryNoticeProps = ParentProps<{
  title: string
  body: string
  color: RGBA
}>

function CompanyEntryNotice(props: CompanyEntryNoticeProps) {
  const { theme } = useTheme()

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
      <box
        width="80%"
        maxWidth={88}
        flexDirection="column"
        gap={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border
        borderColor={props.color}
        backgroundColor={theme.backgroundPanel}
      >
        <text attributes={TextAttributes.BOLD} fg={props.color}>
          {props.title}
        </text>
        <text fg={theme.text}>{props.body}</text>
        {props.children}
      </box>
    </box>
  )
}

export function CompanySetupRequired(props: {
  entry:
    | { type: "setup_required"; data_directory: string }
    | { type: "repository_mismatch"; repository_path: string }
}) {
  const { theme } = useTheme()
  const t = useLanguage().t

  if (props.entry.type === "setup_required") {
    return (
      <CompanyEntryNotice
        title={t("company.setup.required.title")}
        body={t("company.setup.required.body")}
        color={theme.primary}
      >
        <text fg={theme.textMuted}>
          {t("company.setup.dataDirectory", { path: props.entry.data_directory })}
        </text>
      </CompanyEntryNotice>
    )
  }

  return (
    <CompanyEntryNotice
      title={t("company.repositoryMismatch.title")}
      body={t("company.repositoryMismatch.body")}
      color={theme.warning}
    >
      <text fg={theme.textMuted}>{props.entry.repository_path}</text>
      <text fg={theme.accent}>{t("company.repositoryMismatch.command", { path: props.entry.repository_path })}</text>
    </CompanyEntryNotice>
  )
}

export function CompanyConnectionError(props: { error: string; onRetry: () => void }) {
  const { theme } = useTheme()
  const t = useLanguage().t

  useKeyboard((evt) => {
    if (evt.name !== "r") return
    evt.preventDefault()
    props.onRetry()
  })

  return (
    <CompanyEntryNotice
      title={t("company.connection.title")}
      body={t("company.connection.body")}
      color={theme.error}
    >
      <text fg={theme.textMuted}>{props.error}</text>
      <text fg={theme.accent} onMouseUp={props.onRetry}>
        {t("company.connection.retry")}
      </text>
    </CompanyEntryNotice>
  )
}
