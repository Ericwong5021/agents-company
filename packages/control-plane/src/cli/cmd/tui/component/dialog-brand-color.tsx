import { onCleanup } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useLanguage } from "../context/language"
import { useTheme } from "../context/theme"
import type { BrandColor } from "../context/theme"

const BRAND_COLORS: Array<{ value: BrandColor; title: string }> = [
  { value: "red", title: "Red" },
  { value: "yellow", title: "Yellow" },
  { value: "orange", title: "Orange" },
  { value: "purple", title: "Purple" },
  { value: "blue", title: "Blue" },
  { value: "green", title: "Green" },
  { value: "pink", title: "Pink" },
  { value: "white", title: "White" },
]

export function DialogBrandColor() {
  const dialog = useDialog()
  const kv = useKV()
  const { t } = useLanguage()
  const theme = useTheme()
  const initial = kv.get("brand_color")
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) kv.set("brand_color", initial)
  })

  const options: DialogSelectOption<BrandColor>[] = BRAND_COLORS.map((item) => ({
    title: t(`tui.dialog.brand_color.option.${item.value}`),
    value: item.value,
  }))

  return (
    <DialogSelect
      title={`${t("tui.dialog.brand_color.title")} (${theme.mode()})`}
      options={options}
      current={(typeof initial === "string" ? initial : "blue") as BrandColor}
      onMove={(opt) => kv.set("brand_color", opt.value)}
      onSelect={(opt) => {
        kv.set("brand_color", opt.value)
        confirmed = true
        dialog.clear()
      }}
    />
  )
}
