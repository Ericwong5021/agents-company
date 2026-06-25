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

interface StepFoundingTeamProps {
  stepIndex: number
  stepCount: number
  userName: string
  assistantName: string
  scopes: string[]
  mission: string
  onComplete: (agentIDs: string[]) => void
}

interface Founder {
  id: string
  name: string
  description: string
  icon: string
  color: string
}

// Deterministically assembles the founding team from the bundled template
// library. The assistant's "create agent" capability is exercised here: for each
// resolved role we pull the best-matching template and create a Company Agent
// with a company-contextualised system prompt. No reliance on model output.
export function StepFoundingTeam(props: StepFoundingTeamProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const dialog = useDialog()
  const [founders, setFounders] = createSignal<Founder[]>([])
  const [building, setBuilding] = createSignal(true)
  const [visible, setVisible] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    dialog.setSize("large")
    void build()
  })

  async function build() {
    setError(null)
    setBuilding(true)
    setFounders([])
    setVisible(0)

    try {
      const created: Founder[] = []
      for (const role of resolveFoundingRoles(props.scopes)) {
        const founder = await createFounder(role)
        if (founder) created.push(founder)
      }

      if (created.length === 0) {
        setError(t("onboarding.founding_team.error"))
        return
      }

      setFounders(created)
      setBuilding(false)
      // Stagger the reveal of the founder cards for the achievement moment.
      created.forEach((_, i) => setTimeout(() => setVisible((v) => v + 1), 400 * (i + 1)))
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

  const revealed = () => !building() && visible() >= founders().length

  return (
    <OnboardingFrame
      stepIndex={props.stepIndex}
      stepCount={props.stepCount}
      title={t("onboarding.founding_team.title")}
      footer={
        <Show when={revealed()}>
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
              onMouseUp={() => props.onComplete(founders().map((f) => f.id))}
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

      <Show when={building() && !error()}>
        <box alignItems="center" paddingTop={1} paddingBottom={1}>
          <Spinner color={theme.primary}>{t("onboarding.founding_team.assembling")}</Spinner>
        </box>
      </Show>

      {/* Achievement banner */}
      <Show when={!building() && !error()}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.warning ?? theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
            🏆 {t("onboarding.achievement.title")}
          </text>
          <text fg={theme.textMuted}>
            {t("onboarding.achievement.desc").replace("{{name}}", props.userName)}
          </text>
        </box>

        {/* Founder identity cards */}
        <box flexDirection="row" gap={2} flexWrap="wrap" justifyContent="center" paddingTop={1}>
          <For each={founders()}>
            {(f, index) => (
              <Show when={index() < visible()}>
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
              </Show>
            )}
          </For>
        </box>

        <Show when={revealed()}>
          <text fg={theme.textMuted}>
            {t("onboarding.scope.selected")}{" "}
            {props.scopes
              .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
              .join("、")}
          </text>
        </Show>
      </Show>
    </OnboardingFrame>
  )
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
