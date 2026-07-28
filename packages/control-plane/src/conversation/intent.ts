import z from "zod"

// GOAL-01 — 用户输入意图分类与可纠正路由。
//
// 目标：不再把所有发给 Board 的消息都自动立项。分类器是纯函数、确定性、
// 不依赖模型，因此可被单元测试固定，也天然满足“分类失败有确定性回退、不丢失消息”。
// 高影响动作（自动创建项目）采用高精度优先策略：只有明确的可执行任务或复杂目标、
// 且置信度达到阈值时才创建项目；否则先确认或仅作为讨论保留。

export const MessageIntentKind = z.enum([
  "casual", // 普通消息 / 闲聊
  "question", // 知识问题
  "task", // 可直接执行任务
  "goal", // 复杂目标
  "intervention", // 项目干预
  "approval", // 审批回应
])
export type MessageIntentKind = z.infer<typeof MessageIntentKind>

// 用户可在发送前/发送后显式纠正路由：作为目标执行 / 仅讨论 / 追加到已有项目。
export const IntentOverride = z.enum(["execute", "discuss", "project_followup"])
export type IntentOverride = z.infer<typeof IntentOverride>

export const MessageIntent = z
  .object({
    kind: MessageIntentKind,
    confidence: z.number().min(0).max(1),
    createsProject: z.boolean(),
    needsConfirmation: z.boolean(),
    source: z.enum(["classifier", "user_override", "fallback"]),
    reason: z.string(),
  })
  .strict()
export type MessageIntent = z.infer<typeof MessageIntent>

// 自动创建项目所需的最小置信度。低于此值时不静默立项。
export const PROJECT_CONFIDENCE_THRESHOLD = 0.6

// 明确要求“只讨论、不要执行”的护栏短语。命中后强制走讨论路径。
const DISCUSSION_GUARD =
  /不要(执行|实现|开始|动手|做)|先?别(执行|实现|做|急)|不用(执行|实现|马上做)|只是?(想|讨论|聊聊|头脑风暴)|仅(讨论|供参考)|帮我想想|想一想|帮我参谋|头脑风暴|brainstorm|just (?:discuss|think|thinking|brainstorm|chat)|don'?t (?:execute|build|implement|start|do it|code)|no need to (?:build|do|implement)|do not (?:execute|implement|build)/i

// 审批回应：对既有提案/计划的确认或否决。英文需词边界；中文短词以句首锚定并要求独立成句。
const APPROVAL =
  /^(?:approve|approved|reject|rejected|lgtm|sounds good|go ahead|ship it|looks good|ok)\b|^(?:同意|批准|通过|确认|可以|好的|行)(?:$|[\s，,。.!！]|通过|了)|(?:同意|批准|拒绝|驳回|采纳|确认)(?:该|这个|此)?(?:方案|计划|提案|设计|决定)/i

// 项目干预：停止/暂停/取消/改方向/继续既有项目等，指向已存在的工作。
const INTERVENTION =
  /停(?:止|下)|暂停|取消|终止|中止|回滚|撤销|换(?:个|一个|种)?方向|改(?:成|为|一下方向)|重做|重新(?:来|做)|继续(?:上|之前|那个|上一个|刚才)|接着(?:上|之前|刚才)|pause|stop|resume|cancel|abort|halt|roll ?back|revert|redo|change (?:the )?direction|continue (?:the )?(?:previous|last|prior)/i

// 知识问题：疑问句式或以疑问词开头。
const QUESTION_LEAD =
  /^(?:什么|为什么|为啥|怎么|怎样|如何|哪些|哪个|哪里|是否|是不是|能不能|可不可以|可以吗|能否|有没有|有什么|该不该|要不要)|^(?:what|why|how|when|where|who|whom|which|whose|is|are|am|can|could|should|would|does|do|did|will|shall|may|might)\b/i

// 闲聊 / 问候 / 致谢。
const CASUAL =
  /^(?:你好|您好|哈喽|嗨|hi|hello|hey|yo|早上?好|中午好|下午好|晚上好|晚安|在吗|在不在|谢谢|多谢|感谢|thanks|thank you|thx|good (?:morning|afternoon|evening)|辛苦了|不错|棒|好的呀|哈哈+|嗯+|哦+|ok啦)\b/i

// 可直接执行任务：祈使动作动词，单一交付物。
const TASK_VERB =
  /^(?:帮我|请|麻烦|帮忙|给我)?\s*(?:写|生成|创建|新建|修复|修正|修改|更新|删除|移除|添加|增加|补充|翻译|整理|总结|归纳|画|绘制|做个|做一下|实现|重构|优化|检查|校对|排查|列出|统计|配置|部署)/i
const TASK_VERB_EN =
  /^(?:please\s+)?(?:write|create|add|fix|update|remove|delete|implement|build|generate|translate|summari[sz]e|refactor|optimi[sz]e|draft|make|ship|rename|list|review|check|convert|format|clean up)\b/i

// 复杂目标：多步、成体系、端到端、产品/系统/平台级。避免把“系统/平台/产品”等名词单独当作目标信号。
const GOAL_SIGNAL =
  /开发(?:一个|一款|个|一套)?|构建(?:一个|一套|个)|搭建(?:一个|一套)?|上线|端到端|从(?:头|零)(?:到尾|开始|搭建)|设计并(?:实现|开发|落地)|做一个(?:完整|全新|端到端)|做一款|一整套|一套完整|方案设计|策划(?:一个|方案)|研究并(?:产出|给出|落地)|分析并(?:给出|产出)|design and (?:build|implement)|build (?:a|an) (?:complete|full|end-to-end|entire)|research and (?:build|deliver|produce)|end-to-end|from scratch/i

const normalize = (body: string) => body.replace(/\s+/g, " ").trim()

const questionShape = (text: string) => /[?？]\s*$/.test(text) || QUESTION_LEAD.test(text)

function detect(body: string): MessageIntent {
  const text = normalize(body)
  const long = text.length >= 48 || (text.match(/[，,。.;；]/g)?.length ?? 0) >= 2

  // 1) “只讨论、不要执行”的显式护栏优先，避免误立项。
  if (DISCUSSION_GUARD.test(text)) {
    const kind = questionShape(text) ? "question" : "casual"
    return { kind, confidence: 0.86, createsProject: false, needsConfirmation: false, source: "classifier", reason: "explicit_discussion_guard" }
  }

  // 2) 干预既有工作（在无线程上下文时仍不立项）。
  if (INTERVENTION.test(text) && !TASK_VERB.test(text) && !TASK_VERB_EN.test(text)) {
    return { kind: "intervention", confidence: 0.82, createsProject: false, needsConfirmation: false, source: "classifier", reason: "intervention_verb" }
  }

  // 3) 简短审批回应。
  if (text.length <= 24 && APPROVAL.test(text)) {
    return { kind: "approval", confidence: 0.8, createsProject: false, needsConfirmation: false, source: "classifier", reason: "approval_response" }
  }

  // 4) 闲聊 / 问候。
  if (CASUAL.test(text) && !TASK_VERB.test(text) && !TASK_VERB_EN.test(text)) {
    return { kind: "casual", confidence: 0.8, createsProject: false, needsConfirmation: false, source: "classifier", reason: "greeting_or_smalltalk" }
  }

  const hasTaskVerb = TASK_VERB.test(text) || TASK_VERB_EN.test(text)
  const hasGoalSignal = GOAL_SIGNAL.test(text)

  // 5) 知识问题：疑问句式且非祈使动作（“为什么构建慢”等属于提问而非立项）。
  if (questionShape(text) && !hasTaskVerb) {
    return { kind: "question", confidence: 0.78, createsProject: false, needsConfirmation: false, source: "classifier", reason: "knowledge_question" }
  }

  // 6) 复杂目标。
  if (hasGoalSignal || (hasTaskVerb && long)) {
    return { kind: "goal", confidence: 0.82, createsProject: true, needsConfirmation: false, source: "classifier", reason: hasGoalSignal ? "goal_signal" : "compound_task" }
  }

  // 7) 单一可执行任务。过短/缺乏宾语的神使句置信度偏低，交由确认而非静默立项。
  if (hasTaskVerb) {
    const confidence = text.length <= 8 ? 0.55 : 0.72
    return { kind: "task", confidence, createsProject: true, needsConfirmation: false, source: "classifier", reason: "task_verb" }
  }

  // 8) 确定性回退：无法判定为可执行意图时，绝不静默立项，保留为讨论。
  return { kind: "casual", confidence: 0.3, createsProject: false, needsConfirmation: false, source: "fallback", reason: "no_actionable_signal" }
}

/**
 * 对用户输入进行意图分类。可选的 override 表示用户显式纠正路由。
 * 高影响动作（createsProject）在置信度不足阈值时会转为 needsConfirmation，不静默立项。
 */
export function classifyMessageIntent(body: string, override?: IntentOverride): MessageIntent {
  if (override === "execute") {
    return { kind: "goal", confidence: 1, createsProject: true, needsConfirmation: false, source: "user_override", reason: "user_execute" }
  }
  if (override === "discuss") {
    const shaped = questionShape(normalize(body)) ? "question" : "casual"
    return { kind: shaped, confidence: 1, createsProject: false, needsConfirmation: false, source: "user_override", reason: "user_discuss" }
  }
  if (override === "project_followup") {
    return { kind: "intervention", confidence: 1, createsProject: false, needsConfirmation: false, source: "user_override", reason: "user_project_followup" }
  }

  const detected = detect(body)
  if (detected.createsProject && detected.confidence < PROJECT_CONFIDENCE_THRESHOLD) {
    return { ...detected, createsProject: false, needsConfirmation: true, reason: `${detected.reason}_low_confidence` }
  }
  return detected
}
