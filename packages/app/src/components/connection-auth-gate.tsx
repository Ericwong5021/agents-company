import { Button } from "@agents-company/ui/button"
import { Splash } from "@agents-company/ui/logo"
import { createMemo, createResource, type ParentProps, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { BrowserPairing } from "@/pages/company/browser-pairing"
import { createSdkForServer } from "@/utils/server"
import { clearLocalAuthToken } from "@/utils/local-auth-storage"
import { ConnectionError } from "./connection-error"

type AuthProbe = "authenticated" | "unauthenticated" | "network_error"

function AuthenticationMismatch(props: { onRestart: () => void }) {
  return (
    <main class="h-dvh w-screen flex items-center justify-center bg-background-base p-6">
      <section class="w-full max-w-md rounded-xl bg-surface-base shadow-lg p-8 flex flex-col gap-5">
        <div class="flex flex-col gap-2">
          <h1 class="text-18-medium text-text-strong">Sidecar 凭据不匹配</h1>
          <p class="text-14-regular text-text-base">本地 Control Plane 已使用新的短期凭据启动。重启 Agent Company 后会安全地重新连接。</p>
        </div>
        <Button class="self-start active:scale-95 transition-transform" onClick={props.onRestart}>
          重启 Agent Company
        </Button>
      </section>
    </main>
  )
}

export function ConnectionAuthGate(props: ParentProps) {
  const platform = usePlatform()
  const server = useServer()
  const connection = createMemo(() => server.current)
  const pairingClient = createMemo(() => {
    const current = connection()
    if (!current) return
    return createSdkForServer({
      server: { ...current.http, token: undefined },
      fetch: platform.fetch,
    })
  })
  const [probe, actions] = createResource(connection, async (current): Promise<AuthProbe> => {
    if (!current) return "network_error"
    try {
      const result = await createSdkForServer({ server: current.http, fetch: platform.fetch }).localAuth.session()
      if (result.data) return "authenticated"
      if (result.response.status !== 401) return "network_error"
      if (current.http.token) {
        clearLocalAuthToken(current.http.url)
        server.clearToken(current.http.url)
      }
      return "unauthenticated"
    } catch {
      return "network_error"
    }
  })

  return (
    <Show
      when={probe()}
      fallback={
        <div class="h-dvh w-screen flex items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      {(state) => (
        <Show
          when={state() === "authenticated"}
          fallback={
            <Show
              when={state() === "unauthenticated"}
              fallback={
                <ConnectionError
                  onRetry={() => void actions.refetch()}
                  onServerSelected={(key) => {
                    server.setActive(key)
                    void actions.refetch()
                  }}
                />
              }
            >
              <Show
                when={platform.platform === "web" && pairingClient() && connection()}
                fallback={<AuthenticationMismatch onRestart={() => void platform.restart()} />}
              >
                <BrowserPairing
                  client={pairingClient()!}
                  serverUrl={connection()!.http.url}
                  onPaired={() => window.location.reload()}
                />
              </Show>
            </Show>
          }
        >
          {props.children}
        </Show>
      )}
    </Show>
  )
}
