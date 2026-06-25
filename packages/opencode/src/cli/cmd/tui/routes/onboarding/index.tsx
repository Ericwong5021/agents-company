import { createSignal, Match, Switch, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKV } from "@tui/context/kv"
import { StarryBackground } from "@tui/component/starry-background"
import { TextAttributes } from "@opentui/core"
import { StepWelcome } from "./step-welcome"
import { StepProvider } from "./step-provider"
import { StepInterview } from "./step-interview"
import { StepFoundingTeam } from "./step-founding-team"

type OnboardingStep =
  | "welcome"
  | "provider-setup"
  | "interview"
  | "founding-team"
  | "complete"

interface OnboardingData {
  providerID?: string
  modelID?: string
  agentIDs?: string[]
  userName?: string
  assistantName?: string
  businessScopes?: string[]
}

interface StepError {
  step: OnboardingStep
  message: string
  retryCount: number
}

export function Onboarding() {
  const { theme } = useTheme()
  const kv = useKV()
  const [step, setStep] = createSignal<OnboardingStep>("welcome")
  const [data, setData] = createSignal<OnboardingData>({})
  const [error, setError] = createSignal<StepError | null>(null)
  const [retryKey, setRetryKey] = createSignal(0)

  // Validation functions
  function validateProvider(result: { providerID: string; modelID: string }): string | null {
    if (!result.providerID || result.providerID.trim() === "") {
      return "Provider selection is required. Please select a provider to continue."
    }
    if (!result.modelID || result.modelID.trim() === "") {
      return "Model selection is required. Please select a model to continue."
    }
    return null
  }

  function validateInterview(result: {
    agentIDs: string[]
    userName: string
    assistantName: string
    businessScopes: string[]
  }): string | null {
    if (!result.userName || result.userName.trim() === "") {
      return "Your name is required. Please tell us your name."
    }
    if (!result.assistantName || result.assistantName.trim() === "") {
      return "Assistant name is required. Please give your assistant a name."
    }
    if (!result.businessScopes || result.businessScopes.length === 0) {
      return "Business scope is required. Please select at least one business scope."
    }
    if (!result.agentIDs || result.agentIDs.length === 0) {
      return "Founding team creation failed. Please try again."
    }
    return null
  }

  function validateFoundingTeam(agentIDs: string[]): string | null {
    if (!agentIDs || agentIDs.length === 0) {
      return "No founding team members found. Please go back and complete the interview."
    }
    return null
  }

  // Step handlers with validation
  function handleWelcomeComplete() {
    setStep("provider-setup")
    setError(null)
  }

  function handleProviderComplete(result: { providerID: string; modelID: string }) {
    const validationError = validateProvider(result)
    if (validationError) {
      setError({
        step: "provider-setup",
        message: validationError,
        retryCount: (error()?.step === "provider-setup" ? error()!.retryCount : 0) + 1,
      })
      setRetryKey((k) => k + 1)
      return
    }

    setData((prev) => ({
      ...prev,
      providerID: result.providerID,
      modelID: result.modelID,
    }))
    setStep("interview")
    setError(null)
  }

  function handleInterviewComplete(result: {
    agentIDs: string[]
    userName: string
    assistantName: string
    businessScopes: string[]
  }) {
    const validationError = validateInterview(result)
    if (validationError) {
      setError({
        step: "interview",
        message: validationError,
        retryCount: (error()?.step === "interview" ? error()!.retryCount : 0) + 1,
      })
      setRetryKey((k) => k + 1)
      return
    }

    setData((prev) => ({
      ...prev,
      agentIDs: result.agentIDs,
      userName: result.userName,
      assistantName: result.assistantName,
      businessScopes: result.businessScopes,
    }))
    setStep("founding-team")
    setError(null)
  }

  function handleFoundingTeamComplete() {
    const validationError = validateFoundingTeam(data().agentIDs ?? [])
    if (validationError) {
      setError({
        step: "founding-team",
        message: validationError,
        retryCount: (error()?.step === "founding-team" ? error()!.retryCount : 0) + 1,
      })
      return
    }

    kv.set("onboarding_done", true)
    setStep("complete")
    setError(null)
  }

  function handleRetry() {
    const currentError = error()
    if (!currentError) return

    // Stay on the same step but trigger a retry
    setRetryKey((k) => k + 1)
    setError(null)
  }

  function handleBack() {
    const currentStep = step()
    setError(null)

    switch (currentStep) {
      case "provider-setup":
        setStep("welcome")
        break
      case "interview":
        setStep("provider-setup")
        break
      case "founding-team":
        setStep("interview")
        break
    }
  }

  return (
    <box position="relative" width="100%" height="100%">
      <StarryBackground />
      <box position="absolute" top={0} left={0} right={0} bottom={0}>
        {/* Error banner */}
        <Show when={error()}>
          <box
            position="absolute"
            top={0}
            left={0}
            right={0}
            zIndex={100}
            backgroundColor={theme.error}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
          >
            <box flexDirection="row" gap={2} alignItems="center">
              <text fg={theme.background} attributes={TextAttributes.BOLD}>
                ⚠ Validation Failed
              </text>
              <text fg={theme.background}>
                {error()!.message}
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <Show when={step() !== "welcome"}>
                <box
                  backgroundColor={theme.background}
                  paddingLeft={2}
                  paddingRight={2}
                  onMouseUp={handleBack}
                >
                  <text fg={theme.error}>← Back</text>
                </box>
              </Show>
              <box
                backgroundColor={theme.background}
                paddingLeft={2}
                paddingRight={2}
                onMouseUp={handleRetry}
              >
                <text fg={theme.error}>Retry ↻</text>
              </box>
            </box>
          </box>
        </Show>

        {/* Steps */}
        <Switch>
          <Match when={step() === "welcome"}>
            <StepWelcome onComplete={handleWelcomeComplete} />
          </Match>
          <Match when={step() === "provider-setup"}>
            <StepProvider
              key={retryKey()}
              onComplete={handleProviderComplete}
            />
          </Match>
          <Match when={step() === "interview"}>
            <StepInterview
              key={retryKey()}
              onComplete={handleInterviewComplete}
            />
          </Match>
          <Match when={step() === "founding-team"}>
            <StepFoundingTeam
              agentIDs={data().agentIDs ?? []}
              userName={data().userName ?? ""}
              assistantName={data().assistantName ?? ""}
              businessScopes={data().businessScopes ?? []}
              onComplete={handleFoundingTeamComplete}
            />
          </Match>
        </Switch>
      </box>
    </box>
  )
}
