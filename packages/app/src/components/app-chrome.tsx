import { base64Encode } from "@agents-company/shared/util/encode"
import { getFilename } from "@agents-company/shared/util/path"
import { showToast, Toast, toaster } from "@agents-company/ui/toast"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, onCleanup, onMount, type ParentProps } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { setNavigate } from "@/utils/notification-click"
import { playSoundById } from "@/utils/sound"
import { workspaceKey } from "@/pages/layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "@/pages/layout/deep-links"
import { setSessionHandoff } from "@/pages/session/handoff"
import { Titlebar } from "./titlebar"

export function AppChrome(props: ParentProps) {
  const navigate = useNavigate()
  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()
  const server = useServer()
  const settings = useSettings()
  const currentDirectory = createMemo(() => decode64(params.dir) || "")

  setNavigate(navigate)
  onCleanup(() => setNavigate(undefined))

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

  onMount(() => {
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const cooldownMs = 5000

    const dismissSessionAlert = (sessionKey: string) => {
      const toastId = toastBySession.get(sessionKey)
      if (toastId === undefined) return
      toaster.dismiss(toastId)
      toastBySession.delete(sessionKey)
      alertedAtBySession.delete(sessionKey)
    }

    const unsub = globalSDK.event.listen((event) => {
      if (
        event.details?.type === "question.replied" ||
        event.details?.type === "question.rejected" ||
        event.details?.type === "permission.replied"
      ) {
        const properties = event.details.properties as { sessionID: string }
        dismissSessionAlert(`${event.name}:${properties.sessionID}`)
        return
      }

      if (event.details?.type !== "permission.asked" && event.details?.type !== "question.asked") return
      const title =
        event.details.type === "permission.asked"
          ? language.t("notification.permission.title")
          : language.t("notification.question.title")
      const icon = event.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
      const directory = event.name
      const properties = event.details.properties
      if (event.details.type === "permission.asked" && permission.autoResponds(event.details.properties, directory)) {
        return
      }

      const [store] = globalSync.child(directory, { bootstrap: false })
      const session = store.session.find((item) => item.id === properties.sessionID)
      const sessionKey = `${directory}:${properties.sessionID}`
      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(directory)
      const description =
        event.details.type === "permission.asked"
          ? language.t("notification.permission.description", { sessionTitle, projectName })
          : language.t("notification.question.description", { sessionTitle, projectName })
      const href = `/${base64Encode(directory)}/session/${properties.sessionID}`
      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < cooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      if (event.details.type === "permission.asked") {
        if (settings.sounds.permissionsEnabled()) {
          void playSoundById(settings.sounds.permissions())
        }
        if (settings.notifications.permissions()) {
          void platform.notify(title, description, href)
        }
      }

      if (event.details.type === "question.asked" && settings.notifications.agent()) {
        void platform.notify(title, description, href)
      }

      const currentSession = params.id
      if (workspaceKey(directory) === workspaceKey(currentDirectory()) && properties.sessionID === currentSession)
        return
      if (workspaceKey(directory) === workspaceKey(currentDirectory()) && session?.parentID === currentSession) return

      dismissSessionAlert(sessionKey)
      toastBySession.set(
        sessionKey,
        showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        }),
      )
    })
    onCleanup(unsub)

    createEffect(() => {
      const directory = currentDirectory()
      const currentSession = params.id
      if (!directory || !currentSession) return
      dismissSessionAlert(`${directory}:${currentSession}`)
      const [store] = globalSync.child(directory, { bootstrap: false })
      store.session
        .filter((session) => session.parentID === currentSession)
        .forEach((session) => dismissSessionAlert(`${directory}:${session.id}`))
    })
  })

  onMount(() => {
    const handleDeepLinks = (urls: string[]) => {
      if (!server.isLocal()) return

      collectOpenProjectDeepLinks(urls).forEach((directory) => {
        layout.projects.open(directory)
        layout.mobileSidebar.hide()
        navigate(`/${base64Encode(directory)}/session`)
      })

      collectNewSessionDeepLinks(urls).forEach((link) => {
        layout.projects.open(link.directory)
        layout.mobileSidebar.hide()
        const slug = base64Encode(link.directory)
        if (link.prompt) setSessionHandoff(slug, { prompt: link.prompt })
        navigate(link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`)
      })
    }
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail !== "object" || detail === null) return
      const urls = Reflect.get(detail, "urls")
      if (!Array.isArray(urls)) return
      if (!urls.every((url): url is string => typeof url === "string")) return
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  return (
    <div
      data-component="app-shell"
      class="h-dvh w-screen min-h-0 min-w-0 overflow-hidden bg-background-base flex flex-col"
    >
      <Titlebar />
      <div data-component="app-content" class="flex-1 min-h-0 min-w-0 flex">
        {props.children}
      </div>
      <Toast.Region />
    </div>
  )
}
