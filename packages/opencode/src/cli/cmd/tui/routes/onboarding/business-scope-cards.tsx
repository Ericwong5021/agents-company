import { createSignal, For, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes, TextareaRenderable } from "@opentui/core"

export interface BusinessScopeOption {
  key: string
  emoji: string
  title: string
  description: string
}

export const BUSINESS_SCOPE_PRESETS: BusinessScopeOption[] = [
  {
    key: "saas",
    emoji: "🖥",
    title: "SaaS",
    description: "Build and sell software products",
  },
  {
    key: "content",
    emoji: "✍",
    title: "Content",
    description: "Content creation, media, education",
  },
  {
    key: "consulting",
    emoji: "💼",
    title: "Consulting",
    description: "Professional consulting and advisory",
  },
  {
    key: "ecommerce",
    emoji: "🛒",
    title: "E-commerce",
    description: "Online retail and marketplace",
  },
  {
    key: "agency",
    emoji: "🎨",
    title: "Agency",
    description: "Marketing, design, or dev agency",
  },
]

interface BusinessScopeCardsProps {
  onConfirm: (scopes: string[]) => void
}

export function BusinessScopeCards(props: BusinessScopeCardsProps) {
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  useKeyboard((evt) => {
    if (evt.name === "return" && selected().size > 0) confirm()
  })
  const [hovered, setHovered] = createSignal<string | null>(null)
  const [showCustomInput, setShowCustomInput] = createSignal(false)
  let customInput: TextareaRenderable | undefined

  function toggle(key: string) {
    if (key === "custom") {
      setShowCustomInput(true)
      setTimeout(() => customInput && !customInput.isDestroyed && customInput.focus(), 1)
      return
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function addCustom() {
    const text = (customInput?.plainText ?? "").trim()
    if (!text) return
    setSelected((prev) => {
      const next = new Set(prev)
      next.add(text)
      return next
    })
    customInput?.clear()
    setShowCustomInput(false)
  }

  function confirm() {
    if (selected().size > 0) {
      props.onConfirm(Array.from(selected()))
    }
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Select your business scope (multi-select):
      </text>
      <box flexDirection="row" flexWrap="wrap" justifyContent="center" gap={1}>
        <For each={BUSINESS_SCOPE_PRESETS}>
          {(option) => {
            const isSelected = () => selected().has(option.key)
            const isHovered = () => hovered() === option.key
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
                onMouseOver={() => setHovered(option.key)}
                onMouseOut={() => setHovered(null)}
                onMouseUp={() => toggle(option.key)}
              >
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={isSelected() ? theme.background : theme.text}>
                    {option.emoji} {option.title}
                  </text>
                  <Show when={isSelected()}>
                    <text fg={isSelected() ? theme.background : theme.success}>✓</text>
                  </Show>
                </box>
                <box>
                  <text fg={isSelected() ? theme.background : theme.textMuted}>
                    {option.description}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
        {/* Custom card */}
        <box
          flexDirection="column"
          width={22}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            hovered() === "custom" ? theme.backgroundElement : theme.backgroundPanel
          }
          onMouseOver={() => setHovered("custom")}
          onMouseOut={() => setHovered(null)}
          onMouseUp={() => toggle("custom")}
        >
          <text fg={theme.text}>✏ Custom</text>
          <box>
            <text fg={theme.textMuted}>Define your own business scope</text>
          </box>
        </box>
      </box>

      {/* Custom input */}
      <Show when={showCustomInput()}>
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme.textMuted}>Enter custom scope:</text>
          <box
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
            <textarea
              height={1}
              keyBindings={[{ name: "return", action: "submit" }]}
              onSubmit={addCustom}
              placeholder="e.g., AI Research"
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              onMouseDown={(r: any) => r.target?.focus()}
              ref={(r: TextareaRenderable) => (customInput = r)}
            />
          </box>
          <text
            fg={theme.primary}
            onMouseUp={addCustom}
          >
            Add
          </text>
        </box>
      </Show>

      {/* Selected tags + Confirm */}
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={1} flexWrap="wrap">
          <Show when={selected().size > 0}>
            <text fg={theme.textMuted}>Selected:</text>
            <For each={Array.from(selected())}>
              {(scope) => (
                <text fg={theme.primary}>
                  {scope}
                </text>
              )}
            </For>
          </Show>
        </box>
        <Show when={selected().size > 0}>
          <box
            backgroundColor={theme.primary}
            paddingLeft={2}
            paddingRight={2}
            onMouseUp={confirm}
          >
            <text fg={theme.background}>Confirm →</text>
          </box>
        </Show>
      </box>
    </box>
  )
}
