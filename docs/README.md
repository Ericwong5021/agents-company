# Agent Company 文档导航

> 最近清理：2026-07-26

本文档目录采用“一个主题、一个事实源”的原则。阅读或修改前先确认文档层级，避免把历史计划当成当前产品定义。

## 权威顺序

1. [产品宪法](product-design/PRODUCT-CONSTITUTION.md)：不可被普通需求覆盖的产品原则与硬边界。
2. [产品 PRD](Agent%20Company%20产品%20PRD.md)：首次公开版本要交付什么，以及如何验收。
3. [产品设计总览](product-design/00-overview.md) 与专题设计：各子系统如何协作。
4. [体验重构计划](product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)：当前 R0-R4 的执行顺序、任务依赖和发布门槛。
5. [实施计划](product-design/implementation-plan.md)：基于当前代码事实的架构收敛路径。
6. [Seed-and-Grow 计划](AgentCompany-Seed-and-Grow-Development-Plan-v1.0.md)：在 R3/R4 允许窗口内实施动态组织能力，不覆盖体验重构计划的发布顺序。
7. [Founder OS 计划](AgentCompany-Founder-OS-Development-Plan-v1.0.md)：实施创始人治理、公司认知与学习闭环，不覆盖上位产品边界。
冲突时以上位文档为准，并应在同一次文档变更中消除下位冲突。

## 两套计划的分工（2026-07-25 起）

体验重构计划自 2026-07-25 起为 `In Execution`，接管**当前执行顺序**：现在的工作批次由 R0-R4 定义，R0 未通过前不进入 R1。实施计划的 M0-M6 继续作为**架构收敛路径与里程碑退出标准**的事实源，但其“当前下一步”不再决定排期。

- 问“现在该做哪一批”→ 看体验重构计划的 R 阶段与 Task 总览。
- 问“某个子系统的目标架构、退出标准与 PRD 覆盖关系”→ 看实施计划的 M 里程碑。
- 两者对同一能力给出不同状态时，以代码事实为准，并在同一次变更中修正过时的一侧。

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
| [Agent-Company-Experience-Refactor-Plan-v1.0.md](product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md) | Goal 到 Verified Delivery 的体验重构执行清单 | 执行中 / 决定当前排期 |
| [AgentCompany-Seed-and-Grow-Development-Plan-v1.0.md](AgentCompany-Seed-and-Grow-Development-Plan-v1.0.md) | R3/R4 动态组织能力包、实施波次与本地精确 SHA 自动 Gate | 执行中 / 受体验重构阶段窗口约束 |
| [AgentCompany-Founder-OS-Development-Plan-v1.0.md](AgentCompany-Founder-OS-Development-Plan-v1.0.md) | Founder OS、Company Commons 与 Learning Loop 开发波次 | 执行中 |
| [ADR-Founder-OS-Governance-v1.0.md](product-design/ADR-Founder-OS-Governance-v1.0.md) | Founder Twin 治理、权限、来源、Ledger 与身份边界 | Proposed / 待人工确认 |
| [Founder-OS-IA-v1.0.md](product-design/Founder-OS-IA-v1.0.md) | Founder OS 页面在现有五项一级导航中的归属 | Frozen |
| [experience-refactor/manifest.v1.json](product-design/experience-refactor/manifest.v1.json) | 体验重构机器可读语言契约、基准、指标、基线与验证入口 | 执行中 |
| [implementation-plan.md](product-design/implementation-plan.md) | 架构收敛路径、里程碑退出标准与 PRD 覆盖自审 | 当前 / 不决定排期 |
| [CODEX-DESIGN-LANGUAGE.md](product-design/CODEX-DESIGN-LANGUAGE.md) | WebUI 视觉语言：色板、字号、圆角、Phosphor、设置 IA | 当前 |

## 组件与设计资产

- [Marvis 视觉复刻设计源与验收](design/README.md)：记录 Pencil 设计源和同视口 QA 证据；它是实现参考，不覆盖产品宪法或 PRD。
- [Autonomous-Bidding PRD](product-design/bidding-prd.md) 与[技术文档](product-design/bidding-technical-document.md)描述群聊内部的发言调度组件。它是 Thread/群聊的实现机制之一，不定义整个产品的信息架构。

## 维护规则

- 宪法只写长期原则和硬边界；具体页面与字段写入 PRD 或专题设计。
- PRD 只定义用户可感知需求与验收，不复制实现步骤。
- 实施计划必须区分“代码模块存在”和“产品闭环已通过验收”。
- M1 的 Company 数据目录由启动 Control Plane 的 host 在动态导入前固定；本地浏览器直接读取该 host 已选目录，不能在线搬迁它。
- 已完成的临时计划、故障报告和验证快照由 Git 历史追溯，不在现行文档树长期保留。
- 设计 QA 与验收快照必须写明验收对象（实现与提交）。被验收的实现一旦被替换或删除，该记录立即标注失效，不得继续当作当前实现的验收证据。
- 新增文档前先检查能否补充现有事实源；不创建平行版本的总览、路线图或实施日志。
