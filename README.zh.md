<div align="center">

# Agent Company

**在本地经营你自己的 AI 软件公司。**

你定方向，公司把它变成有责任、有验收、有证据的交付；只有真正需要你决定的事情才会回来找你。

[English](README.md) · [产品宪法](docs/product-design/PRODUCT-CONSTITUTION.md) · [产品 PRD](docs/Agent%20Company%20产品%20PRD.md) · [文档导航](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company 正在向 **Pre-Public** 版本收敛。仓库已经包含大量 Agent Runtime、治理、TUI、WebUI 和 Electron 基础，但完整的 IM-first 桌面旅程、托盘常驻、严格私人空间和人格型 Dreaming 仍是目标工作，并非已完成的公开产品。上方文档定义目标，代码与实施计划记录当前差距。

## Agent Company 是什么

Agent Company 让一个用户在自己的电脑上经营一个持续存在的 AI 组织。

你不需要手工编排一组用后即抛的 Agent，而是与一个最小董事会对话。董事会把较大的目标细化为可验收的 Project Charter，组建临时项目团队，委派和审查工作，并只把重大决定升级给你。

产品包含三个缺一不可的层次：

| 层次 | 职责 |
|---|---|
| 工作层 | IM 协作、软件项目、代码、测试、审查与交付 |
| 治理层 | 组织、委派、批准策略、Gate、声誉与审计 |
| 生命层 | 持久身份、私人空间、社交关系、Reflection 与 Dreaming |

## 产品方向

目标产品公式是：

> Multica 级别的视觉完成度 + Bloome 式 IM-first 交互 + Agent Company 的自治治理与 Agent 人格。

具体意味着：

- **IM-first，不是 Kanban-first。** 对话是主入口，任务和看板是派生视图。
- **默认高信号。** 主会话只显示结论、决定、风险、审批与交付；完整协作在 Thread 展开；工具日志再嵌套一层。
- **最小固定董事会 + 动态组织。** 新公司从 CEO、CTO、Product Lead 开始，部门和项目岗位只在真实工作需要时形成。
- **自治但可配置审批。** 内部分解、委派、实现、测试和 Agent Review 默认自动运行；用户可选自主、平衡或严格等级。
- **Local-first 且持续在线。** 桌面端和浏览器共用 WebUI，由本地 Control Plane 驱动；桌面目标是关闭窗口后仍在托盘/状态栏继续获授权任务。
- **先把软件研发做好。** 首次公开版本围绕一个项目对应一个主 Git 仓库优化，其他领域后续升级。

## 它为什么不同

### 董事会必须把目标变得可执行

把笼统、不可验收的目标直接丢给执行 Agent，是董事会失职。开发前，董事会必须形成包含价值、交付物、验收、范围、约束、风险、里程碑、DRI 和待决策项的 Project Charter。

### 临时 Agent 是候选人，不是消耗品

项目 Agent 在结束后返回候选池。入选理由、质量、声誉、成本、速度和专长会跨项目积累。持续、高频且高质量的工作可以推动其晋升为正式岗位。

### 正式 Agent 不只有工作

正式 Agent 拥有相互隔离的空间：

```text
agents/<id>/
  private/       # SOUL、梦境、日志、兴趣、私人记忆
  professional/  # ROLE、指令、职业、技能、工作记忆
  public/        # PROFILE、贡献、共享技能
```

Agent 可以写自己的私人空间；用户可以阅读但不能修改；包括管理者和董事会在内的其他 Agent 都不能读取。PROFILE 是 Agent 自己选择展示的名片，旁边附有系统签名的职位和声誉等事实。

Dreaming 与任务 Reflection 不同：它是对真实经历的低频私人整合，可以产生版本化 SOUL 变化，但永远不能修改正式职位、权限、公司宪法或项目代码。

## 软件交付契约

首次公开版本遵循一条严格闭环：

```text
目标
→ Project Charter
→ 项目群与动态团队
→ Worktree
→ 实现与测试
→ Agent Review
→ 按策略审批
→ 合并
→ 验证主分支
→ 销毁 Worktree
→ Reflection 与 Agent 生命周期更新
```

Worktree 可配置且默认开启。启用后，合并和主分支验证完成前不能销毁；冲突回到审查；失败和取消的 Worktree 保留，等待明确处置。

## 架构

```text
Electron / Browser / TUI
          │ 本地 API + 事件流
          ▼
Local Control Plane
  ├─ Agent / Thread / Workflow Runtime
  ├─ Governance / Approval / Audit
  ├─ Context Resolver / Privacy Boundaries
  ├─ Project / Admission / Worktree Delivery
  ├─ SQLite
  ├─ 版本化 Agent 身份文件
  └─ Git 仓库与 Worktree
```

现有代码在原地演进：

| Package | 职责 |
|---|---|
| `packages/app` | SolidJS + Vite 共享 WebUI |
| `packages/desktop` | Electron 桌面壳与本地 Server 宿主 |
| `packages/control-plane` | Bun/Effect/Hono Runtime、Control Plane 服务、SQLite、Git、Workflow 与 TUI |

Renderer 客户端不能直接修改 SQLite 或身份文件；Control Plane 统一负责认证写入、恢复和事件顺序。

## 已有基础

仓库已经有可复用的 Session、Actor、Group Session、Autonomous-Bidding、Thread、Company Project、Delegation、Admission、Org、Reputation、Trust Dial、Audit Event、Token Governance、Workflow、Control Plane Workspace 和 Git Worktree 实现。

当前重点是产品整合与硬化：共享 IM 工作台、桌面生命周期、批准继承、严格 Worktree 治理、候选职业路径、三空间隐私、Direct 和人格型 Dreaming。详见[实施计划](docs/product-design/implementation-plan.md)。

## 本地开发

需要 Bun 1.3.x，以及 Electron/node-pty 所需的平台依赖。

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

运行当前 TUI/Runtime 开发入口：

```bash
bun run dev
```

运行共享 WebUI 或 Electron：

```bash
bun run dev:web
bun run dev:desktop
```

类型检查和测试必须从具体 package 目录运行，不能在仓库根目录运行测试：

```bash
cd packages/control-plane
bun typecheck
bun test
```

仓库规范见 [AGENTS.md](AGENTS.md)。

## 当前发布路径

1. 产品与术语基线
2. 本地 Control Plane 与托盘/状态栏生命周期
3. IM-first 公司、项目群与 Thread
4. 董事会 Charter、批准策略与软件交付闭环
5. 候选职业、Agent Home、隐私、Direct 与 Dreaming
6. Windows/macOS Pre-Public 硬化和首次公开版本

首次公开版本明确不包含云端多租户、移动端、单项目多仓库、通用行业交付、Kanban-first 重型项目管理和像素办公室模拟。

## 文档

- [产品宪法](docs/product-design/PRODUCT-CONSTITUTION.md)：不可被普通需求覆盖的原则与边界
- [产品 PRD](docs/Agent%20Company%20产品%20PRD.md)：公开版本需求与验收
- [产品设计总览](docs/product-design/00-overview.md)：系统模型和文档地图
- [实施计划](docs/product-design/implementation-plan.md)：当前基础、差距和工作流
- [文档导航](docs/README.md)：权威顺序与历史文档状态

## 许可证

源代码使用 [Apache License 2.0](LICENSE)。使用行为同时受 [Use Restrictions](USE_RESTRICTIONS.md) 约束。
