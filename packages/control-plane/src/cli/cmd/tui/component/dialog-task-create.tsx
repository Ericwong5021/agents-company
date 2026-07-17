import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

interface DialogTaskCreateProps {
  sessionID: string
}

export function DialogTaskCreate(props: DialogTaskCreateProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  return (
    <DialogPrompt
      title="New Task"
      placeholder="Describe the task..."
      onConfirm={async (value) => {
        const trimmed = value.trim()
        if (!trimmed) {
          dialog.clear()
          return
        }
        try {
          const res = await sdk.fetch(`${sdk.url}/session/${props.sessionID}/task`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: trimmed }),
          })
          if (!res.ok) {
            toast.show({ variant: "error", message: "Failed to create task" })
          }
        } catch {
          toast.show({ variant: "error", message: "Failed to create task" })
        }
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
