# M2 真实 IM、董事会与高信号 Thread 关闭报告

> 状态：已关闭
> 关闭日期：2026-07-15
> 事实源：[产品宪法](../../product-design/PRODUCT-CONSTITUTION.md) → [产品 PRD](../../Agent%20Company%20产品%20PRD.md) → [实施计划](../../product-design/implementation-plan.md) → [M2 实施计划](../plans/2026-07-14-m2-real-im-board.md)

## 结论

M2 已满足退出标准并关闭。Company Workspace 现在使用持久 Channel、ChannelMessage、ConversationThread、ConversationRun 与 SignalProjection；Browser、Desktop 和 TUI 通过同一生成 SDK / Control Plane 契约发送董事会目标。生产默认开放 `board_messages`，严重运行问题可通过 `AGENTCOMPANY_DISABLE_BOARD_MESSAGES=true` 关闭新发送并保留只读历史。

本次不是只按任务数量关单。对 M2 历史实现做了跨提交审查，并沿“interrupt → SSE → Playwright → Desktop → capability/文档”顺序收口；审查中额外发现并修复了发送未即时启动 runtime、终态竞争、恢复关联窗口、来源未精确 hydrate、Thread 数据不完整、work-scoped 隔离不足和 Desktop sidecar 运行依赖缺失。

## 历史提交审查范围

审查覆盖 M2 的领域、Runtime、SDK、Web、TUI 与关闭 Gate 提交：

- `f87c442` — Conversation schema 与 migration
- `3983625` — 持久频道读取模型
- `b91b674` — 幂等董事会 intake
- `644d2b4` — Board runtime 与来源桥
- `43d283e` — 高信号投影与恢复
- `cb2ec75` — 生成式 Conversation SDK
- `762efdc` — Web Conversation store
- `20e01e0` — TUI 统一入口
- `3240152` — 真实 Company Workspace UI
- `ddc9e98` — Task 9 状态记录
- `205055a` — 原 Task 10 纵向 Gate

审查方法包括逐提交 diff、当前实现调用链、权限与终态对抗检查、恢复故障点与并发重复启动检查、同类代码 sibling sweep、失败测试先行回归、真实 child-process restart、Browser Playwright、原生 Electron 与 Windows unpacked 打包验证。

## 发现与收口

| 发现 | 风险 | 收口结果 |
|---|---|---|
| Thread interrupt 在可见性校验前可能修改状态，且 HTTP 路径缺少 Repository Instance 上下文 | 越权副作用；中断状态不一致 | 先验证 company/channel/thread scope，再原子更新 run/thread；传播到 GroupSession/Session；不可见 interrupt 回归验证无写入 |
| HTTP send 只持久化 queued run，未在提交后立即启动 runtime | 用户要等进程重启才可能执行 | 新增 Conversation command 应用层；202 提交后立即 dispatch，重启恢复仍作为兜底 |
| completed/failed/interrupted 可被迟到投影覆盖 | 中断复活、终态倒退 | Thread/run 终态使用条件更新；投影器不得覆盖 interrupted；相关竞争回归通过 |
| run 已持久化但 GroupSession/runtime binding 尚未创建时崩溃 | 恢复重复或永久卡住 | 恢复逻辑以稳定 group ID 幂等补建 runtime binding，并按持久阶段续跑 |
| `work_scoped` 复用普通主 Agent 与工具能力 | private memory、Direct 或仓库外副作用泄漏 | 新增隐藏、无工具的 `board-discussion` 内部 Agent；GroupSession work scope 与 canary 负向测试通过 |
| source 只返回指针，未按 runtime message 精确 hydrate | 来源无法证明；可能错配消息 | 通过 GroupMessage `runtime_message_id` 精确解析 MessageV2/Part；每次 source 读取重新校验可见性 |
| 旧 Thread 的 source 请求迟到时会清掉新 Thread 同名 source 的 loading 状态，旧错误也可能污染新面板 | 快速切换 Thread 时证据 UI 状态错乱 | source 完成、错误与 cleanup 全部增加 thread generation/ID guard；迟到响应回归通过 |
| Thread entries 未完整包含 run 与 Agent runtime message | UI 无法显示真实运行状态和发言 | tagged union 增加 run/agent_message；Web/TUI 均按类型安全渲染 |
| Company feed 未包含 company-visible Board 高信号 | 公司群缺失应公开的重要结果 | 投影读取纳入 company-visible 信号并保持普通 Agent 输出只在 Thread |
| SSE 重连只继续监听，不强制快照对账 | 丢事件后 UI 永久缺消息或残留 pending | `server.connected`、页面重新可见与失效事件触发 company/channels/current messages/open thread 刷新；generation guard 隔离迟到响应；按持久 ID 对账 pending |
| 原 Playwright 主要验证 API，未证明真实 UI send/Thread，项目并发也会破坏共享生命周期 | Gate 假绿或不稳定 | 固定单 worker 与 project dependency；真实 UI Composer 发送并打开 Thread；reload 从 snapshot 重建；`m2-e2e` 纳入 CI |
| 无原生 Desktop 纵向 Gate | Web 可用不代表 Electron main/preload/sidecar 可用 | 新增 Windows 原生 Electron Gate，覆盖目录选择、bootstrap、发送/Thread、Browser 共享、重启恢复与 revoke；`m2-desktop` 纳入 CI |
| Desktop 内嵌 sidecar externalize `jsonc-parser`，但 Desktop 未声明运行依赖 | 当前开发/发布启动可能在创建窗口前挂起 | Desktop 声明 `jsonc-parser@3.3.1`；原生 Gate 通过；Windows `app.asar` 已确认包含依赖 |
| capability 只有测试专用开启方式，服务端发送边界未统一 | 生产永远只读，或 UI 隐藏但 API 可绕过 | 生产默认开启；服务端 command 统一校验；紧急只读开关为 `AGENTCOMPANY_DISABLE_BOARD_MESSAGES`；Web/TUI fail-closed |

关闭时没有遗留未修复的 M2 审查 finding。

## 原生 Desktop Gate 口径

Windows Gate 运行真实 Electron main、preload、renderer、内嵌 Control Plane sidecar 与真实 SQLite/Git fixture，验证：

1. Company home 目录选择取消不推进，成功后进入首次引导；
2. 首次引导绑定真实临时 Git 仓库；
3. Desktop Composer 真实发送消息并打开来源 Thread；
4. Browser 配对凭据从同一 Control Plane 读取相同 message ID 与 thread ID；
5. 关闭并重启应用后恢复同一公司、消息、Thread 与凭据；
6. Desktop revoke 后原 Browser Bearer 返回 401。

测试只替换操作系统目录对话框的返回值，以便稳定覆盖取消/成功分支；按钮、IPC、主进程 handler、数据目录切换及之后的产品路径均为真实实现。曾按原计划尝试 Windows 人工交互采集，但辅助工具返回 `GetCursorPos 0x80070005`，因此没有把未发生的人工点击写入证据；里程碑关闭依据是可重复的原生集成 Gate。

## 验证证据

所有 Bun 测试从对应 package 目录运行，服务端恢复测试使用 `--max-concurrency 1 --timeout 30000` 避免多个 child process 相互争用造成假超时。

| 范围 | 结果 |
|---|---|
| `packages/opencode` Agent 权限与内部代理 | 43 passed |
| `packages/opencode` Conversation 主链、10k、恢复、并发幂等与投影 | 32 passed |
| `packages/opencode` Company、GroupSession、HTTP、TUI | 49 passed |
| `packages/app` Company unit/component | 64 passed |
| Browser Playwright：shell → bootstrap → conversation | 6 passed |
| Windows 原生 Electron Playwright | 1 passed |
| SDK Conversation contract | 1 passed；重新生成后复验通过 |
| Typecheck | `opencode`、`sdk/js`、`app`、`ui`、`desktop` 全部通过 |
| Build | App production build、Desktop Electron build 全部通过 |
| Windows package | `electron-builder --win --dir` 通过；`app.asar` 包含 `node_modules/jsonc-parser` |
| 10,000 条 ChannelMessage | 首屏 50 条 cursor query 最终串行 Gate 为 10.3 ms；未设置无基线绝对阈值 |

SDK 使用仓库指定命令 `bun ./packages/sdk/js/script/build.ts` 重新生成，生成 contract 未出现 M2 产品 response `unknown`。

## CI 与回滚

- `m2-e2e` 在 Linux 上按 `app-shell → company-bootstrap → company-conversation` 单 worker 顺序运行并上传 JUnit/Playwright artifact。
- `m2-desktop` 在 `windows-latest` 上依赖 `m2-e2e`，构建并运行原生 Electron Gate，上传 JUnit/trace/screenshot artifact。
- M2 migration 只前向新增，不通过代码回滚删除用户 Channel/Thread/Message/Run/Projection。
- 紧急回滚只设置 `AGENTCOMPANY_DISABLE_BOARD_MESSAGES=true` 停止新发送；历史仍可读取，不回退到 `/company-project` 或 fixture。

## 关闭后的产品边界

Internal Alpha 可以表述为“可创建本地公司并进行真实董事会会话”。M2 没有实现 Charter、批准治理、Worktree 交付、Delivery、Direct、Agent private 或人格型 Dreaming；这些仍分别属于 M3–M5。当前下一里程碑是 M3 的治理与真实软件交付闭环。
