<div align="center">

# Agent Company

**一家公司形态的本地 AI Agent 系统，能够围绕你的目标动态组织、自治治理并持续成长。**

你定方向，公司自行组建合适的团队，交付可验证结果，只把真正需要你决定的事情带回来。

[English](README.md) · [产品宪法](docs/product-design/PRODUCT-CONSTITUTION.md) · [产品 PRD](docs/Agent%20Company%20产品%20PRD.md) · [文档导航](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company 是仍在开发中的 **Pre-Public** 产品。[体验重构计划](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)继续决定 R0–R4 的发布顺序。本地 Control Plane、Agent Runtime、共享 WebUI、Electron、动态组织基础和 Founder OS v1 已实现；发布验收、严格私人空间与 Agent 生命层仍是独立工作或保持冻结。
>
> 已实现不等于已启用或已公开发布。Founder Twin 与 Company Commons 默认 `off`，机器 Gate 通过不能替代人工授权或真实样本验收。当前合同见 [Founder OS v1](docs/product-design/Founder-OS-v1.md)，文档分工见[文档导航](docs/README.md)。

## 它是什么

Agent Company 让一个用户在自己的电脑上经营一个持续存在的 AI 组织。它不是一组固定专家 Bot，也不以编程为产品边界。Agent 围绕目标动态形成临时责任与能力组合，在群聊中协作，在治理约束内行动，并跨领域交付有证据、可验收的结果。

产品包含三个缺一不可的层次：

| 层次 | 职责 | 现状 |
|---|---|---|
| 工作层 | 目标、群体协作、执行、制品、验证与交付 | 基础已实现；发布验收仍按 R0–R3 |
| 治理层 | Charter、委派、批准策略、Gate、Founder OS、恢复与审计 | Founder OS v1 已实现；高模式仍需授权 |
| 生命层 | 持久身份、关系、私人空间、Reflection、Ambient 与 Dreaming | 冻结，待交付闭环通过验证 |

## 产品原则

- **动态自组织。** 用户说目标，公司判断需要什么责任、Agent、工具和验证器；能力包不会固化成永久专家团队。
- **自治理与用户权威并存。** 内部工作可在策略范围内自主推进；高影响外部动作、隐私边界和未收敛的产品选择继续受治理。
- **群聊优先。** 主会话承载结论、决定、风险、审批和交付；Thread 展开工作日志、产出物、预览、失败 Attempt 与嵌套工具细节。
- **失败真实可见。** 失败原因、策略调整与恢复状态不会被最终答案掩盖，而是成为可追踪、可审计的正式事实。
- **视觉品质就是产品能力。** Marvis 是办公室氛围、角色辨识、行为状态和结果分层的重要 UI 参照；Agent Company 将这些优点融合进多 Agent 群聊工作台。
- **员工真实存在。** 员工卡片读取同一份来自真实运行的活动投影，不做装饰性动画。当前投影覆盖工作、等待、恢复和失败状态；闲逛、社交、反思，以及由它们产生的关系与人格成长属于冻结中的生命层。后续二维或三维办公室必须复用同一状态契约，不得自行编造活动。
- **Local-first。** 浏览器和桌面端通过同一套共享 WebUI 消费本地 Control Plane，Electron 提供常驻的本地产品体验。
- **领域中立内核，深度领域适配器。** 研究、文档、本地应用和软件交付复用同一公司模型；软件适配器额外提供严格仓库、Worktree、审查、合并与验证规则，但不定义整个产品。

## 架构

```text
Electron / Browser
          │ 本地 API + 事件流
          ▼
Local Control Plane
  ├─ Company / Conversation 服务
  ├─ Agent Execution Kernel / Workflow Runtime
  ├─ Governance / Approval / Audit
  ├─ Delivery / Domain Adapters / Managed Resources
  ├─ Context Resolver / Privacy Boundaries
  ├─ SQLite
  └─ 版本化 Agent 身份文件
```

| Package | 职责 |
|---|---|
| `packages/app` | Nuxt 共享 WebUI |
| `packages/desktop` | Electron 桌面壳、本地 Server 宿主与打包 |
| `packages/control-plane` | Bun/Effect/Hono Control Plane、Runtime、SQLite、Git、Workflow 与内部 CLI 工具 |
| `packages/sdk` | 生成与手写的客户端 SDK |
| `packages/ui` | 共享 UI 原语 |

客户端不直接写 SQLite、身份文件或受管资源。Control Plane 统一负责权威写入、事件顺序、权限和恢复。

## 当前交付路径

体验重构继续控制从 **R0 — Truthful Product Shell** 到 R4 的发布顺序。机器证据与人工/公开发布证据保持分离；当前发布裁决应读取计划和 Gate，不能由某个模块已经实现来推断。

当前产品已具备公司初始化、持久频道与 Thread、Agent 执行内核、Charter 与批准治理、基于 Worktree 的软件交付、真实 Board 治理面、Decision Center、Founder Studio 与 Control Center、Company Commons、Interpretations、Beliefs 和 Learning Patches。服务或模式不可用时，界面如实失败关闭。

Founder OS v1 在候选提交 `b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8` 上完成 W0–W7、E0、K0–K2 两轮机器 Gate。人工授权与真实样本验收仍为建议项且尚未确认；该结论不提高任何运行模式。

- [体验重构计划](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)：当前在做什么、按什么顺序、发布门槛是什么。
- [实施计划](docs/product-design/implementation-plan.md)：当前代码事实、各里程碑退出标准与剩余缺口。
- [Founder OS v1](docs/product-design/Founder-OS-v1.md)：已实现架构、产品承载面、模式与验证边界。

## 本地开发

需要 Bun 1.3.x，以及 Electron 和 node-pty 所需的平台依赖。

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

```bash
bun run dev:web      # 共享 WebUI
bun run dev:desktop  # Electron
```

测试和类型检查必须从实际修改的 package 运行，不能从仓库根目录运行测试：

```bash
cd packages/control-plane
bun typecheck
bun test
```

仓库规范见 [AGENTS.md](AGENTS.md)，贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [产品宪法](docs/product-design/PRODUCT-CONSTITUTION.md)：长期原则与硬边界
- [产品 PRD](docs/Agent%20Company%20产品%20PRD.md)：Pre-Public 需求与验收
- [产品设计总览](docs/product-design/00-overview.md)：系统模型与专题导航
- [体验重构计划](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)：当前执行顺序（R0–R4）、任务与发布门槛
- [实施计划](docs/product-design/implementation-plan.md)：当前事实、缺口与里程碑退出标准
- [Founder OS v1](docs/product-design/Founder-OS-v1.md)：已实现的治理与组织学习合同
- [文档导航](docs/README.md)：权威顺序与维护规则

## 许可证

源代码使用 [Apache License 2.0](LICENSE)。使用行为同时受 [Use Restrictions](USE_RESTRICTIONS.md) 约束。
