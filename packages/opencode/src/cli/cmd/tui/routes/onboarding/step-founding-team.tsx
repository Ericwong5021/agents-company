import { createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"
import { OnboardingFrame } from "./frame"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"
import { resolveFoundingRoles, type FoundingRoleSpec } from "./founding-roles"
import { buildButlerPrompt } from "./prompts"

interface StepFoundingTeamProps {
  stepIndex: number
  stepCount: number
  userName: string
  assistantName: string
  scopes: string[]
  mission: string
  onComplete: (agentIDs: string[], teamNames: string[]) => void
}

interface Founder {
  id: string
  name: string
  description: string
  icon: string
  color: string
}

// Deterministically assembles the founding team from the bundled template
// library. Each role is searched and revealed one by one with ceremony: a
// "searching for…" animation plays, then the founder card fades in, then a
// short pause before the next role — giving the whole moment weight and
// a sense that a real team is being born.
export function StepFoundingTeam(props: StepFoundingTeamProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const dialog = useDialog()
  const [founders, setFounders] = createSignal<Founder[]>([])
  const [done, setDone] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // Which role we're currently searching for (shown with a spinner).
  const [searching, setSearching] = createSignal<string | null>(null)

  onMount(() => {
    dialog.setSize("large")
    void build()
  })

  async function build() {
    setError(null)
    setDone(false)
    setFounders([])

    try {
      const roles = resolveFoundingRoles(props.scopes)
      const created: Founder[] = []

      for (let i = 0; i < roles.length; i++) {
        const role = roles[i]

        // Show "searching for [role label]…" animation.
        setSearching(role.fallback.name)

        // The search + creation takes ~0.5-2s naturally (network). Add a
        // short floor so the animation always plays long enough to feel real.
        const [founder] = await Promise.all([
          createFounder(role),
          delay(1800),
        ])

        if (!founder) {
          setSearching(null)
          setError(t("onboarding.founding_team.error"))
          return
        }

        // Reveal the card and clear the search spinner.
        created.push(founder)
        setFounders([...created])
        setSearching(null)

        // Pause between cards so each reveal lands individually.
        if (i < roles.length - 1) await delay(800)
      }

      setDone(true)

      // Hot-swap the assistant's soul from guidance to butler now that the
      // founding team exists and the company profile is locked in.
      void sdk.fetch(`${sdk.url}/company-agent/onboarding-assistant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "onboarding-assistant",
          name: props.assistantName,
          system_prompt: buildButlerPrompt({
            userName: props.userName,
            assistantName: props.assistantName,
            scopeLabels: props.scopes
              .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
              .join("、"),
            mission: props.mission || undefined,
            team: created.map((f) => f.name),
          }),
        }),
      }).catch(() => undefined)
    } catch {
      setError(t("onboarding.founding_team.error"))
    }
  }

  async function createFounder(role: FoundingRoleSpec): Promise<Founder | null> {
    const template = await searchTemplate(role)
    const id = `${role.division}-${role.key}-founder`
    const name = template?.name ?? role.fallback.name
    const icon = template?.emoji ?? role.fallback.icon
    const color = template?.color ?? role.fallback.color
    const description = template?.description ?? role.fallback.description

    const res = await sdk.fetch(`${sdk.url}/company-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        name,
        description,
        color,
        icon,
        system_prompt: buildFounderPrompt(props, name, template?.system_prompt),
      }),
    })
    if (!res.ok) return null
    return { id, name, description, icon, color }
  }

  async function searchTemplate(role: FoundingRoleSpec) {
    try {
      const params = new URLSearchParams({ q: role.query, division: role.division, limit: "1" })
      const res = await sdk.fetch(`${sdk.url}/company-agent/templates/search?${params}`)
      if (!res.ok) return null
      const list = await res.json()
      return Array.isArray(list) && list.length > 0 ? list[0] : null
    } catch {
      return null
    }
  }

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.founding_team.title")}
      speaker={{ name: props.assistantName, icon: "🌟" }}
      speech={
        searching()
          ? t("onboarding.founding_team.searching").replace("{{role}}", searching()!)
          : done()
            ? t("onboarding.founding_team.complete_speech").replace("{{name}}", props.userName)
            : undefined
      }
      footer={
        <Show when={done()}>
          <box flexDirection="column" alignItems="center" gap={1}>
            <text fg={theme.textMuted}>
              {t("onboarding.founding_team.ready").replace("{{assistant}}", props.assistantName)}
            </text>
            <box
              backgroundColor={theme.primary}
              paddingLeft={4}
              paddingRight={4}
              paddingTop={1}
              paddingBottom={1}
              onMouseUp={() => props.onComplete(founders().map((f) => f.id), founders().map((f) => f.name))}
            >
              <text fg={theme.background}>{t("onboarding.founding_team.enter")}</text>
            </box>
          </box>
        </Show>
      }
    >
      <Show when={error()}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.error}>⚠ {error()}</text>
          <box backgroundColor={theme.primary} paddingLeft={3} paddingRight={3} onMouseUp={build}>
            <text fg={theme.background}>{t("onboarding.provider.retry")}</text>
          </box>
        </box>
      </Show>

      {/* Searching animation: spinner + role label */}
      <Show when={searching()}>
        <box flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
          <Spinner color={theme.primary} />
          <text fg={theme.textMuted}>
            {t("onboarding.founding_team.matching").replace("{{role}}", searching()!)}
          </text>
        </box>
      </Show>

      {/* Achievement banner — shows once at least one founder is revealed */}
      <Show when={founders().length > 0 && !error()}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.warning ?? theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
            🏆 {t("onboarding.achievement.title")}
          </text>
          <text fg={theme.textMuted}>
            {t("onboarding.achievement.desc").replace("{{name}}", props.userName)}
          </text>
        </box>
      </Show>

      {/* Founder identity cards — revealed one by one as they're created */}
      <Show when={founders().length > 0}>
        <box flexDirection="row" gap={2} flexWrap="wrap" justifyContent="center" paddingTop={1}>
          <For each={founders()}>
            {(f) => (
              <box
                flexDirection="column"
                width={22}
                backgroundColor={theme.backgroundElement}
                border
                borderColor={theme.border}
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={1}
                paddingRight={1}
                gap={1}
              >
                <box flexDirection="row" gap={1}>
                  <text>{f.icon}</text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {f.name}
                  </text>
                </box>
                <text fg={theme.textMuted}>{f.description}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <Show when={done()}>
        <text fg={theme.textMuted}>
          {t("onboarding.scope.selected")}{" "}
          {props.scopes
            .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
            .join("、")}
        </text>
      </Show>
    </OnboardingFrame>
  )
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function buildFounderPrompt(props: StepFoundingTeamProps, roleName: string, base?: string) {
  const scopeLabels = props.scopes
    .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
    .join("、")
  const context = `## 🏢 公司背景

你是 **${props.userName} 的公司** 的创始团队成员，担任「${roleName}」。

**业务方向**：${scopeLabels}
**创始人愿景与目标**：
${props.mission || "（创始人尚在探索中，请主动帮助厘清方向）"}

作为联合创始人，你拥有主人翁意识：不等指令，主动发现该做的事并推进，与其他创始成员及创始人 ${props.userName} 紧密协作。
`
  return base ? `${context}\n\n---\n\n${base}` : context
}
