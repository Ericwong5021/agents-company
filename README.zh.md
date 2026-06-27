<div align="center">

# Agent Company

**AI 公司操作系统**

*给自己开一家 AI 公司——不是聊天机器人，是真正的组织。*

[![npm version](https://img.shields.io/npm/v/@agents-company/cli?color=cb3837&label=npm)](https://www.npmjs.com/package/@agents-company/cli)
[![npm downloads](https://img.shields.io/npm/dm/@agents-company/cli?color=cb3837)](https://www.npmjs.com/package/@agents-company/cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![language](https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![TUI](https://img.shields.io/badge/interface-TUI-00d111)](#快速开始)

[快速开始](#快速开始) · [English](README.md) · [中文](README.zh.md) · [设计文档](docs/product-design/00-overview.md) · [产品 PRD](docs/Agent%20Company%20产品%20PRD.md) · [路线图](#路线图)

</div>

---

## 核心理念

> **你定方向，公司自己推。需要你的时候，它会来找你。**

你不是在"用聊天机器人"。你在**经营一家虚拟公司**。

Agent Company 是一个多智能体操作系统：AI Agent 组成一个真实的组织——有董事会、部门、项目组和执行团队。你告诉公司你想要什么，它会拆解目标、沿组织架构逐层委派、执行、审查，然后把需要你拍板的决策带回来。

```
你 ←→ 🏢 董事会（CEO / CTO / CFO / CMO）
           ↓
        📋 部门层 — 拆目标 + 定验收标准
           ↓
        👥 项目组 — 拆解为可执行规格
           ↓
        ⚙️ 执行层 — 驱动工具，产出制品
```

**严格不越级。** 每个需求都走完整个组织链路，4-5 层深度。只有工具层直接产出制品（代码/文档/数据/设计稿），其余都是规划、编排和治理。

---

## 为什么是"公司"而不是"框架"？

| | 多 Agent 框架 | Agent Company |
|---|---|---|
| 隐喻 | "套壳的 Prompt 模板" | 有真实层级的虚拟组织 |
| 协作 | Agent 互相聊天 | Agent 有**角色、汇报关系和问责** |
| 治理 | 无或手动 | **内置审批关卡、升级机制、审计链路** |
| 身份 | 无状态 Prompt | **持久化 Agent 文件**：soul、memory、skills、relationships |
| 用户体验 | 写代码来编排 | **告诉公司你想要什么就行** |

---

## 核心能力

<table>
<tr>
<td width="50%" valign="top">

### 🏛️ 董事会界面

入口是一场与董事会的会议——CEO、CTO、CFO、CMO。讨论目标、设定优先级、审查进度。不需要 Prompt 工程。

</td>
<td width="50%" valign="top">

### 🔄 递归委派

任务沿组织架构自然分解：董事会 → 部门 → 项目组 → 执行层 → 工具层。每一层只做一件事。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 竞标调度器

Agent 根据相关性、专业度和轮转权利竞标发言。无中央主持人，无人垄断，无人被淹没。去中心化的多 Agent 发言调度方案。

</td>
<td width="50%" valign="top">

### 🧠 持久化身份

每个 Agent 不只是 Prompt——而是一束持久化文件：**soul**（身份）、**memory**（记忆）、**skills**（技能）、**relationships**（关系）。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📋 任务与制品管理

通过组织架构追踪工作。制品经由**关卡**向上流转——通过则升级，失败则重试。每个决策可追溯。

</td>
<td width="50%" valign="top">

### 🔒 治理优先

每个层级都有审批检查点。信任随表现增长。系统记录一切——因为不可追溯的系统不可治理。

</td>
</tr>
<tr>
<td colspan="2" align="center">

### 🖥️ 终端原生 UI

基于 SolidJS + OpenTUI 的精美 TUI。不是 Web 应用，不是桌面包装器——而是面向终端开发者的**原生终端体验**。

</td>
</tr>
</table>

---

## 快速开始

### 安装

```bash
# npm
npm install -g @agents-company/cli

# Bun（推荐）
bun install -g @agents-company/cli
```

### 运行

```bash
agents
```

就这样。引导向导会带你完成：

1. **设置你的 AI 公司** — 名称、行业、团队规模
2. **创建创始团队** — CEO、CTO、CFO、CMO
3. **进入董事会** — 开始下达方向

### 本地开发

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
bun run dev
```

> **当前核心开发重点是 TUI**，位于 `packages/opencode/src/cli/cmd/tui/`。Web 和 App 不是当前主线。

---

## 架构

```
用户 ←→ 董事会（CEO/CTO/CFO/CMO）    ← 系统入口 = 一场会议
        ↓
     部门层（业务 + 基建）
        ↓
     项目组（Leader）
        ↓
     执行层
        ↓
     工具层                              ← 唯一直接产出制品的层
```

**核心理念：**

| 理念 | 含义 |
|------|------|
| **递归委托** | 每个非叶节点：拆解 → 委派 → 准入校验 |
| **身份 ≠ 执行** | Agent 文件是"谁"，Model 是"怎么跑" |
| **信息即文件** | 规章、战略、记忆都是文档，由作用域 × 密级控制 |
| **注意力即成本** | 四种模式（空闲/响应/发散/专注）选择模型档位 |
| **治理靠记录** | 每次跨 Agent 操作都是审计事件 |

详见 [产品设计总览](docs/product-design/00-overview.md)。

---

## 核心对象

| 对象 | 说明 |
|------|------|
| **Workspace** | 公司空间：组织、任务、会议、制品、规则、历史 |
| **Agent** | 数字员工：soul/instruct/memory/skills/relationships/kanban |
| **Thread** | 并发单元：专注/发散/响应/环境 |
| **Group / Meeting** | 可治理的协作房间，不只是群聊 |
| **Task** | 可追踪、可审查、可验收的工作单元 |
| **Artifact** | 工具层产出的制品，经关卡向上流转 |
| **Gate** | 验收关卡：通过则升级，失败则重试 |
| **Decision** | 可追溯的组织决策（DRI 拍板，不投票） |
| **Proposal** | Agent 自下而上的建议和提案 |

---

## 内置 Agent

| Agent | 角色 | 说明 |
|-------|------|------|
| `build` | 🔨 工程师 | 基于权限执行工具 |
| `plan` | 📐 规划师 | 只读规划模式——建议但不修改 |
| `compose` | 🎼 编排者 | 管理工作流和编排技能 |
| `explore` | 🔍 研究员 | 快速代码库探索和分析 |
| `general` | 🤖 通才 | 通用多用途 Agent |

自定义 Agent 可通过配置文件或 `.agentcompany/agent/` 目录创建。

---

## 技术栈

| 层 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh) + TypeScript |
| TUI | SolidJS + OpenTUI（终端渲染） |
| 状态管理 | [Effect-TS](https://effect.website)（函数式 Effect 系统） |
| 存储 | Drizzle ORM + SQLite |
| 构建 | Turborepo（monorepo） |
| 模型 | 任意 LLM 服务商（OpenAI、Anthropic、Google、本地模型...） |

---

## 路线图

| 阶段 | 状态 | 描述 |
|------|------|------|
| **P0** — 执行底座 | ✅ 完成 | 单任务链路、结构化活动契约、真交付、审批、取消 |
| **P1** — 执行模型 + 多 Agent | 🔨 进行中 | Agent=文件束、模型=动力、并发=线程、Presence 登记表 |
| **P2** — 组织上下文底座 | 📋 计划中 | 上下文解析器、作用域 × 密级、角色可见性、delegate/message 原语 |
| **P3** — 交互 + 递归委派 | 📋 计划中 | A2A 对齐、递归委派、失败协议、准入分级 |
| **P4** — 治理 + 学习 | 📋 计划中 | 声誉、组织变更、提案闭环、经验→技能结晶 |
| **P5** — 体验与空间闭环 | 📋 计划中 | 差异化演出、活态办公室、组织树 + 线程可视化 |

---

## 参与贡献

欢迎贡献！请先阅读 [AGENTS.md](AGENTS.md) 了解编码规范。

```bash
# 在 package 目录下运行（不要在仓库根目录）
cd packages/opencode
bun typecheck
bun test
```

---

## 社区

- [GitHub Discussions](https://github.com/Ericwong5021/agents-company/discussions) — 提问、交流
- [GitHub Issues](https://github.com/Ericwong5021/agents-company/issues) — 报 Bug、提需求

---

## 许可证

源代码基于 [MIT 许可证](./LICENSE) 开源。使用 Agent Company 还需遵守[使用限制](./USE_RESTRICTIONS.md)。

---

<div align="center">

<sub>理念：AI 应该像<strong>组织</strong>一样运作，而不是像聊天机器人。</sub>

</div>
