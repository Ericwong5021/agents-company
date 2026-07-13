# Autonomous-Bidding 群聊调度组件 PRD

> 版本：1.2
> 校准日期：2026-07-13
> 状态：核心调度器已实现；IM-first 产品整合待完成
> 上位文档：[IM-first 交互与协作原语](05-interaction-primitives.md)

> [!IMPORTANT]
> Bidding 是 Group Session/Thread 内部选择下一位发言者的机制，不是 Agent Company 的主产品入口，不负责董事会治理、任务委派或高信号摘要。普通用户不需要理解出价和评分。

## 1. 问题

多 Agent 群聊常见两种调度方式：

- 中央 Host LLM 每轮决定谁发言：成本和延迟高，形成单点判断；
- 固定 Round Robin：可预测但机械，Agent 即使没有贡献也必须发言。

Agent Company 需要更接近自然 IM 的行为：每个 Agent 根据自己的身份与上下文表达发言意愿，系统用确定性规则选择下一位发言者，并在无人需要补充时自然停下。

## 2. 目标与非目标

### 2.1 目标

- Agent 能表达 `must / want / could / pass` 的发言意愿；
- Probe 并行、廉价、失败安全；
- 仲裁确定、可测试、可诊断；
- 被直接点名、专业异议和回答得到合理优先级；
- cooldown 防止独白，staleness 降低长期沉默；
- 全员 pass 或达到轮次预算时把控制权交还用户；
- 调度细节不污染主会话。

### 2.2 非目标

- 用 Bidding 代替 Project Charter、DRI 或组织权限；
- 根据职位高低决定意见价值；
- 强迫所有 Agent 每轮发言；
- 通过 Bidding 创建或认领正式 Work Item；
- 生成结论、Decision 或主会话摘要；
- 在默认 UI 展示每个分数和 Probe reason。

## 3. 适用场景

| 场景 | 期望行为 |
|---|---|
| 董事会讨论 Charter | 有实质异议或需补充的角色发言，无新信息时停止 |
| 技术方案评审 | 被点名的技术角色和 blocker objection 优先 |
| 项目群状态讨论 | 有风险、问题或答案的 Agent 发言，重复同意不占主会话 |
| 用户直接提问 | 至少有合适 Agent 回应；全员 pass 时安全 fallback |
| Agent 连续讨论 | 有 K 上限，不能无人值守无限对话 |

Direct 不使用多方 Bidding；两人私聊由普通会话和注意力调度处理。

## 4. 用户体验

### 4.1 默认展示

用户看到：

- 当前谁在回复；
- 会话是否仍在形成结论；
- 讨论自然停止或因预算让回用户；
- 最终高信号结论及其来源 Thread。

用户默认看不到：

- 每个 Agent 的 Probe Prompt；
- 原始 Probe 输出；
- 每轮完整评分表；
- cooldown、staleness 和 tau 参数。

这些信息只在 Thread 诊断层按需显示，并遵守日志保留与隐私规则。

### 4.2 控制

用户可以：

- @Agent 或 @Role；
- 中断当前讨论；
- 显式邀请某 Agent 回答；
- 查看调度为何停止；
- 在高级设置中选择经验证的预设，而不是直接面对所有数学参数。

用户点名提高优先级，但 Agent 仍可以在没有价值或权限不足时 `pass` 或升级问题。

## 5. 需求与实现状态

| ID | 需求 | 当前基础 | Pre-Public 缺口 |
|---|---|---|---|
| BID-01 | 四级发言意愿和六类贡献类型 | 已实现 | 校准真实对话 Prompt |
| BID-02 | 并行 Probe 全部成员 | 已实现 | 加公司级并发/Token 上限 |
| BID-03 | 结构化 Bid 解析，失败降级 pass | 已实现 | schema-constrained output 与遥测脱敏 |
| BID-04 | 确定性评分和资格门禁 | 已实现 | 版本化 tie-break，支持重放 |
| BID-05 | direct/mention 与贡献类型加分 | 已实现 | 验证多语言与角色场景 |
| BID-06 | cooldown 与 staleness Rights | 已实现于单次 loop | 定义跨用户轮次持久与重置语义 |
| BID-07 | Human Fallback | 已实现 | 验证最小发言人数策略不会制造噪音 |
| BID-08 | 连续 Agent 发言 K 上限 | 已实现 | 接入公司/项目预算和 UI 原因 |
| BID-09 | Bidding/Agent/Yield/Round 事件 | 已实现 | 映射到 Thread 与诊断 UI |
| BID-10 | 高信号结论提升 | 不属于调度器 | 由 IM Thread 协议实现并消费调度事件 |
| BID-11 | 在线参数配置 | 默认常量存在 | 提供安全预设、验证和变更审计 |
| BID-12 | 任务完成重置 | Scheduler 有重置方法 | 与正式 Work Item 事件整合 |

“已实现”只指 `packages/opencode/src/group-session/scheduler/` 和当前 Group Session 循环存在代码，不代表 Web/Desktop 产品验收完成。

## 6. 行为规格

### 6.1 Bid

```ts
interface Bid {
  level: "must" | "want" | "could" | "pass"
  type: "objection" | "answer" | "question" | "claim" | "info" | "support"
  addressedAs: "direct" | "mention" | "none"
  reason: string
}
```

语义：

- `must`：若不发言会遗漏 blocker、关键纠错或直接责任；
- `want`：有明确的新答案或高价值补充；
- `could`：可能有帮助，但不影响讨论完整性；
- `pass`：没有新增价值、信息不足或不应参与。

### 6.2 仲裁

仲裁考虑：

- 发言意愿基础分；
- 被点名方式；
- 贡献类型；
- 发言后的 cooldown；
- 未发言轮数的有限加分；
- 最低资格阈值；
- 完全平分时的稳定规则。

默认参数和公式属于技术契约，见[技术文档](bidding-technical-document.md)。产品层只承诺行为，不把具体分值当成永远不变的 UX。

### 6.3 停止

以下情况停止或让回用户：

- 已有足够成员参与，且所有人 pass；
- 没有 Bid 达到资格阈值；
- 连续 Agent 发言达到 K；
- 用户中断；
- 预算、权限或运行错误要求终止。

停止必须产生结构化原因，不让 UI 看起来像无响应。

### 6.4 Fallback

用户输入后全员 pass，且仍需要一个回应时，选择当前最欠发言权的成员。Fallback 只是防止死寂，不能无限触发，也不能把没有信息的回复提升成高信号结论。

## 7. 权限与隐私

- Probe 只接收当前 Group Session 已授权 transcript；
- 不能读取其他 Agent private、Direct 或无关项目信息；
- Probe reason 和原始输出按诊断数据处理，不进入组织记忆；
- Bidding 不能授予发言者新的工具、项目或文件权限；
- 用户 @Agent 不能绕过该 Agent 的权限边界；
- 调度器失败只能降低为 pass/停止，不能降低治理门槛。

## 8. 非功能需求

### 8.1 性能

- Probe 并行执行，但受全局并发和 Token 预算限制；
- 一轮延迟主要由最慢可接受 Probe 决定；
- 大群组必须支持候选过滤或分层 Probe，避免无界 fan-out；
- 调度日志和 Thread 历史增量持久，不阻塞发言流。

### 8.2 可靠性

- 任一 Probe 失败等价于该 Agent `pass`；
- 所有 Probe 失败时可 fallback 或明确停止；
- Agent 发言失败后记录 error，Rights 结算语义必须明确；
- 调度循环可取消，用户中断优先；
- 事件必须足以解释 winner、idle 和 yield。

### 8.3 可重放

给定相同的 Bid、Rights、配置版本和稳定 tie-break，仲裁结果必须一致。LLM Probe 本身不要求确定，但其结构化输出必须保存为事件证据。

## 9. 验收

### 9.1 核心调度器

- 不同 level/type/addressedAs 得到预期排序；
- pass 不参与竞争；
- cooldown 抑制连续发言；
- staleness 在 cap 内提高参与机会；
- 完全平分使用稳定规则；
- K 达到后 yield；
- 全员 pass 正确 idle；
- fallback 选择最欠发言者。

### 9.2 Group Session 集成

- 用户消息触发并行 Probe；
- winner 发言、消息持久化、Rights 结算后重新竞价；
- 全员 pass、阈值不足、K、用户中断和 Agent error 都能结束；
- 事件顺序可供 Thread UI 恢复；
- 无权限内容不进入 transcript 或诊断。

### 9.3 产品体验

- 主会话不显示评分噪音；
- 用户能理解谁正在回复和讨论为何停止；
- Thread 诊断可解释异常选择；
- 高信号结论引用完整讨论来源；
- Bidding 不创建影子任务或绕过 DRI。

## 10. 成功指标

- 无有效贡献时的无意义 Agent 回复率；
- 一次用户输入后的平均 Agent 发言数与 K 触发率；
- 长期被忽略 Agent 的比例；
- Fallback 后产生有效回应的比例；
- 每轮 Probe 延迟、Token 和失败率；
- 用户对会话自然度和可控性的评价；
- 主会话中由调度噪音造成的消息占比（目标为零）。

这些指标不能激励系统让更多 Agent 发言。质量与停止能力优先于参与数量。

## 11. 后续问题

- Rights 应在一个用户轮次、一个 Thread 还是一个 Channel 维度持久；
- 20+ Agent 群组如何先筛选相关候选；
- 中文、英文和混合语言是否需要不同 Probe 示例；
- Agent 发言失败后是否应施加 cooldown；
- 如何用 event replay 调参而不让历史数据包含敏感 transcript；
- 何时提供任务职责权重，以及如何防止职位权重压制专业异议。

这些问题不阻塞核心调度器，但在把 Bidding 标记为 Pre-Public 产品完成前必须有明确答案或范围限制。
