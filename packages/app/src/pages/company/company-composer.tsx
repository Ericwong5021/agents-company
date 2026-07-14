import { For, Show, createMemo, createSignal, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import { useLanguage } from "@/context/language"
import type { ConversationError } from "./company-model"

/**
 * Real composer. Sends through the conversation store (202-confirmed
 * persistence), supports @board-role mentions and referencing the open Thread,
 * and exposes `/interrupt` — the only structured M2 thread action. `/approve`
 * and `/delegate` are deliberately not offered: those governance actions belong
 * to M3 and must not be faked with a string. State (sending / failed / retrying)
 * is surfaced with text and aria attributes, not color alone.
 */

const ROLE_MENTIONS = [
  { key: "ceo", labelKey: "company.composer.mention.ceo" },
  { key: "cto", labelKey: "company.composer.mention.cto" },
  { key: "product_lead", labelKey: "company.composer.mention.product_lead" },
] as const

export function CompanyComposer(props: {
  sending: Accessor<boolean>
  error: Accessor<ConversationError | null>
  hasOpenThread: Accessor<boolean>
  onSend: (body: string) => void
  onInterrupt: () => void
  onRetry: () => void
}) {
  const language = useLanguage()
  const [value, setValue] = createSignal("")
  const [showMentions, setShowMentions] = createSignal(false)
  const canSend = createMemo(() => !props.sending() && value().trim().length > 0)

  function send() {
    const body = value().trim()
    if (!canSend()) return
    props.onSend(body)
    setValue("")
  }

  function insertMention(label: string) {
    setValue((current) => `${current}${current.endsWith(" ") || current === "" ? "" : " "}@${label} `)
    setShowMentions(false)
  }

  function onInput(event: InputEvent & { currentTarget: HTMLInputElement }) {
    const next = event.currentTarget.value
    setValue(next)
    // `/` at start or `@` toggles the mention menu
    setShowMentions(next.endsWith("@"))
  }

  return (
    <div class="company-composer" data-state={props.sending() ? "sending" : props.error() ? "failed" : "idle"}>
      <Show when={props.error()}>
        {(err) => (
          <div class="company-composer-error" role="alert">
            <span>{err().description}</span>
            <Show when={err().retryable}>
              <button type="button" class="company-composer-retry" onClick={props.onRetry}>
                {language.t("company.composer.retry")}
              </button>
            </Show>
          </div>
        )}
      </Show>

      <div class="company-composer-input">
        <input
          value={value()}
          placeholder={language.t("company.composer.placeholder")}
          aria-label={language.t("company.composer.label")}
          disabled={props.sending()}
          onInput={onInput}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            send()
          }}
        />
        <Show when={showMentions()}>
          <div class="company-composer-mentions" role="listbox" aria-label={language.t("company.composer.mention.label")}>
            <For each={ROLE_MENTIONS}>
              {(role) => (
                <button type="button" role="option" onClick={() => insertMention(role.key)}>
                  {language.t(role.labelKey)}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="company-composer-actions">
        <div>
          <button
            type="button"
            aria-label={language.t("company.composer.mention.label")}
            disabled={props.sending()}
            onClick={() => setShowMentions((current) => !current)}
          >
            @
          </button>
          <button
            type="button"
            aria-label={language.t("company.composer.interrupt")}
            disabled={!props.hasOpenThread() || props.sending()}
            onClick={props.onInterrupt}
          >
            /
          </button>
        </div>
        <span class="company-composer-status" aria-live="polite">
          <Show when={props.sending()}>{language.t("company.composer.sending")}</Show>
        </span>
        <button
          type="button"
          class="company-send"
          aria-label={language.t("company.composer.send")}
          disabled={!canSend()}
          onClick={send}
        >
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
  )
}
