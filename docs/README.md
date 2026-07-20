# Agent Company 文档导航

> 最近清理：2026-07-18

本文档目录采用“一个主题、一个事实源”的原则。阅读或修改前先确认文档层级，避免把历史计划当成当前产品定义。

## 权威顺序

1. [产品宪法](product-design/PRODUCT-CONSTITUTION.md)：不可被普通需求覆盖的产品原则与硬边界。
2. [产品 PRD](Agent%20Company%20产品%20PRD.md)：首次公开版本要交付什么，以及如何验收。
3. [产品设计总览](product-design/00-overview.md) 与专题设计：各子系统如何协作。
4. [实施计划](product-design/implementation-plan.md)：基于当前代码事实的收敛路径。
冲突时以上位文档为准，并应在同一次文档变更中消除下位冲突。

## 当前产品设计

| 文档 | 主题 | 状态 |
|---|---|---|
| [PRODUCT-CONSTITUTION.md](product-design/PRODUCT-CONSTITUTION.md) | 产品使命、硬边界、人格与治理原则 | 规范性 / 当前 |
| [00-overview.md](product-design/00-overview.md) | 产品公式、三层模型、技术总览 | 当前 |
| [01-organization-structure.md](product-design/01-organization-structure.md) | 最小董事会、动态组织、Agent 职业生命周期 | 当前 |
| [02-execution-model.md](product-design/02-execution-model.md) | 目标到交付的执行模型 | 当前 |
| [03-information-architecture.md](product-design/03-information-architecture.md) | 上下文、可见性与私人空间 | 当前 |
| [04-attention-modes.md](product-design/04-attention-modes.md) | Thread、Reflection、Ambient、Dreaming | 当前 |
| [05-interaction-primitives.md](product-design/05-interaction-primitives.md) | IM-first、频道、Thread 与交互原语 | 当前 |
| [06-governance.md](product-design/06-governance.md) | Charter、审批、Gate、审计 | 当前 |
| [07-work-types.md](product-design/07-work-types.md) | 领域中立工作契约、动态能力组合与软件深度适配器 | 当前 |
| [implementation-plan.md](product-design/implementation-plan.md) | 实现基础、缺口和工作流 | 当前 |

## 组件与设计资产

- [Marvis 视觉复刻设计源与验收](design/README.md)：记录 Pencil 设计源和同视口 QA 证据；它是实现参考，不覆盖产品宪法或 PRD。
- [Autonomous-Bidding PRD](product-design/bidding-prd.md) 与[技术文档](product-design/bidding-technical-document.md)描述群聊内部的发言调度组件。它是 Thread/群聊的实现机制之一，不定义整个产品的信息架构。

## 维护规则

- 宪法只写长期原则和硬边界；具体页面与字段写入 PRD 或专题设计。
- PRD 只定义用户可感知需求与验收，不复制实现步骤。
- 实施计划必须区分“代码模块存在”和“产品闭环已通过验收”。
- M1 的 Company 数据目录由启动 Control Plane 的 host 在动态导入前固定；本地浏览器直接读取该 host 已选目录，不能在线搬迁它。
- 已完成的临时计划、故障报告和验证快照由 Git 历史追溯，不在现行文档树长期保留。
- 新增文档前先检查能否补充现有事实源；不创建平行版本的总览、路线图或实施日志。
