import { createMemo, createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompanyAgentInfo {
  id: string
  name: string
  description?: string
  system_prompt?: string
  model?: string
  color?: string
  icon?: string
}

interface AgentTemplate {
  slug: string
  division: string
  name: string
  description: string
  color: string
  emoji: string
  vibe: string
  system_prompt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
}

const CREATE_SENTINEL = "__create__"

// ---------------------------------------------------------------------------
// Main dialog — lists all company agents
// ---------------------------------------------------------------------------

export function DialogCompanyAgents() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const keybind = useKeybind()

  const [refetch, setRefetch] = createSignal(0)
  const [confirmDelete, setConfirmDelete] = createSignal<string>()

  const [agents] = createResource(refetch, async () => {
    const res = await sdk.fetch(`${sdk.url}/company-agent`)
    if (!res.ok) return [] as CompanyAgentInfo[]
    return (await res.json()) as CompanyAgentInfo[]
  })

  onMount(() => dialog.setSize("large"))

  const options = createMemo(() => {
    const list = agents() ?? []
    const deleting = confirmDelete()
    return [
      {
        value: CREATE_SENTINEL,
        title: "Create new agent",
        description: "Set up a specialized AI assistant from a template",
        category: "actions",
      },
      ...list.map((a: CompanyAgentInfo) => ({
        value: a.id,
        title: deleting === a.id ? `Press ${keybind.print("session_delete")} again to confirm` : `${a.icon ? a.icon + " " : ""}${a.name}`,
        description: deleting === a.id ? undefined : a.description,
        bg: deleting === a.id ? theme.error : undefined,
        category: "agents",
      })),
    ]
  })

  return (
    <DialogSelect
      title="Company Agents"
      options={options()}
      onSelect={(option) => {
        setConfirmDelete(undefined)
        if (option.value === CREATE_SENTINEL) {
          dialog.replace(() => (
            <DialogCompanyAgentCreate
              onDone={() => dialog.replace(() => <DialogCompanyAgents />)}
            />
          ))
          return
        }
        dialog.clear()
      }}
      onMove={() => setConfirmDelete(undefined)}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (option.value === CREATE_SENTINEL) return
            if (option.value === "assistant") {
              toast.show({ variant: "warning", message: "Cannot delete the default assistant agent" })
              return
            }
            if (confirmDelete() === option.value) {
              const res = await sdk.fetch(`${sdk.url}/company-agent/${option.value}`, { method: "DELETE" })
              if (!res.ok) {
                toast.show({ variant: "error", message: "Failed to delete agent" })
              } else {
                setRefetch((n: number) => n + 1)
              }
              setConfirmDelete(undefined)
              return
            }
            setConfirmDelete(option.value)
          },
        },
      ]}
    />
  )
}

// ---------------------------------------------------------------------------
// Create dialog — template search + name prompt
// ---------------------------------------------------------------------------

export function DialogCompanyAgentCreate(props: { onDone: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [query, setQuery] = createSignal("")

  const [templates] = createResource(query, async (q: string) => {
    const params = new URLSearchParams({ limit: "80" })
    if (q) params.set("q", q)
    const res = await sdk.fetch(`${sdk.url}/company-agent/templates/search?${params}`)
    if (!res.ok) return [] as AgentTemplate[]
    return (await res.json()) as AgentTemplate[]
  })

  onMount(() => dialog.setSize("large"))

  const options = createMemo(() => {
    const list = templates() ?? []
    return [
      {
        value: "__blank__",
        title: "Start from scratch",
        description: "Create a custom agent with your own system prompt",
        category: "custom",
      },
      ...list.map((t: AgentTemplate) => ({
        value: `${t.division}/${t.slug}`,
        title: `${t.emoji ? t.emoji + " " : ""}${t.name}`,
        description: t.description || t.vibe || undefined,
        category: t.division,
      })),
    ]
  })

  async function doCreate(template: AgentTemplate | null) {
    const defaultName = template?.name ?? ""
    const name = await DialogPrompt.show(dialog, "Name your agent", {
      placeholder: "e.g. Research Assistant",
      value: defaultName,
    })
    if (name === null) return

    const trimmedName = (name.trim() || defaultName).trim()
    if (!trimmedName) return

    const slug = toSlug(trimmedName) || "agent"
    const id = `${slug}-${Date.now().toString(36)}`

    const body: Record<string, string> = { id, name: trimmedName }
    if (template?.description) body.description = template.description
    if (template?.system_prompt) body.system_prompt = template.system_prompt
    if (template?.color) body.color = template.color
    if (template?.emoji) body.icon = template.emoji

    const res = await sdk.fetch(`${sdk.url}/company-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.show({ variant: "error", message: (err as any)?.error ?? "Failed to create agent" })
      return
    }

    toast.show({ variant: "info", message: `"${trimmedName}" created` })
    props.onDone()
  }

  return (
    <DialogSelect
      title="Choose a template"
      flat={true}
      options={options()}
      onFilter={setQuery}
      onSelect={(option) => {
        if (option.value === "__blank__") {
          void doCreate(null)
        } else {
          const t = templates()?.find((t: AgentTemplate) => `${t.division}/${t.slug}` === option.value)
          if (t) void doCreate(t)
        }
      }}
    />
  )
}
