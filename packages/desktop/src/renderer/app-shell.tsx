// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@agents-company/app"
import { useTheme } from "@agents-company/ui/theme"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createResource, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"

const deepLinkEvent = "agentcompany:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__AGENTCOMPANY__ ??= {}
  const pending = window.__AGENTCOMPANY__.deepLinks ?? []
  window.__AGENTCOMPANY__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const isWslEnabled = async () => {
    if (os !== "windows") return false
    return window.api
      .getWslConfig()
      .then((config) => config.enabled)
      .catch(() => false)
  }

  const wslHome = async () => {
    if (!(await isWslEnabled())) return undefined
    return window.api.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !(await isWslEnabled())) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux").catch(() => path))) as unknown as T
    }
    return (await window.api.wslPath(result, "linux").catch(() => result)) as unknown as T
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()
    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key) => window.api.storeGet(name, key),
        setItem: (key, value) => window.api.storeSet(name, key, value),
        removeItem: (key) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "agent-company.settings") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },
    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },
    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },
    openLink(url) {
      window.api.openLink(url)
    },
    async openPath(path, app) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          if (await isWslEnabled()) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },
    back() {
      window.history.back()
    },
    forward() {
      window.history.forward()
    },
    storage,
    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },
    update: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },
    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },
    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return
      window.api.showNotification({
        id: JSON.stringify([href ?? "", title, description ?? ""]),
        title,
        body: description,
        href,
      })
    },
    fetch: globalThis.fetch,
    getWslEnabled: () => isWslEnabled(),
    setWslEnabled: async (enabled) => window.api.setWslConfig({ enabled }),
    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },
    setDefaultServer: async (url) => window.api.setDefaultServerUrl(url),
    getDisplayBackend: async () => window.api.getDisplayBackend().catch(() => null),
    setDisplayBackend: async (backend) => window.api.setDisplayBackend(backend),
    parseMarkdown: (markdown) => window.api.parseMarkdownCommand(markdown),
    webviewZoom,
    checkAppExists: async (appName) => window.api.checkAppExists(appName),
    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" })
    },
  }
}

export function mountApp(root: HTMLElement) {
  void initI18n()
  let menuTrigger: ((id: string) => void) | undefined
  window.api.onMenuCommand((id) => menuTrigger?.(id))
  listenForDeepLinks()
  window.api.onNotificationClick((href) => handleNotificationClick(href))

  render(() => {
    const platform = createPlatform()
    const [windowConfig] = createResource(() => window.api.getWindowConfig().catch(() => ({ updaterEnabled: false })))
    const loadLocale = async () => {
      const raw = await platform.storage?.("agent-company.global.dat").getItem("language")
      if (!raw) return
      const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
      if (!locale) return
      const next = normalizeLocale(locale)
      if (next !== "en") await loadLocaleDict(next)
      return next satisfies Locale
    }
    const [windowCount] = createResource(() => window.api.getWindowCount())
    const [sidecar] = createResource(() => window.api.awaitInitialization(() => undefined))
    const [defaultServer] = createResource(() =>
      platform.getDefaultServer?.().then((url) => (url ? ServerConnection.key({ type: "http", http: { url } }) : undefined)),
    )
    const [locale] = createResource(loadLocale)
    const servers = () => {
      const data = sidecar()
      if (!data) return []
      return [
        {
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: { url: data.url },
        } satisfies ServerConnection.Sidecar,
      ] as ServerConnection.Any[]
    }

    function handleClick(event: MouseEvent) {
      const link = (event.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
      if (!link?.href) return
      event.preventDefault()
      platform.openLink(link.href)
    }

    function Inner() {
      const command = useCommand()
      menuTrigger = (id) => command.trigger(id)
      const theme = useTheme()
      createEffect(() => {
        theme.themeId()
        theme.mode()
        const background = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
        if (background) void window.api.setBackgroundColor(background)
      })
      return null
    }

    onMount(() => {
      document.addEventListener("click", handleClick)
      onCleanup(() => document.removeEventListener("click", handleClick))
    })

    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale={locale.latest}>
          <Show when={!defaultServer.loading && !sidecar.loading && !windowConfig.loading && !windowCount.loading && !locale.loading}>
            <AppInterface
              defaultServer={defaultServer.latest ?? ServerConnection.Key.make("sidecar")}
              servers={servers()}
              router={MemoryRouter}
            >
              <Inner />
            </AppInterface>
          </Show>
        </AppBaseProviders>
      </PlatformProvider>
    )
  }, root)
}
