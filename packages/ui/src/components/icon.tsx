import { splitProps, type ComponentProps } from "solid-js"
import { PHOSPHOR_VIEWBOX, phosphorIcons, type PhosphorIconName } from "./icons/phosphor"

export type IconName = PhosphorIconName

export interface IconProps extends ComponentProps<"svg"> {
  name: IconName
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  return (
    <div data-component="icon" data-size={local.size || "normal"} data-icon-set="phosphor">
      <svg
        data-slot="icon-svg"
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
        fill="currentColor"
        viewBox={PHOSPHOR_VIEWBOX}
        innerHTML={phosphorIcons[local.name]}
        aria-hidden="true"
        {...others}
      />
    </div>
  )
}
