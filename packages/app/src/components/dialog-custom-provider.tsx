import { Button } from "@agents-company/ui/button"
import { useDialog } from "@agents-company/ui/context/dialog"
import { Dialog } from "@agents-company/ui/dialog"
import { Icon } from "@agents-company/ui/icon"
import { IconButton } from "@agents-company/ui/icon-button"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@agents-company/ui/text-field"
import { showToast } from "@agents-company/ui/toast"
import { batch, For } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { COMPANY_PROVIDER_CONFIGURED_EVENT } from "@/pages/company/provider-availability"
import { type CustomProviderFormat, type FormState, headerRow, modelRow, validateCustomProvider } from "./dialog-custom-provider-form"

type Props = {
  back?: "close"
  onSaved?: (result: NonNullable<ReturnType<typeof validateCustomProvider>["result"]>) => void | Promise<void>
  onFetchModels?: (input: {
    format: CustomProviderFormat
    baseURL: string
    apiKey?: string
    headers: Record<string, string>
  }) => Promise<{ model_id: string; name: string }[] | undefined>
}

export function DialogCustomProvider(props: Props) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    format: "openai",
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })

  const goBack = () => {
    dialog.close()
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: globalSync.data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(globalSync.data.provider.all.map((p) => p.id)),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const fetchModelsMutation = useMutation(() => ({
    mutationFn: async () => {
      const baseURL = form.baseURL.trim()
      if (!/^https?:\/\//.test(baseURL)) throw new Error(language.t("provider.custom.error.baseURL.format"))
      const headers = Object.fromEntries(
        form.headers
          .map((header) => ({ key: header.key.trim(), value: header.value.trim() }))
          .filter((header) => !!header.key && !!header.value)
          .map((header) => [header.key, header.value]),
      )
      const input = { format: form.format, baseURL, apiKey: form.apiKey.trim() || undefined, headers }
      if (props.onFetchModels) return props.onFetchModels(input)
      const response = await globalSDK.client.company.providerModels({
        customProviderModelsInput: {
          format: input.format,
          base_url: input.baseURL,
          ...(input.apiKey ? { api_key: input.apiKey } : {}),
          headers: input.headers,
        },
      })
      if (response.data === undefined) throw new Error(language.t("common.requestFailed"))
      return response.data
    },
    onSuccess: (models) => {
      if (!models?.length) {
        showToast({ title: language.t("provider.custom.models.empty") })
        return
      }
      setForm(
        "models",
        models.map((model) => ({ ...modelRow(), id: model.model_id, name: model.name })),
      )
    },
    onError: (error) => {
      showToast({
        title: language.t("provider.custom.models.fetchFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = globalSync.data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      if (result.key) {
        await globalSDK.client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })
      }

      await globalSync.updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: async (result) => {
      await props.onSaved?.(result)
      window.dispatchEvent(new Event(COMPANY_PROVIDER_CONFIGURED_EVENT))
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <Dialog
      class="company-provider-dialog"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <div class="company-provider-form flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
        <div class="px-2.5 flex gap-4 items-center">
          <div class="size-8 rounded-md bg-surface-raised-base flex items-center justify-center shrink-0">
            <Icon name="providers" class="size-4 icon-strong-base" />
          </div>
          <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
        </div>

        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">{language.t("provider.custom.description.prefix")}</p>

          <div class="flex flex-col gap-4">
            <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-2.5">
              <span class="text-12-medium text-text-weak">{language.t("provider.custom.field.format.label")}</span>
              <span class="text-13-medium text-text-strong">{language.t("provider.custom.field.format.openai")}</span>
            </div>
            <TextField
              autofocus
              label={language.t("provider.custom.field.providerID.label")}
              placeholder={language.t("provider.custom.field.providerID.placeholder")}
              description={language.t("provider.custom.field.providerID.description")}
              value={form.providerID}
              onChange={(v) => setField("providerID", v)}
              validationState={form.err.providerID ? "invalid" : undefined}
              error={form.err.providerID}
            />
            <TextField
              label={language.t("provider.custom.field.name.label")}
              placeholder={language.t("provider.custom.field.name.placeholder")}
              value={form.name}
              onChange={(v) => setField("name", v)}
              validationState={form.err.name ? "invalid" : undefined}
              error={form.err.name}
            />
            <TextField
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
            />
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.custom.field.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
          </div>

          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
              <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
              <Button
                type="button"
                size="small"
                variant="secondary"
                onClick={() => fetchModelsMutation.mutate()}
                disabled={fetchModelsMutation.isPending}
              >
                {fetchModelsMutation.isPending
                  ? language.t("provider.custom.models.fetching")
                  : language.t("provider.custom.models.fetch")}
              </Button>
            </div>
            <For each={form.models}>
              {(m, i) => (
                <div class="flex gap-2 items-start" data-row={m.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.id.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.id.placeholder")}
                      value={m.id}
                      onChange={(v) => setModel(i(), "id", v)}
                      validationState={m.err.id ? "invalid" : undefined}
                      error={m.err.id}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.name.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.name.placeholder")}
                      value={m.name}
                      onChange={(v) => setModel(i(), "name", v)}
                      validationState={m.err.name ? "invalid" : undefined}
                      error={m.err.name}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeModel(i())}
                    disabled={form.models.length <= 1}
                    aria-label={language.t("provider.custom.models.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>

          <Button
            class="w-auto self-start"
            type="submit"
            size="large"
            variant="primary"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
