import { Button } from "@agents-company/ui/button"
import { Mark } from "@agents-company/ui/logo"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { normalizeServerUrl } from "@/context/server"
import { localAuthStorageKey } from "@/utils/local-auth-storage"
import type { CompanyClient } from "./company-data-source"

function pairingCode() {
  if (typeof location !== "object") return ""
  try {
    return new URL(location.href).searchParams.get("pair")?.toUpperCase() ?? ""
  } catch {
    return ""
  }
}

function browserLabel() {
  if (typeof navigator !== "object") return "Browser"
  if (/macintosh|mac os/i.test(navigator.userAgent)) return "Browser on macOS"
  if (/windows/i.test(navigator.userAgent)) return "Browser on Windows"
  if (/linux/i.test(navigator.userAgent)) return "Browser on Linux"
  return "Browser"
}

export function BrowserPairing(props: { client: CompanyClient; serverUrl: string; onPaired: () => void }) {
  const language = useLanguage()
  const [code, setCode] = createSignal(pairingCode())
  const [label, setLabel] = createSignal(browserLabel())
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const exchange = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending()) return
    setPending(true)
    setError()
    try {
      const result = await props.client.localAuth.exchange({
        localExchangeInput: {
          code: code().trim().toUpperCase(),
          label: label().trim() || browserLabel(),
        },
      })
      if (result.error || !result.data) {
        setError(language.t("company.pairing.invalid"))
        return
      }
      localStorage.setItem(localAuthStorageKey(normalizeServerUrl(props.serverUrl) ?? props.serverUrl), result.data.token)
      const next = new URL(location.href)
      next.searchParams.delete("pair")
      history.replaceState(null, "", next)
      props.onPaired()
    } catch {
      setError(language.t("company.pairing.invalid"))
    } finally {
      setPending(false)
    }
  }

  return (
    <main class="h-dvh w-screen flex items-center justify-center bg-background-base p-6">
      <form class="w-full max-w-md rounded-xl bg-surface-base shadow-lg p-8 flex flex-col gap-6" onSubmit={exchange}>
        <div class="flex items-start gap-4">
          <div class="size-11 shrink-0 rounded-lg bg-text-strong text-background-base flex items-center justify-center">
            <Mark class="w-4 h-5" />
          </div>
          <div class="flex flex-col gap-1">
            <h1 class="text-18-medium text-text-strong">{language.t("company.pairing.title")}</h1>
            <p class="text-14-regular text-text-base">{language.t("company.pairing.description")}</p>
          </div>
        </div>
        <label class="flex flex-col gap-2 text-12-medium text-text-base">
          {language.t("company.pairing.code.label")}
          <input
            class="h-10 px-3 rounded-md bg-surface-raised-base border border-border-base text-14-regular text-text-strong tracking-[0.14em] uppercase"
            autocomplete="one-time-code"
            inputmode="text"
            maxlength={9}
            value={code()}
            onInput={(event) => setCode(event.currentTarget.value.toUpperCase())}
          />
        </label>
        <label class="flex flex-col gap-2 text-12-medium text-text-base">
          {language.t("company.pairing.label.label")}
          <input
            class="h-10 px-3 rounded-md bg-surface-raised-base border border-border-base text-14-regular text-text-strong"
            maxlength={80}
            value={label()}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        {error() ? <p class="text-12-regular text-text-danger-base">{error()}</p> : null}
        <Button class="w-full active:scale-95 transition-transform" type="submit" disabled={pending()}>
          {pending() ? language.t("company.pairing.pending") : language.t("company.pairing.submit")}
        </Button>
      </form>
    </main>
  )
}
