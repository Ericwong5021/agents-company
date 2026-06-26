import { createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { OrgTemplateService, type FlatRole } from "@/company-agent/org-templates"
import type { OrgTemplate } from "@/company-agent/org-templates/types"

interface StepTemplateSelectProps {
  stepIndex: number
  stepCount: number
  onComplete: (templateId: string) => void
}

// Card-driven template selection. Shows org templates as compact cards in a
// single horizontal row. The founder picks one, previews the org structure,
// and confirms.
export function StepTemplateSelect(props: StepTemplateSelectProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (evt.name === "return" && selected()) confirm()
  })

  onMount(() => {
    dialog.setSize("large")

    if (process.env["ONBOARDING_DEV"] && starters.length > 0) {
      setSelected(starters[0]!.id)
      setTimeout(() => props.onComplete(starters[0]!.id), 500)
    }
  })
  const [selected, setSelected] = createSignal<string | null>(null)
  const [hovered, setHovered] = createSignal<string | null>(null)

  const templates = OrgTemplateService.all()
  const starters = templates.filter((tpl) => tpl.tier === "starter")
  const advanced = templates.filter((tpl) => tpl.tier === "advanced")

  function select(id: string) {
    setSelected(id === selected() ? null : id)
  }

  function confirm() {
    const id = selected()
    if (id) props.onComplete(id)
  }

  function roleCount(tpl: OrgTemplate) {
    return tpl.divisions.reduce((sum, d) => sum + d.roles.length, 0)
  }

  const selectedTemplate = () => {
    const id = selected()
    return id ? OrgTemplateService.get(id) : undefined
  }

  // Compact card sized to fit the (double-width) CJK template names on a single
  // line. Two content lines + border keeps each card short so the wrapping grid
  // stays within the dialog without overflowing vertically.
  function renderCard(tpl: OrgTemplate) {
    const isSelected = () => selected() === tpl.id
    const isHovered = () => hovered() === tpl.id
    return (
      <box
        flexDirection="column"
        width={20}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={
          isSelected()
            ? theme.primary
            : isHovered()
              ? theme.backgroundElement
              : theme.backgroundPanel
        }
        border
        borderColor={isSelected() ? theme.primary : theme.border}
        onMouseOver={() => setHovered(tpl.id)}
        onMouseOut={() => setHovered(null)}
        onMouseUp={() => select(tpl.id)}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={isSelected() ? theme.background : theme.text}>
            {tpl.icon} {tpl.name}
          </text>
          <Show when={isSelected()}>
            <text fg={theme.background}>✓</text>
          </Show>
        </box>
        <text fg={isSelected() ? theme.background : theme.textMuted}>
          {roleCount(tpl)} {t("onboarding.template.roles")}
        </text>
      </box>
    )
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.template.title")}
      speaker={{ name: t("onboarding.assistant.default_name"), icon: "🌟" }}
      speech={t("onboarding.template.speech")}
    >
      {/* Cards (left, wrapping grid) + preview (right). Side-by-side keeps the
          body height bounded so the dialog never runs off the bottom of the
          screen when a template is selected. */}
      <box flexDirection="row" gap={2}>
        <box flexDirection="row" flexWrap="wrap" gap={1} flexGrow={1}>
          <For each={starters}>
            {(tpl) => renderCard(tpl)}
          </For>
          <For each={advanced}>
            {(tpl) => renderCard(tpl)}
          </For>
        </box>

        {/* Preview: show selected template's org structure */}
        <Show when={selectedTemplate()}>
          {(tpl) => (
            <box
              flexDirection="column"
              width={32}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              border
              borderColor={theme.border}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {t("onboarding.template.preview")}: {tpl().name}
              </text>
              <For each={tpl().divisions}>
                {(div) => (
                  <box flexDirection="column" paddingLeft={1}>
                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                      📁 {div.name}
                    </text>
                    <For each={div.roles}>
                      {(role) => (
                        <box flexDirection="row" paddingLeft={2} gap={1}>
                          <text fg={theme.textMuted}>
                            {role.level === "c-suite" ? "👑" : role.level === "lead" ? "⭐" : "·"}
                          </text>
                          <text fg={theme.text}>{role.fallback.icon} {role.fallback.name}</text>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          )}
        </Show>
      </box>

      {/* Confirm button */}
      <Show when={selected()}>
        <box flexDirection="row" justifyContent="flex-end">
          <box
            backgroundColor={theme.primary}
            paddingLeft={3}
            paddingRight={3}
            paddingTop={1}
            paddingBottom={1}
            onMouseUp={confirm}
          >
            <text fg={theme.background}>{t("onboarding.template.confirm")}</text>
          </box>
        </box>
      </Show>
    </OnboardingFrame>
  )
}
