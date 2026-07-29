# ADR：Founder OS 治理边界

- 状态：Proposed
- 日期：2026-07-30
- 人工确认：not_confirmed
- 适用范围：Founder OS v1

本记录包含 W0 的六项架构决定。Pre-Public 开发中，人工确认作为 advisory 弱门禁登记；未确认不阻塞机器验证、集成或后续开发，也不等于已获得授权。提高 Founder Twin 模式仍需要真实授权。

## FOS-ADR-001：Founder Twin 属于 Governance Plane

### 背景

Founder Twin 代表创始人形成判断，不是执行 Worker、Tool 容器或第二套 Runtime。治理判断与执行副作用混在同一权限域会使授权、审计和接管失效。

### 决策

Founder Twin 只存在于 Governance Plane，只能读取经权限过滤的 Founder Assets、Delegation Policy、Decision Ledger 和业务证据，并输出版本化 `DecisionIntent`。它不得直接依赖 Runtime、Tool、Recruitment 或 Graph Mutation 写模块。

### 不采用

- 不把 Founder Twin 实现为拥有执行工具的通用 Agent。
- 不建立第二个 Control Plane、数据库或 Agent Runtime。
- 不以模型置信度替代确定性权限判断。

### 推进影响

`packages/control-plane/src/founder-os/**` 和兼容目录 `packages/control-plane/src/founder-twin/**` 受可执行依赖边界检查约束。后续执行只能经 Decision Ledger、权限服务和现有 Control Plane 纵向链进入。

## FOS-ADR-002：Founder Twin 不得直接修改任务图

### 背景

Seed-and-Grow 已决定 Worker 只提交 Work Receipt，Graph Supervisor 只提出变更，确定性 Policy 决定是否应用。Founder Twin 若能直接创建、修改或完成 WorkItem，会绕过该链。

### 决策

Founder Twin 只能提出 `DecisionIntent`，不得直接创建、修改、完成 WorkItem，不得调用 Graph Supervisor 或提交 Graph Mutation。Worker 同样不得直接调用 Graph Supervisor。

### 不采用

- 不向 Founder Twin 暴露 Company Project 写服务。
- 不允许 Worker 以 prompt、Tool 或内部导入调用 Graph Supervisor。
- 不把自然语言建议解释为任务图写命令。

### 推进影响

Founder OS 边界检查拒绝 Graph Supervisor、Graph Mutation 和 Company Project 执行写模块的直接依赖；Worker 路径出现 Graph Supervisor 依赖时同样失败。

## FOS-ADR-003：AI 推测不是创始人事实

### 背景

Founder Twin 会从历史选择、资料和结果推测偏好。推测可以参与 Shadow 或 Advisor 判断，但不能伪装成大东本人明确表达或确认的事实。

### 决策

所有治理输入必须携带 authority。AI 生成内容只能处于 `ai_inferred` 或更低权限状态；只有可核验的人类确认事件可以产生 `human_confirmed`，且升级采用追加记录。

### 不采用

- 不因高置信度自动升级为创始人事实。
- 不允许模型自报“已由创始人确认”。
- 不覆盖原始推测来隐藏其来源。

### 推进影响

后续 authority 状态机必须包含 AI 不能升级为 human 的负例；UI 和证据包必须区分推测、外部来源与人类确认。

## FOS-ADR-004：原始来源不能直接成为有效公司政策

### 背景

文章、对话导出、播客、图片和外部观点是来源材料，不等于公司已采纳的政策。直接生效会绕过解释、实验与治理决定。

### 决策

原始来源只作为带来源跨度和隐私作用域的 Artifact。它必须经过 Agent Interpretation、候选观点、实验或决策链，最终由获授权的治理决定升级为 Governance Asset、Delegation Policy、Skill 或 Benchmark 变更。

### 不采用

- 不把导入、摘要、embedding 或检索命中直接标为公司政策。
- 不让 Agent Interpretation 自动取得 human authority。
- 不因来源知名或重复出现而自动采纳。

### 推进影响

Company Commons 默认最多进入 ingest-only；来源升级状态机必须保留不能直接从 raw source 到 active policy 的负例。

## FOS-ADR-005：所有自治决定必须进入 Decision Ledger

### 背景

自治决定若只存在于消息、模型输出或运行日志中，无法证明代理身份、依据、权限、接管和结果之间的关系。

### 决策

任何代表创始人的自治决定在进入执行链前必须追加写入 Decision Ledger，并绑定 Snapshot、Evidence、权限分类和来源 DecisionIntent。没有 Ledger 主记录的执行请求必须拒绝。

### 不采用

- 不以 ChannelMessage、Artifact、Tool log 或模型自述替代 Ledger。
- 不允许先执行后补写主记录。
- 不原地覆盖已决定记录。

### 推进影响

W1 建立 append-only Ledger 后，所有 delegated 路径必须先取得 Ledger 标识；Flag 降级和回滚不删除审计记录。

## FOS-ADR-006：AI 大东与 `board-ceo` 是同一 Founder 治理投影

### 背景

当前董事会固定存在 `board-ceo`、`board-cto` 和 `board-product-lead`。无声新增第四名 AI Founder 会产生两个都声称拥有最终 Founder 权威的身份。

### 决策

AI 大东是现有 `board-ceo` 的 Founder Governance Projection，不是第四名员工 Agent。v1 保留稳定主体标识 `board-ceo`，在 Founder OS 视图中显示 `AI 大东 · 创始人代理`，并以模式、Snapshot、DecisionIntent 和 Ledger 元数据区分代理行为。人类大东始终是最终权限来源，接管、否决和纠偏优先于该投影。

### 不采用

- 不创建独立 `founder-twin` 员工并与 `board-ceo` 并列。
- 不让 `board-ceo` 和另一个 AI 身份分别产生最终 Founder 决定。
- 不把展示名称变更当成身份迁移。

### 推进影响

后续数据迁移复用 `board-ceo` 主体并追加代理元数据，不复制历史消息或决定。任何需要保留独立 CEO Agent 的实现变化都必须先替换本 ADR，明确优先级、消息来源和迁移。
