---
feature: board-group-chat
status: delivered-with-verification-boundary
specs: []
plans:
  - plans/2026-08-21-board-group-chat.md
branch: main
commits: uncommitted-working-tree
---

# 董事会 Cumora 群聊机制迁移 — Final Report

## 交付结果

董事会主路径已经从“用户消息 → 单个 ConversationRun → 集中式 GroupSession 圆桌”切换为持久化群聊。每条董事会消息按频道领取单调递增序号，并为每位在职董事 Agent 建立独立投递；Agent 分别使用小模型判断是否需要参与，再使用自己的大模型生成回复。董事会讨论不再选举唯一 winner，也不再向产品界面暴露 Bidding 状态。

旧的 Bidding scheduler、评分器和调度配置已删除。GroupSession 仅保留给非董事会内部场景；董事会写入、恢复和中断入口已经改接 RoomRuntime。

## 运行机制

1. 用户消息先持久化为 ChannelMessage，并在同一 SQLite 事实层维护频道 sequence。
2. 系统为频道内每位董事建立独立 delivery，状态覆盖 pending、triaging、running、held、responded、passed、failed 和 cancelled。
3. 同一 Agent 串行处理投递；短时间内的多条未读消息会合并，避免重复唤醒。
4. 小模型依据职责、点名和新增价值独立判断；直接点名强制进入大模型阶段，CEO 对人类消息承担兜底响应。
5. 大模型运行仍受 AgentRun、只读权限和 Founder OS 治理边界约束，聊天讨论本身不构成执行授权。
6. 发布前检查频道新鲜度；发现更新消息时旧回复进入 held，不直接发出。逐字重复回复会在事务内被拦截。
7. 限流进入 60 秒冷却，普通失败采用有限重试；重启会恢复未完成的 pending、triaging 和 running 投递。

## 群聊能力

- 按 sequence 排序的用户、Agent 和系统消息流。
- 回复引用、@Agent、资源信息、Reaction、Poll 与投票。
- 用户已读水位与 Agent shown/processed 水位分离。
- triaging、running、held、cooldown、failed 等投递状态可见。
- 未读分割线、进入页面后的 mark-read、消息序号定位。
- 顾问收敛、决策台账、治理资产和人工接管继续保留在董事会治理区域，不因聊天自动升级为授权。

## 数据迁移与接口

新增 channel_counter、channel_delivery、channel_read_state、channel_message_hold、channel_reaction 和 channel_poll_vote 事实表；ChannelMessage 增加 sequence、kind 和 poll 数据。迁移会回填既有消息序号、迁移未投影的历史董事会发言，并中断仍处于活动态的旧董事会 ConversationRun。

董事会 API 已增加 Reaction、Poll Vote、mark-read 和群聊投递投影；JavaScript SDK 与 OpenAPI 已重新生成。

## 验证

| 验证项 | 结果 |
|---|---|
| `packages/control-plane` 执行 `bun typecheck` | 通过 |
| `packages/app` 执行 `bun typecheck` | 通过 |
| 董事会消息持久化、每 Agent delivery、无集中 ConversationRun、Reaction、Poll、read watermark | 3 项通过，0 失败 |
| Conversation thread 读取模型去除 Bidding entry | 1 项通过，0 失败 |
| 自然群聊回应门槛、点名兜底、反独白与轮次上限 | 5 项通过，0 失败 |
| WebUI snapshot 与消息分类合同 | 15 项通过，0 失败 |
| 非董事会 GroupSession 结构化模型路由 | 单独运行 1 项通过，0 失败 |
| SDK 生成 | 成功 |
| 空数据库迁移与新增群聊表 | 成功 |
| `git diff --check` | 通过 |

## 验证边界

- 未运行产品 build 或 package。
- 未完成真实浏览器中的视觉与交互验收，也未用真实 Provider 完成“至少两位董事响应、用户中途 steer、刷新及进程重启恢复”的端到端场景，因此这些不能宣称为已验收。
- `test/group-session/group-session.test.ts` 整文件运行时，一项 15 秒用例超时并引发后续共享数据库清理竞态；同一结构化模型路由用例单独运行通过。该旧 GroupSession 套件不再覆盖董事会主路径，但整文件稳定性仍需单独治理。
- hold acknowledgement 的事实表已经建立，当前产品行为采用自动丢弃陈旧回复并重新处理最新 pending 消息，尚未暴露人工 override 操作。
- 当前工作区包含远程访问、公司运行日志和 Agent brain 等并行未提交改动；本次未提交、未推送，也未重置这些改动。

## Journey Log

- [pivot] 将先前仅在 GroupSession 内模拟自然发言的方案升级为 ChannelMessage 与独立 delivery 驱动的董事会主路径，避免产品表面像群聊、底层仍是圆桌运行时。
- [decision] 继续复用 AgentTurn、AgentRun、Provider brain model 和 Founder OS，不迁入 Cumora 的服务端、CLI 或多用户边界。
- [lesson] 新鲜度、去重、恢复和水位必须成为数据库事实，不能只依赖进程内调度状态。
- [boundary] 代码与合同验证已完成，真实多 Agent UI 验收尚未完成，报告将两者明确分开。

## Source Materials

| 文件 | 作用 |
|---|---|
| `packages/control-plane/src/conversation/room.sql.ts` | 群聊计数器、投递、水位、hold、Reaction 与投票事实 |
| `packages/control-plane/src/conversation/room-runtime.ts` | 独立分诊、Agent 运行、新鲜度、去重、重试、steer 与恢复 |
| `packages/control-plane/migration/20260821010000_board_group_chat/migration.sql` | 结构迁移、历史消息回填与旧运行中断 |
| `packages/control-plane/src/server/routes/company-conversation.ts` | 群聊写入与动作 API |
| `packages/app/app/pages/company/board.vue` | 董事会群聊主界面和治理区域 |
| `packages/app/modules/agent-company/runtime/shared/company-contract.ts` | WebUI 群聊合同 |
| `plans/2026-08-21-board-group-chat.md` | 实施计划与验收边界 |
