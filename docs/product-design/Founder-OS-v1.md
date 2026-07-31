# Founder OS v1 当前合同

> 状态：产品开发完成 / Pre-Public
> 实现候选：`b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8`
> 完成日期：2026-07-30
> 人工授权：`not_confirmed`，非阻塞登记
> 真实样本验收：`not_confirmed`，非阻塞登记

本文描述 Founder OS v1 在当前代码中的能力、边界和接入位置。开发任务与机器 Gate 记录仍保留在[开发计划](../AgentCompany-Founder-OS-Development-Plan-v1.0.md)，长期治理决定见[治理 ADR](ADR-Founder-OS-Governance-v1.0.md)。

## 1. 产品边界

Founder OS v1 包含：

- Founder Twin：以 `board-ceo` 的 Founder Governance Projection 形成可审计建议；
- Decision Ledger：保存不可变决定核心、追加式状态、纠偏、派发与 Outcome；
- Founder Assets：保存带来源、authority、版本和作用域的治理资产与 Snapshot；
- Company Commons：导入、恢复、检索和隔离外部材料；
- Learning Loop：Interpretation、Belief、Experiment 与 Learning Patch。

Founder Twin 只能输出 `DecisionIntent`。它不能直接调用 Runtime、Tool、Recruitment、Graph Supervisor 或 Graph Mutation 写链。执行必须经过 Authority、Ledger、ApprovalGate、Orchestrator、确定性 Policy、Work Receipt 与 Outcome。

## 2. 模式与授权

| 模式 | 全局环境变量 | 默认值 | 可选值 |
|---|---|---|---|
| Founder Twin | `AGENTCOMPANY_FOUNDER_TWIN_MODE` | `off` | `off / shadow / advisor / green-delegated / yellow-delegated` |
| Company Commons | `AGENTCOMPANY_COMPANY_COMMONS_MODE` | `off` | `off / ingest-only / reading / belief-loop` |

有效模式取全局上限与 Company 设置中更严格的一项。UI 不能越过全局上限；未知值失败关闭。机器 Gate 通过只证明实现满足合同，不构成提高模式、确认 Founder Asset、批准红灯动作或开放外部副作用的授权。

## 3. 用户承载面

| 位置 | 路径 | 能力 |
|---|---|---|
| Inbox | `/inbox` | Decision Center、红灯 Gate、Green/Yellow 状态与回滚 |
| Board | `/company/board` | Shadow、Advisor 收敛、依据、接管、暂停、否决和目标重定义 |
| Library | `/library` | Company Commons 与来源能力矩阵 |
| Library | `/library/interpretations` | 多 Agent Interpretation 与来源跨度 |
| Library | `/library/beliefs` | Belief、证据、反证与 Experiment |
| Library | `/library/patches` | Learning Patch、Benchmark、Canary 与回滚 |
| Settings | `/settings/company` | Founder Studio、Control Center 与模式上限 |

这些页面读取 Control Plane 的持久化事实或可重建投影。接口缺失、连接中断、模式关闭或证据不足时显示不可用或阻断状态，不维护前端第二套治理事实。

## 4. 代码与数据事实源

| 区域 | 事实源 |
|---|---|
| Shared 契约 | `packages/shared/src/founder-os.ts` |
| JavaScript SDK | `packages/sdk/js/src/v2/founder-os.ts` |
| Ledger、Authority、Asset、Shadow、Advisor、Yellow | `packages/control-plane/src/founder-os/` |
| Green 委派与 Graph 适配 | `packages/control-plane/src/project-orchestrator/founder-delegation.ts` |
| Outcome | `packages/control-plane/src/company-project/outcome-signal.ts` |
| Commons | `packages/control-plane/src/company-commons/` |
| Reading | `packages/control-plane/src/company-reading/` |
| Learning | `packages/control-plane/src/company-learning/` |
| WebUI | `packages/app/app/pages/` 与 `packages/app/modules/agent-company/runtime/` |

Ledger、Correction、Outcome、Rollback 和核心治理状态采用追加事实或可重建投影。Feature Flag 降级不删除历史；服务启动时恢复 Outcome、Commons 与治理投影。

## 5. API 与 SDK

客户端优先使用 `@agents-company/sdk/v2/founder-os`，不要手写第二套类型。API 分组包括：

- `/company/founder-os/*`：Ledger、Authority、Governance、Decision Center、Green/Yellow；
- `/company/founder-studio/*`：Asset、Snapshot、校准；
- `/company/founder-shadow/*` 与 `/company/founder-benchmarks/*`；
- `/company/founder-board*` 与 `/company/founder-control-center`；
- `/company-commons/*`、Reading 与 Learning 对应的生成 SDK 接口。

修改 OpenAPI 后运行 `./packages/sdk/js/script/build.ts`，随后从各 package 目录执行类型检查和测试。

## 6. 验证

Founder OS 使用 `script/founder-os-gate.ts`、`script/founder-os-stage-evidence.ts` 与 `script/founder-os-stage-gate.ts`。W0–W7、E0、K0–K2 必须绑定同一候选 SHA，每阶段运行两次且归一化摘要一致。

候选 `b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8` 已满足上述机器 Gate。人工授权与真实样本继续在[Pre-Public 弱门禁登记](pre-public-acceptance-register.md)中维护；不得把本地测试、Fixture、模型自述或页面截图写成真实授权。
