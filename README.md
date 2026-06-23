# Agent Company

Agent Company 是一间由 AI Agent 组成的可治理虚拟公司。

用户不是在“使用一个聊天机器人”，而是在经营一套可以分工、协作、观察、审批和持续沉淀经验的数字员工组织。需求会在组织中流动，被理解、拆解、分派、执行、审查，再回到用户做关键决策。

当前仓库的核心开发重点是 **TUI（Terminal UI）**，主实现位于 [packages/opencode/src/cli/cmd/tui](/Users/wangyidong/project/agent-company/agents-company/packages/opencode/src/cli/cmd/tui)。Web 和 App 不是当前主线，不作为默认支持范围。

## 产品定位

Agent Company 关注的不是“让一个模型回答更多问题”，而是把 AI 组织成一家公司：

- 有不同角色的 Agent
- 有组织结构、职责边界和上下级关系
- 有会议、讨论、任务、产出和审批
- 有活动流、状态、风险和阻塞可观察性
- 有治理机制，包括暂停、继续、重试、升级和复盘
- 有记忆、声誉和长期沉淀，而不是一次性会话

理想体验是：

> 用户把目标说清楚，公司自己推进；需要用户拍板的时候，再来请求审批。

## 这个仓库正在构建什么

基于 PRD，Agent Company 的目标产品核心对象包括：

- `Workspace`：公司空间，承载组织、任务、会议、产出、规则和历史
- `Agent`：具有持续身份的数字员工，而不是 prompt 模板
- `Group / Meeting`：可治理的协作房间，而不只是群聊
- `Task`：可追踪、可验收、可审查的工作单
- `Artifact`：代码、文档、报告、纪要等公司资产
- `Decision`：带理由、可追溯的组织决策
- `Proposal`：Agent 自下而上的建议和改进提案

仓库首页、交互和开发方向都会逐步围绕这些对象收敛。

## 当前开发边界

这不是 MiMoCode 的兼容性维护仓库。

Agent Company 虽然重建自 MiMoCode 的技术基础，但它是一个新的产品方向。除非明确需要迁移桥接，我们不会优先保留历史的 MiMoCode 文件结构、配置格式或 API 兼容性。

当前对外和对内都应默认遵循这些边界：

- 以 **TUI 优先** 的工作流来设计和实现功能
- 优先建设“组织协作、任务执行、审批治理、状态可观察”能力
- 不把多 Agent 系统包装成单一 supervisor 的黑盒输出
- 不把 PRD 愿景描述成已经全部完成的现状

## 仓库结构

- [packages/opencode](/Users/wangyidong/project/agent-company/agents-company/packages/opencode)：当前 CLI 与 TUI 主体
- [packages/opencode/src/cli/cmd/tui](/Users/wangyidong/project/agent-company/agents-company/packages/opencode/src/cli/cmd/tui)：TUI 主实现
- [docs/Agent Company 产品 PRD.md](/Users/wangyidong/project/agent-company/agents-company/docs/Agent%20Company%20产品%20PRD.md)：产品定义与长期方向
- [packages/sdk/js](/Users/wangyidong/project/agent-company/agents-company/packages/sdk/js)：JavaScript SDK

## 本地开发

### 环境要求

- [Bun](https://bun.sh)
- Node.js（部分工具链会用到）

### 安装依赖

```bash
bun install
```

### 启动开发

```bash
# 从仓库根目录启动主开发入口
bun run dev
```

当前 CLI 入口仍然是 `mimo`，这是现阶段代码实现状态的一部分，品牌与命令名会在后续逐步收敛。

### 常用命令

```bash
# 根目录开发入口
bun run dev

# 桌面端开发
bun run dev:desktop

# Console 开发
bun run dev:console
```

### 类型检查

不要从仓库根目录直接运行测试。

类型检查请优先在具体 package 中执行，例如：

```bash
cd packages/opencode
bun typecheck
```

### 测试

测试也请在具体 package 目录中运行，例如：

```bash
cd packages/opencode
bun test
```

## SDK

如果修改了 JavaScript SDK 相关内容，按仓库约定重新生成：

```bash
./packages/sdk/js/script/build.ts
```

## 设计原则

代码和产品实现默认遵循以下方向：

- 一个 Agent 应该像数字员工，而不是一次性模型调用
- 一个 Workspace 应该像公司运行空间，而不是普通聊天项目
- 默认异步推进，关键节点同步确认
- 可观察性优先于盲目自动化
- 治理能力优先于表面效率

这些原则决定了我们在 TUI 中更重视：

- 谁在工作
- 正在做什么
- 为什么这样做
- 当前卡在哪里
- 下一步是谁
- 用户何时应该介入

## 参考文档

- [Agent Company 产品 PRD](/Users/wangyidong/project/agent-company/agents-company/docs/Agent%20Company%20产品%20PRD.md)
- [packages/opencode/README.md](/Users/wangyidong/project/agent-company/agents-company/packages/opencode/README.md)

## License

[MIT](/Users/wangyidong/project/agent-company/agents-company/LICENSE)
