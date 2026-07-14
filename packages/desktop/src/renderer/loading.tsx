import { MetaProvider } from "@solidjs/meta"
import { createMemo, createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import "@agents-company/app/index.css"
import { Font } from "@agents-company/ui/font"
import { Splash } from "@agents-company/ui/logo"
import { Progress } from "@agents-company/ui/progress"
import type { InitStep } from "../preload/types"
import "./styles.css"

const root = document.getElementById("root")!

render(() => {
  const [step, setStep] = createSignal<InitStep>({ phase: "server_waiting" })
  const complete = createMemo(() => step().phase === "done")

  onMount(() => {
    void window.api.awaitInitialization(setStep).catch(() => undefined)
  })

  return (
    <MetaProvider>
      <div class="w-screen h-screen bg-background-base flex items-center justify-center">
        <Font />
        <div class="flex flex-col items-center gap-11">
          <Splash class="w-20 h-25 opacity-15" />
          <div class="w-60 flex flex-col items-center gap-4" aria-live="polite">
            <span class="w-full overflow-hidden text-center text-ellipsis whitespace-nowrap text-text-strong text-14-normal">
              {complete() ? "Ready" : "Starting Agent Company…"}
            </span>
            <Progress
              value={complete() ? 100 : 30}
              class="w-20 [&_[data-slot='progress-track']]:h-1 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-none [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-none [&_[data-slot='progress-fill']]:bg-icon-warning-base"
              aria-label="Agent Company startup progress"
              getValueLabel={({ value }) => `${Math.round(value)}%`}
            />
          </div>
        </div>
      </div>
    </MetaProvider>
  )
}, root)
