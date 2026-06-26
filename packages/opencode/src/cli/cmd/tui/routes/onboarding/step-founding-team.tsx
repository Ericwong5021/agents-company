import { createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"
import { OnboardingFrame } from "./frame"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"
import { resolveTemplateRoles, resolveFoundingRoles, type FoundingRoleSpec } from "./founding-roles"
import { OrgTemplateService } from "@/company-agent/org-templates"
import { buildButlerPrompt } from "./prompts"

interface StepFoundingTeamProps {
  stepIndex: number
  stepCount: number
  userName: string
  assistantName: string
  templateId?: string
  scopes: string[]
  mission: string
  onComplete: (agentIDs: string[], teamNames: string[]) => void
}

interface Founder {
  id: string
  name: string
  description: string
  shortDescription: string
  icon: string
  color: string
  level: "c-suite" | "lead" | "ic"
  divisionName: string
}

// Deterministically assembles the founding team. When a templateId is provided,
// uses the org-template system for role resolution; otherwise falls back to the
// legacy scope-based path. Each role is searched and revealed one by one with
// ceremony: a "searching for…" animation, then the founder card, then a pause.
export function StepFoundingTeam(props: StepFoundingTeamProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const t = useLanguage().t
  const dialog = useDialog()
  const [founders, setFounders] = createSignal<Founder[]>([])
  const [done, setDone] = createSignal(false)
  const [showAchievement, setShowAchievement] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [searching, setSearching] = createSignal<string | null>(null)

  const templateName = () => {
    if (props.templateId) {
      const tpl = OrgTemplateService.get(props.templateId)
      return tpl?.name ?? ""
    }
    return ""
  }

  onMount(() => {
    dialog.setSize("large")
    void build()
  })

  async function build() {
    setError(null)
    setDone(false)
    setFounders([])

    // Validate required fields before starting.
    if (!props.userName || !props.assistantName) {
      setError(t("onboarding.founding_team.error"))
      return
    }

    try {
      // Resolve roles: template path (preferred) or legacy scope path.
      const roles = props.templateId
        ? resolveTemplateRoles(props.templateId) ?? resolveFoundingRoles(props.scopes)
        : resolveFoundingRoles(props.scopes)

      const created: Founder[] = []

      for (let i = 0; i < roles.length; i++) {
        const role = roles[i]
        setSearching(role.fallback.name)

        const [founder] = await Promise.all([
          createFounder(role),
          delay(1500),
        ])

        if (!founder) {
          setSearching(null)
          setError(t("onboarding.founding_team.error"))
          return
        }

        created.push(founder)
        setFounders([...created])
        setSearching(null)

        if (i < roles.length - 1) await delay(600)
      }

      setDone(true)
      setShowAchievement(true)

      const scopeLabels = props.templateId
        ? templateName()
        : props.scopes
            .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
            .join("、")

      void sdk.fetch(`${sdk.url}/company-agent/onboarding-assistant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "onboarding-assistant",
          name: props.assistantName,
          system_prompt: buildButlerPrompt({
            userName: props.userName,
            assistantName: props.assistantName,
            scopeLabels,
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
    const shortDescription = description.length > 28 ? description.slice(0, 28) + "…" : description

    try {
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
      return {
        id, name, description, shortDescription, icon, color,
        level: role.level,
        divisionName: role.divisionName ?? role.division,
      }
    } catch {
      return null
    }
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

  // Group founders by division for the org-chart style display.
  function groupedFounders() {
    const groups = new Map<string, Founder[]>()
    for (const f of founders()) {
      const list = groups.get(f.divisionName) ?? []
      list.push(f)
      groups.set(f.divisionName, list)
    }
    return groups
  }

  // Level indicator for hierarchy display.
  function levelIcon(level: string) {
    return level === "c-suite" ? "👑" : level === "lead" ? "⭐" : "·"
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
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.error}>⚠ {error()}</text>
          <box backgroundColor={theme.primary} paddingLeft={3} paddingRight={3} onMouseUp={build}>
            <text fg={theme.background}>{t("onboarding.provider.retry")}</text>
          </box>
        </box>
      </Show>

      <Show when={searching()}>
        <box flexDirection="row" justifyContent="center" alignItems="center" gap={1}>
          <Spinner color={theme.primary} />
          <text fg={theme.textMuted}>
            {t("onboarding.founding_team.matching").replace("{{role}}", searching()!)}
          </text>
        </box>
      </Show>

      <Show when={showAchievement() && !error()}>
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.warning ?? theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
            🏆 {t("onboarding.achievement.title")}
          </text>
          <text fg={theme.textMuted}>
            {t("onboarding.achievement.desc").replace("{{name}}", props.userName)}
          </text>
        </box>
      </Show>

      {/* Founder cards — grouped by division when using org templates */}
      <Show when={founders().length > 0}>
        <Show
          when={props.templateId}
          fallback={
            // Legacy flat card layout for scope-based flow
            <box flexDirection="row" gap={2} flexWrap="wrap" justifyContent="center" paddingTop={1}>
              <For each={founders()}>
                {(f) => (
                  <FounderCard founder={f} theme={theme} dialog={dialog} />
                )}
              </For>
            </box>
          }
        >
          {/* Org-chart style: grouped by division */}
          <box flexDirection="column" gap={0} paddingTop={1}>
            <For each={Array.from(groupedFounders())}>
              {([divName, members]) => (
                <box flexDirection="row" gap={2} alignItems="center">
                  <text fg={theme.primary} attributes={TextAttributes.BOLD} minWidth={10}>
                    {divName}
                  </text>
                  <box flexDirection="row" gap={2} flexWrap="wrap">
                    <For each={members}>
                      {(f) => (
                        <FounderCard founder={f} theme={theme} dialog={dialog} />
                      )}
                    </For>
                  </box>
                </box>
              )}
            </For>
          </box>
        </Show>
      </Show>

      <Show when={done()}>
        <text fg={theme.textMuted}>
          {props.templateId
            ? `${t("onboarding.template.selected")}: ${templateName()}`
            : `${t("onboarding.scope.selected")} ${props.scopes
                .map((s) => BUSINESS_SCOPE_PRESETS.find((p) => p.key === s)?.title ?? s)
                .join("、")}`}
        </text>
      </Show>
    </OnboardingFrame>
  )
}

// Shared founder card component.
function FounderCard(props: { founder: Founder; theme: any; dialog: any }) {
  return (
    <box
      flexDirection="column"
      width={22}
      backgroundColor={props.theme.backgroundElement}
      border
      borderColor={props.theme.border}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
      gap={1}
      onMouseUp={() => {
        props.dialog.replace(
          <box flexDirection="column" gap={1} padding={2}>
            <box flexDirection="row" gap={1} alignItems="center">
              <text>{props.founder.icon}</text>
              <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
                {props.founder.name}
              </text>
            </box>
            <text fg={props.theme.text}>{props.founder.description}</text>
          </box>
        )
      }}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text>{props.founder.level === "c-suite" ? "👑" : props.founder.level === "lead" ? "⭐" : " "}</text>
        <text>{props.founder.icon}</text>
        <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
          {props.founder.name}
        </text>
      </box>
      <text fg={props.theme.textMuted}>{props.founder.shortDescription}</text>
    </box>
  )
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function buildFounderPrompt(props: StepFoundingTeamProps, roleName: string, base?: string) {
  const scopeLabels = props.templateId
    ? (OrgTemplateService.get(props.templateId)?.name ?? "")
    : props.scopes
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
