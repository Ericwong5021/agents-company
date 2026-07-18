import { For, type Accessor } from "solid-js"
import { Icon } from "@agents-company/ui/icon"
import type { ConversationError } from "./company-model"
import { CompanyComposer } from "./company-composer"

const EXAMPLES = [
  {
    title: "研究一个值得进入的新市场",
    body: "研究一个值得进入的新市场，建立证据链、关键假设和下一步验证计划。",
    icon: "magnifying-glass" as const,
  },
  {
    title: "把模糊想法变成可执行方案",
    body: "把我的模糊想法整理成目标、约束、里程碑、风险和可验证的交付计划。",
    icon: "task" as const,
  },
  {
    title: "分析一次复杂选择",
    body: "分析这个复杂选择，组织不同观点，明确取舍并给出有证据的建议。",
    icon: "brain" as const,
  },
  {
    title: "完成一个跨工具交付",
    body: "完成一个需要调研、文件处理和结果验收的跨工具交付，并保留完整工作记录。",
    icon: "folder" as const,
  },
] as const

export function NewGoalSurface(props: {
  companyName: string
  sending: Accessor<boolean>
  error: Accessor<ConversationError | null>
  hasOpenThread: Accessor<boolean>
  onSend: (body: string) => void
  onInterrupt: () => void
  onRetry: () => void
}) {
  let composer: HTMLDivElement | undefined

  const choose = (body: string) => {
    composer?.querySelector("textarea")?.focus()
    composer?.dispatchEvent(new CustomEvent("company:goal-preset", { detail: body }))
  }

  return (
    <div class="company-new-goal">
      <section class="company-goal-hero" aria-labelledby="company-goal-title">
        <span class="company-goal-mark" aria-hidden="true">
          <Icon name="brain" />
        </span>
        <div>
          <h1 id="company-goal-title">{props.companyName}</h1>
          <p>说出目标，公司会围绕真实进展动态组织团队</p>
        </div>
      </section>

      <div ref={composer} class="company-goal-composer-host">
        <CompanyComposer
          mode="goal"
          sending={props.sending}
          error={props.error}
          hasOpenThread={props.hasOpenThread}
          onSend={props.onSend}
          onInterrupt={props.onInterrupt}
          onRetry={props.onRetry}
        />
      </div>

      <section class="company-goal-examples" aria-labelledby="company-goal-examples-title">
        <header>
          <strong id="company-goal-examples-title">从一个真实目标开始</strong>
          <span>示例只填充目标，不预设员工或团队</span>
        </header>
        <div class="company-goal-example-grid">
          <For each={EXAMPLES}>
            {(example) => (
              <button type="button" onClick={() => choose(example.body)}>
                <Icon name={example.icon} size="small" />
                <strong>{example.title}</strong>
                <p>{example.body}</p>
                <Icon name="arrow-right" size="small" />
              </button>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
