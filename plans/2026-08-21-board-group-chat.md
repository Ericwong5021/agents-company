# Board Group Chat Implementation Plan

> 实施报告：[reports/board-group-chat.md](../reports/board-group-chat.md)。核心切换、数据迁移、API、SDK 与 WebUI 已完成；真实 Provider 多 Agent 浏览器验收、hold 人工 override 和旧 GroupSession 整文件稳定性仍保留为明确验证边界。

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Cumora 的持续群聊协作机制替换董事会集中式 GroupSession 圆桌，让每位董事基于持久未读事实独立判断、发言、被 steer、恢复并收敛正式决策。

**Architecture:** 继续使用 Agent Company 的 Channel、ConversationThread、ChannelMessage、AgentTurn、AgentRun、Decision Ledger 与本地 SQLite。新增按消息序号驱动的投递队列、每 Agent 已读/处理水位、限界唤醒和发送保护；董事会不再由 BiddingScheduler 选出单一发言者。WebUI 以群聊为主，Founder OS 治理能力收进右侧治理栏。

**Tech Stack:** TypeScript、Bun、Effect、Drizzle SQLite、Hono、Nuxt/Vue、SSE。

## Global Constraints

- 在 `main` 当前共享工作区实施，不创建分支，不重置或覆盖现有未提交改动。
- 保留当前 Agent `big/small brain`、Provider `resolveBrainModel()` 和远程访问在途改动。
- Control Plane 是消息、投递、运行、决策和恢复状态的唯一权威写入者。
- 不引入 PostgreSQL、Redis、Cumora CLI、云端多用户、移动端、邮件或推送依赖。
- 群聊讨论不能直接冒充 Decision Ledger、Gate、Approval 或用户授权。
- 不长期保留董事会双运行时；只允许迁移期回滚开关，完成后移除旧 Bidding 入口。
- 只更新因机制替换而过时的现有测试，不建立平行测试框架。
- 不从仓库根运行测试；不主动构建或打包产品。

---

### Task 1: Durable Room Facts

**Files:**
- Create: `packages/control-plane/src/conversation/room.sql.ts`
- Create: `packages/control-plane/migration/20260821010000_board_group_chat/migration.sql`
- Modify: `packages/control-plane/src/conversation/conversation.sql.ts`
- Modify: `packages/control-plane/src/conversation/schema.ts`
- Modify: `packages/control-plane/src/storage/schema.ts`

**Interfaces:**
- Produces: `ChannelCounterTable`、`ChannelDeliveryTable`、`ChannelReadStateTable`、`ChannelMessageHoldTable`、`ChannelReactionTable`、`ChannelPollVoteTable`。
- Produces: `ChannelMessage.sequence`、`ChannelDeliveryStatus`、`ChannelAgentTurnState`、群聊消息游标。

- [ ] 给 `channel_message` 增加非空 `sequence`，按 channel 建立唯一索引，并为现有消息按创建时间回填稳定序号。
- [ ] 建立 `channel_counter(channel_id, next_sequence)`，所有消息写入在同一 SQLite immediate transaction 中领取序号。
- [ ] 建立每条消息对每位 Agent 的持久投递记录，状态固定为 `pending | triaging | running | held | responded | passed | failed | cancelled`。
- [ ] 建立用户 read、Agent shown、Agent processed 三个独立水位，禁止用 UI read 游标推进 Agent inbox。
- [ ] 建立与 Agent、channel、sequence、过期时间绑定的 hold acknowledgement；建立 Reaction 与 Poll Vote 事实表。

### Task 2: Cumora Coordination Kernel

**Files:**
- Create: `packages/control-plane/src/conversation/room-runtime.ts`
- Create: `packages/control-plane/src/conversation/room-triage.ts`
- Create: `packages/control-plane/src/conversation/room-steer.ts`
- Modify: `packages/control-plane/src/conversation/index.ts`
- Modify: `packages/control-plane/src/effect/app-runtime.ts`

**Interfaces:**
- Produces: `RoomRuntime.Service.enqueueMessage(messageID)`、`drainAgent(agentID)`、`recover()`、`interruptAgent(agentID)`。
- Consumes: `CompanyAgent.Service.get()`、`Provider.Service.resolveBrainModel()`、`AgentTurn.prepare()`、`AgentRun.Service`。

- [ ] 将消息投递给 channel 中除作者外的活动 Agent 成员；用户消息和直接 mention 标记为强唤醒。
- [ ] 以 Agent 为串行单元合并 2.5 秒窗口内的 pending 消息；同一 Agent 同时最多一个董事会 turn。
- [ ] 小模型只返回 `must | want | could | pass` 与简短公开原因；人类消息、直接点名和正式待决策强制 actionable。
- [ ] 大模型获得完整可见 channel 历史、当前未处理消息、同轮新消息和 Agent 公共职业上下文；返回 `speak | pass`，不暴露内部推理。
- [ ] Provider 限流时保留未读和投递，进入 60 秒冷却；普通失败有限重试并写 AgentRun 事实。

### Task 3: Freshness, Deduplication, Steering and Recovery

**Files:**
- Modify: `packages/control-plane/src/conversation/room-runtime.ts`
- Modify: `packages/control-plane/src/conversation/room-steer.ts`
- Modify: `packages/control-plane/src/conversation/recovery.ts`
- Modify: `packages/control-plane/src/agent-run/supervisor.ts`

**Interfaces:**
- Produces: `publishAgentMessage()` 的 `sent | held | duplicate` 结果。
- Produces: 内存 steer queue；消息本体与 processed 水位继续持久化。

- [ ] Agent 发送前检查 shown 水位之后的新非本人消息；存在新消息时将投递改为 held，并把新上下文重新排入同一 Agent。
- [ ] 在领取 sequence 与 INSERT 的同一事务中比较上一条非本人消息，拦截逐字相同回复。
- [ ] hold override 只接受当前 sequence 水位且两分钟内的一次 acknowledgement，不能预先绕过。
- [ ] 活跃 turn 收到用户或 mention 时在安全 hop 边界合并 steer；群聊普通消息只投递一次内容无关 nudge。
- [ ] 重启后把 triaging、running、held 且未终结的投递恢复为 pending；内存 steer 丢失时由持久 inbox 自动补偿。

### Task 4: Conversation Cutover and APIs

**Files:**
- Modify: `packages/control-plane/src/conversation/intake.ts`
- Modify: `packages/control-plane/src/conversation/conversation.ts`
- Modify: `packages/control-plane/src/conversation/runtime.ts`
- Modify: `packages/control-plane/src/conversation/signal-projector.ts`
- Modify: `packages/control-plane/src/server/routes/company-conversation.ts`
- Modify: `packages/control-plane/src/server/server.ts`
- Modify: `packages/sdk/openapi.json`
- Modify: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Modify: `packages/sdk/js/src/v2/gen/types.gen.ts`

**Interfaces:**
- Produces: channel timeline、mark-read、reaction、poll vote、agent delivery/typing projection API。
- Removes: board message → one ConversationRun → one centralized GroupSession 的主路径。

- [ ] Board Channel 写入成功后提交 room deliveries 并启动 RoomRuntime，不再为每条用户消息创建集中式 GroupSession run。
- [ ] Board timeline 返回用户、Agent、系统消息的 sequence、reply、mentions、resources、reactions、poll、delivery 和 typing 投影。
- [ ] 保留 Thread 与 Root Need；聊天消息可继续形成 Goal Brief、Charter 与 DecisionIntent。
- [ ] Signal Projector 从 ChannelMessage 与 AgentRun 来源生成高信号投影，不再依赖 Bidding winner。
- [ ] 增加 mark-read、reaction、poll vote 与中断端点并重新生成 JavaScript SDK。

### Task 5: Board Chat WebUI

**Files:**
- Create: `packages/app/app/components/company/BoardChat.vue`
- Create: `packages/app/app/components/company/BoardMessage.vue`
- Create: `packages/app/app/components/company/BoardGovernanceRail.vue`
- Modify: `packages/app/app/pages/company/board.vue`
- Modify: `packages/app/app/assets/css/main.css`
- Modify: `packages/app/modules/agent-company/runtime/shared/company-contract.ts`
- Modify: `packages/app/modules/agent-company/runtime/server/api/board.get.ts`
- Create: `packages/app/modules/agent-company/runtime/server/api/board-read.post.ts`
- Create: `packages/app/modules/agent-company/runtime/server/api/board-reaction.post.ts`
- Create: `packages/app/modules/agent-company/runtime/server/api/board-poll-vote.post.ts`

**Interfaces:**
- Consumes: Task 4 board timeline and action APIs。
- Produces: 持续董事会群聊主界面与治理侧栏。

- [ ] 页面中心改为按 sequence 排序的真实消息流，显示作者、角色、时间、回复关系、提及、成果和失败状态。
- [ ] Composer 支持普通消息、`@Agent`、回复、文本附件和 Poll；发送失败保留草稿并可重试。
- [ ] 显示 Agent 正在判断、正在回复、冷却、held 和失败恢复状态；不展示 Bidding 或 winner 内部状态。
- [ ] 支持 Reaction、消息 `#sequence` 定位、未读分割线和进入可见区后的 mark-read。
- [ ] 现有影子建议、顾问收敛、决策台账、治理资产和人工接管移入右侧治理栏，保持来源与授权不变。

### Task 6: Retire the Board Roundtable

**Files:**
- Modify: `packages/control-plane/src/group-session/group-session.ts`
- Modify: `packages/control-plane/src/group-session/group-session.sql.ts`
- Delete: `packages/control-plane/src/group-session/scheduler/BiddingScheduler.ts`
- Delete: `packages/control-plane/src/group-session/scheduler/scoring.ts`
- Delete: `packages/control-plane/src/group-session/scheduler/scheduler.config.ts`
- Modify: `packages/control-plane/src/group-session/scheduler/index.ts`
- Modify: `packages/control-plane/src/conversation/conversation.ts`
- Modify: `packages/app/modules/agent-company/runtime/shared/company-contract.ts`

**Interfaces:**
- Board 不再产生 `GroupSessionBidding`、winner 或 round budget。
- GroupSession 只保留仍被非董事会内部功能使用的最小边界；若无引用则整体移除。

- [ ] 将历史 `group_message` 中未投影的可见董事会发言迁移为 ChannelMessage，并保留来源引用。
- [ ] 移除董事会读取 Bidding entries、winner 和 round 状态的 API 与 UI 合同。
- [ ] 删除无引用的 Bidding scheduler 与配置，保留当前大小模型解析实现。
- [ ] 确认 Project Graph Supervisor、Workflow 与项目执行不依赖被删除的董事会调度器。

### Task 7: Replace Obsolete Acceptance Coverage

**Files:**
- Modify: `packages/control-plane/test/group-session/group-session.test.ts`
- Modify: `packages/control-plane/test/conversation/conversation.test.ts`
- Modify: `packages/app/e2e/r0-shell.spec.ts`
- Modify: `packages/app/e2e/fake-control-plane.ts`

**Interfaces:**
- Produces: 新群聊机制的现有测试入口，不增加平行测试框架。

- [ ] 用并行董事投递、human/mention 强唤醒、pass、held、原子去重和重启恢复替换 winner/bidding 断言。
- [ ] 保留 Goal Brief、Charter、Decision Ledger、Gate 与人工接管的来源关联断言。
- [ ] WebUI 验收覆盖消息连续显示、输入不丢、回复、Reaction、Poll、未读、Agent 状态和治理侧栏。

### Task 8: Verification and Final Report

**Files:**
- Create: `reports/board-group-chat.md`
- Create: `reports/board-group-chat.html`

**Interfaces:**
- Produces: 可复核的源码、类型、测试与真实 UI 证据边界。

- [ ] 在 `packages/control-plane` 运行 `bun typecheck` 和被替换的 conversation/group-session 测试。
- [ ] 在 `packages/app` 运行 `bun typecheck` 和董事会现有 Playwright 用例；不运行产品 build 或 package。
- [ ] 启动本地 Control Plane 与 WebUI，真实发送一条需要 CEO、CTO、Product Lead 讨论的决策消息。
- [ ] 验证至少两位董事独立响应、无人重复刷屏、用户中途纠正能 steer、刷新与重启后消息和未读状态恢复。
- [ ] 验证讨论可收敛 DecisionIntent，但没有用户授权时不产生高风险执行。
- [ ] 运行 `git diff --check`，生成同名 Markdown 与独立 HTML 报告。
