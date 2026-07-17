import { Button } from "@agents-company/ui/button"
import { useDialog } from "@agents-company/ui/context/dialog"
import { Dialog } from "@agents-company/ui/dialog"
import { List, type ListRef } from "@agents-company/ui/list"
import { Tag } from "@agents-company/ui/tag"
import { Tooltip } from "@agents-company/ui/tooltip"
import { type Component, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"

type ModelState = ReturnType<typeof useLocal>["model"]

export const DialogSelectModelUnpaid: Component<{ model?: ModelState }> = (props) => {
  const model = props.model ?? useLocal().model
  const dialog = useDialog()
  const language = useLanguage()

  const connect = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  let listRef: ListRef | undefined
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="overflow-y-auto [&_[data-slot=dialog-body]]:overflow-visible [&_[data-slot=dialog-body]]:flex-none"
    >
      <div class="flex flex-col gap-3 px-2.5" onKeyDown={handleKeyDown}>
        <div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.unpaid.freeModels.title")}</div>
        <List
          class="[&_[data-slot=list-scroll]]:overflow-visible"
          ref={(ref) => (listRef = ref)}
          items={model.list}
          current={model.current()}
          key={(x) => `${x.provider.id}:${x.id}`}
          itemWrapper={(item, node) => (
            <Tooltip
              class="w-full"
              placement="right-start"
              gutter={12}
              value={
                <ModelTooltip
                  model={item}
                  latest={item.latest}
                  free={item.provider.id === "control-plane" && (!item.cost || item.cost.input === 0)}
                />
              }
            >
              {node}
            </Tooltip>
          )}
          onSelect={(x) => {
            model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
              recent: true,
            })
            dialog.close()
          }}
        >
          {(i) => (
            <div class="w-full flex items-center gap-x-2.5">
              <span>{i.name}</span>
              <Tag>{language.t("model.tag.free")}</Tag>
              <Show when={i.latest}>
                <Tag>{language.t("model.tag.latest")}</Tag>
              </Show>
            </div>
          )}
        </List>
      </div>
      <div class="px-1.5 pb-1.5">
        <div class="w-full rounded-sm border border-border-weak-base bg-surface-raised-base">
          <div class="w-full flex flex-col items-start gap-4 px-1.5 pt-4 pb-4">
            <div class="px-2 text-14-medium text-text-base">{language.t("dialog.model.unpaid.addMore.title")}</div>
            <p class="px-2 text-12-regular text-text-weak">{language.t("settings.providers.custom.description")}</p>
            <Button class="ml-2" variant="secondary" icon="plus-small" onClick={connect}>
              {language.t("command.provider.connect")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
