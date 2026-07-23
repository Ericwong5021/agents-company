<div align="center">

# Agent Company

**一家公司形态的本地 AI Agent 系统，能够围绕你的目标动态组织、自治治理并持续成长。**

你定方向，公司自行组建合适的团队，交付可验证结果，只把真正需要你决定的事情带回来。

[English](README.md) · [产品宪法](docs/product-design/PRODUCT-CONSTITUTION.md) · [产品 PRD](docs/Agent%20Company%20产品%20PRD.md) · [文档导航](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company 是仍在开发中的 **Pre-Public** 产品。本地 Control Plane、真实董事会会话、共享 WebUI、Electron、Agent Runtime 和治理基础已经存在；领域中立交付、桌面后台生命周期、严格私人空间和完整的 Agent 生命层仍在实施。目标行为以产品文档为准，当前差距以实施计划为准。

## 它是什么

Agent Company 让一个用户在自己的电脑上经营一个持续存在的 AI 组织。它不是一组固定专家 Bot，也不以编程为产品边界。Agent 围绕目标动态形成临时责任与能力组合，在群聊中协作，在治理约束内行动，并跨领域交付有证据、可验收的结果。

产品包含三个缺一不可的层次：

| 层次 | 职责 |
|---|---|
| 工作层 | 目标、群体协作、执行、制品、验证与交付 |
| 治理层 | Charter、委派、批准策略、Gate、声誉、恢复与审计 |
| 生命层 | 持久身份、关系、私人空间、Reflection、Ambient 与 Dreaming |

## 产品原则

- **动态自组织。** 用户说目标，公司判断需要什么责任、Agent、工具和验证器；能力包不会固化成永久专家团队。
- **自治理与用户权威并存。** 内部工作可在策略范围内自主推进；高影响外部动作、隐私边界和未收敛的产品选择继续受治理。
- **群聊优先。** 主会话承载结论、决定、风险、审批和交付；Thread 展开工作日志、产出物、预览、失败 Attempt 与嵌套工具细节。
- **失败真实可见。** 失败原因、策略调整与恢复状态不会被最终答案掩盖，而是成为可追踪、可审计的正式事实。
- **视觉品质就是产品能力。** Marvis 是办公室氛围、角色辨识、行为状态和结果分层的重要 UI 参照；Agent Company 将这些优点融合进多 Agent 群聊工作台。
- **员工真实存在。** 员工卡片投影实际的工作、等待、Review、协作、闲逛、社交、反思和恢复事件。Ambient 活动可以形成关系、文化理解、提案与人格成长；后续二维或三维办公室复用同一状态契约。
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
| `packages/app` | Eve/Nuxt 共享 WebUI |
| `packages/desktop` | Electron 桌面壳、本地 Server 宿主与打包 |
| `packages/control-plane` | Bun/Effect/Hono Control Plane、Runtime、SQLite、Git、Workflow 与内部 CLI 工具 |
| `packages/sdk` | 生成与手写的客户端 SDK |
| `packages/ui` | 共享 UI 原语 |

客户端不直接写 SQLite、身份文件或受管资源。Control Plane 统一负责权威写入、事件顺序、权限和恢复。

## 当前交付路径

代码已经完成共享 App Shell、本地公司初始化，以及带来源 Thread 的真实持久化董事会会话。当前工作聚焦 Agent Execution Kernel 和受治理的领域中立交付闭环；桌面后台生命周期、Agent Home/私人空间、更完整的 Ambient 生命层和发布硬化位于后续里程碑。

当前事实、缺口、里程碑与发布 Gate 见[实施计划](docs/product-design/implementation-plan.md)。

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
- [实施计划](docs/product-design/implementation-plan.md)：当前事实、缺口、里程碑与 Gate
- [文档导航](docs/README.md)：权威顺序与维护规则

## 许可证

源代码使用 [Apache License 2.0](LICENSE)。使用行为同时受 [Use Restrictions](USE_RESTRICTIONS.md) 约束。
