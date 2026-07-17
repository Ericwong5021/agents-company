import { Button } from "@agents-company/ui/button"
import { useDialog } from "@agents-company/ui/context/dialog"
import { Icon } from "@agents-company/ui/icon"
import { Tag } from "@agents-company/ui/tag"
import { showToast } from "@agents-company/ui/toast"
import { createMemo, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { SettingsList } from "./settings-list"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export const SettingsProviders: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()

  const configured = createMemo(() =>
    Object.entries(globalSync.data.config.provider ?? {}).flatMap(([id, provider]) => {
      if (provider.npm !== OPENAI_COMPATIBLE || !provider.models || Object.keys(provider.models).length === 0) return []
      return [{
        id,
        name: provider.name ?? id,
        endpoint: provider.options?.baseURL?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? id,
        models: Object.keys(provider.models).length,
        enabled: !(globalSync.data.config.disabled_providers ?? []).includes(id),
      }]
    }),
  )

  const disconnect = async (providerID: string, name: string) => {
    const before = globalSync.data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    globalSync.set("config", "disabled_providers", next)

    await globalSDK.client.auth.remove({ providerID }).catch(() => undefined)
    await globalSync
      .updateConfig({ disabled_providers: next })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        globalSync.set("config", "disabled_providers", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <div class="company-provider-settings flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="company-provider-settings-header sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-2 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.providers.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.providers.custom.description")}</p>
        </div>
      </div>

      <section
        class="company-provider-settings-list flex flex-col gap-1 max-w-[720px]"
        data-component="agent-company-compatible-provider-settings"
      >
        <div class="flex items-center justify-between gap-4 pb-2">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.connected")}</h3>
          <Button
            size="large"
            variant="primary"
            icon="plus-small"
            onClick={() => dialog.show(() => <DialogCustomProvider back="close" />)}
          >
            {language.t("common.connect")}
          </Button>
        </div>
        <SettingsList>
          <Show
            when={configured().length > 0}
            fallback={
              <div class="company-provider-settings-empty flex flex-col gap-2 py-5">
                <span class="text-14-medium text-text-strong">{language.t("settings.providers.connected.empty")}</span>
                <span class="text-12-regular text-text-weak">{language.t("settings.providers.custom.description")}</span>
              </div>
            }
          >
            <For each={configured()}>
              {(item) => (
                <div class="company-provider-settings-row flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="size-8 rounded-md bg-surface-raised-base flex items-center justify-center shrink-0">
                      <Icon name="providers" class="size-4 icon-strong-base" />
                    </div>
                    <div class="flex flex-col min-w-0 gap-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-14-medium text-text-strong truncate">{item.name}</span>
                        <Tag>{language.t("provider.custom.field.format.openai")}</Tag>
                        <Show when={!item.enabled}>
                          <Tag>{language.t("common.disabled")}</Tag>
                        </Show>
                      </div>
                      <span class="text-12-regular text-text-weak truncate">
                        {item.endpoint} · {item.models} {language.t("provider.custom.models.label")}
                      </span>
                    </div>
                  </div>
                  <Button size="large" variant="ghost" onClick={() => void disconnect(item.id, item.name)}>
                    {language.t("common.disconnect")}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </SettingsList>
      </section>
    </div>
  )
}
