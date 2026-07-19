import { showToast, Toast } from "@agents-company/ui/toast"
import { createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"

export function AppChrome(props: ParentProps) {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  onMount(() => {
    if (!platform.checkUpdate || !platform.update || !platform.restart) return

    let toastId: number | undefined
    let interval: ReturnType<typeof setInterval> | undefined

    const pollUpdate = () =>
      platform.checkUpdate!().then(({ updateAvailable, version }) => {
        if (!updateAvailable) return
        if (toastId !== undefined) return
        toastId = showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: version ?? "" }),
          actions: [
            {
              label: language.t("toast.update.action.installRestart"),
              onClick: async () => {
                await platform.update!()
                await platform.restart()
              },
            },
            {
              label: language.t("toast.update.action.notYet"),
              onClick: "dismiss",
            },
          ],
        })
      })

    createEffect(() => {
      if (!settings.ready()) return

      if (!settings.updates.startup()) {
        if (interval === undefined) return
        clearInterval(interval)
        interval = undefined
        return
      }

      if (interval !== undefined) return
      void pollUpdate()
      interval = setInterval(pollUpdate, 10 * 60 * 1000)
    })

    onCleanup(() => {
      if (interval === undefined) return
      clearInterval(interval)
    })
  })

  return (
    <div
      data-component="app-shell"
      class="h-dvh w-screen min-h-0 min-w-0 overflow-hidden bg-background-base flex flex-col"
    >
      <div data-component="app-content" class="flex-1 min-h-0 min-w-0 flex">
        {props.children}
      </div>
      <Toast.Region />
    </div>
  )
}
