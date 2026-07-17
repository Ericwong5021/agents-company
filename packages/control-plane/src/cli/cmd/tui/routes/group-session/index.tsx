import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { useRouteData, useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "../../ui/toast"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useKeybind } from "@tui/context/keybind"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useExit } from "@tui/context/exit"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useLanguage } from "../../context/language"
import { Autocomplete, type AutocompleteRef } from "@tui/component/prompt/autocomplete"
import { useRightSidebar } from "@tui/context/right-sidebar"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../context/tui-config"
import { NavRow } from "../../component/nav-row"
import * as Clipboard from "../../util/clipboard"

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  color?: string
  icon?: string
}

interface GroupMember {
  sessionID: string
  companyAgentID: string
  position: number
}

interface GroupSessionInfo {
  id: string
  projectID: string
  title: string
  members: GroupMember[]
  time: { created: number; updated: number; archived?: number }
}

interface GroupMessage {
  id: string
  groupSessionID: string
  roundNum: number
  role: "user" | "agent"
  companyAgentID?: string
  sessionID?: string
  content: string
  statusSummary?: string
  time: { created: number; updated: number }
}

interface BiddingBidEntry {
  agentId: string
  level: "must" | "want" | "could" | "pass"
  type: "objection" | "answer" | "question" | "claim" | "info" | "support"
  addressedAs: "direct" | "mention" | "none"
  reason: string
  score: number
  eligible: boolean
}

interface BiddingRoundDisplay {
  roundNum: number
  status: "probing" | "resolved"
  winnerId: string | null
  bids: BiddingBidEntry[]
}

export function GroupSession() {
  const route = useRouteData("group-session")
  const fullRoute = useRoute()
  const navigate = fullRoute.navigate
  const sync = useSync()
  const event = useEvent()
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()
  const keybind = useKeybind()
  const tuiConfig = useTuiConfig()
  const command = useCommandDialog()
  const exit = useExit()
  const dialog = useDialog()
  const t = useLanguage().t
  const { syntax } = useTheme()

  let scroll: any
  let textarea: any
  let promptAnchor: any
  let promptPartTypeId = 0

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!

  // The group prompt only supports client-side slash commands (the global
  // command palette's `/…` entries). Unlike a single session, group input
  // fans out to every member agent, so @file attachments, $agent picks, and
  // per-session server commands (/compact, /undo, …) don't apply — the
  // Autocomplete's slashCommandsOnly mode restricts the popup accordingly.
  const [autocompleteRef, setAutocompleteRef] = createSignal<AutocompleteRef | undefined>()

  const rightSidebar = useRightSidebar()
  // The right sidebar (member list + workspace) is now rendered by the shell;
  // this route publishes its content (the shell decides visibility/width).

  // ---- fetch group session + messages + agents ----
  const [infoResource, { refetch: refetchInfo }] = createResource(() => route.groupSessionID, async (id) => {
    const res = await sdk.fetch(`${sdk.url}/group-session/${id}`)
    if (!res.ok) return undefined
    return (await res.json()) as GroupSessionInfo
  })
  const [messagesResource, { refetch: refetchMessages }] = createResource(
    () => route.groupSessionID,
    async (id) => {
      const res = await sdk.fetch(`${sdk.url}/group-session/${id}/messages`)
      if (!res.ok) return [] as GroupMessage[]
      return (await res.json()) as GroupMessage[]
    },
  )
  const [agentsResource] = createResource(async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })

  const info = createMemo(() => infoResource())
  const agents = createMemo(() => agentsResource() ?? [])
  const agentByID = createMemo(() => {
    const map: Record<string, CompanyAgentInfo> = {}
    for (const a of agents()) map[a.id] = a
    return map
  })

  // sync each member session so streaming events populate the store
  createEffect(() => {
    const i = info()
    if (!i) return
    for (const m of i.members) void sync.session.sync(m.sessionID)
  })

  // reload group messages when the group rounds complete / refresh
  const [messagesRev, setMessagesRev] = createSignal(0)
  createResource(messagesRev, async () => {
    if (!info()) return
    await refetchMessages()
  })

  // ---- optimistic user message (instant bubble before POST returns) ----
  const [optimisticUser, setOptimisticUser] = createSignal<GroupMessage | null>(null)

  // ---- per-agent working state (driven by agent_started / agent_completed events) ----
  const [workingAgents, setWorkingAgents] = createSignal<
    Record<string, { companyAgentID: string; roundNum: number }>
  >({})

  // ---- bidding phase state (driven by group_session.bidding_* events) ----
  const [biddingRounds, setBiddingRounds] = createSignal<BiddingRoundDisplay[]>([])
  const [biddingActive, setBiddingActive] = createSignal(false)

  const currentBiddingRound = createMemo(() => {
    const rounds = biddingRounds()
    return rounds.length > 0 ? rounds[rounds.length - 1] : undefined
  })

  // ---- per-member live state derived from sync store ----
  // Only depends on session_status, which flips on busy/idle transitions —
  // NOT on message/part deltas. This keeps the memo (and the <For> over it)
  // from recomputing on every SSE text delta, which was the other half of
  // the flicker. Streaming text is intentionally not tracked here; the
  // finalized content arrives via refetchMessages → GroupMessageView.
  const memberState = createMemo(() => {
    const i = info()
    if (!i) return [] as {
      member: GroupMember
      agent: CompanyAgentInfo | undefined
      status: string
      busy: boolean
    }[]
    return i.members.map((member) => {
      const agent = agentByID()[member.companyAgentID]
      const status = sync.data.session_status?.[member.sessionID]?.type ?? "idle"
      const busy = status === "busy"
      return { member, agent, status, busy }
    })
  })

  // Working entries derived from workingAgents signal (event-driven).
  // Each agent_started event adds an entry; agent_completed removes it.
  // This drives the LiveCard rendering — agents appear simultaneously.
  const workingEntries = createMemo(() => {
    const agents = agentByID()
    const entries = workingAgents()
    return Object.entries(entries).map(([sessionID, entry]) => {
      const agent = agents[entry.companyAgentID]
      return { sessionID, companyAgentID: entry.companyAgentID, agent, roundNum: entry.roundNum }
    })
  })

  const groupBusy = createMemo(() => biddingActive() || workingEntries().length > 0 || memberState().some((m) => m.busy))
  const anyMember = createMemo(() => memberState().length > 0)

  // Publish the member-list sidebar to the shell's right column. Re-runs when
  // info / member live state change so busy indicators stay current.
  createEffect(() => {
    const i = info()
    const members = memberState()
    if (!i) {
      rightSidebar.set(null)
      return
    }
    rightSidebar.set(() => (
      <GroupSessionSidebar
        title={i.title}
        members={members}
        onOpen={(sessionID) =>
          navigate({ type: "session", sessionID, groupSessionID: route.groupSessionID })
        }
      />
    ))
  })

  // When the group becomes idle after being busy, reload messages to pick up
  // the finalized group-level agent responses.
  let wasBusy = false
  createEffect(() => {
    const busy = groupBusy()
    if (wasBusy && !busy) {
      void refetchInfo()
      setMessagesRev((n) => n + 1)
    }
    wasBusy = busy
  })

  // F-ghost-busy: a member's busy→idle transition reaches the store only via
  // the session.status SSE event, which is drop-oldest under streaming
  // backpressure (event.ts AsyncQueue, capacity 10k). If that event is dropped
  // the member card sticks on "working" until the user interrupts. The server
  // re-asserts every member to idle when the round ends (group-session.ts),
  // emitting fresh idle events then — but as a final catch-up, when we DO see
  // any member session go idle we make sure the store is reconciled against the
  // server's authoritative status map so a single missed event can't strand a
  // sibling card in "busy". (The reconcile is cheap and idempotent.)
  onMount(() => {
    return event.subscribe((ev) => {
      switch (ev.type) {
        // When any member goes idle, reconcile the whole status map.
        // This catches dropped idle events under streaming backpressure.
        case "session.idle": {
          const i = info()
          if (!i?.members.some((m) => m.sessionID === ev.properties.sessionID)) return
          void sync.session.reconcileStatus()
          break
        }
        // User message persisted → clear optimistic bubble, clear bidding state, refetch real data
        case "group_session.user_message_persisted": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setOptimisticUser(null)
          setBiddingRounds([])
          setBiddingActive(false)
          void refetchMessages()
          toBottom()
          break
        }
        // Bidding round started → add a probing entry
        case "group_session.bidding_started": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setBiddingActive(true)
          setBiddingRounds((prev) => [
            ...prev,
            {
              roundNum: ev.properties.roundNum,
              status: "probing",
              winnerId: null,
              bids: [],
            },
          ])
          break
        }
        // Bidding round completed → fill in bids + winner on the last entry
        case "group_session.bidding_completed": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setBiddingRounds((prev) => {
            if (prev.length === 0) return prev
            const next = [...prev]
            next[next.length - 1] = {
              roundNum: next[next.length - 1].roundNum,
              status: "resolved",
              winnerId: ev.properties.winnerId,
              bids: ev.properties.bids,
            }
            return next
          })
          break
        }
        // Turn yielded → bidding phase is over
        case "group_session.turn_yielded": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setBiddingActive(false)
          break
        }
        // Agent started → add to workingAgents
        case "group_session.agent_started": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setWorkingAgents((prev) => ({
            ...prev,
            [ev.properties.sessionID]: {
              companyAgentID: ev.properties.companyAgentID,
              roundNum: ev.properties.roundNum,
            },
          }))
          break
        }
        // Agent completed → remove from workingAgents, refetch messages
        case "group_session.agent_completed": {
          if (ev.properties.groupSessionID !== route.groupSessionID) return
          setWorkingAgents((prev) => {
            const next = { ...prev }
            delete next[ev.properties.sessionID]
            return next
          })
          void refetchMessages()
          toBottom()
          break
        }
      }
    })
  })

  function openBiddingDialog() {
    const rounds = biddingRounds()
    if (rounds.length === 0) return
    const agents = agentByID()
    dialog.setSize("xlarge")
    dialog.replace(
      <BiddingDetailsDialog rounds={rounds} agentByID={agents} />,
    )
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 30)
  }

  // group the stored messages by round for rendering
  const groupedMessages = createMemo(() => {
    const msgs = messagesResource() ?? []
    const rounds: GroupMessage[][] = []
    let curRound = -1
    for (const m of msgs) {
      if (m.roundNum !== curRound) {
        rounds.push([])
        curRound = m.roundNum
      }
      rounds[rounds.length - 1].push(m)
    }
    return rounds
  })

  // ---- input ----
  const [inputText, setInputText] = createSignal("")

  // /copy — copy the group session transcript (grouped by round) to the
  // clipboard. Mirrors the single-session /copy, but the transcript here is
  // the group-level visible history (user messages + each agent's response),
  // not a single session's tool/part stream.
  command.register(() => [
    {
      title: "Copy group transcript",
      value: "group-session.copy",
      category: "session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const i = info()
          const rounds = groupedMessages()
          const lines: string[] = []
          if (i) lines.push(`# ${i.title}`, "")
          for (const round of rounds) {
            const roundNum = round[0]?.roundNum ?? 0
            lines.push(`## Round ${roundNum + 1}`)
            for (const msg of round) {
              const who =
                msg.role === "user"
                  ? "User"
                  : (agentByID()[msg.companyAgentID ?? ""]?.name ?? msg.companyAgentID ?? "Agent")
              const body = msg.content || (msg.statusSummary === "error" ? "(error)" : "(no output)")
              lines.push(`**${who}**: ${body}`)
            }
            lines.push("")
          }
          const transcript = lines.join("\n").trim()
          if (!transcript) {
            toast.show({ message: "Nothing to copy", variant: "warning" })
            dialog.clear()
            return
          }
          await Clipboard.copy(transcript)
          toast.show({ message: "Group transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy group transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
  ])

  async function send() {
    const raw = textarea && !textarea.isDestroyed ? textarea.plainText : inputText()
    const text = raw.trim()
    if (!text) return
    // While the slash menu is open, Enter is intercepted by the autocomplete's
    // onKeyDown (it preventDefaults), so submit never reaches here. Guard
    // anyway in case a non-keyboard path fires send().
    if (autocompleteRef()?.visible) return
    // Client-side slash commands (e.g. /group, /company-agents, /theme) are
    // global palette entries — trigger them directly instead of fanning the
    // literal "/group" text out to every member agent. This mirrors how the
    // session prompt handles a typed slash command without the menu open.
    const clientSlash = text.startsWith("/")
      ? command.slashes().find((s) => s.display === text)
      : undefined
    if (clientSlash) {
      setInputText("")
      if (textarea && !textarea.isDestroyed) textarea.clear()
      clientSlash.onSelect?.()
      return
    }
    if (groupBusy()) {
      toast.show({ variant: "warning", message: "Agents are still responding" })
      return
    }
    // Optimistic: immediately show the user bubble before the POST returns.
    // The server persists the user message and returns roundNum, then the
    // UserMessagePersisted event clears the optimistic bubble and refetches
    // the real data.
    // Reset bidding state for the new user turn.
    setBiddingRounds([])
    setBiddingActive(false)
    const now = Date.now()
    setOptimisticUser({
      id: `optimistic-${now}`,
      groupSessionID: route.groupSessionID,
      roundNum: 0, // will be corrected by refetch
      role: "user",
      content: text,
      time: { created: now, updated: now },
    })

    setInputText("")
    if (textarea && !textarea.isDestroyed) textarea.clear()
    toBottom()

    const res = await sdk.fetch(`${sdk.url}/group-session/${route.groupSessionID}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (res.status === 409) {
      // Server rejected because group is busy — roll back optimistic bubble
      setOptimisticUser(null)
      toast.show({ variant: "warning", message: "Group session is busy" })
      return
    }
    if (!res.ok) {
      // Server error — roll back optimistic bubble
      setOptimisticUser(null)
      toast.show({ variant: "error", message: "Failed to send message" })
      return
    }
    // POST succeeded — the server persisted the user message and forked
    // the agent fan-out. The UserMessagePersisted event will fire shortly
    // and clear the optimistic bubble + refetch real data.
  }

  async function interrupt() {
    if (!groupBusy()) return
    await sdk.fetch(`${sdk.url}/group-session/${route.groupSessionID}/interrupt`, { method: "POST" })
  }

  // Ctrl+C (app_exit): first press interrupts busy agents, second press shows exit dialog
  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      if (groupBusy()) {
        void interrupt()
        return
      }
      void DialogConfirm.show(dialog, t("tui.dialog.exit.title"), t("tui.dialog.exit.message")).then((result) => {
        if (result) void exit()
      })
    }
  })

  onMount(() => {
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed && !groupBusy()) textarea.focus()
    }, 1)
  })

  createEffect(() => {
    if (groupBusy()) {
      if (textarea && !textarea.isDestroyed) {
        textarea.traits = { suspend: true, status: "BUSY" }
        textarea.blur()
      }
    } else {
      if (textarea && !textarea.isDestroyed) {
        textarea.traits = {}
        textarea.focus()
      }
    }
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
        {/* header */}
        <box flexShrink={0} paddingTop={0} paddingBottom={0}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {info()?.title ?? "Group Session"}
          </text>
          {/* Spinner must stay a sibling of <text>, not a child — TextNodeRenderable
              only accepts strings/TextNodeRenderables/StyledText, so nesting a
              <Spinner> inside <text> throws when groupBusy() flips on. */}
          <box flexDirection="row">
            <text fg={theme.textMuted}>
              {"  ·  "}
              {memberState().length} agents
            </text>
            <Show when={groupBusy()}>
              <text fg={theme.textMuted}>{"  ·  "}</text>
              <Spinner color={theme.warning}>working</Spinner>
            </Show>
          </box>
        </box>

        <Show
          when={info()}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <Spinner color={theme.textMuted}>Loading group session…</Spinner>
            </box>
          }
        >
          <scrollbox
            ref={(r: any) => (scroll = r)}
            flexGrow={1}
            viewportOptions={{
              paddingRight: 1,
            }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              visible: true,
              trackOptions: {
                backgroundColor: theme.backgroundElement,
                foregroundColor: theme.border,
              },
            }}
            stickyScroll={true}
            stickyStart="bottom"
            scrollAcceleration={scrollAcceleration()}
          >
            <box height={1} />

            {/* stored group conversation */}
            <For each={groupedMessages()}>
              {(round, roundIndex) => (
                <box marginTop={roundIndex() === 0 ? 0 : 1} flexDirection="column">
                  <For each={round}>
                    {(msg) => (
                      <Show when={msg.content || msg.role === "user"}>
                        <GroupMessageView
                          msg={msg}
                          agent={agentByID()[msg.companyAgentID ?? ""]}
                          members={info()!.members}
                          onJump={(sessionID) => navigate({ type: "session", sessionID, groupSessionID: route.groupSessionID })}
                        />
                      </Show>
                    )}
                  </For>
                </box>
              )}
            </For>

            {/* optimistic user bubble (shown before server confirms) */}
            <Show when={optimisticUser()}>
              {(u) => (
                <box marginTop={1}>
                  <GroupMessageView
                    msg={u()}
                    agent={undefined}
                    members={info()?.members ?? []}
                    onJump={() => {}}
                  />
                </box>
              )}
            </Show>

          </scrollbox>

          {/* ---- status bar area (below scrollbox, always at bottom) ---- */}
          <Show when={currentBiddingRound()}>
            {(round) => (
              <box flexShrink={0}>
                <BiddingStatusBar
                  round={round()}
                  onClick={openBiddingDialog}
                />
              </box>
            )}
          </Show>
          <Show when={workingEntries().length > 0}>
            <box flexShrink={0} flexDirection="column" gap={1}>
              <For each={workingEntries()}>
                {(w, i) => (
                  <LiveCard
                    agent={w.agent}
                    color={agentColor(theme, w.agent, i())}
                    status="busy"
                    onClick={() => navigate({ type: "session", sessionID: w.sessionID, groupSessionID: route.groupSessionID })}
                  />
                )}
              </For>
            </box>
          </Show>

          {/* input footer */}
          <box flexShrink={0} paddingBottom={1} paddingTop={1} gap={1}>
            {/* Autocomplete renders as an absolute-positioned popup anchored
                above this box. slashCommandsOnly restricts it to client-side
                /commands — @files and $agents don't apply to a group fan-out. */}
            <Autocomplete
              value={inputText()}
              setPrompt={() => {}}
              setExtmark={() => {}}
              anchor={() => promptAnchor}
              input={() => textarea}
              ref={(r) => setAutocompleteRef(() => r)}
              fileStyleId={fileStyleId}
              agentStyleId={agentStyleId}
              promptPartTypeId={() => promptPartTypeId}
              slashCommandsOnly
            />
            <box ref={(r: any) => (promptAnchor = r)} flexGrow={1}>
              <textarea
                ref={(v: any) => {
                  textarea = v
                  if (promptPartTypeId === 0) {
                    promptPartTypeId = v.extmarks.registerType("prompt-part")
                  }
                }}
                height={3}
                keyBindings={groupBusy() ? [] : [{ name: "return", action: "submit" }]}
                onContentChange={() => {
                  // ContentChangeEvent carries no payload; read the buffer
                  // directly (mirrors the session Prompt's onContentChange).
                  const value = textarea && !textarea.isDestroyed ? textarea.plainText : ""
                  setInputText(value)
                  autocompleteRef()?.onInput(value)
                }}
                onKeyDown={(e: any) => {
                  // Let the autocomplete handle nav/escape/return/tab while the
                  // menu is open, plus the "/" trigger when closed. These call
                  // e.preventDefault() so the textarea never sees the key.
                  autocompleteRef()?.onKeyDown(e)
                }}
                onSubmit={() => void send()}
                placeholder={groupBusy() ? "Waiting for all agents to finish…" : "Message all agents…  (/ for commands, enter to send)"}
                placeholderColor={theme.textMuted}
                textColor={groupBusy() ? theme.textMuted : theme.text}
                focusedTextColor={groupBusy() ? theme.textMuted : theme.text}
                cursorColor={theme.text}
              />
            </box>
            <Show when={groupBusy()}>
              <box onMouseUp={() => void interrupt()}>
                <text fg={theme.warning}>interrupt</text>
              </box>
            </Show>
          </box>
        </Show>
      </box>
  )
}

// Right-sidebar content for the group-session route: title + member list with
// live busy status. Rendered by the shell via the RightSidebarProvider.
type MemberStateEntry = {
  member: GroupMember
  agent: CompanyAgentInfo | undefined
  status: string
  busy: boolean
}

function GroupSessionSidebar(props: {
  title: string
  members: MemberStateEntry[]
  onOpen: (sessionID: string) => void
}) {
  const { theme } = useTheme()
  return (
    <box height="100%" flexDirection="column">
      <scrollbox flexGrow={1}>
        <box flexShrink={0} gap={1} paddingRight={1}>
          <box paddingRight={1}>
            <text fg={theme.text}>
              <b>{props.title ?? "Group Session"}</b>
            </text>
            <text fg={theme.textMuted}>{props.members.length} agents in session</text>
          </box>
          <For each={props.members}>
            {(s, i) => (
              <NavRow
                onSelect={() => props.onOpen(s.member.sessionID)}
              >
                <text fg={agentColor(theme, s.agent, i())}>
                  <b>{s.agent?.icon ? s.agent.icon + " " : ""}{s.agent?.name ?? "Agent"}</b>
                </text>
                <Show when={s.busy}>
                  <Spinner color={theme.textMuted}>working</Spinner>
                </Show>
                <Show when={!s.busy}>
                  <text fg={theme.textMuted}>· click to open</text>
                </Show>
              </NavRow>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}

function GroupMessageView(props: {
  msg: GroupMessage
  agent: CompanyAgentInfo | undefined
  members: GroupMember[]
  onJump: (sessionID: string) => void
}) {
  const { theme, syntax } = useTheme()
  if (props.msg.role === "user") {
    return (
      <box marginTop={1}>
        <box border={["left"]} borderColor={theme.textMuted} customBorderChars={SplitBorder.customBorderChars}>
          <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
            <text fg={theme.text}>{props.msg.content}</text>
          </box>
        </box>
      </box>
    )
  }
  const idx = props.members.findIndex((m) => m.companyAgentID === props.msg.companyAgentID)
  const color = props.agent?.color
    ? props.agent.color.startsWith("#")
      ? props.agent.color
      : ((theme as any)[props.agent.color] ?? theme.accent)
    : [theme.secondary, theme.accent, theme.success, theme.warning, theme.primary, theme.info][idx % 6]
  const sessionID = props.msg.sessionID
  return (
    <box
      marginTop={1}
      border={["left"]}
      borderColor={color as any}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseUp={() => sessionID && props.onJump(sessionID)}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
        <text fg={theme.textMuted}>
          <span style={{ fg: color as any, bold: true }}>
            {props.agent?.icon ? props.agent.icon + " " : ""}
            {props.agent?.name ?? props.msg.companyAgentID}
          </span>
        </text>
        <Show when={props.msg.content}>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming={false}
            syntaxStyle={syntax()}
            content={props.msg.content}
            fg={theme.text}
          />
        </Show>
        <Show when={!props.msg.content}>
          <text fg={theme.textMuted}>(no output)</text>
        </Show>
        <text fg={theme.textMuted}>
          <Show when={props.msg.statusSummary === "error"}>
            <span style={{ fg: theme.error }}> · error</span>
          </Show>
          <Show when={sessionID}>
            <span> · click to open session</span>
          </Show>
        </text>
      </box>
    </box>
  )
}

function LiveCard(props: {
  agent: CompanyAgentInfo | undefined
  color: string
  status: string
  onClick: () => void
}) {
  const { theme } = useTheme()
  // NOTE: We deliberately do NOT render the streaming text here. Each SSE
  // message.part.delta updates the sync store at full speed; rendering a
  // <code streaming> block per delta re-runs a tree-sitter highlight pass
  // per card, which (multiplied across every busy member) caused heavy
  // flicker. Instead we show a loading buffer while busy, and the finalized
  // message is rendered once via GroupMessageView after the round completes
  // (see the groupBusy → idle effect that triggers refetchMessages).
  return (
    <box border={["left"]} borderColor={props.color as any} customBorderChars={SplitBorder.customBorderChars}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
        <box flexDirection="row" gap={1}>
          <text fg={props.color as any} attributes={TextAttributes.BOLD}>
            {props.agent?.icon ? props.agent.icon + " " : ""}
            {props.agent?.name ?? "Agent"}
          </text>
          <Spinner color={theme.textMuted}>{statusLabel(props.status)}</Spinner>
        </box>
        <text fg={theme.textMuted}>generating response… · click to open session</text>
      </box>
      <box onMouseUp={props.onClick} />
    </box>
  )
}

function statusLabel(status: string): string {
  switch (status) {
    case "busy":
      return "working"
    case "retry":
      return "retrying"
    case "idle":
      return "idle"
    default:
      return status
  }
}

function agentColor(theme: any, agent: CompanyAgentInfo | undefined, fallbackIndex: number): string {
  if (agent?.color) {
    if (agent.color.startsWith("#")) return agent.color
    return (theme as any)[agent.color] ?? theme.accent
  }
  const palette = [theme.secondary, theme.accent, theme.success, theme.warning, theme.primary, theme.info]
  return palette[fallbackIndex % palette.length]
}

// ---------------------------------------------------------------------------
// Bidding status bar – shown during / after each bidding round
// ---------------------------------------------------------------------------

function BiddingStatusBar(props: {
  round: BiddingRoundDisplay
  onClick: () => void
}) {
  const { theme } = useTheme()
  const r = props.round

  if (r.status === "probing") {
    return (
      <box
        border={["left"]}
        borderColor={theme.info}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.info}>⚡ Bidding round {r.roundNum}…</text>
            <Spinner color={theme.textMuted}>probing</Spinner>
          </box>
        </box>
        <box onMouseUp={props.onClick} />
      </box>
    )
  }

  return (
    <box
      border={["left"]}
      borderColor={r.winnerId ? (theme.success) : (theme.textMuted)}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
        <box flexDirection="row" gap={1}>
          <Show when={r.winnerId} fallback={
            <text fg={theme.textMuted}>⏸ Round {r.roundNum}: no speaker selected</text>
          }>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>🏆</span>
              {" "}Round {r.roundNum}: {r.winnerId} won{" "}
              <span style={{ fg: theme.textMuted }}>
                ({r.bids.length} bids){" "}
                <span style={{ fg: theme.textMuted }}>· Click for details</span>
              </span>
            </text>
          </Show>
        </box>
      </box>
      <box onMouseUp={props.onClick} />
    </box>
  )
}

// ---------------------------------------------------------------------------
// Bidding details dialog – shows full bid table per round
// ---------------------------------------------------------------------------

function BiddingDetailsDialog(props: {
  rounds: BiddingRoundDisplay[]
  agentByID: Record<string, CompanyAgentInfo>
}) {
  const { theme } = useTheme()

  return (
    <box padding={2} flexDirection="column" gap={0}>
      {/* header */}
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Bidding Details{" "}
      </text>
      <text fg={theme.textMuted}>
        {props.rounds.length} round{props.rounds.length > 1 ? "s" : ""} · click outside or Esc to close
      </text>

      <box height={1} />

      {/* round list */}
      <For each={props.rounds}>
        {(round) => (
          <box flexDirection="column" gap={0} marginTop={1}>
            {/* round header */}
            <Show when={round.status === "resolved" && round.winnerId} fallback={
              <text fg={theme.textMuted}>
                Round {round.roundNum}: probing in progress…
              </text>
            }>
              <text fg={theme.success} attributes={TextAttributes.BOLD}>
                Round {round.roundNum} — Winner: {round.winnerId}
              </text>
            </Show>

            {/* bid table (only when resolved) */}
            <Show when={round.status === "resolved" && round.bids.length > 0}>
              <box flexDirection="column" gap={0} marginTop={0} paddingLeft={2}>
                {/* header row */}
                <box flexDirection="row" gap={3} paddingTop={0}>
                  <text fg={theme.textMuted} width={3}> </text>
                  <text fg={theme.textMuted} width={14}>Agent</text>
                  <text fg={theme.textMuted} width={7}>Level</text>
                  <text fg={theme.textMuted} width={10}>Type</text>
                  <text fg={theme.textMuted} width={12}>Addressed</text>
                  <text fg={theme.textMuted} width={6}>Score</text>
                </box>
                <text fg={theme.textMuted}>
                  {"  "}{"─".repeat(52)}
                </text>
                <For each={round.bids}>
                  {(bid) => (
                    <box flexDirection="row" gap={3}>
                      <text width={3} fg={bid.agentId === round.winnerId ? (theme.warning) : (theme.textMuted)}>
                        {bid.agentId === round.winnerId ? "🏆" : "  "}
                      </text>
                      <text
                        width={14}
                        fg={bid.agentId === round.winnerId ? (theme.text) : (theme.textMuted)}
                        attributes={bid.agentId === round.winnerId ? TextAttributes.BOLD : undefined}
                      >
                        {bid.agentId}
                      </text>
                      <text
                        width={7}
                        fg={bid.eligible ? (theme.text) : (theme.textMuted)}
                      >
                        {bid.level}
                      </text>
                      <text width={10} fg={bid.eligible ? (theme.text) : (theme.textMuted)}>
                        {bid.type}
                      </text>
                      <text width={12} fg={bid.eligible ? (theme.text) : (theme.textMuted)}>
                        {bid.addressedAs}
                      </text>
                      <text
                        width={6}
                        fg={bid.eligible ? (bid.agentId === round.winnerId ? (theme.success) : (theme.text)) : (theme.textMuted)}
                        attributes={bid.agentId === round.winnerId ? TextAttributes.BOLD : undefined}
                      >
                        {bid.eligible ? String(bid.score) : "—"}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>

            {/* reason summary for winner */}
            <Show when={round.status === "resolved" && round.winnerId}>
              <text fg={theme.textMuted} paddingLeft={5}>
                Winner bid:{" "}
                {round.bids.find((b) => b.agentId === round.winnerId)?.reason ?? ""}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}