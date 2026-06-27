# Autonomous-Bidding 群聊调度器 — 技术文档

> 版本: 1.0 | 最后更新: 2026-06-27
> 代码位置: `packages/agent-runtime/src/groupOrchestration/scheduler/`

---

## 目录

1. [架构概述](#1-架构概述)
2. [核心类型系统](#2-核心类型系统)
3. [双层评分系统](#3-双层评分系统)
4. [意图探测 (Probe)](#4-意图探测-probe)
5. [仲裁与 fallback](#5-仲裁与-fallback)
6. [状态机与生命周期](#6-状态机与生命周期)
7. [权利管理 (Rights)](#7-权利管理-rights)
8. [事件系统](#8-事件系统)
9. [配置参数指南](#9-配置参数指南)
10. [前端集成](#10-前端集成)
11. [测试策略](#11-测试策略)
12. [性能与安全](#12-性能与安全)

---

## 1. 架构概述

### 1.1 设计哲学

本调度器采用 **Autonomous Bidding（自主竞价）** 机制，取代传统的中央 LLM 主持人决策模式。在传统方案中，一个广播式 `system` 调用（host LLM）负责观察讨论并指定下一个发言者。本方案让每个 agent **独立出价 + 确定性仲裁**来决定谁发言，使群聊更像真实的 IM 群组对话——成员主动发言，而非被点名。

### 1.2 核心循环

```
init → probe(并行探测所有成员) → arbitrate(确定性仲裁)
     → call_agent(让胜者发言) → agent_spoke(接收完成事件)
     → settle rights(结算权利) → re-bid(重新出价)
     → ... → 直到无人竞标(room idle)或达到预算 K(yield to human)
```

关键特性：
- **无中央主持人**：不依赖 LLM 做选人决策
- **并行探测 + 串行发言**：所有成员同时出价（IO 并行），但只有一人发言
- **确定性仲裁**：评分纯函数，无随机性，可复现

### 1.3 文件结构

```
scheduler/
├── bidding.types.ts          # 核心类型定义（Bid, RightsState, SchedulerState 等）
├── BiddingScheduler.ts       # 调度器主类（状态机 + 循环控制）
├── scoring.ts                # 纯函数：评分、仲裁、权利结算
├── probe.ts                  # 意图探测：prompt 构建、解析、安全降级
├── scheduler.config.ts       # 数值校准配置（默认值）
├── index.ts                  # 统一导出入口
└── __tests__/
    ├── BiddingScheduler.test.ts   # 调度器单元测试（8 用例）
    ├── scoring.test.ts            # 评分仲裁测试（15 用例）
    ├── probe.test.ts              # 探测测试（8 用例）
    └── groupChatSimulation.test.ts # 集成模拟测试（5 用例）
```

### 1.4 集成位置

```
packages/agent-runtime/src/groupOrchestration/
├── scheduler/                  ← bidding 调度器核心（本模块）
├── types.ts                    ← IGroupOrchestrationSupervisor 接口
├── GroupOrchestrationRuntime.ts ← 运行时协调（supervisor + executor 循环）
└── index.ts

src/store/chat/slices/
├── aiAgent/actions/groupOrchestration.ts  ← BiddingScheduler 实例化 + gatherBids
└── scheduler/                             ← 前端调度状态管理
    ├── action.ts                          ← updateSchedulerState, emitSchedulerEvent
    ├── initialState.ts                    ← schedulerStateMap, eventHistoryMap
    └── selectors.ts                       ← getSchedulerState, getEventHistory
```

---

## 2. 核心类型系统

### 2.1 Bid（投标单）

每个 agent 每轮发出一个 `Bid`，表示是否希望在当前轮次发言：

```typescript
interface Bid {
  level: BidLevel;        // 发言意愿强度
  type: BidType;          // 贡献类型（仲裁优先级）
  addressedAs: AddressedAs; // 被点名程度
  reason: string;         // 简短原因（日志/UI）
}
```

**BidLevel — 意愿强度**（排序：`must > want > could > pass`）：

| 级别 | 含义 | 典型场景 |
|------|------|----------|
| `must` | 必须说话 | 被直接问到且能回答；有阻塞性反对意见；只有自己能回答 |
| `want` | 想要发言 | 有新信息、真正的答案、或要认领并执行一个任务 |
| `could` | 可以但无所谓 | 一个次要观点；不说不影响结果 |
| `pass` | 不发言 | 没有实质性内容可贡献 |

**BidType — 贡献类型**（仲裁优先级：`objection > answer > question > claim > info > support`）：

| 类型 | 含义 | 优先级 |
|------|------|--------|
| `objection` | 反对/发现风险 | 最高 |
| `answer` | 直接回答问题 | 高 |
| `question` | 提出关键性问题 | 中高 |
| `claim` | 认领任务去执行 | 中 |
| `info` | 补充事实性上下文 | 低 |
| `support` | 同意/重申/附和 | 最低 |

**AddressedAs — 被点名程度**（排序：`direct > mention > none`）：

| 类型 | 含义 | 加分 |
|------|------|------|
| `direct` | 最后一次发言直接询问了本 agent | +40 |
| `mention` | 本 agent 的名称/工作被提及，但未被询问 | +15 |
| `none` | 未被点名 | 0 |

> **关键规则**：被点名 **不强制** 发言。如果不是本领域话题且更适合的人在场，可以投 `pass`。

### 2.2 RightsState（权利层状态）

跨轮次的持久化状态，记录每个成员在对话中的"权利"：

```typescript
interface RightsState {
  cooldown: number;    // 冷却惩罚值（刚发言后设为最大值，逐轮归零）
  idleRounds: number;  // 自上次发言后的空闲轮次（驱动"久沉默加分"）
}
```

### 2.3 ScoredBid（打分后的投标）

```typescript
interface ScoredBid {
  agentId: string;
  bid: Bid;
  eligible: boolean;      // 是否合格（level !== pass 且 base >= tau）
  score: number;          // 最终分数（只有 eligible=true 时有意义）
}
```

### 2.4 ArbitrationResult（仲裁结果）

```typescript
interface ArbitrationResult {
  scored: ScoredBid[];             // 所有投标（分数降序），用于日志/UI
  winnerId: string | null;         // 当选者，null 表示无人合格
  idleReason?: 'all_pass' | 'none_over_threshold';  // 无人竞标的原因
}
```

### 2.5 SchedulerState（调度器状态）

```typescript
interface SchedulerState {
  channelId: string;
  consecutiveAgentTurns: number;  // 连续 agent 发言轮次（与 K 比较）
  currentSpeaker?: string;        // 当前发言者
  phase: SchedulerPhase;          // 'idle' | 'bidding' | 'speaking'
  rights: Record<string, RightsState>;  // 所有成员的权利状态
  round: number;                  // 当前轮次
  taskBoard: TaskBoardEntry[];    // 协作看板（运行中的任务）
}
```

---

## 3. 双层评分系统

### 3.1 评分公式

```
Score = IntentLayer + RightsLayer

IntentLayer  = base(level) + addressBonus(addressedAs) + typePriority(type)
RightsLayer  = -cooldown + staleness(idleRounds)

Eligibility  = level !== 'pass' && base(level) >= tau
```

| 组件 | 来源 | 特点 |
|------|------|------|
| **IntentLayer** | 每轮重新探测 | 反映当前轮次的发言意图 |
| **RightsLayer** | 跨轮持久化 | 反映"公平性"——刚说过的被压制，久沉默的获加分 |

### 3.2 评分细则

#### base(level) — 基础分

| level | base |
|-------|------|
| `must` | 100 |
| `want` | 60 |
| `could` | 30 |

> `pass` 的 level 不计算 base，直接排除。

#### addressBonus(addressedAs) — 被点名加分

| addressedAs | bonus |
|-------------|-------|
| `direct` | 40 |
| `mention` | 15 |
| `none` | 0 |

#### typePriority(type) — 类型优先级加分

| type | bonus |
|------|-------|
| `objection` | 15 |
| `answer` | 10 |
| `question` | 6 |
| `claim` | 4 |
| `info` | 2 |
| `support` | 0 |

#### staleness(idleRounds) — 久沉默加分

```
staleness(idleRounds) = min(idleRounds × stalenessPerRound, stalenessCap)
```

- `stalenessPerRound = 5`，`stalenessCap = 30`
- 沉默 6 轮达到满分 30
- 防止通过永不出声来"躺赢"——有上限

#### cooldown — 冷却惩罚

- 刚发言者：`cooldown = 50`
- 每轮衰减：`cooldown -= 15`（减到 0 为止）
- 发言后需约 3-4 轮才能完全恢复

### 3.3 资格门禁 (τ / tau)

```typescript
tau: 30   // 默认值
```

只有 `base(level) >= tau` 的投标才参与竞争：
- `could` = 30 → 刚好达到门槛
- `want` / `must` → 总是合格
- `pass` → 始终不合格（即使调低 τ 也不影响，因为 level=pass 直接返回 null）

调高 τ（如 60）会将 `could` 级别排除出竞争，仅允许 `want` 和 `must` 参与。

### 3.4 公平性保证（反独白）

```
刚刚发言的 A(want+answer) = 60 + 0 + 10 - 50 + 0 = 20  ← 不敌别人
沉默两轮的 B(want+answer) = 60 + 0 + 10 - 0 + 10 = 80  ← 胜出
```

刚发言的 agent 即使发出强力出价（`must` + `objection`），cooldown=50 也足以将其压制到低于别人普通 `want` 的分数，确保对话不会变成一人独白。

### 3.5 平分决胜

分数相同时，`idleRounds` 更大的成员胜出（更久未发言者获得机会）。这是确定性算法——没有随机种子，给定相同输入总输出相同结果。

---

## 4. 意图探测 (Probe)

### 4.1 设计目标

每个 agent 在被询问是否要发言时，调用一个**廉价模型**（intent probe），**只决定要不要说话，不生成实际发言内容**。这比让主模型完整推理一轮要快且便宜得多。

### 4.2 Probe 流程

```
输入 (ProbeInput)
  ├── persona: 当前 agent 的名称、角色、描述
  ├── lastEvent: 触发本轮出价的事件
  ├── transcript: 最近的对话记录（窗口化）
  ├── members: 所有成员名称和角色
  └── taskBoard: 协作看板（已认领/运行/完成的任务）
        ↓
buildProbePrompt() → ProbeModel(LLM) → parseBid()
        ↓
输出 (Bid) — level, type, addressedAs, reason
```

### 4.3 Probe Prompt 硬规则

出价 prompt 中编入了 6 条不可变规则：

1. **默认投 `pass`**——沉默是正确的，除非能增加实质价值。
2. **同意/鼓励/"+1" 最多投 `could`，通常投 `pass`**——绝不因礼貌而出价。
3. **真正的反对意见是受尊重的**——可以投 `want` 或 `must`。模糊的不安（"我不确定……"）最多 `could`。
4. **协作看板已有相同任务在运行时，不重复认领**——除非有完全不同的角度。
5. **被点名也不强制发言**——如果不是自己的领域，可以让给更适合的人。
6. **针对最新状态判断**——对话已经过去的话题现在是 `pass`，即使之前很重要。

### 4.4 安全降级

所有可能的探测失败点都有安全降级：

| 失败模式 | 降级结果 |
|----------|----------|
| LLM 调用异常（超时/限流） | `pass` + reason "fallback: probe model error" |
| 返回内容不是 JSON | `pass` + reason "fallback: no JSON found" / "invalid JSON" |
| `level` 字段无效 | `pass` + reason "fallback: invalid level" |
| `level` 有效但 `type` 无效 | 将 `type` 强制设为 `info` |
| `level` 有效但 `addressedAs` 无效 | 将 `addressedAs` 强制设为 `none` |

> **设计原则：错误的出价绝不能导致错误发言。** 有疑问时，保持安静（pass）。

---

## 5. 仲裁与 Fallback

### 5.1 标准仲裁流程

```typescript
function arbitrate(entries, config): ArbitrationResult {
  1. 对每个 entry 计算 scoreBid(bid, rights, config)
  2. 标记 eligible = score !== null
  3. 按 score 降序排列（平局 → idleRounds 大者优先）
  4. 如果至少一个 eligible → 选 score 最高的
  5. 否则 → winnerId = null
}
```

### 5.2 Human Fallback 机制

**核心问题**：当 human 发了消息但所有 agent 都 `pass`（如 LLM probe 全部不可用），对话不能死寂。

**解决方案**：

```
if winnerId === null AND lastEvent.type !== 'agent_spoke':
    speakerId = pickFallbackSpeaker(memberIds)
    // 选 idleRounds - cooldown 最大的成员
    // 即"最欠发言"的人
```

**区分两种场景：**

| 触发事件 | 无人竞标时行为 | 原因 |
|----------|----------------|------|
| `human_message`（含 `init`） | 触发 fallback，选最欠发言者 | 用户需要被回应 |
| `agent_spoke` | 保持安静（`finish`） | agent 自然间歇是合理的 |
| `task_completed` | 触发 fallback | 新信息进入对话，需要响应 |

### 5.3 Fallback Speaker 选择算法

```typescript
pickFallbackSpeaker(memberIds):
    return candidates.reduce((best, id) => {
        score = rights[id].idleRounds - rights[id].cooldown
        bestScore = rights[best].idleRounds - rights[best].cooldown
        return score > bestScore ? id : best
    })
```

选择 `idleRounds - cooldown` 最大者——即最久未说话且冷却最少的人。这确保了：
- 对话不会总由同一个 agent 回应
- 所有成员有机会轮流参与
- 刚发言的人不会被再次选中

### 5.4 预算机制（K 值）

```
maxConsecutiveAgentTurns: 6   // K 值
```

- 每轮 agent 发言后，`consecutiveAgentTurns += 1`
- 当达到 K 值时 → `yield_to_human:budget_exhausted`
- 防止 agent 垄断对话
- **任务完成（`task_completed` / `tasks_completed`）重置计数器**——新结果进入对话时应重新开始计数

---

## 6. 状态机与生命周期

### 6.1 状态定义

```typescript
type SchedulerPhase = 'idle' | 'bidding' | 'speaking';
```

### 6.2 状态转换图

```
                    ┌─────────────────────────────────────┐
                    │              decide('init')          │
                    │                  │                   │
                    ▼                  ▼                   │
              ┌──────────┐     ┌──────────┐               │
              │   idle   │────▶│ bidding  │               │
              │          │     │          │               │
              └──────────┘     └────┬─────┘               │
                    ▲               │                     │
                    │         arbitrate()                  │
                    │       ┌───────┴────────┐            │
                    │       │                │            │
                    │  winner=null      winner=id         │
                    │       │                │            │
                    │       ▼                ▼            │
                    │  ┌──────────┐   ┌──────────┐        │
                    │  │  idle    │   │ speaking │        │
                    │  │ (finish) │   │          │        │
                    │  └──────────┘   └────┬─────┘        │
                    │                      │              │
                    │              agent_spoke             │
                    │                      │              │
                    │            ┌─────────┴────────┐     │
                    │            │                  │     │
                    │      budget_K_reached   within K    │
                    │            │                  │     │
                    │            ▼                  │     │
                    │      ┌──────────┐             │     │
                    │      │  idle    │             └─────┘
                    │      │ (yield)  │
                    │      └──────────┘
                    └──────────────────────────────────────┘
                            task_completed 重置 budget
                                  从外部重新进入
```

### 6.3 `decide()` 状态机

`BiddingScheduler.decide()` 根据输入的 `ExecutorResult` 类型分发处理：

| `ExecutorResult` 类型 | 行为 | 下一状态 |
|------------------------|------|----------|
| `init` | 创建初始状态 → `openRound()` | bidding |
| `agent_spoke` | 结算权利 → 检查 K 值 → `openRound()` | bidding 或 idle(yield) |
| `task_started` | 发射事件 → `openRound()`（不操作 budget） | bidding |
| `task_completed` | 重置 budget=0 → `openRound()` | bidding |
| `tasks_completed` | 重置 budget=0 → `openRound()` | bidding |

### 6.4 完整对话示例

```
Round 1 [human]: "我们讨论一下新产品路线图"
  → probe(CEO/CTO/CFO/CMO 并行出价)
  → arbitrate: CMO(want+market) wins
  → CMO: "从市场角度看，我们应该先做 MVP 验证..."
  → settleAfterSpeak(CMO): cooldown=50, idle=0; 其他人 decay

Round 2 [agent_spoke]:
  → re-bid: CMO is in cooldown, others staleness has grown
  → arbitrate: CTO(want+answer, silent 1 round) wins
  → CTO: "技术上我们可以用 React + Node 快速搭建..."
  → settleAfterSpeak(CTO): cooldown=50; 其他人 decay

Round 3 [agent_spoke]:
  → re-bid: CEO(want+product, silent 2 rounds) wins
  → CEO: "我们产品定位是面向中小企业..."

... 直到 K=6 或无人竞标 → yield to human
```

---

## 7. 权利管理 (Rights)

### 7.1 权利层数据结构

```
rights: Record<string, RightsState>
```

每个成员在 `SchedulerState.rights` 中有一个条目，跨轮次持久存在。

### 7.2 状态转换

#### 初始化
```typescript
initialRights() => { cooldown: 0, idleRounds: 0 }
```

#### 每轮结算（对所有未发言者）
```typescript
decayRights(rights) => {
  cooldown: max(0, rights.cooldown - cooldownRecoverPerRound),  // 15
  idleRounds: rights.idleRounds + 1,
}
```

#### 发言后（仅对胜者）
```typescript
markSpoke() => { cooldown: cooldownInitial, idleRounds: 0 }  // 50
```

#### 完整的 `settleAfterSpeak(speakerId)` 流程

```typescript
for each member:
    if member === speakerId:
        rights[member] = markSpoke()    // cooldown=50, idle=0
    else:
        rights[member] = decayRights()  // cooldown+=15, idle+=1
```

### 7.3 数值示例

| 轮次 | 发言者 | CEO | CTO | CFO | CMO |
|------|--------|-----|-----|-----|-----|
| 初始 | - | C:0, I:0 | C:0, I:0 | C:0, I:0 | C:0, I:0 |
| 1 | CTO | C:+15, I:1 | C:50, I:0 | C:+15, I:1 | C:+15, I:1 |
| 2 | CEO | C:50, I:0 | C:-35, I:2 | C:-30, I:2 | C:-30, I:2 |
| 3 | CFO | C:-35, I:1 | C:-20, I:3 | C:50, I:0 | C:-15, I:3 |
| 4 | CMO | C:-20, I:2 | C:-5, I:4 | C:-35, I:1 | C:50, I:0 |

- `C` = cooldown, `I` = idleRounds
- 发言后 cooldown=50，idle=0
- 未发言者每轮 cooldown -= 15（到 0 为止），idle += 1
- 大约 3-4 轮后刚发言者才能再次有竞争力

---

## 8. 事件系统

### 8.1 事件类型

调度器通过 `onEvent` 回调发射 10 种事件，供前端投影使用：

```typescript
type BiddingEvent =
  | { type: 'bidding.opened'; round: number; eligibleAgentIds: string[] }
  | { type: 'bid.submitted'; agentId: string; bid: Bid; finalScore: number }
  | { type: 'speaker.elected'; agentId: string; round: number; finalScore: number }
  | { type: 'speaker.skipped'; agentId: string; reason: 'below_threshold' | 'cooldown' | 'lost' }
  | { type: 'room.idle'; reason: 'no_bid_over_threshold' | 'all_pass' }
  | { type: 'turn.yielded'; reason: 'budget_K_reached' }
  | { type: 'task.started'; agentId: string; taskId: string; title: string }
  | { type: 'task.completed'; agentId: string; taskId: string; status: string; resultRef?: string }
```

### 8.2 事件发射时序

```
openRound()
  → bidding.opened                    [一轮出价开始]
  → bid.submitted (for each member)   [每个 agent 的出价]
  → speaker.elected / room.idle        [仲裁结果]
  → (如果 fallback) bid.submitted      [fallback 产生的虚拟出价]

agent_spoke → settleAfterSpeak → openRound → ...

task_completed → task.completed         [任务完成通知]
  → reset budget → openRound

turn.yielded → budget_K_reached         [预算耗尽]
```

---

## 9. 配置参数指南

### 9.1 完整参数表

| 参数 | 默认值 | 范围 | 含义 | 调优方向 |
|------|--------|------|------|----------|
| `base.must` | 100 | 0-200 | must 级别基础分 | 调高使强力出价更占优 |
| `base.want` | 60 | 0-200 | want 级别基础分 | 核心发言意愿门槛 |
| `base.could` | 30 | 0-200 | could 级别基础分 | 影响轻微意见的参与度 |
| `addressBonus.direct` | 40 | 0-100 | 被直接点名加分 | 提升被点名者的发言概率 |
| `addressBonus.mention` | 15 | 0-50 | 被提及加分 | 轻量提醒加分 |
| `addressBonus.none` | 0 | - | 未点名 | 固定为 0 |
| `typePriority.objection` | 15 | 0-30 | 反对意见优先级 | 反对意见是否应优先讨论 |
| `typePriority.answer` | 10 | 0-30 | 直接回答问题优先级 | 回答是否优先于提问 |
| `typePriority.question` | 6 | 0-20 | 提问优先级 | 关键性问题权重 |
| `typePriority.claim` | 4 | 0-15 | 认领任务优先级 | 任务认领权重 |
| `typePriority.info` | 2 | 0-10 | 补充信息优先级 | 事实性信息权重 |
| `typePriority.support` | 0 | - | 附和/支持 | 固定为 0 |
| `cooldownInitial` | 50 | 0-200 | 发言后冷却初值 | `> base.want - base.could`≈30 才有效 |
| `cooldownRecoverPerRound` | 15 | 1-50 | 每轮冷却恢复量 | 影响发言者重回竞争的速度 |
| `stalenessPerRound` | 5 | 1-20 | 每空闲轮次加分 | 影响长期沉默者的参与度 |
| `stalenessCap` | 30 | 0-100 | 久沉默加分上限 | 防通过沉默来"躺赢" |
| `tau (τ)` | 30 | 0-100 | 资格门禁阈值 | `base(level) >= τ` 才合格 |
| `maxConsecutiveAgentTurns` | 6 | 1-20 | 最大连续 agent 轮次(K) | 越大 agent 越主导，越小 user 越主导 |

### 9.2 调优原则

1. **绝对分数无意义，比例才重要** ——只看相对差距
2. **从保守开始，逐步放开** ——初始配置偏紧（silence 多一些），调松如果对话太死寂
3. **关键比率**：
   - `cooldownInitial > base.want - base.could` (50 > 30) ✅ — 确保刚发言者的弱出价不及别人的强出价
   - `stalenessCap < base.want` (30 < 60) ✅ — 久沉默者不会仅靠 idle 分数超过有实质内容的人
4. **调优手段**：通过事件流重放（event-stream replay）分析胜者分布、沉默率、独白/乒乓现象

### 9.3 场景配置建议

| 场景 | tau | cooldownInitial | maxConsecutiveTurns | 说明 |
|------|-----|-----------------|---------------------|------|
| 创意讨论（默认） | 30 | 50 | 6 | 平衡 |
| 技术评审 | 30 | 40 | 8 | 各角色需要更详细讨论 |
| 快速决策 | 60 | 60 | 4 | 仅允许强力出价 |
| 全体大会 | 30 | 30 | 10 | 更多人需要轮流发言 |

---

## 10. 前端集成

### 10.1 状态管理

前端在 `src/store/chat/slices/scheduler/` 中管理调度器状态：

- **`action.ts`** — `updateSchedulerState()` 和 `emitSchedulerEvent()`
- **`initialState.ts`** — `schedulerStateMap`（频道 → SchedulerState）、`eventHistoryMap`（频道 → BiddingEvent[]）
- **`selectors.ts`** — `getSchedulerState(channelId)`、`getEventHistory(channelId)`

### 10.2 群聊消息发送流程

```
用户发送消息
    ↓
sendGroupMessage() 检测 speakerSelectionMethod === 'bidding'
    ↓
sendClientOrchestratedGroupMessage()
    ↓
internal_execGroupOrchestration()
    ↓
创建 BiddingScheduler 实例 (客户端侧)
    ↓
BiddingScheduler.decide({ type: 'init' })
    ↓
gatherBids() — 并行发起所有 agent 的 intent probe
    ↓
... 调度器循环 ...
```

### 10.3 业务后端集成

在 `apps/server/src/services/agentCompany/boardGroup.ts` 中，创建董事会圆桌会议群组时设置 `speakerSelectionMethod: 'bidding'`，包含 CEO/CTO/CFO/CMO 四个角色成员。

---

## 11. 测试策略

### 11.1 测试概览

| 测试文件 | 类型 | 用例数 | 覆盖范围 |
|----------|------|--------|----------|
| `scoring.test.ts` | 纯函数单元测试 | 15 | 资格检查、双层评分组合、staleness、仲裁各种场景、权利转换、预算 K |
| `probe.test.ts` | 单元测试 | 8 | prompt 构建、JSON 解析、容错、安全降级 |
| `BiddingScheduler.test.ts` | 调度器测试 | 8 | init 开启、重新出价、human fallback、自然安静、权利结算、K 值 yield、task 重置 |
| `groupChatSimulation.test.ts` | 集成模拟 | 5 | 无 host 群聊模拟、多发言者覆盖、轮转性、provider 宕机、自然安静 |

### 11.2 关键测试场景

**仲裁测试（scoring.test.ts）：**

```
✓ 防独白: just-spoke must yields to another fresh want
✓ 质疑 > 回答: same level, objection beats answer
✓ 久沉默专家: long-idle want is pulled in over a fresh want
✓ 软点名: pass-level bid is ineligible
✓ 静默: all pass → no winner, all_pass reason
✓ 静默: bids exist but none clear tau → none_over_threshold
✓ tie-break: equal scores resolved by most idle rounds
```

**调度器测试（BiddingScheduler.test.ts）：**

```
✓ init opens the first round and elects highest bidder
✓ re-bids after each speak, electing freshly each round
✓ answers human with fallback even when everyone passes
✓ goes idle when agents pass after an agent turn (natural lull)
✓ settles rights: just-spoken member is damped next round
✓ yields to human after K consecutive agent turns
✓ task completion resets consecutive-agent budget
```

### 11.3 运行命令

```bash
# 运行所有 bidding 相关测试
bunx vitest run src/groupOrchestration/scheduler/__tests__/

# 运行单个测试文件
bunx vitest run --silent='passed-only' 'src/groupOrchestration/scheduler/__tests__/scoring.test.ts'
bunx vitest run --silent='passed-only' 'src/groupOrchestration/scheduler/__tests__/BiddingScheduler.test.ts'
bunx vitest run --silent='passed-only' 'src/groupOrchestration/scheduler/__tests__/probe.test.ts'
bunx vitest run --silent='passed-only' 'src/groupOrchestration/scheduler/__tests__/groupChatSimulation.test.ts'
```

---

## 12. 性能与安全

### 12.1 性能特征

| 指标 | 预期 | 说明 |
|------|------|------|
| 每轮 LLM 调用数 | N（成员数） | 所有成员并行调用 probe LLM |
| 仲裁时间复杂度 | O(N log N) | 主要是 scored bids 排序 |
| 每轮延迟 | max(probe_io_latency) | 最慢的 probe 调用决定轮次速度 |
| 安全降级开销 | 零 | 所有降级路径不额外调用 LLM |

### 12.2 安全与鲁棒性

- **单点故障不扩散**：任何 agent 的 probe 失败仅影响其自身的出价，不阻塞整个对话
- **无中央 LLM 单点**：不存在传统方案中 host LLM 死掉就无法继续的问题
- **确定性仲裁**：评分函数是纯函数，不会因 LLM 幻觉而不一致
- **预算保护**：K 值确保 agent 不会无限发言，human 永远有机会介入
- **所有异常有降级**：probe → pass; fallback → 最欠发言者; 无合格者 → idle
