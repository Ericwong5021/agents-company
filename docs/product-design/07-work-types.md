# 工作类型：软件研发优先

> 状态：当前
> 上位文档：[产品宪法](PRODUCT-CONSTITUTION.md)

## 1. 当前范围

Pre-Public 和首次公开版本只承诺把**软件研发**做成完整、可信、可长期使用的 Agent 公司工作流。

底层对象可以保持领域中立，但产品、界面、验收、模板和默认 Agent 必须先围绕代码仓库优化。没有完成软件纵向闭环前，不进入“全行业 AI 公司”扩张。

## 2. 通用工作契约

所有领域未来都应遵循：

```text
明确目标 + 输入 + 权限 + 工作流
  → 可审查制品
  → 领域验证
  → Gate / 决定 / 交付
```

通用对象包括 Project Charter、Work Item、Thread、Artifact、Admission、Decision 和 Audit Event。领域适配器负责提供工具、制品类型和验证器。

## 3. 软件研发适配器

### 3.1 输入

- 一个主 Git 仓库；
- 用户目标和 Project Charter；
- 分支、Worktree 与合并策略；
- 允许的工具和网络/外部权限；
- 仓库规则、构建和测试命令。

### 3.2 典型角色

- Product DRI：目标、范围和验收；
- Technical Lead：技术方案与风险；
- Engineer：实现与自检；
- Reviewer：独立 Agent Review；
- 按需的 Test、Security、Design 或 Research Agent。

角色可以由同一个 Agent 在低风险小任务中兼任，但执行者不能在需要独立审查时自我批准。

### 3.3 制品

- Project Charter 与技术方案；
- 代码 diff 和提交；
- 测试、构建、类型检查、Lint 或安全报告；
- Review findings 与处理记录；
- 合并提交和主分支验证；
- 必要的文档、迁移和发布说明。

### 3.4 验证

验证优先级：

1. 用户定义的业务验收；
2. 仓库内已有规则和测试；
3. 项目 Charter 新增的场景测试；
4. 构建、类型、静态分析和安全检查；
5. 人工或 Agent 的体验审查。

不能因为完整测试耗时而静默跳过。若风险可接受，必须通过明确 Gate 记录部分验证和剩余风险。

## 4. 软件交付状态

```text
Charter
→ Planned
→ Worktree Ready
→ Implementing
→ Testing
→ Agent Review
→ Waiting Approval
→ Merging
→ Verifying Main
→ Delivered
→ Worktree Destroyed
```

失败和取消是可恢复状态，不是销毁资源的快捷方式。

## 5. 一项目一仓库

首次公开版本不在一个 Project 内修改多个仓库。跨仓库需求由董事会拆成多个关联 Project，每个项目有自己的：

- Charter 与 DRI；
- 项目群；
- 审批和 Gate；
- Worktree 生命周期；
- 验收结果。

上层 Initiative 可以聚合多个项目的状态，但不能绕过单仓库治理。

## 6. 后续领域

后续可能的适配器：

| 领域 | 制品 | 核心验证 |
|---|---|---|
| Research | 报告、证据包 | 来源追踪、交叉验证、时效性 |
| Writing | 文稿、版本 | Rubric、事实核验、版权与语气 |
| Design | 设计稿、资产 | 渲染、可用性、视觉审查 |
| Analysis | 数据模型、报告 | 重算、假设审计、数据血缘 |
| Operations | 计划、执行记录 | 授权、外部副作用、回滚 |

某领域进入产品主线前必须满足：

- 有持续用户需求；
- 有领域 Agent 与工具；
- 有可执行的 Admission；
- 权限和外部副作用可治理；
- 不破坏软件研发主线的可靠性。

## 7. 非目标

- 用大量 Agent 模板数量代表领域能力；
- 只有生成没有验证的“工作适配器”；
- 在首次公开版本中提供通用企业自动化市场；
- 为适配领域而弱化 Project、Gate、审计或私人空间规则。
