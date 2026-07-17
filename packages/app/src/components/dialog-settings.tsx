import { Show, type Component, type JSX } from "solid-js"
import { Dialog } from "@agents-company/ui/dialog"
import { Tabs } from "@agents-company/ui/tabs"
import { Icon, type IconProps } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import { SettingsProviders } from "./settings-providers"

type DialogSettingsProps = {
  extension?: {
    value: string
    sectionTitle: JSX.Element
    label: JSX.Element
    icon: IconProps["name"]
    render: () => JSX.Element
  }
  defaultValue?: string
}

export const DialogSettings: Component<DialogSettingsProps> = (props) => {
  const language = useLanguage()

  return (
    <Dialog size="large" title={language.t("sidebar.settings")} class="company-settings-dialog" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        defaultValue={props.defaultValue ?? props.extension?.value ?? "providers"}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col gap-5 h-full w-full pt-3">
            <Show when={props.extension}>
              {(extension) => (
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{extension().sectionTitle}</Tabs.SectionTitle>
                  <Tabs.Trigger value={extension().value}>
                    <Icon name={extension().icon} />
                    {extension().label}
                  </Tabs.Trigger>
                </div>
              )}
            </Show>
            <div class="flex flex-col gap-1.5">
              <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
              <Tabs.Trigger value="providers">
                <Icon name="providers" />
                {language.t("settings.providers.title")}
              </Tabs.Trigger>
            </div>
          </div>
        </Tabs.List>
        <Show when={props.extension}>
          {(extension) => (
            <Tabs.Content value={extension().value} class="no-scrollbar">
              {extension().render()}
            </Tabs.Content>
          )}
        </Show>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
