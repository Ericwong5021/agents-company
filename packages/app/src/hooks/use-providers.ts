import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { isAgentCompanyProvider, popularProviders } from "./provider-filter"

export { isAgentCompanyProvider, popularProviders } from "./provider-filter"

const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  const all = () => providers().all.filter((provider) => isAgentCompanyProvider(provider.id))
  return {
    all,
    default: () => providers().default,
    popular: () => all().filter((provider) => popularProviderSet.has(provider.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return all().filter((provider) => connected.has(provider.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return all().filter((provider) => connected.has(provider.id))
    },
  }
}
