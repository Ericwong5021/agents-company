import { createMemo, createResource, createSignal, onCleanup, onMount, batch } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { Keybind } from "@/util"
import { useRoute } from "@tui/context/route"

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  system_prompt?: string
  model?: string
  color?: string
  icon?: string
}

interface GroupSessionInfo {
  id: string
  projectID: string
  title: string
  members: { sessionID: string; companyAgentID: string; position: number }[]
  time: { created: number; updated: number; archived?: number }
}

export function DialogGroupSessionCreate() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const route = useRoute()
  const { theme } = useTheme()
  const keybind = useKeybind()

  const [agents] = createResource(async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })
  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  onMount(() => dialog.setSize("large"))

  const options = createMemo(() => {
    const list = (agents() ?? []).filter((a) => a.id !== "assistant")
    const picked = selected()
    return list.map((a) => ({
      value: a.id,
      title: `${picked.has(a.id) ? "● " : "○ "}${a.icon ? a.icon + " " : ""}${a.name}`,
      description: a.description,
      category: "agents",
      bg: picked.has(a.id) ? theme.backgroundPanel : undefined,
    }))
  })

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function confirm() {
    const picked = [...selected()]
    if (picked.length === 0) {
      toast.show({ variant: "warning", message: "Select at least one agent" })
      return
    }
    const title = await DialogPrompt.show(dialog, "Name this group session", {
      placeholder: "e.g. Architecture Review",
    })
    if (title === null) return
    const trimmed = title.trim()
    if (!trimmed) return

    const res = await sdk.fetch(`${sdk.url}/group-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: trimmed, agentIDs: picked }),
    })
    if (!res.ok) {
      let detail = `Failed to create group session (${res.status})`
      try {
        const body = await res.json()
        if (body && typeof body === "object") {
          const msg = (body as any).message ?? (body as any).error
          if (typeof msg === "string" && msg) detail = msg
        }
      } catch {
        try {
          const text = await res.text()
          if (text) detail = text
        } catch {}
      }
      toast.show({ variant: "error", message: detail })
      return
    }
    const info = (await res.json()) as GroupSessionInfo
    route.navigate({ type: "group-session", groupSessionID: info.id })
    dialog.clear()
  }

  // Enter is used to toggle an agent; use ctrl+s to confirm creation.
  const confirmKey = Keybind.parse("ctrl+s")[0]

  return (
    <DialogSelect
      title={`New Group Session${selected().size ? `  ·  ${selected().size} selected` : ""}`}
      hint="Enter to toggle an agent · ctrl+s to create"
      options={options()}
      skipFilter={false}
      onSelect={(option) => toggle(option.value)}
      onMove={() => {}}
      keybind={[
        {
          keybind: confirmKey,
          title: "create",
          side: "right",
          onTrigger: () => {
            void confirm()
          },
        },
      ]}
    />
  )
}
