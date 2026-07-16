import type { CompanyReadyState } from "@agents-company/sdk/v2/client"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { CompanyWorkspaceAccess } from "./company-model"

export type CompanyReadySnapshot = CompanyReadyState & {
  status: "ready"
  access: CompanyWorkspaceAccess
}

function policyLabel(preset: CompanyReadyState["company"]["approval_policy"]["preset"]) {
  if (preset === "autonomous") return "Autonomous"
  if (preset === "strict") return "Strict"
  return "Balanced"
}

export function CompanyReady(props: { snapshot: CompanyReadySnapshot; onOpenBoard?: () => void }) {
  const language = useLanguage()

  return (
    <main class="company-ready" data-company-state="ready">
      <header class="company-ready-header">
        <div>
          <span class="company-ready-eyebrow">Agent Company</span>
          <h1>{props.snapshot.company.name}</h1>
          <p>{language.t("company.ready.subtitle")}</p>
        </div>
        <span class="company-ready-status">{language.t("company.ready.status")}</span>
      </header>

      <section class="company-ready-facts" aria-label={language.t("company.ready.facts")}>
        <article>
          <span>{language.t("company.ready.dataDirectory")}</span>
          <strong>{props.snapshot.data_directory}</strong>
        </article>
        <article>
          <span>{language.t("company.ready.provider")}</span>
          <strong>{props.snapshot.company.provider.provider_id}</strong>
          <small>{props.snapshot.company.provider.model_id}</small>
        </article>
        <article>
          <span>{language.t("company.ready.repository")}</span>
          <strong>{props.snapshot.company.repository.root_path}</strong>
          <small>
            {props.snapshot.company.repository.default_branch} ·{" "}
            {props.snapshot.company.repository.bootstrap_head_commit ?? "HEAD"}
          </small>
        </article>
        <article>
          <span>{language.t("company.ready.policy")}</span>
          <strong>{policyLabel(props.snapshot.company.approval_policy.preset)}</strong>
          <small>
            {props.snapshot.company.repository.dirty
              ? language.t("company.ready.dirty")
              : language.t("company.ready.clean")}
          </small>
        </article>
      </section>

      <section class="company-ready-board" aria-labelledby="company-ready-board-title">
        <div class="company-ready-section-heading">
          <div>
            <span class="company-ready-eyebrow">{language.t("company.ready.board.eyebrow")}</span>
            <h2 id="company-ready-board-title">{language.t("company.ready.board.title")}</h2>
          </div>
        </div>
        <div class="company-ready-board-grid">
          <For each={props.snapshot.company.board}>
            {(member) => (
              <article class="company-ready-member">
                <span>{member.role.replace("_", " ")}</span>
                <h3>{member.name}</h3>
                <p>{member.responsibilities.join(" · ")}</p>
              </article>
            )}
          </For>
        </div>
      </section>

      <section class="company-ready-start" aria-labelledby="company-ready-start-title">
        <div>
          <span class="company-ready-eyebrow">{language.t("company.ready.start.eyebrow")}</span>
          <h2 id="company-ready-start-title">
            {language.t(`company.ready.start.${props.snapshot.start_suggestion.kind}.title`)}
          </h2>
          <p>{language.t(`company.ready.start.${props.snapshot.start_suggestion.kind}.body`)}</p>
        </div>
        <button
          type="button"
          disabled={!props.onOpenBoard}
          title={props.onOpenBoard ? undefined : language.t("company.ready.start.m2")}
          onClick={props.onOpenBoard}
        >
          {language.t("company.ready.start.action")}
        </button>
      </section>

      <Show when={!props.snapshot.capabilities.board_messages}>
        <section class="company-ready-capability" data-capability="board-messages-disabled">
          <strong>{language.t("company.ready.capability.title")}</strong>
          <p>{language.t("company.ready.capability.body")}</p>
        </section>
      </Show>
    </main>
  )
}
