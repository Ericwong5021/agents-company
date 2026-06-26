import { createSignal, For, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextAttributes } from "@opentui/core"
import { OnboardingFrame } from "./frame"
import { OrgTemplateService, type FlatRole } from "@/company-agent/org-templates"
import type { OrgTemplate } from "@/company-agent/org-templates/types"

interface StepTemplateSelectProps {
  stepIndex: number
  stepCount: number
  onComplete: (templateId: string) => void
}

// Card-driven template selection. Shows org templates as visual cards grouped
// by tier (starter first, then advanced). The founder picks one, sees a preview
// of the org structure, and confirms.
export function StepTemplateSelect(props: StepTemplateSelectProps) {
  const { theme } = useTheme()
  const t = useLanguage().t
  const dialog = useDialog()
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

  const allTemplates = () => [...starters, ...advanced]

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.template.title")}
      speaker={{ name: t("onboarding.assistant.default_name"), icon: "🌟" }}
      speech={t("onboarding.template.speech")}
    >
      {/* Horizontal layout: cards on the left, preview on the right */}
      <box flexDirection="row" gap={2}>
        {/* Left: template cards in a wrapping grid */}
        <box flexDirection="row" flexWrap="wrap" gap={1} flexGrow={1}>
          <For each={allTemplates()}>
            {(tpl) => {
              const isSelected = () => selected() === tpl.id
              const isHovered = () => hovered() === tpl.id
              return (
                <box
                  flexDirection="column"
                  width={22}
                  paddingTop={1}
                  paddingBottom={1}
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
                    {tpl.description}
                  </text>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={isSelected() ? theme.background : theme.textMuted}>
                      {roleCount(tpl)} {t("onboarding.template.roles")}
                    </text>
                    <Show when={tpl.tier === "advanced"}>
                      <text fg={isSelected() ? theme.background : theme.primary}>
                        ★
                      </text>
                    </Show>
                  </box>
                </box>
              )
            }}
          </For>
        </box>

        {/* Right: org structure preview (only when a template is selected) */}
        <Show when={selectedTemplate()}>
          {(tpl) => (
            <box
              flexDirection="column"
              gap={1}
              width={28}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              border
              borderColor={theme.border}
              flexShrink={0}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {tpl().name}
              </text>
              <For each={tpl().divisions}>
                {(div) => (
                  <box flexDirection="column">
                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                      📁 {div.name}
                    </text>
                    <For each={div.roles}>
                      {(role) => (
                        <box flexDirection="row" paddingLeft={1} gap={1}>
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
              {/* Confirm button inside the preview panel */}
              <box paddingTop={1} flexDirection="row" justifyContent="flex-end">
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
            </box>
          )}
        </Show>
      </box>
    </OnboardingFrame>
  )
}
