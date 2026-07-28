import { describe, expect, test } from "bun:test"
import { classifyMessageIntent, MessageIntent, PROJECT_CONFIDENCE_THRESHOLD } from "../../src/conversation/intent"

// GOAL-01 基准样本：至少 100 条中英文样本，覆盖六类意图与边界情况。
// label.project 表示该输入是否应自动创建项目（可执行任务 / 复杂目标）。
// label.kind 为期望意图类别（仅在分类确定的样本上断言）。
type Sample = { body: string; project: boolean; kind?: MessageIntent["kind"] }

const casual: Sample[] = [
  { body: "你好", project: false, kind: "casual" },
  { body: "您好，初次见面", project: false, kind: "casual" },
  { body: "早上好", project: false, kind: "casual" },
  { body: "下午好呀", project: false, kind: "casual" },
  { body: "谢谢你的帮助", project: false, kind: "casual" },
  { body: "多谢，太给力了", project: false, kind: "casual" },
  { body: "哈哈哈太棒了", project: false, kind: "casual" },
  { body: "在吗", project: false, kind: "casual" },
  { body: "辛苦了", project: false, kind: "casual" },
  { body: "嗯嗯知道了", project: false, kind: "casual" },
  { body: "hi", project: false, kind: "casual" },
  { body: "hello there", project: false, kind: "casual" },
  { body: "hey team", project: false, kind: "casual" },
  { body: "thanks a lot", project: false, kind: "casual" },
  { body: "good morning everyone", project: false, kind: "casual" },
]

const question: Sample[] = [
  { body: "什么是向量数据库？", project: false, kind: "question" },
  { body: "为什么我的构建这么慢？", project: false, kind: "question" },
  { body: "如何配置 HTTPS？", project: false, kind: "question" },
  { body: "Rust 和 Go 哪个更适合写 CLI？", project: false, kind: "question" },
  { body: "这个报错是什么意思？", project: false, kind: "question" },
  { body: "能不能解释一下事件循环？", project: false, kind: "question" },
  { body: "是否有更省内存的做法？", project: false, kind: "question" },
  { body: "该不该引入状态管理库？", project: false, kind: "question" },
  { body: "What is a monad?", project: false, kind: "question" },
  { body: "Why is my build so slow?", project: false, kind: "question" },
  { body: "How do I set up HTTPS?", project: false, kind: "question" },
  { body: "Which database should I use for time series?", project: false, kind: "question" },
  { body: "Is TypeScript better than JavaScript?", project: false, kind: "question" },
  { body: "Can you explain the event loop?", project: false, kind: "question" },
  { body: "Should I use SQLite or Postgres here?", project: false, kind: "question" },
]

const approval: Sample[] = [
  { body: "同意", project: false, kind: "approval" },
  { body: "批准这个方案", project: false, kind: "approval" },
  { body: "可以，通过", project: false, kind: "approval" },
  { body: "同意该计划", project: false, kind: "approval" },
  { body: "确认", project: false, kind: "approval" },
  { body: "驳回这个提案", project: false, kind: "approval" },
  { body: "采纳该设计", project: false, kind: "approval" },
  { body: "approved", project: false, kind: "approval" },
  { body: "lgtm", project: false, kind: "approval" },
  { body: "go ahead", project: false, kind: "approval" },
  { body: "reject", project: false, kind: "approval" },
  { body: "sounds good", project: false, kind: "approval" },
]

const intervention: Sample[] = [
  { body: "停止当前项目", project: false, kind: "intervention" },
  { body: "暂停一下", project: false, kind: "intervention" },
  { body: "取消这个任务", project: false, kind: "intervention" },
  { body: "换个方向重做", project: false, kind: "intervention" },
  { body: "继续上一个项目", project: false, kind: "intervention" },
  { body: "把方向改成移动端优先", project: false, kind: "intervention" },
  { body: "回滚刚才的改动", project: false, kind: "intervention" },
  { body: "终止这次运行", project: false, kind: "intervention" },
  { body: "pause the current run", project: false, kind: "intervention" },
  { body: "stop this project now", project: false, kind: "intervention" },
  { body: "cancel that task", project: false, kind: "intervention" },
  { body: "resume the previous project", project: false, kind: "intervention" },
  { body: "roll back the last change", project: false, kind: "intervention" },
]

const guards: Sample[] = [
  { body: "帮我想想但先不要执行", project: false },
  { body: "只是讨论一下方案，不用马上做", project: false },
  { body: "帮我参谋一下，别动手", project: false },
  { body: "先别急着实现，我们聊聊思路", project: false },
  { body: "brainstorm ideas but don't build anything yet", project: false },
  { body: "just discuss, no need to implement", project: false },
  { body: "let's just think it through, do not execute", project: false },
]

const tasks: Sample[] = [
  { body: "帮我写一个 Python 快速排序函数", project: true, kind: "task" },
  { body: "修复登录页的空指针错误", project: true, kind: "task" },
  { body: "生成一份季度销售报表", project: true, kind: "task" },
  { body: "翻译这段英文到中文", project: true, kind: "task" },
  { body: "创建一个 Nginx 配置示例", project: true, kind: "task" },
  { body: "整理这份会议纪要成要点", project: true, kind: "task" },
  { body: "优化这段 SQL 查询", project: true, kind: "task" },
  { body: "重构用户模块的重复代码", project: true, kind: "task" },
  { body: "给我画一个系统时序图", project: true, kind: "task" },
  { body: "统计这份日志里的错误数量", project: true, kind: "task" },
  { body: "Write a debounce function in TypeScript", project: true, kind: "task" },
  { body: "Fix the null pointer on the login page", project: true, kind: "task" },
  { body: "Create a Dockerfile for this service", project: true, kind: "task" },
  { body: "Add pagination to the users API", project: true, kind: "task" },
  { body: "Refactor the payment module", project: true, kind: "task" },
  { body: "Generate a weekly status report", project: true, kind: "task" },
  { body: "Translate this README into Chinese", project: true, kind: "task" },
  { body: "Implement a rate limiter middleware", project: true, kind: "task" },
  { body: "Update the dependencies to the latest versions", project: true, kind: "task" },
  { body: "Draft an onboarding email for new hires", project: true, kind: "task" },
]

const goals: Sample[] = [
  { body: "开发一个完整的待办事项 Web 应用，包含登录、增删改查和部署", project: true, kind: "goal" },
  { body: "从零搭建一个博客系统并上线到云服务器", project: true, kind: "goal" },
  { body: "构建一个端到端的数据分析平台，支持导入、清洗和可视化", project: true, kind: "goal" },
  { body: "做一款面向独立开发者的时间追踪产品", project: true, kind: "goal" },
  { body: "设计并实现一整套用户权限系统", project: true, kind: "goal" },
  { body: "研究并产出一份竞品分析报告，覆盖五家主要对手", project: true, kind: "goal" },
  { body: "策划一个新产品的上线方案，包含定价与推广", project: true, kind: "goal" },
  { body: "Build a complete e-commerce site with cart, checkout and admin", project: true, kind: "goal" },
  { body: "Design and build an end-to-end CI pipeline from scratch", project: true, kind: "goal" },
  { body: "Research and deliver a market analysis for the fintech sector", project: true, kind: "goal" },
  { body: "Build a full analytics platform with ingestion and dashboards", project: true, kind: "goal" },
]

const extra: Sample[] = [
  { body: "晚安，明天见", project: false, kind: "casual" },
  { body: "多谢啦", project: false, kind: "casual" },
  { body: "有没有推荐的日志库？", project: false, kind: "question" },
  { body: "怎样提升测试覆盖率？", project: false, kind: "question" },
  { body: "为什么会内存泄漏？", project: false, kind: "question" },
  { body: "How can I reduce bundle size?", project: false, kind: "question" },
  { body: "帮我配置一个 GitHub Actions 工作流", project: true, kind: "task" },
  { body: "写一段匹配邮箱的正则", project: true, kind: "task" },
  { body: "总结这篇论文的要点", project: true, kind: "task" },
  { body: "Format this JSON file for readability", project: true, kind: "task" },
  { body: "开发一个跨平台的笔记应用并同步到云端", project: true, kind: "goal" },
  { body: "先停下来，不用继续了", project: false, kind: "intervention" },
]

const all = [...casual, ...question, ...approval, ...intervention, ...guards, ...tasks, ...goals, ...extra]

describe("GOAL-01 message intent classifier", () => {
  test("covers at least 100 labeled CN/EN samples", () => {
    expect(all.length).toBeGreaterThanOrEqual(100)
  })

  test("每条样本的立项决策与标注一致", () => {
    const wrong = all.filter((sample) => classifyMessageIntent(sample.body).createsProject !== sample.project)
    expect(wrong.map((sample) => sample.body)).toEqual([])
  })

  test("在有确定类别标注的样本上分类正确", () => {
    const labeled = all.filter((sample) => sample.kind)
    const wrong = labeled.filter((sample) => classifyMessageIntent(sample.body).kind !== sample.kind)
    expect(wrong.map((sample) => `${sample.body} => ${classifyMessageIntent(sample.body).kind}`)).toEqual([])
  })

  test("自动创建项目的精确率不低于 95%", () => {
    const predictedProject = all.filter((sample) => classifyMessageIntent(sample.body).createsProject)
    const truePositives = predictedProject.filter((sample) => sample.project)
    expect(predictedProject.length).toBeGreaterThan(0)
    expect(truePositives.length / predictedProject.length).toBeGreaterThanOrEqual(0.95)
  })

  test("普通问答与闲聊不会立项", () => {
    for (const sample of [...casual, ...question]) {
      expect(classifyMessageIntent(sample.body).createsProject).toBe(false)
    }
  })

  test("对抗样本：隐含“想但不做”不立项", () => {
    for (const sample of guards) {
      const intent = classifyMessageIntent(sample.body)
      expect(intent.createsProject).toBe(false)
      expect(intent.needsConfirmation).toBe(false)
    }
  })

  test("“继续上一个项目”路由为干预而非新项目", () => {
    const intent = classifyMessageIntent("继续上一个项目")
    expect(intent.kind).toBe("intervention")
    expect(intent.createsProject).toBe(false)
  })

  test("低置信度的可执行意图转为待确认，不静默立项", () => {
    const intent = classifyMessageIntent("写个脚本")
    expect(intent.createsProject).toBe(false)
    expect(intent.needsConfirmation).toBe(true)
    expect(intent.confidence).toBeLessThan(PROJECT_CONFIDENCE_THRESHOLD)
  })

  test("确定性回退：无可执行信号时不丢失、不立项", () => {
    const intent = classifyMessageIntent("......")
    expect(intent.source).toBe("fallback")
    expect(intent.createsProject).toBe(false)
  })

  test("同一输入分类结果稳定可复现", () => {
    const first = classifyMessageIntent("开发一个完整的待办事项 Web 应用")
    const second = classifyMessageIntent("开发一个完整的待办事项 Web 应用")
    expect(second).toEqual(first)
  })
})

describe("GOAL-01 user override routing", () => {
  test("execute 覆盖强制立项", () => {
    const intent = classifyMessageIntent("随便聊聊", "execute")
    expect(intent).toMatchObject({ kind: "goal", createsProject: true, source: "user_override" })
  })

  test("discuss 覆盖强制不立项", () => {
    const intent = classifyMessageIntent("开发一个完整的电商系统", "discuss")
    expect(intent.createsProject).toBe(false)
    expect(intent.source).toBe("user_override")
  })

  test("project_followup 覆盖路由为干预", () => {
    const intent = classifyMessageIntent("再加一个筛选功能", "project_followup")
    expect(intent).toMatchObject({ kind: "intervention", createsProject: false, source: "user_override" })
  })
})
