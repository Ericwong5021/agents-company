import type { TuiPlugin, TuiPluginModule } from "@agents-company/plugin/tui"
import { createMemo, createResource, createSignal, createEffect, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useRightSidebar } from "../../context/right-sidebar"
import { useEvent } from "../../context/event"
import { useToast } from "../../ui/toast"
import { Card } from "../../component/card"
import { AgentCard } from "./agent-card"
import {
  buildOfficeModel,
  flattenCollaborationNodes,
  formatTokens,
  type AgentStatus,
  type CompanyAgentInfo,
  type ProjectTokenStats,
  type ThreadInfo,
  type WorkstationStatus,
} from "./workstation-model"

const id = "internal:nav-workstation"

// ---------------------------------------------------------------------------
// WorkstationView
// ---------------------------------------------------------------------------

function WorkstationView() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const route = useRoute()
  const rightSidebar = useRightSidebar()
  const event = useEvent()
  const toast = useToast()

  const [refetch, setRefetch] = createSignal(0)

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const [agents] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })

  const [allThreads] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/thread`)
    if (!res.ok) return [] as ThreadInfo[]
    return (await res.json()) as ThreadInfo[]
  })

  const [workstationStatus] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/workstation/status`)
    if (!res.ok) return undefined
    return (await res.json()) as WorkstationStatus
  })

  const [projectTokenStats] = createResource(
    () => workstationStatus()?.project.id,
    async (projectID) => {
      if (!projectID) return undefined
      const res = await sdk.fetch(`${sdk.url}/project/${encodeURIComponent(projectID)}/token-stats`)
      if (!res.ok) return undefined
      return (await res.json()) as ProjectTokenStats
    },
  )

  const [agentStatuses] = createResource(refetch, async () => {
    const list = agents()
    if (!list) return {} as Record<string, AgentStatus>
    const entries = await Promise.all(
      list.map(async (a) => {
        const res = await sdk.fetch(`${sdk.url}/thread/agent/${encodeURIComponent(a.id)}/status`)
        if (!res.ok) return [a.id, "idle" as AgentStatus] as const
        const data = (await res.json()) as { status: AgentStatus }
        return [a.id, data.status] as const
      }),
    )
    return Object.fromEntries(entries) as Record<string, AgentStatus>
  })

  // -------------------------------------------------------------------------
  // Real-time updates via bus events
  // -------------------------------------------------------------------------

  const bump = () => setRefetch((n) => n + 1)

  event.on("thread.created", bump)
  event.on("thread.updated", bump)
  event.on("thread.completed", bump)

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleStart = async (agentID: string) => {
    const res = await sdk.fetch(`${sdk.url}/thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentID,
        kind: "primary",
        description: t("tui.workstation.action.start_description"),
      }),
    })
    if (!res.ok) {
      toast.show({ variant: "error", message: t("tui.workstation.action.start_failed") })
    } else {
      toast.show({ variant: "info", message: t("tui.workstation.action.start_success") })
      bump()
    }
  }

  const handleStop = async (agentID: string) => {
    const threads = (allThreads() ?? []).filter(
      (t) => t.agentID === agentID && t.status === "active",
    )
    if (threads.length === 0) return

    const results = await Promise.all(
      threads.map(async (thread) => {
        const res = await sdk.fetch(`${sdk.url}/thread/${thread.id}/complete`, {
          method: "POST",
        })
        return res.ok
      }),
    )

    const allOk = results.every(Boolean)
    if (!allOk) {
      toast.show({ variant: "error", message: t("tui.workstation.action.stop_failed") })
    } else {
      toast.show({ variant: "info", message: t("tui.workstation.action.stop_success") })
      bump()
    }
  }

  const handleConfigure = (agentID: string) => {
    route.navigate({ type: "plugin", id: "agent-management", data: { agentID } })
  }

  const handleApproval = async (messageID: string, decision: "approve" | "reject") => {
    const res = await sdk.fetch(`${sdk.url}/workstation/approval/${encodeURIComponent(messageID)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, actorAgentID: "user" }),
    })
    if (!res.ok) {
      toast.show({ variant: "error", message: t("tui.workstation.approval.failed") })
      return
    }
    toast.show({
      variant: "info",
      message: decision === "approve" ? t("tui.workstation.approval.approved") : t("tui.workstation.approval.rejected"),
    })
    bump()
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const office = createMemo(() =>
    buildOfficeModel({
      agents: agents() ?? [],
      statuses: agentStatuses() ?? {},
      threads: allThreads() ?? [],
      workstation: workstationStatus(),
      tokenStats: projectTokenStats(),
    }),
  )
  const workstationAgents = createMemo(() => office().agents)
  const summary = createMemo(() => office().summary)

  // -------------------------------------------------------------------------
  // Right sidebar
  // -------------------------------------------------------------------------

  createEffect(() => {
    const list = workstationAgents()
    const s = summary()

    rightSidebar.set(() => (
      <box height="100%" flexDirection="column">
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <text fg={theme.textMuted}>
            <b>{t("tui.shell.right.workstation")}</b>
          </text>
        </box>

        {/* Quick stats */}
        <Card flush>
          <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{s.activeAgents}</text>/{s.totalAgents}
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{s.totalThreads}</text>
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{s.openTasks}</text>
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tokens")}: <text fg={theme.accent}>{formatTokens(s.trackedTokens)}</text>
            </text>
            <Show when={s.pendingApprovals > 0}>
              <text fg={theme.warning}>
                {t("tui.workstation.summary.approvals")}: {s.pendingApprovals}
              </text>
            </Show>
          </box>
        </Card>

        <Show when={office().project?.blocked}>
          <Card flush>
            <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
              <text fg={theme.error}>{t("tui.workstation.project.blocked")}</text>
              <text fg={theme.textMuted}>{office().project?.blocked_reason}</text>
            </box>
          </Card>
        </Show>

        {/* Agent list */}
        <box flexShrink={0} paddingTop={1} paddingBottom={0}>
          <text fg={theme.textMuted}>
            <b>{t("tui.workstation.agents")}</b>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={list}>
              {(a) => {
                const statusConfig = {
                  idle: { icon: "●", colorKey: "success" as const },
                  busy: { icon: "◉", colorKey: "warning" as const },
                  paused: { icon: "◐", colorKey: "textMuted" as const },
                }
                const cfg = statusConfig[a.status]
                return (
                  <box
                    flexShrink={0}
                    paddingTop={0}
                    paddingBottom={0}
                    onMouseUp={() => handleConfigure(a.id)}
                  >
                    <text>
                      <text fg={theme[cfg.colorKey]}>{cfg.icon}</text>
                      <text fg={theme.text}>
                        {" "}
                        {a.icon ? a.icon + " " : ""}
                        {a.name}
                      </text>
                      <Show when={a.department}>
                        <text fg={theme.textMuted}> ({a.department})</text>
                      </Show>
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>

        {/* Quick actions */}
        <box flexShrink={0} paddingTop={1} border={["top"]} borderColor={theme.border}>
          <box onMouseUp={() => route.navigate({ type: "plugin", id: "agent-management" })}>
            <text fg={theme.accent}>+ {t("tui.workstation.create_agent")}</text>
          </box>
        </box>
      </box>
    ))
  })

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      {/* Header */}
      <box flexShrink={0} flexDirection="row" alignItems="center" gap={1} paddingTop={1}>
        <text fg={theme.text}>
          <b>{t("tui.shell.route.workstation")}</b>
        </text>
        <text fg={theme.textMuted}>({summary().totalAgents})</text>
        <box flexGrow={1} />
        <box onMouseUp={bump}>
          <text fg={theme.accent}>{t("tui.workstation.refresh")}</text>
        </box>
        <box onMouseUp={() => route.navigate({ type: "plugin", id: "agent-management" })}>
          <text fg={theme.accent}>+ {t("tui.workstation.add_agent")}</text>
        </box>
      </box>

      <scrollbox flexGrow={1}>
        <box flexDirection="column" gap={1} paddingTop={1}>
          {/* Summary bar */}
          <box
            flexShrink={0}
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
            backgroundColor={theme.backgroundElement}
            border={["top", "left", "right", "bottom"]}
            borderColor={theme.border}
          >
            <text fg={theme.text}>
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents}
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{summary().openTasks}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={summary().pendingApprovals > 0 ? theme.warning : theme.text}>
              {t("tui.workstation.summary.approvals")}: <text fg={theme.accent}>{summary().pendingApprovals}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={summary().blocked ? theme.error : theme.text}>
              {summary().blocked ? t("tui.workstation.project.blocked") : t("tui.workstation.project.running")}
            </text>
          </box>

          <box
            flexShrink={0}
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundElement}
            border={["left", "right", "bottom"]}
            borderColor={theme.border}
          >
            <text fg={theme.text}>
              {t("tui.workstation.presence.busy")}: <text fg={theme.warning}>{office().presence.busy}</text>
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.presence.idle")}: <text fg={theme.success}>{office().presence.idle}</text>
            </text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tokens")}: <text fg={theme.accent}>{formatTokens(summary().trackedTokens)}</text>
            </text>
            <Show when={summary().observedTokens > 0}>
              <text fg={theme.text}>
                {t("tui.workstation.summary.observed")}: <text fg={theme.accent}>{formatTokens(summary().observedTokens)}</text>
              </text>
            </Show>
          </box>

          <Show when={office().approvals.length > 0}>
            <box flexShrink={0} flexDirection="column" gap={0}>
              <text fg={theme.warning}>
                <b>{t("tui.workstation.approval.title")}</b>
              </text>
              <For each={office().approvals}>
                {(approval) => (
                  <box
                    flexShrink={0}
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    border={["left"]}
                    borderColor={theme.warning}
                  >
                    <text fg={theme.text}>
                      {approval.from_agent_id} → {approval.to_agent_id}
                      <Show when={approval.task_summary}>
                        <text fg={theme.textMuted}> · {approval.task_summary}</text>
                      </Show>
                    </text>
                    <text fg={theme.textMuted}>{approval.body.split("\n")[0]}</text>
                    <box flexDirection="row" gap={2}>
                      <box onMouseUp={() => handleApproval(approval.id, "approve")}>
                        <text fg={theme.success}>{t("tui.workstation.approval.approve")}</text>
                      </box>
                      <box onMouseUp={() => handleApproval(approval.id, "reject")}>
                        <text fg={theme.error}>{t("tui.workstation.approval.reject")}</text>
                      </box>
                    </box>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <Show when={office().collaborationTrees.length > 0}>
            <box flexShrink={0} flexDirection="column" gap={0}>
              <text fg={theme.text}>
                <b>{t("tui.workstation.collaboration.title")}</b>
              </text>
              <For each={office().collaborationTrees}>
                {(tree) => (
                  <box flexShrink={0} flexDirection="column" paddingLeft={1} border={["left"]} borderColor={theme.border}>
                    <text fg={theme.textMuted}>
                      {tree.root_need_id} · {tree.total_messages} {t("tui.workstation.collaboration.messages")}
                    </text>
                    <For each={flattenCollaborationNodes(tree.nodes)}>
                      {(row) => (
                        <text fg={row.node.outcome === "needs_approval" ? theme.warning : theme.textMuted}>
                          {"  ".repeat(row.level)}
                          {row.node.kind}: {row.node.from_agent_id} → {row.node.to_agent_id}
                          <Show when={row.node.task_summary}>
                            <text fg={theme.text}> · {row.node.task_summary}</text>
                          </Show>
                          <Show when={row.node.outcome}>
                            <text fg={theme.accent}> [{row.node.outcome}]</text>
                          </Show>
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </Show>

          {/* Agent cards */}
          <box flexShrink={0} flexDirection="column" gap={1}>
            <For each={workstationAgents()}>
              {(agent) => (
                <AgentCard
                  agent={agent}
                  onStart={handleStart}
                  onStop={handleStop}
                  onConfigure={handleConfigure}
                />
              )}
            </For>

            <Show when={workstationAgents().length === 0}>
              <text fg={theme.textMuted}>{t("tui.workstation.empty")}</text>
            </Show>
          </box>

          {/* Bottom separator and summary */}
          <box flexShrink={0} paddingTop={1}>
            <text fg={theme.textMuted}>
              {"─".repeat(50)}
            </text>
          </box>
          <box flexShrink={0} flexDirection="row" gap={2}>
            <text fg={theme.text}>
              {t("tui.workstation.summary.active")}: <text fg={theme.accent}>{summary().activeAgents}</text>/{summary().totalAgents}
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.threads")}: <text fg={theme.accent}>{summary().totalThreads}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tasks")}: <text fg={theme.accent}>{summary().openTasks}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.approvals")}: <text fg={theme.accent}>{summary().pendingApprovals}</text>
            </text>
            <text fg={theme.textMuted}>{"│"}</text>
            <text fg={theme.text}>
              {t("tui.workstation.summary.tokens")}: <text fg={theme.accent}>{formatTokens(summary().trackedTokens)}</text>
            </text>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "workstation",
      render: () => <WorkstationView />,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
