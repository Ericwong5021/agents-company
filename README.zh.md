<h1 align="center">Agent Company</h1>

<p align="center"><strong>全球首个 Agent 公司操作系统——让每个人都能拥有自己的第一家 Agent 公司。</strong></p>

<p align="center">
  中文 | <a href="README.md">English</a>
</p>

---

Agent Company 是一间由 AI Agent 组成的可治理虚拟公司。

你不是在「使用一个聊天机器人」，而是在经营一套可以分工、协作、观察、审批和持续沉淀经验的数字员工组织。需求会在组织中流动，被理解、拆解、分派、执行、审查，再回到你做关键决策。

> 你把目标说清楚，公司自己推进；需要你拍板的时候，再来请求审批。

---

## 核心理念

整个系统是一棵**递归的「拆解—委派—准入/升级」树**：用户与董事会圆桌讨论，需求逐层向下拆解委派，**只有叶子节点（工具层）直接产出制品**（代码/文档/数据/设计稿），非叶节点做的是决策 → 规划 → 规格 → 编排的逐层转化，结果逐层向上准入（成功）或升级（失败）。

- **递归委托** — 固定层级的递归委托树，每个非叶节点都做同一件事：拆解目标、招募/委派、准入校验、失败升级。
- **身份与执行解耦** — Agent 是一束持久文件（谁），Model 是把文件跑起来的执行引擎（在做什么）；并发计量单位是 Thread，不是 Agent。
- **信息即文件** — 规章、战略、项目、记忆、关系都是文件系统中的文档，访问由作用域 × 密级 × 清除级别三维控制。
- **注意力即成本** — 四种注意力模式（空闲/响应/发散/专注）同时决定注入什么上下文、用哪档模型；空闲用廉价模型，专注用强模型。
- **治理靠记录** — 涌现式系统不追求复现，每次跨 Agent 的访问、消息、准入、升级都是审计事件，轨迹即这次的「源代码」。
- **自底向上提案** — 想法可自底向上冒，董事会从「生成任务」转为「筛选提案」。

详见 [产品设计总览](docs/product-design/00-overview.md)。

---

## 组织架构

```
用户 ←→ 董事会圆桌（CEO/CTO/CFO/CMO）   ← 系统入口 = 一场会议
        ↓
     部门层（业务部门 + 基建部门）       ← 拆目标 + 定验收标准 + 组团队
        ↓
     项目组（Leader）                    ← 拆解为可执行规格 + 招募成员 + 管准入
        ↓
     执行层                              ← 匹配预定义工作流 + 细化规格 + 驱动工具
        ↓
     工具层                              ← 唯一直接产出制品的层（编码/检索/写作/设计/分析）
```

**严格不可越级**：无论任务大小，每层必须经过，不设跳步；委派深度约 4–5 层。

---

## 核心对象

| 对象 | 说明 |
|------|------|
| **Workspace** | 公司空间，承载组织、任务、会议、产出、规则和历史 |
| **Agent** | 具有持续身份的数字员工（soul/instruct/memory/skills/relationships/kanban），而不是 prompt 模板 |
| **Thread** | 并发执行单元：主线（专注/发散）、响应线（碎片）、环境线（空闲探索） |
| **Group / Meeting** | 可治理的协作房间，而不只是群聊 |
| **Task** | 可追踪、可验收、可审查的工作单 |
| **Artifact** | 工具层直接产出的制品（代码/文档/数据/设计稿），经 Gate 向上流转 |
| **Gate** | 每层向上流转的验收关卡，通过则升级，打回则重试或升级 |
| **Decision** | 带理由、可追溯的组织决策（DRI 拍板，不投票表决） |
| **Proposal** | Agent 自下而上的建议和改进提案 |

---

## 快速开始

```bash
# 安装依赖
bun install

# 从仓库根目录启动主开发入口
bun run dev
```

> 当前仓库核心开发重点是 **TUI（Terminal UI）**，主实现位于 [packages/opencode/src/cli/cmd/tui](packages/opencode/src/cli/cmd/tui)。Web 和 App 不是当前主线。
>
> 当前 CLI 入口仍为 `mimo`，品牌与命令名会在后续逐步收敛。

类型检查与测试请在具体 package 目录中执行（不要从仓库根目录运行）：

```bash
cd packages/opencode
bun typecheck
bun test
```

---

## 当前开发边界

这不是 AgentCompany 的兼容性维护仓库。Agent Company 虽然重建自 AgentCompany 的技术基础，但它是一个新的产品方向——除非明确需要迁移桥接，我们不保留历史的文件结构、配置格式或 API 兼容性。

- 以 **TUI 优先** 的工作流来设计和实现功能
- 优先建设「组织协作、任务执行、审批治理、状态可观察」能力
- 不把多 Agent 系统包装成单一 supervisor 的黑盒输出
- 不把设计愿景描述成已经全部完成的现状

---

## 参考文档

- [产品设计总览](docs/product-design/00-overview.md)（理念、组织架构、模块索引）
- [Agent Company 产品 PRD](docs/Agent%20Company%20产品%20PRD.md)

---

## 社区

扫描二维码加入社区群聊：

<p align="center">
  <img src="assets/readme/community-qrcode-1.jpg" alt="社区群聊二维码 1" width="240">
  &nbsp;&nbsp;
  <img src="assets/readme/community-qrcode-2.jpg" alt="社区群聊二维码 2" width="240">
</p>

---

## 许可证

源代码基于 [MIT 许可证](./LICENSE) 开源。使用 Agent Company 还需遵守[使用限制](./USE_RESTRICTIONS.md)。
