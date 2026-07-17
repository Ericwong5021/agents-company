import { createSignal, type JSX } from "solid-js"
import { createSimpleContext } from "./helper"

// The shell's right-sidebar content broker. Each route/page publishes a render
// function via `set(...)` in a createEffect keyed to the route; the shell's
// <RightSidebar> renders `content()()`. Publishing `null` (or never calling
// `set` for a route) means "no right sidebar for this route" — the shell hides
// the column regardless of the visibility toggle.
//
// `visible`/`setVisible` are owned by the shell and read by routes (e.g. the
// session route computes its content width from whether the right sidebar is
// shown). `setVisible` is called from <Shell> on mount; routes should treat
// `visible()` as read-only.
export const { use: useRightSidebar, provider: RightSidebarProvider } = createSimpleContext({
  name: "RightSidebar",
  init: () => {
    const [content, setContent] = createSignal<(() => JSX.Element) | null>(null)
    const [visible, setVisible] = createSignal(false)
    const [effectiveWidth, setEffectiveWidth] = createSignal(0)

    return {
      get content() {
        return content
      },
      set(next: (() => JSX.Element) | null) {
        setContent(() => next)
      },
      get visible() {
        return visible
      },
      setVisible,
      get effectiveWidth() {
        return effectiveWidth
      },
      setEffectiveWidth,
    }
  },
})

export type RightSidebarContext = ReturnType<typeof useRightSidebar>
