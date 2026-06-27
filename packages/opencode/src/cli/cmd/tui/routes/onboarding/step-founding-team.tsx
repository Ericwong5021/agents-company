import { createSignal, For, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLanguage } from "@tui/context/language"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"
import { OnboardingFrame } from "./frame"
import { BUSINESS_SCOPE_PRESETS } from "./business-scope-cards"
import { resolveTemplateRoles, resolveFoundingRoles, type FoundingRoleSpec } from "./founding-roles"
import { OrgTemplateService } from "@/company-agent/org-templates"
import { buildButlerPrompt } from "./prompts"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { agentSkillsDir } from "@/session/checkpoint-paths"
import type { CompanyAgentID } from "@/company-agent/schema"
import { COFOUNDER_RECRUIT_SKILL } from "./cofounder-recruit-skill"

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
  const toast = useToast()
  const [founders, setFounders] = createSignal<Founder[]>([])
  const [done, setDone] = createSignal(false)
  const [showAchievement, setShowAchievement] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [searching, setSearching] = createSignal<string | null>(null)
  const [logFilePath, setLogFilePath] = createSignal<string | null>(null)

  useKeyboard((evt) => {
    if (evt.name === "return") {
      if (done()) props.onComplete(founders().map((f) => f.id), founders().map((f) => f.name))
      else if (error()) build()
    }
  })

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
      const errors: string[] = []

      for (let i = 0; i < roles.length; i++) {
        const role = roles[i]
        setSearching(role.fallback.name)

        const [result] = await Promise.all([
          createFounder(role),
          delay(1500),
        ])

        if (!result.founder) {
          setSearching(null)
          if (result.error) {
            errors.push(`[${role.fallback.name}] ${result.error}`)
          }
          const allErrors = errors.join("\n\n---\n\n")
          const logFile = await saveErrorLog(allErrors)
          const errorMessage = logFile
            ? `${t("onboarding.founding_team.error")}\n\n日志已保存到: ${logFile}`
            : t("onboarding.founding_team.error")
          setError(errorMessage)
          return
        }

        created.push(result.founder)
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
          org_layer: "board",
          system_prompt: buildButlerPrompt({
            userName: props.userName,
            assistantName: props.assistantName,
            scopeLabels,
            mission: props.mission || undefined,
            team: created.map((f) => f.name),
          }),
        }),
      }).catch(() => undefined)
    } catch (err) {
      const errorDetails = `异常错误: ${err instanceof Error ? err.message : String(err)}\n堆栈: ${err instanceof Error ? err.stack : "无堆栈信息"}`
      const logFile = await saveErrorLog(errorDetails)
      const errorMessage = logFile
        ? `${t("onboarding.founding_team.error")}\n\n日志已保存到: ${logFile}`
        : t("onboarding.founding_team.error")
      setError(errorMessage)
    }
  }

  async function createFounder(role: FoundingRoleSpec): Promise<{ founder: Founder | null; error?: string }> {
    const template = await searchTemplate(role)
    const id = `${role.division}-${role.key}-founder`
    const name = template?.name ?? role.fallback.name
    const icon = template?.emoji ?? role.fallback.icon
    const color = template?.color ?? role.fallback.color
    const description = template?.description ?? role.fallback.description
    const shortDescription = description.length > 28 ? description.slice(0, 28) + "…" : description

    // Delete any existing agent with this ID first, so retry won't hit
    // UNIQUE constraint on company_agent.id.
    await sdk.fetch(`${sdk.url}/company-agent/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined)

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
          org_layer: role.level === "c-suite" ? "board" : role.level === "lead" ? "department" : "execution",
          department: role.divisionName ?? role.division,
          reports_to: "onboarding-assistant",
          system_prompt: buildFounderPrompt(props, name, template?.system_prompt),
        }),
      })
      if (!res.ok) {
        const errorText = await res.text().catch(() => "无法读取响应内容")
        return {
          founder: null,
          error: `API 请求失败: ${res.status} ${res.statusText}\n响应内容: ${errorText}\n请求 URL: ${sdk.url}/company-agent\n请求参数: ${JSON.stringify({ id, name, description, color, icon }, null, 2)}`,
        }
      }

      // Seed the co-founders' private recruit skill so they can autonomously
      // bring in vertical specialists once the direction is settled. Best-effort:
      // a failure here must not block the founding team from assembling.
      await seedCofounderRecruitSkill(id).catch(() => undefined)

      return {
        founder: {
          id, name, description, shortDescription, icon, color,
          level: role.level,
          divisionName: role.divisionName ?? role.division,
        },
      }
    } catch (err) {
      return {
        founder: null,
        error: `异常错误: ${err instanceof Error ? err.message : String(err)}\n堆栈: ${err instanceof Error ? err.stack : "无堆栈信息"}\n角色信息: ${JSON.stringify(role, null, 2)}`,
      }
    }
  }

  async function saveErrorLog(errorDetails: string) {
    try {
      const dir = Global.Path.log
      await fs.mkdir(dir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const file = path.join(dir, `onboarding-error-${timestamp}.log`)
      const content = `[${new Date().toISOString()}] 创始团队组建失败\n\n${errorDetails}\n\n---\n用户信息: ${JSON.stringify({ userName: props.userName, assistantName: props.assistantName, templateId: props.templateId, scopes: props.scopes }, null, 2)}`
      await fs.writeFile(file, content, "utf-8")
      setLogFilePath(file)
      return file
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
          <box flexDirection="row" gap={2}>
            <box backgroundColor={theme.backgroundElement} paddingLeft={3} paddingRight={3} onMouseUp={async () => {
              const path = logFilePath() ?? error()?.match(/日志已保存到: (.+)/)?.[1]
              if (path) {
                try {
                  const content = await fs.readFile(path, "utf-8")
                  await Clipboard.copy(content)
                } catch {
                  await Clipboard.copy(error() ?? "")
                }
              } else {
                await Clipboard.copy(error() ?? "")
              }
              toast.show({ message: t("tui.toast.copied_to_clipboard"), variant: "info" })
            }}>
              <text fg={theme.text}>{t("onboarding.founding_team.copy_error")}</text>
            </box>
            <box backgroundColor={theme.primary} paddingLeft={3} paddingRight={3} onMouseUp={build}>
              <text fg={theme.background}>{t("onboarding.provider.retry")}</text>
            </box>
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

      <Show when={founders().length > 0}>
        <box flexDirection="row" gap={2} flexWrap="wrap" justifyContent="center" paddingTop={1}>
          <For each={founders()}>
            {(f) => (
              <FounderCard founder={f} theme={theme} dialog={dialog} />
            )}
          </For>
        </box>
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

// Shared founder card component — name above, compact horizontal body below.
function FounderCard(props: { founder: Founder; theme: any; dialog: any }) {
  return (
    <box flexDirection="column" gap={0} alignItems="center" width={22}>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        {props.founder.name}
      </text>
      <box
        flexDirection="row"
        backgroundColor={props.theme.backgroundElement}
        border
        borderColor={props.theme.border}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
        gap={1}
        width={22}
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
        <text>{props.founder.level === "c-suite" ? "👑" : props.founder.level === "lead" ? "⭐" : " "}</text>
        <text>{props.founder.icon}</text>
        <text fg={props.theme.textMuted}>{props.founder.shortDescription}</text>
      </box>
    </box>
  )
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Write the recruit skill into a co-founder's private skills/ folder so the
// skill system discovers it (scoped to this agent) and the co-founder can hire
// specialists via the `recruit` tool once the direction is settled.
async function seedCofounderRecruitSkill(id: string) {
  const dir = path.join(agentSkillsDir(id as CompanyAgentID), "recruit-teammate")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "SKILL.md"), COFOUNDER_RECRUIT_SKILL, "utf-8")
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
