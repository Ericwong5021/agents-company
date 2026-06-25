import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "@tui/component/dialog-provider"
import { DialogModel } from "@tui/component/dialog-model"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useLanguage } from "@tui/context/language"
import { Spinner } from "@tui/component/spinner"
import { OnboardingFrame } from "./frame"

interface StepProviderProps {
  key?: number
  stepIndex: number
  stepCount: number
  onComplete: (data: { providerID: string; modelID: string }) => void
}

// Provider + default-model selection. We reuse the app's provider/model dialogs
// for the actual connection (auth flows are non-trivial) but frame the step in
// card style and only advance once a model is actually chosen.
export function StepProvider(props: StepProviderProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const t = useLanguage().t
  const [waiting, setWaiting] = createSignal(false)
  const [needsRetry, setNeedsRetry] = createSignal(false)

  function hasConnectedModels() {
    return sync.data.provider_next.connected.some((id) => {
      const provider = sync.data.provider.find((p) => p.id === id)
      return provider && Object.keys(provider.models).length > 0
    })
  }

  onMount(() => setTimeout(open, 300))

  function open() {
    setNeedsRetry(false)
    // Jump straight to model selection when a provider is already connected.
    dialog.replace(
      () => (hasConnectedModels() ? <DialogModel /> : <DialogProvider />),
      onDialogClosed,
    )
  }

  function onDialogClosed() {
    const current = local.model.current()
    if (current?.providerID && current?.modelID) {
      setWaiting(true)
      setTimeout(() => props.onComplete({ providerID: current.providerID, modelID: current.modelID }), 600)
      return
    }
    setNeedsRetry(true)
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.provider.title")}
      subtitle={t("onboarding.provider.description")}
    >
      <Show when={waiting()}>
        <Spinner color={theme.textMuted}>{t("onboarding.provider.setting_up")}</Spinner>
      </Show>
      <Show when={needsRetry()}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.error}>⚠ {t("onboarding.provider.required")}</text>
          <box
            backgroundColor={theme.primary}
            paddingLeft={3}
            paddingRight={3}
            paddingTop={1}
            paddingBottom={1}
            onMouseUp={open}
          >
            <text fg={theme.background}>{t("onboarding.provider.retry")}</text>
          </box>
        </box>
      </Show>
      <Show when={!waiting() && !needsRetry()}>
        <Spinner color={theme.textMuted}>{t("onboarding.provider.description")}</Spinner>
      </Show>
    </OnboardingFrame>
  )
}
