import { createStore, reconcile } from "solid-js/store"
import { createMemo, type Accessor } from "solid-js"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  agentID?: string
  prompt?: PromptInfo
  groupSessionID?: string
}

export type GroupSessionRoute = {
  type: "group-session"
  groupSessionID: string
}

export type CompanyChannelRoute = {
  type: "company-channel"
  channelID: string
  companyID: string
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | GroupSessionRoute | PluginRoute | CompanyChannelRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const [store, setStore] = createStore<Route>(
      props.initialRoute ??
        (process.env["AGENTCOMPANY_ROUTE"]
          ? JSON.parse(process.env["AGENTCOMPANY_ROUTE"])
          : {
              type: "home",
            }),
    )
    // Navigation history for the shell's Back button. Each entry is a plain
    // snapshot of the route before a navigate() (shallow-copied, with plugin
    // route `data` shallow-copied too, since reconcile() replaces the store).
    const history: Route[] = []
    const HISTORY_MAX = 50

    const snapshot = (r: Route): Route => {
      if (r.type === "plugin" && r.data) return { ...r, data: { ...r.data } }
      return { ...r }
    }

    return {
      get data() {
        return store
      },
      get history() {
        return history
      },
      navigate(route: Route) {
        const prev = snapshot(store)
        history.push(prev)
        if (history.length > HISTORY_MAX) history.shift()
        setStore(reconcile(route))
      },
      // Replace the current route WITHOUT pushing onto history (used for
      // mid-route param updates like switching agentID within a session).
      replace(route: Route) {
        setStore(reconcile(route))
      },
      // Pop history and restore the previous route. Returns the restored route
      // or undefined if history was empty (caller should fall back to home).
      back(): Route | undefined {
        const prev = history.pop()
        if (!prev) return undefined
        setStore(reconcile(prev))
        return prev
      },
      get canBack() {
        return history.length > 0
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}

export function useCurrentAgentID(): Accessor<string> {
  const route = useRoute()
  return createMemo(() =>
    route.data.type === "session" ? (route.data.agentID ?? "main") : "main",
  )
}
