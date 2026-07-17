import { type Component } from "solid-js"
import { DialogCustomProvider } from "./dialog-custom-provider"

export const DialogSelectProvider: Component = () => <DialogCustomProvider back="close" />
