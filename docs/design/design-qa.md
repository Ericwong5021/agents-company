# Agent Company WebUI 设计 QA

日期：2026-07-18

## 已通过

- 已存档 Marvis 首页、自动任务、技能广场、应用、办公室、工作日志、产出物与预览等真实界面状态，并记录来源日期。
- Pencil 已完成 Reference Archive、Company Group、Thread Attempt Recovery、Agent Activity Detail、375px 响应式和目标 Contact Sheet。
- Pencil layout snapshot 未发现裁切、重叠或溢出问题。
- 已把 Marvis 办公室实机截图与 Agent Company 员工卡片目标稿放入同一视觉比较输入，确认保留轻盈留白、低对比表面和空间感，同时去除虚假 Token 与装饰性活动。
- App 单元测试 397 项通过，App typecheck、生产构建与 CSS 检查通过。
- 高信号消息、Thread 页签恢复、真实导航与员工卡片的单元测试基线已覆盖。
- `/company/agents` 公开活动投影目标测试通过，验证候选人不会进入员工列表、失败状态保留安全风险摘要且 Evidence 不携带私密消息正文。

## 当前阻塞

- JavaScript SDK 生成、SDK typecheck 和 App 接入已通过。Control Plane 完整 typecheck 当前被既有 Plugin 改动阻塞，错误集中在 `plugin/codex.ts`、`plugin/github-copilot/copilot.ts`、`plugin/index.ts` 及 `../plugin/src/index.ts`，本轮 Company 活动投影文件没有新增类型错误。
- App E2E 启动后被系统以 137 终止，尚未完成五档真实浏览器视觉回归。未经用户选择浏览器，不使用其他浏览器或 Playwright 绕过该限制。
- 部分 Control Plane 旧测试仍使用缺少 `setup_goal`、`conversation_thread_id` 的旧 seed，与当前数据库契约不一致。

## 下一轮验证门槛

1. 修复既有 Plugin 类型错误与旧测试 seed 后执行 Control Plane 全量目标测试和完整 typecheck。
2. 在用户选择的真实浏览器中完成 1421×768、1180×800、820×1180、375×812、320×568 五档回归，并保存同视口对照图。
