---
feature: board-natural-group-chat
status: delivered
specs: []
plans: []
branch: main
commits: uncommitted-working-tree
---

# 董事会自然群聊机制 — Final Report

## What Was Built

董事会群聊改为 Cumora 风格的独立唤醒机制。用户或 Agent 的新消息会唤醒尚未处理该消息的其他成员，每个 Agent 根据身份、职责、直接提及和最新对话独立判断是否回应；非必要补充、附和和重复内容保持沉默，不再经过中央竞标、评分和唯一发言人选举。

多个有实质贡献的 Agent 最多同时思考 3 个。每条草稿发布前都会在串行门禁中核对群聊最新消息；上下文已经变化时，旧草稿不会直接发送，Agent 会基于新消息重新分诊并最多重新生成一次。系统禁止连续自我回复，并保留每轮最多 6 条 Agent 消息的安全上限。

## Architecture

`GroupSession.runConversationLoop` 维护本轮已读消息水位、并行唤醒和发布锁。`probeOne` 使用每个 Agent 的小脑模型完成独立分诊，`AgentTurn.prepare` 使用大脑模型生成自然、简洁的群聊回复。已存在的 `group_session_bidding` 数据结构继续作为内部诊断记录，记录每次唤醒的分诊结果，但不再参与中央评分或发言人选举，因此无需数据库迁移。

`natural-turn.ts` 集中定义实质回应门槛、直接提及兜底、反独白规则和 6 条上限。旧的 `BiddingScheduler`、冷却分、陈旧度加权和评分配置已移除。

### Design Decisions

- 选择每个 Agent 独立分诊，因为角色相关性和是否有新增价值应由 Agent 自己判断，而不是由中央分数替代。
- 选择“并行思考、串行发布”，因为它保留群聊即时性，同时让发布前新鲜度检查可以原子地阻止抢话和过时回答。
- 选择一次有界重判，因为上下文变化需要重新判断，但无限重试会放大成本并制造新的对话循环。
- 保留原诊断表而不迁移数据库，因为用户可见行为不依赖旧竞标语义，当前改造可以安全回滚。

## Usage

该机制自动应用于现有董事会 GroupSession，不新增配置、API 或用户操作。用户继续在董事会频道发送消息；被直接点名或有明确职责的 Agent 优先回应，其他成员只有在能提供不同且必要的信息时才发言。

## Verification

- `bun test test/group-session/scheduler/natural-turn.test.ts test/group-session/scheduler/probe.test.ts`：7 项通过，0 项失败。
- `git diff --check -- src/group-session src/agent-turn test/group-session`：通过。
- 旧中央竞标器、评分器和配置引用扫描：无剩余引用。
- `bun test test/group-session/group-session.test.ts`：5 项均在测试夹具初始化阶段被共享 WIP 的 `Service not found: @control-plane/Auth` 阻塞，未进入本次群聊代码。
- `bun typecheck`：被共享 WIP 的 `src/remote-access/client.ts:218` 类型错误阻塞；错误为联合类型缺少 `connection_epoch`，本次未越界修改。
- 未运行产品构建或浏览器验收。

## Journey Log

- [pivot] 将“全员竞标后选唯一发言人”替换为“全员独立判断后自然回应”，因为机械感来自调度模型而不是单条提示词。
- [lesson] 并行生成必须配合发布前水位检查，否则多个正确的独立判断仍可能形成重复或过时消息。
- [lesson] 共享脏工作区中的验证失败必须追溯到进入目标代码之前还是之后，不能把 Auth 夹具错误归因于群聊重构。

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `packages/control-plane/src/group-session/group-session.ts` | 群聊运行时 | 独立唤醒、新鲜度门禁、恢复与中断 |
| `packages/control-plane/src/group-session/scheduler/natural-turn.ts` | 发言约束 | 回应门槛、兜底、反独白和上限 |
| `packages/control-plane/src/group-session/scheduler/probe.ts` | 小脑分诊 | 自然群聊分诊提示与 Agent 小脑模型 |
| `packages/control-plane/src/agent-turn/agent-turn.ts` | 大脑回复 | Agent 身份与自然群聊回复提示 |
| `/Users/wangyidong/project/cumora/docs/COORDINATION.md` | 参考机制 | 独立唤醒、新鲜度检查和防碰撞原则 |
