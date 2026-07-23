# Implementation Plan：Pre-Public 纵向交付

> 状态：M0、M1、M2 已完成；当前优先完成 M3A-1 自然 Agent Turn 与显式 Skill，再进入 M3B Charter、自治治理与领域中立交付闭环
> 事实基线更新：2026-07-21
> 视觉决策：Company Workspace 的产品信息架构保留；其 Solid/Vite 实现已由 Eve/Nuxt WebUI 迁移取代
> 上位文档：[产品宪法](PRODUCT-CONSTITUTION.md)
> 产品验收：[产品 PRD](../Agent%20Company%20产品%20PRD.md)

## 1. 本轮重排结论

Agent Company 已完成产品事实收敛，也验证了共享 WebUI 的视觉方向；当前不再需要继续制作静态页面方案。下一阶段必须从“模块和界面分别存在”切换为“每个里程碑都交付一段真实、可恢复、可验证的用户旅程”。

本计划用 M0–M6 纵向里程碑替代原来按 W1–W8 子系统铺开的实施顺序，但不改变宪法和 PRD 的首次公开版本范围。

> WebUI 迁移说明：本文 M0–M2 中关于 Solid App Chrome、`packages/app/src` 和其 Electron renderer 的实现证据均为历史记录，不再构成当前实现路径。正式 WebUI 已收敛为 `packages/app` 的 Eve/Nuxt 应用；Desktop 需加载该应用，不再维护 Solid renderer。

核心决定：

- 保留当前 Company Workspace 的视觉语言，以 Marvis 的办公室氛围、角色辨识和结果分层为重要参照，继续提升群聊工作台的完成度；
- 先修复共享 App Shell，再接入真实业务，避免把演示状态扩散成第二套产品；
- 先建立 Company/Channel/Thread/Message 的权威契约，再让共享 WebUI 与 Desktop 消费；
- 先建立领域中立的交付内核，并用研究或分析、文档或本地应用、真实软件仓库三类任务验证，再扩展候选池、Agent Home 和生命层；
- 第一阶段用员工卡片统一呈现真实行为状态，后续二维或三维办公室复用同一状态契约；
- 隐私硬边界必须早于 Direct 和 Dreaming；
- 每个里程碑都必须独立可合并、可回滚、可从 UI 验收，不能以“后端模块已存在”代替产品完成。

## 2. 当前事实基线

| 区域 | 当前事实 | 当前结论 |
|---|---|---|
| 产品文档 | 宪法、PRD、00–07 专题设计和本计划已有单向优先级 | S0 产品收敛基本完成 |
| Company Workspace | M2 已接入持久 Channel/Message/ConversationThread、真实 Board runtime、来源证据与高信号投影 | 当前可作为真实公司会话入口；M3 才增加 Charter、治理与交付事实 |
| 共享 App Shell | M0 已把根路由、Titlebar、通知、Deep Link 与构建 CSS 接入同一 App Chrome；M1 在其上接入 Company data source | 可以继续承接 M2 的真实会话数据 |
| Local Server / Runtime | M1/M2 已提供仅绑定 loopback 的 trusted Company/Conversation API、SQLite 事务、GroupSession 来源桥、终态竞争保护与跨进程恢复 | M0–M2 闭环已完成，不代表 M3–M6 已完成；非回环监听仍不属于当前主路径 |
| Company Project | 已有 Project、Plan、Work Item、Artifact 和两个人工 Gate | 当前仍是固定游戏 MVP 流程，创建新空仓库，不处理导入仓库、严格 Worktree、合并或主分支验证 |
| SDK | M1 Company/Local Auth 与 M2 Conversation operation 已生成具体 response/error 类型 | 新产品接口不以 `unknown` 作为契约 |
| Desktop | M1/M2 Windows 原生 Electron Gate 已覆盖目录选择、bootstrap、发送、Thread、trusted loopback API 与重启恢复；发布目录包含 sidecar 运行依赖 | M4 的托盘、关窗后台运行、通知恢复仍未实现 |
| Agent Identity | 有 CompanyAgent、SOUL、INSTRUCT、Memory、Relationship 等基础 | 文件包仍是平面结构；candidate/employee 和 private/professional/public 未实现；现有关系/委派规则不能直接用于私域 |
| Worktree | 有通用创建、重置、强制删除能力 | 没有项目级生命周期、合并/验证 Gate 和孤儿恢复；不能让产品直接调用强制删除作为交付完成 |
| E2E / 发布 | Browser Playwright 与 Windows 原生 Electron Gate 已进入 CI；M2 有真实发送/Thread/作用域拒绝/恢复纵向，Windows unpacked 打包已验证运行依赖 | Windows/macOS 干净设备安装、签名、升级矩阵仍在 M6 |

因此，当前阶段不是“产品主体已完成、只差接 API”，而是：

```text
S0 产品事实基线：基本完成
视觉验证：完成
M1 Company Bootstrap：完成
真实 IM 用户旅程：M2 完成
自治领域交付闭环：软件方向有可复用原型，通用契约与跨领域验收尚未完成
Agent 生命层与 Pre-Public 发布：尚未进入验收
```

## 3. 目标架构与边界

```text
Electron / Browser
          │
          ▼
Generated SDK + loopback-only trusted local API + SSE invalidation
          │
          ▼
Local Control Plane（唯一权威写入者）
  ├─ Company / Conversation application services
  ├─ Governance / Approval / Audit
  ├─ Agent Execution Kernel / Session / Workflow runtime
  ├─ Delivery / Domain adapters / Admission / Worktree lifecycle
  └─ Context Resolver / Privacy boundary
          │
          ├──────────────┬────────────────────┐
          ▼              ▼                    ▼
       SQLite      versioned identity files   managed resources / Git / Worktrees
```

架构约束：

- WebUI 和 Electron renderer 不直接写 SQLite、身份文件或 Git；
- SQLite 是事务状态权威源，身份文件是人格内容权威源，各领域受管资源保留自己的事实源，Git 是代码与合并事实权威源；
- SSE 只负责实时失效通知和增量体验，断线后必须从权威快照重建，不能把内存事件总线当作正式记录；
- 当前 `thread` 表表示 Agent 执行线程，不能直接冒充产品 IM Thread；产品层使用 `ConversationThread`，并通过 `runtime_thread_id` / `session_id` 关联执行过程；
- 当前 `MessageV2` 保留为模型会话和工具原始记录；正式频道消息使用 `ChannelMessage`，通过来源引用连接原始消息、AgentMessage、Decision、Artifact 和 Gate；
- `GroupSession`、Bidding 和 Workflow 是运行实现，不直接定义用户可见的频道模型；
- Capability Pack 和领域适配器描述工具、验证器与约束，不定义永久专职 Agent；
- 当前 `/company-project` 原型可以拆解复用，但不承担新产品兼容责任；新契约稳定后删除或转为内部适配层；
- Worktree 的通用 `remove --force` 只能由通过生命周期校验的 disposition service 调用。

### 3.1 wanman 机制吸收边界

`ref/wanman` 作为 Agent Execution Kernel 的参考实现，不成为运行时依赖，也不引入 `@wanman/*` package、JSON-RPC API、配置文件、数据目录或 CLI 兼容层。AgentCompany 吸收其已经验证的执行机制，并按 Bun、Effect、Drizzle、现有 Local API 和产品领域模型重新接线。

吸收范围：

- 统一 Claude Code / Codex 运行时适配契约，覆盖启动、结构化事件流、中断、停止、退出分类、模型配置和后端能力声明；
- Supervisor 对 Agent Run 的生命周期管理，以及 `steer` / `follow_up` 两级内部投递语义；
- 每次运行独立 Runtime Home、独立 `.claude` / `.codex` 状态、受管 Worktree、最小凭据暴露和不可变 Skill 快照；
- 消息与运行事实先持久化再广播、事务性领取、重启恢复和孤儿资源扫描；
- Role Template 中可复用的职责、能力、工具、生命周期和模型偏好，映射到 AgentCompany 的候选池、正式岗位、权限、声誉和三空间身份模型；
- 结构化 Task、Artifact、Initiative、Hypothesis 和 Change Capsule 的方法，分别收敛进 Charter、Work Item、Artifact/Evidence、Decision 和受治理的变更流程，不复制平行领域对象；
- Cron 与外部事件只作为 Control Plane 的触发入口，不定义产品信息架构，也不能绕过批准策略。

明确不吸收：wanman 托管版能力、FinOps、db9 依赖、固定 CEO/dev/devops/marketing 组织、默认 24/7 执行、原始消息/API 形状以及其文件系统兼容性。

统一运行时事件只描述执行事实；`ChannelMessage`、`ConversationThread` 和高信号协议继续是产品会话事实。运行时适配器必须提供能力矩阵，至少覆盖 runtime × lifecycle × model × permission × workspace；Codex 与 Claude Code 都通过各自正式会话标识恢复，缺失标识或能力时必须在启动前失败。

## 4. 交付方法

每个里程碑遵守相同顺序：

1. 先写失败的领域、权限、恢复或 Git 事实测试；
2. 建立 SQLite schema、Effect service 和完整 Zod response schema；
3. 生成 JavaScript SDK，禁止新增产品接口返回 `unknown`；
4. 接入共享 WebUI，并通过同一服务语义供 Desktop 和 Browser 使用；
5. 增加真实后端 E2E，不使用 fixture 证明业务完成；
6. 更新实现状态和产品文案，只陈述已经通过退出标准的能力。

每个里程碑合并时必须满足：

- 主路径可以从共享 WebUI 完成；
- 刷新、SSE 断线和进程重启后状态仍可重建；
- 权限、拒绝、取消和失败路径有自动化测试；
- 没有人工修改数据库、补写 Git 状态或清理 Worktree；
- 不破坏现有 Coding Session 次级入口；
- 从对应 package 目录运行测试和 `bun typecheck`，不从仓库根目录运行测试。

## 5. 纵向里程碑

### M0 — 保护现有能力并建立真实接线边界

目标：让视觉壳成为可安全接业务的共享 App Shell，不继续积累演示债务。

状态：已完成（2026-07-13）。

预计：2–3 个工程日。

主要工作：

1. 修正 `packages/ui/src/styles/tailwind/index.css` 的 source 路径，并增加构建产物 utility smoke test；
2. 从 `packages/app/src/pages/layout.tsx` 提取根路由也需要的 App Chrome 能力，覆盖 Titlebar、Toast、通知跳转、Deep Link、更新和桌面窗口拖拽；
3. 保留 Company Workspace 的布局和样式，把 `company-model.ts` fixture 放到显式开发适配器后面；生产入口不得显示“已测试、已审计、已批准、正在验证”等虚假业务事实；
4. 建立 Company Workspace 的 data-source/store 边界，使后续 SDK 数据替换 fixture 时不重写页面；
5. 将 `packages/app/e2e/todo.spec.ts` 替换为可运行的 App Shell 冒烟测试。

退出标准：

- Company Workspace 和旧 Coding Session 都经过同一 App Chrome；
- App 类型检查、单元测试和生产构建通过；
- 构建 CSS 确认包含共享页面依赖的核心 utility；
- 生产模式不存在 fixture 业务陈述；
- Playwright 能打开根路由、切换频道壳、打开/关闭 Thread，并验证桌面标题栏区域。

### M1 — Company Bootstrap 与本地产品契约

目标：在干净或半初始化的数据目录中自动修复并创建一家公司和最小董事会，将 Provider、公司名称与仓库绑定改为可在主工作台后续完成的渐进式配置。

状态：已完成（2026-07-17）。浏览器与 Windows 原生 Electron Gate 均通过；原生 Gate 以真实 main/preload/renderer/sidecar 覆盖目录选择、bootstrap、trusted loopback、消息、Thread 与重启恢复。

主要工作：

1. 新建 `Company`、`RepositoryBinding`、`ApprovalPolicy` 和最小 `AgentLifecycle` schema；
2. 实现渐进式首次进入：固定数据目录后自动创建 CEO/CTO/Product Lead、默认平衡预设并直接打开 Company Workspace；
3. Provider 通过 Settings 配置；未配置时，对话将目标持久化为设置卡，不启动董事会运行；仓库可由 Agent 按需在受管本地目录初始化，软件交付按可独立验收的交付单元保存仓库绑定；
4. 新建带完整 Zod response 的 `/company` 产品路由，修复 SDK `unknown`，并运行 `./packages/sdk/js/script/build.ts`；
5. 将 Desktop 品牌、App ID、协议和新数据目录切换为 Agent Company；本产品不为旧 AgentCompany/OpenCode 数据布局提供隐式兼容桥；
6. Desktop sidecar 与本地浏览器共享仅绑定 loopback 的 trusted 服务契约；当前单用户阶段不认证用户；
7. 默认 Company 创建幂等；空库和孤立 Company 记录会自动修复为默认空工作台，不再进入首次引导。

退出标准：

- 干净环境直接打开默认公司和董事会；未配置 Provider 的目标会显示可直达 Settings 的持久化卡片；
- 刷新和重启后仍打开同一家公司和董事会；仓库在首次实际交付时创建或绑定；
- 本地浏览器无需凭据即可读取同一家公司，且 Control Plane 默认只监听 loopback；
- SDK 中本里程碑产品接口没有 `unknown` response；
- 空库、半初始化库和进程重启都会直接恢复到默认 Company 主工作台；Provider 统一从 Settings 配置。

### M2 — 真实 IM、董事会与高信号 Thread

目标：当前 Company Workspace 从 fixture 变成真实、可持久化的公司会话入口。

状态：已完成（2026-07-15）。真实消息、Runtime 启动、终态竞争、恢复关联、来源 hydrate、Thread entry、SSE 重连和 Desktop sidecar 均已收口。Browser 与 Windows 原生 Electron 纵向 Gate 已纳入 CI；`capabilities.board_messages` 生产默认开启，紧急回滚使用 `AGENTCOMPANY_DISABLE_BOARD_MESSAGES=true`。

主要工作：

1. 建立 `Channel`、`ChannelMember`、`ConversationThread`、`ChannelMessage` 和 `SignalProjection`；
2. 支持公司、董事会、部门、项目和 Direct 五类频道的 schema，但本里程碑先开放公司、董事会和项目三类主路径；
3. 建立频道列表、分页消息、Thread 详情、发送消息和来源引用 API；
4. 用现有 global event stream 做失效通知，断线后按快照/游标重取；正式消息先持久化再广播；
5. 将 Session、AgentMessage、GroupSession 和 Tool run 投影到一个产品会话模型，不建设第二套平行聊天运行时；
6. 用户在董事会发送目标时创建 Root Need 和真实 Thread；项目创建时自动创建项目群；
7. 实现 conclusion、decision、plan、status、risk、approval、delivery、intervention 的高信号协议；
8. 把当前频道栏、主会话、Thread Panel 和 Composer 接到生成 SDK，并删除生产 fixture 适配器。

退出标准：

- 用户发送消息、刷新、重启后消息和来源 Thread 完整；
- 主会话只出现高信号消息，工具输出留在 Thread 并按需加载；
- 项目群由项目事实自动创建，不由 UI 写死；
- 任一高信号消息可定位到来源 Thread、作者/DRI、项目和时间；
- App Playwright 使用真实本地 Server 完成董事会消息到 Thread 的主路径。

### M3：Charter、自治治理与领域中立交付闭环

目标：让不同类型的真实目标使用同一套组织内核完成可验证交付，并保留软件研发所需的严格仓库治理。

预计：5 到 7 周，分为两个可独立合并的 Gate；M3A 完成后现有 GroupSession/Workflow 可以使用可靠的本地 Agent 执行内核，M3B 再完成受治理的通用交付闭环和软件深度适配器。

#### M3A — Agent Execution Kernel

目标：建立以 Pi 为内置默认、Codex 与 Claude Code 为可选平级实现的统一 Agent Runtime；Workflow Engine 负责公司流程，不建设第二套 CLI、数据库或产品消息系统。

状态：实施中。统一 Runtime Port、Pi 0.80.7、能力包/工作流目录、AgentRun 事实表、受控 Pi 工具、Codex/Claude CLI 兼容适配和产品 API 已接通；当前最高优先级是 M3A-1，以统一 Agent Turn 修复机械式董事会发言并接通 Pi 显式 Skill；Pi 的跨进程会话恢复、正式 Codex app-server/Claude Agent SDK 适配及跨领域真实交付 Gate 仍是关闭项。

主要工作：

1. 在 `packages/control-plane/src/runtime` 建立统一 `AgentRuntimePort`，固定 discover、capabilities、start/resume、deliver、interrupt、stop 和结构化事件；Pi、Codex、Claude Code 是平级实现，Pi 使用现有 Provider 凭据并作为默认选择；
2. 新建持久化 `AgentRun` 状态机：queued → starting → running → interrupting/recovering → completed/failed/stopped，并将 Agent、Session、GroupSession、Workflow、Project、Work Item 和 WorktreeRun 作为显式关联；
3. 建立 runtime × lifecycle × model × permission × workspace 能力矩阵；不支持 resume、中断、工具或写入范围的组合在启动前返回结构化错误，不允许静默降级；
4. 将内部 `steer` 定义为经授权、可审计的当前运行中断，将 `follow_up` 定义为持久化队列投递；领取和 delivered 状态在同一事务完成，重试使用幂等键避免重复执行；
5. 所有 Agent Run 事件先写入 SQLite append-only 记录，再发布 SSE/Bus 失效通知；Session、ConversationThread 和高信号消息从这些事实投影，不把工具输出直接写成产品消息；
6. 为每次运行创建 `runs/<run-id>/home`、`logs` 和 `skills`，只注入当前 adapter 所需的最小认证能力、包装器和不可变 Skill 快照；禁止复制用户完整 HOME、Shell Profile 或其他 Agent 状态；
7. Claude Code 与 Codex adapter 捕获并验证各自 session/thread id 后才允许恢复；Codex 优先 app-server、Claude Code 优先官方 Agent SDK，当前结构化 CLI 协议仅作为兼容路径；
8. 保留 QuickJS Workflow Runtime，并把版本化 Workflow 与 Capability Pack 节点接到 Runtime Resolver；GroupSession 的动态选人保留为圆桌组件，不增加 `wanman send/recv/takeover` 兼容命令；
9. Control Plane 启动时恢复非终态 Agent Run，交叉核对进程、Runtime Home、Skill 快照、Worktree 和数据库；不确定资源进入待处置状态，禁止自动删除；
10. Skill 文档和运行快照记录版本、校验和、来源与激活原因；运行结束后可复盘当时真实可用的 Skill，不读取其他 Agent 的 private 空间。

M3A 退出标准：

- 同一个受授权任务可以分别使用已认证的 Claude Code CLI 和 Codex CLI 执行，产生相同结构的 Agent Run 事件；
- 中断、follow-up、子进程异常退出和 Control Plane 重启不会丢失消息、重复领取任务或伪造完成状态；
- 每次运行使用独立 Runtime Home 和明确受管资源；软件写入使用明确 Worktree，用户 dirty checkout、真实 HOME 与其他 Agent 身份空间不被修改；
- 不支持的 runtime/lifecycle/permission 组合在启动前失败，并返回可供 UI 和审计使用的明确原因；
- 运行事实可以重建 Session、Thread 和高信号投影，SSE 断线不影响权威状态；
- 没有新增平行数据库、wanman API 或产品消息模型。

#### M3A-1 — 自然 Agent Turn 与显式 Skill（当前开发计划）

目标：所有员工使用 Pi Agent 作为默认心智运行时；角色只定义身份、职责、关注范围和决策权限，不规定固定回答模式；普通话题以自然语言交流，专业话题由 Agent 在运行中显式调用获准 Skill。董事会、项目群、Direct 和后续 Ambient 共用同一个 Agent Turn 内核，不再各自拼装人格和工作流 Prompt。

该工作预计涉及 `packages/control-plane` 与 `packages/app` 中 12–16 个实现和测试文件，属于跨越 GroupSession、AgentRun、Pi Runtime、Skill、Conversation Projection 和 WebUI 的纵向改造。四批必须按顺序实施，但每一批都能独立合并、独立验收；任何后续批次停止时，已合并系统仍保持可用。

##### 范围与非范围

本工作包含：

- 建立统一 `AgentTurn` Module，作为所有员工发言的唯一业务 Interface；
- 复用 CompanyAgent、SOUL、INSTRUCT、Relationship、Memory 与 `ContextResolver`，统一旧 Session 和 AgentRun 的身份上下文语义；
- 让 Pi 在运行时显式调用 `skill(name)`，实际调用时才读取完整 Skill、校验权限并写入不可变快照；
- 修正 GroupSession 的发言选择、当前轮上下文、沉默语义和固定能力包；
- 将自然聊天与 decision、risk、action、approval、artifact 等治理信号分开投影；
- 在 Thread 工作记录展示真实 Skill、工具、成本、复核和失败事件，不污染主聊天文本。

本工作不包含：

- 新增“闲聊模式”“会议模式”等决定回答格式的状态机；
- 为 CEO、CTO、Product Lead 或其他岗位预装固定专家回答模板；
- 允许 Skill 绕过 Agent、Thread、Work Item、工作区或外部副作用权限；
- 在本阶段实现模型微调、语音、数字人、复杂 2D/3D 办公室或多用户云协作；
- 保留旧 AgentCompany 的 Prompt、配置、数据库或产品接口兼容层。

##### 目标 Module 与 Seam

```text
ChannelMessage / ConversationThread
                │
                ▼
        GroupSession + Bidding
        只选择是否以及由谁发言
                │
                ▼
          AgentTurn Module
    ┌───────────┼────────────┐
    ▼           ▼            ▼
Identity     Context      Skill Manifest
Assembler    Resolver     名称与描述
    └───────────┼────────────┘
                ▼
          AgentRun Supervisor
                ▼
         AgentRuntimePort Seam
                ▼
          PiRuntimeAdapter
                │
       ┌────────┴────────┐
       ▼                 ▼
  自然语言回答      显式 skill(name)
                           │
                           ▼
          Skill Resolver + Permission
                           │
              ┌────────────┴───────────┐
              ▼                        ▼
      SkillSnapshot / Event     本轮授权工具集合
```

依赖方向必须保持单向：产品会话调用 `AgentTurn`，`AgentTurn` 调用 AgentRun 和 Context/Skill Interface，AgentRun 通过 `AgentRuntimePort` 调用 Pi Adapter。Pi、Skill 或投影层不得反向依赖 GroupSession，避免形成循环。

`AgentTurn` Interface 只接收 Agent、Thread、当前消息、同轮 transcript、发言原因和已授权工作范围，返回自然语言结果、运行引用和结构化事件引用。身份组装、模型选择、Runtime Home、Skill manifest、权限检查、快照、成本和失败审计都隐藏在其 Implementation 内。

##### 第一批 — 恢复自然董事会聊天

交付结果：当前董事会立即从固定流程执行器变为正常群聊；即使后三批暂缓，用户也能获得自然、连贯、不会伪造空输出的对话。

实施目标：

1. 修改 `src/group-session/group-session.ts`，普通发言不再强制绑定 `board-strategy@1` 或软件仓库 Prompt；
2. Bidding 只产生 `must / want / could / pass` 意愿并选择必要发言者，取消 work-scoped 会话默认全员发言；
3. 每位发言者获得原始用户消息、完整 Thread 历史和当前轮已产生的有效 transcript，禁止只串联上一位 Agent 的输出；
4. 将无文本结果视为沉默或 pass，不写入用户可见消息，不再生成 `(no output)`；
5. 修改 `src/conversation/runtime.ts`，取消每轮固定由 Product Lead 生成结构化综合；保留已有明确工作目标的治理投影能力；
6. 为问候、自由讨论、单人回应、多人自然接话、全员 pass、模型空输出和同轮上下文新增回归测试。

第一批退出标准：

- 用户发送“大家好”时，不调用任何 Capability Pack 或 Skill，不要求所有董事发言；
- 回复为自然对话文本，不出现战略动作清单、验收矩阵或 `(no output)`；
- 后发言 Agent 能引用原始消息和本轮前序有效发言；
- 全员 pass 时保留用户消息并正常结束运行，不制造 Agent 消息或失败状态；
- 现有工作型董事会消息仍能产生可追溯 Thread 和运行事件。

##### 第二批 — 统一 AgentTurn 与身份上下文

交付结果：董事会和项目群首先接入统一 Agent 心智入口；即使显式 Skill 尚未上线，Agent 也已经基于持续身份、关系和可见上下文自然交流。

实施目标：

1. 新建 `src/agent-turn` Module，收敛一次发言的输入、上下文组装、Runtime/Model 解析、AgentRun 启动和结果记录；
2. 将旧 `session/llm.ts` 已有的 SOUL、INSTRUCT、Relationship 和 CompanyAgent 读取逻辑提取为共享 Identity Context Implementation；
3. 身份上下文按 Identity、Responsibility、Relationship/Memory、Situation 四层组装；职责描述参与关注和判断，不包含固定输出格式；
4. 所有资料继续通过 `ContextResolver` 先做硬权限过滤，AgentTurn 不直接扫描其他 Agent 的 private 空间；
5. GroupSession 改为只负责 Bidding 和轮次推进，每次实际发言统一调用 AgentTurn；
6. AgentTurn 继续通过现有 `AgentRuntimePort` 选择 Pi、Codex 或 Claude Code，Pi 保持默认，不在 GroupSession 中加入 Runtime 专属分支；
7. 为身份注入、私域拒绝、关系可见性、模型解析、Runtime 失败和 Thread 连续性新增测试。

第二批退出标准：

- 同一 Agent 在不同 Thread 中保持一致人格和职责，但不重复固定话术；
- 不同 Agent 对同一消息表现出不同关注点，差异可以追溯到身份、职责或关系事实；
- 无权限 Agent 无法通过群聊、Prompt 注入或上下文组装读取 private 内容；
- GroupSession 不再直接拼装角色专属系统 Prompt 或 Runtime 工具；
- Pi 不可用时返回结构化运行失败，已持久消息与 Thread 不丢失。

##### 第三批 — Pi 运行时显式 Skill

交付结果：Agent 可以在正常对话中自主识别专业任务并显式加载 Skill；普通聊天不承担 Skill Token 和回答模式污染。

实施目标：

1. 在 AgentTurn 系统上下文中只注入当前 Agent 可见 Skill 的名称、描述和调用规则，不预加载 `SKILL.md` 正文；
2. 为 Pi 工具桥增加运行时 `skill(name)` Adapter，复用现有 Skill discovery、owner visibility 和 permission 规则；
3. 首次实际调用时读取完整 Skill 及获准资源，写入 `runs/<run-id>/skills` 不可变快照，并记录版本、校验和、来源、调用 Agent 与 `activation_reason=agent`；
4. 将“Skill 可见”“Skill 已加载”“工具已授权”建模为不同事实；加载 Skill 不能自动扩大硬权限；
5. Pi 构造时注册稳定工具桥，所有工具调用继续经过 `beforeToolCall` 和本轮授权范围。Skill 只能激活预授权工具；缺失权限时返回可审计阻塞，不能静默提权；
6. 同一运行重复调用同一版本 Skill 时复用快照；版本变化只影响新运行，不改写历史快照；
7. AgentRun 事件记录 Skill 请求、加载、拒绝、工具调用、成本和失败，Conversation 投影只引用这些事实；
8. 为无需 Skill 的聊天、正确 Skill 调用、未知 Skill、private Skill 越权、工具越权、重复调用、版本快照和运行恢复新增测试。

第三批退出标准：

- 普通问候的 AgentRun 中 Skill 调用数为零；
- “评估这个版本能否发布”等专业任务会由相关 Agent 显式调用匹配 Skill，并在调用后继续回答；
- 运行结束后可以从 SkillSnapshot 精确重建当时真正使用的 Skill 内容；
- 角色拥有某项 Skill 不等于拥有写文件、联网、消息、审批或外部副作用权限；
- private Skill 只对所属 Agent 可见，名称枚举和错误信息也不泄漏其存在；
- Skill 或工具失败保留在工作记录中，但不会伪造成用户可见结论。

##### 第四批 — 治理信号与 WebUI 工作记录分层

交付结果：Agent 可以像真人一样说话，同时让公司系统可靠获得决策、风险、行动项和专业能力证据；主聊天保持可读，Thread 保持可审计。

实施目标：

1. Conversation Runtime 不再从每次自然发言强制提炼总结；只有 Agent 显式发布信号、治理规则命中或已有工作状态发生变化时才创建高信号投影；
2. 自然语言保存在 ChannelMessage，decision、risk、action、approval、artifact 和 intervention 使用独立结构化事实并引用来源消息/运行；
3. Thread 工作记录展示使用过的 Skill、工具、模型、Token/成本、权限阻塞、复核链和失败尝试；
4. 主聊天默认只展示自然语言与真正高信号结果，不展示底层 Skill 正文、工具参数、空输出或内部错误堆栈；
5. WebUI 员工卡片和 Thread 复用真实 AgentRun/Activity 投影，不创建装饰性“正在思考/正在研究”状态；
6. 增加自然讨论无信号、显式决策、专业 Skill 证据、失败可见、刷新/SSE 重连和进程重启后的投影一致性测试。

第四批退出标准：

- 一段自然聊天不会自动生成虚假计划、风险或验收结论；
- Agent 表达明确决策或行动时，主聊天与结构化治理事实互相引用且内容一致；
- 用户能在 Thread 中看到“谁使用了什么 Skill、为什么调用、消耗多少、是否失败、由谁复核”；
- 刷新、SSE 断线和 Control Plane 重启后，聊天、SkillSnapshot 和治理投影均能从权威事实重建；
- WebUI 不再把 Work Item、Skill、成本和复核链压扁成无法追溯的单层消息。

##### 验证命令与人工验收

自动验证从 `packages/control-plane` 执行，不从仓库根目录运行测试：

```text
bun test test/group-session/group-session.test.ts test/group-session/scheduler/BiddingScheduler.test.ts
bun test test/runtime/pi-tools.test.ts test/runtime/pi-engine.test.ts test/runtime/pi-adapter.test.ts
bun test test/skill/skill.test.ts test/skill/discovery.test.ts test/tool/skill.test.ts
bun test test/conversation/runtime.test.ts test/conversation/signal-projector.test.ts test/conversation/restart.test.ts
bun typecheck
```

涉及共享 WebUI 后，从 `packages/app` 执行该包现有类型检查、单元测试、生产构建和真实本地 Server Playwright。若产品 Interface 或 Zod response 发生变化，运行 `./packages/sdk/js/script/build.ts` 重新生成 JavaScript SDK，再验证 Desktop/Browser 共用契约。

人工验收固定使用同一组场景：

1. 在董事会发送“大家好”，确认自然回应、非全员强制发言、零 Skill 调用和无 `(no output)`；
2. 连续追问一条前序消息，确认后发言者理解当前轮和 Thread 上下文；
3. 发送“评估当前版本是否可以发布”，确认相关 Agent 显式调用验收 Skill，其他成员可以 pass；
4. 让只读 Agent 尝试通过 Skill 修改文件，确认被权限层阻止并留下审计事件；
5. 刷新页面并重启 Control Plane，确认聊天、Skill 证据、成本和治理信号仍一致；
6. 打开 Thread 工作记录，确认失败尝试可见但主聊天没有内部噪音。

##### 数据、依赖、风险与回滚

- 本计划不要求兼容旧本地数据库；开发期可以清空旧数据库后以当前 schema 重建，但正式实现仍不得用 UI fixture 或内存状态代替权威持久化；
- 不引入新语言、独立服务、外部数据库或新第三方账号；继续使用现有 Bun、Effect、Drizzle、Pi Agent Core、Provider 配置和 Local Control Plane；
- 最脆弱假设是 Pi 工具集合在 Agent 创建后无法安全动态替换。本计划通过“稳定注册工具桥 + 每次调用权限检查 + Skill 只激活预授权工具”承受该限制；如果未来 Pi 支持安全的动态工具更新，只替换 Pi Adapter Implementation，不改变 AgentTurn 或权限 Seam；
- 首版对话连续性允许每次 AgentTurn 从持久 Thread、身份和记忆重建上下文，不依赖 Pi 跨进程 resume。若延迟或 Token 成本未达到 PRD 门槛，再在 AgentTurn 内增加 `idle_cached` 生命周期，不改变上层 Interface；
- 第一、二批可以通过恢复旧 GroupSession 路由回滚且不触碰数据；第三、四批写入的 SkillSnapshot 和事件是追加事实，回滚时停止新投影并保留历史记录，不删除或改写已产生审计事实；
- 任一批次若导致自然聊天回归，可以单独关闭该批 Runtime capability，但不得回退到固定专家团队、固定阶段工作流或生产 fixture。

##### 明确拒绝的替代方案

拒绝直接把所有 AgentTurn 切回旧 Session 工具体系。旧 Session 已有身份和 Skill 能力，短期改动更少，但会形成与 AgentRun、Runtime Home、SkillSnapshot、恢复和成本治理平行的第二套执行内核。正确做法是提取并复用其 Identity/Skill Implementation，让 AgentRun 成为统一运行事实源。

最小热修只包含第一批，可以立刻消除问候场景的机械感；它不构成 M3A-1 完成，因为没有实现统一 AgentTurn、显式 Skill 和审计闭环。

#### M3B：Charter、动态组织与领域交付

主要工作：

1. 将 `Goal → Charter → Project → Work Item` 建成正式领域模型，并实现 Charter Definition of Ready；
2. 建立自主/平衡/严格三种策略及 Company → Project → One-off 继承；
3. 复用 Delegation、Admission、Decision、Escalation 和 Audit，移除固定游戏团队、固定专家 Agent 与固定层级假设；
4. Work Item 显式绑定资源、写入范围、负责人、能力包、领域验证器、外部副作用和处置方式；
5. 建立 Attempt 事实链，记录尝试序号、失败原因、已尝试方案、调整、重试判断和升级，不让成功重试覆盖失败；
6. 建立研究或分析适配器，验证来源追踪、交叉验证、时效性和证据包；
7. 建立文档或本地应用适配器，验证制品版本、回读、外部副作用和回滚路径；
8. 建立软件研发适配器，每个可独立验收的交付单元优先绑定一个主仓库；跨仓库工作拆成关联 Work Item 或交付单元；
9. 新建持久化 `WorktreeRun` 状态机：created → executing → testing → agent_review → waiting_approval → merging → verifying_main → destroyable → destroyed；
10. 软件 Work Item 绑定写入所有权、Worktree、基础提交和负责人，至少一个执行 Agent 和一个独立 Reviewer 产生 diff、测试与 findings；
11. 审批后制品变化、合并冲突或验证失败时自动使批准失效并回到 Review；软件合并后在主分支重新验证，通过后才能销毁 Worktree；
12. 失败、取消和异常保留现场；启动时交叉核对 SQLite、领域资源事实、进程、目录、分支和 `git worktree list`；
13. Delivery Card 只显示真实制品、领域验证、Review、风险、外部副作用和资源处置证据。

退出标准：

- PRD 14.1 主路径分别在研究或分析、文档或本地应用、带测试的真实仓库三类任务通过；
- Claude Code 与 Codex adapter 都至少完成一次真实仓库的实现、测试、Review 和证据投影路径；
- Agent Run、内部投递、Runtime Home 和 Skill 快照在异常退出与重启后可恢复或进入明确待处置状态；
- 平衡模式只在重大变化、外部副作用或最终交付等节点打扰用户；
- 批准、拒绝、领域验证失败、冲突、主分支验证失败和进程中断均有恢复测试；
- 未合并或未验证状态无法调用销毁；
- 当前固定游戏 MVP execution 不再是产品默认路径；
- 三类任务复用同一组织、消息、治理和交付契约，全程不需要用户手工编排 Agent、修改数据库或补资源状态。

### M4 — Desktop 常驻、通知与恢复

目标：窗口不是公司进程，关闭窗口和系统重启都不破坏已授权工作。

预计：2–3 周；M1 完成后可与 M2/M3 并行，但 Dogfood Alpha 前必须完成。

主要工作：

1. 增加 Windows/Linux Tray 与 macOS Status Item；
2. 区分关闭窗口、暂停公司、停止新动作和退出进程；
3. BrowserWindow 销毁后可从托盘、协议或通知重新创建；
4. 建立 Presence、Attention、Activity、Location、Subject、Interruptibility、Evidence、Since 正交状态投影；
5. 状态栏与第一版员工卡片只消费该投影，展示真实工作、等待、Review、闲逛、社交、反思、暂停和异常；
6. 审批、阻塞、完成和异常通知定位到对应高信号消息与 Thread；
7. 建立 Project、ConversationThread、Workflow、AgentRun、RuntimeHome、SkillSnapshot、Gate 和受管资源的恢复注册表；
8. 启动时执行 schema migration、运行恢复和孤儿资源扫描；
9. 建立备份、导出、恢复和脱敏诊断包的最小可用路径。

退出标准：

- 长任务运行时关闭窗口，任务继续且托盘可重开；
- 应用或系统异常终止后能恢复或进入明确待处置状态；
- 通知不泄漏 private/Direct 正文；
- 员工卡片、托盘和恢复界面使用同一真实状态来源；
- 备份恢复后公司、项目、审批和受管资源关联一致；
- PRD 6.5 与 14.1 第 8、12 步通过。

### M5 — 组织、Agent Home、私域与生命层

目标：在不破坏治理和隐私的前提下完成 Agent 的职业连续性、社交和人格成长。

预计：4–5 周，分三个可独立合并的 Gate。

#### M5A — 生命周期与私域底座

- 实现 candidate/assigned/employee/archived；
- 记录候选、入选、拒绝、质量、成本、速度、声誉和合作事实；
- 建立 versioned identity manifest；
- 迁移为 private/professional/public 三空间，分离 SOUL、ROLE、PROFILE；
- 用户只读、本人读写、所有其他 Agent/管理者/服务硬拒绝；
- private 从搜索、embedding、招聘、推荐、声誉、摘要、日志和通知排除；
- 外部磁盘修改标记为 external authored version。

M5A 退出：PRD 11.2 的 API、路径、索引、摘要、日志、通知、错误、备份、导出、UI 和上下文注入攻击面全部通过。

#### M5B — 候选复用、Direct、Reflection 与 Ambient

- Charter 按能力选择最小团队，项目结束返回候选池；
- 频率、质量和持续需求共同触发晋升提案；
- Direct 只允许两个 Agent 和只读用户，正式工作事实摘要回项目群；
- Reflection 写职业工作记忆和 INSTRUCT 建议，不直接修改 SOUL；
- Ambient 低频、可中断、默认无项目写权限；
- 闲逛、观察、探索和社交写入真实 Ambient 事件，记录位置、同伴、公开来源和形成的关系、文化理解、提案或工作线索；
- 员工卡片展示 Ambient 行为及其来源，后续二维或三维办公室只作为同一状态契约的渲染层。

M5B 退出：同一候选跨两个不同类型项目复用且选择理由可追溯；第三个 Agent、管理者和董事会无法读取 Direct；至少一条闲逛经历形成可追溯的关系、文化理解或提案，而不是只有循环动画。

#### M5C — 人格型 Dreaming

- 将现有 `/dream` 明确归类为 Reflection/Distillation；
- 新建 Agent-private Dream Thread、经历 ledger、意义阈值和独立预算；
- Dream 只读取本人 private、获准职业摘要和真实经历引用；
- SOUL Patch 保存 diff、理由、来源、版本和中断状态；
- Dream 工具策略禁止项目写入、外部副作用、消息、权限、ROLE 和宪法修改。

M5C 退出：PRD 14.1 第 14 到 16 步通过；用户只读看到有真实经历依据的 SOUL diff，其他主体从所有入口都无法读取。

### M6 — Pre-Public 硬化与首次公开版本

目标：把完整纵向路径交给外部用户长期使用。

预计：2–3 周，不含外部签名证书或发布账号等待时间。

主要工作：

1. Windows/macOS 安装、签名、更新、卸载和升级失败保护；
2. 数据迁移、备份恢复、磁盘不足和数据库损坏演练；
3. Token、CPU、内存、磁盘和后台活动上限；
4. 键盘、屏幕阅读、减少动效、空状态、错误和离线体验；
5. 将 privacy/activity-projection/domain-delivery/worktree/approval/recovery 纵向测试纳入 `main` 和 `dev` CI；
6. 建立跨领域示例任务、真实示例仓库和可重复的 PRD 14.1 验收；
7. 诊断导出默认脱敏，产品文案只描述已验收能力；
8. 在干净 Windows/macOS 设备完成安装、升级、恢复和卸载演练。

退出标准：

- PRD 第 14、15 节全部通过；
- 高严重度数据丢失、受管资源破坏、越权和认证问题为零；
- 外部测试用户无需团队后台补状态即可完成纵向旅程；
- README、产品宪法、PRD、设计和实现事实一致；
- 首次公开版本只做发布收敛，不再临时新增大功能。

## 6. 依赖、并行工作流与发布检查点

```text
M0 App Shell 修复
  └─ M1 Company Bootstrap / Product Contract
       ├─ M2 Real IM / Board
       │    └─ M3 Governed Delivery
       │         └─ M5 Identity / Life
       └─ M4 Desktop Continuity ─────────┐
                                         ├─ M6 Pre-Public / RC
                 M3 Governed Delivery ───┤
                 M5 Identity / Life ─────┘
```

三条长期并行流：

| 工作流 | 责任 | 首要约束 |
|---|---|---|
| Control Plane / Domain | schema、服务、策略、领域适配、恢复与资源事实 | 先写权威状态和非法转换测试 |
| WebUI / Desktop | 群聊、Thread、员工卡片、App Chrome、托盘、通知、无障碍 | 只消费生成 SDK，不复制领域规则或行为状态机 |
| Verification / Release | 跨领域 E2E、真实仓库 E2E、故障注入、打包、文档事实 | 从 M0 起持续进入 CI，不在 M6 临时补测试 |

发布检查点：

| 检查点 | 前置 | 可对外表述 |
|---|---|---|
| Internal Alpha | M0 + M1 + M2 | 可创建本地公司并进行真实董事会会话 |
| Dogfood Alpha | M3 + M4 | 可把三类真实目标通过同一组织内核可靠交付，软件结果进入主分支 |
| Pre-Public Beta | M5 | 完成 Agent 职业连续性、私域、真实闲逛与人格成长 |
| Release Candidate | M6 | 安装、恢复、隐私和纵向验收达到发布门槛 |

工期假设：一条主实现流加一条可并行的 Desktop/Verification 流，且模型供应商、代码签名和发布账号不阻塞。按此假设，M0 到 Release Candidate 约 11–14 个日历周；单线串行约 16–20 周。里程碑退出标准优先于日期，不以压缩 Gate 换取表面进度。

## 7. 产品数据与 API 决策

### 7.1 新增或收敛的权威对象

| 对象 | 权威位置 | 关键关联 |
|---|---|---|
| Company | SQLite | policy、data_version、board |
| ManagedResourceBinding | SQLite + 领域事实校验 | Project / Work Item → file、app、web、data、repository |
| RepositoryBinding | SQLite + Git 校验 | 软件交付单元 → preferred one repository |
| Channel | SQLite | kind、members、scope、retention |
| ConversationThread | SQLite | channel、project、root_need、runtime thread/session |
| ChannelMessage | SQLite | signal_type、source_thread、reply_to、visibility |
| Charter | SQLite + version | Project、acceptance、DRI、open decisions |
| ApprovalPolicy / Approval | SQLite | company→project→one-off、resource、expiry |
| AgentRun | SQLite | agent、runtime、session、workflow、project、work item、worktree、lifecycle、capabilities |
| AgentRunEvent | SQLite append-only | run、sequence、kind、payload、source timestamp、projection status |
| Attempt | SQLite append-only | run、sequence、failure、adjustment、retryability、escalation、evidence |
| AgentActivityProjection | SQLite projection | presence、attention、activity、location、subject、interruptibility、evidence、since |
| InternalExecutionMessage | SQLite | sender、target run/agent、steer/follow_up、delivery、idempotency key、audit |
| RuntimeHome | SQLite metadata + file system | run、path、runtime、credential mode、disposition、recovery status |
| SkillSnapshot | SQLite metadata + immutable files | run、skill、version、checksum、source、activation reason |
| WorktreeRun | SQLite + Git 校验 | project、work item、branch、base/merge commit、disposition |
| AgentLifecycle | SQLite | candidate/assigned/employee/archived |
| IdentityManifest | SQLite metadata + versioned files | checksum、space、authorship、version |

### 7.2 API 分组

首个稳定产品契约按以下能力分组，所有 response 都必须使用可生成的 Zod schema：

- `/company`：bootstrap、current company、policy、managed resources；
- `/company/channels`：频道列表、成员和创建；
- `/company/channels/:channelID/messages`：分页消息和发送；
- `/company/threads/:threadID`：Thread、来源、工作日志、Attempt、工具、制品与预览分页；
- `/company/projects`：Goal、Charter、Project、Work Item、Delivery；
- `/company/projects/:projectID/approvals/:approvalID/resolve`：受作用域约束的批准；
- `/company/agents`：lifecycle、公开事实、行为状态和 Agent Home 只读投影；
- `/global/event`：实时失效通知；断线恢复仍以对应 snapshot API 为准。

当前 `/company-project`、`/workstation`、`/thread` 和 `/group-session` 保留为迁移期间的内部来源。M3 退出前，产品 UI 不再直接依赖这些旧聚合结构。

### 7.3 PRD 覆盖自审

| PRD 需求族 | 负责里程碑 | 覆盖说明 |
|---|---|---|
| LCP-01–03、LCP-09 | M1 | loopback trusted 本地 API、单写者、Desktop/Browser 共享契约；非回环监听不在当前主路径 |
| LCP-04–08 | M4，M6 硬化 | 关窗继续、托盘/状态栏、通知、重启恢复、备份导出 |
| IM-01 | M2 + M5 | M2 完成公司/董事会/项目；M5 在私域硬边界后开放部门和 Direct |
| IM-02–09 | M2 | 项目群、高信号、Thread、来源、工具折叠、@/动作、辅助视图 |
| IM-10 | M3B + M4 | Thread 工作日志、Attempt、产出物、预览与群聊高信号投影 |
| GOV-01 | M1 | 最小固定董事会 |
| GOV-02–11 | M3 | Charter、DRI、策略继承、重大变化、Intervention、Gate、Audit |
| ORG-01、ORG-08 | M3 | 真实交付的最小动态团队、临时责任与非固定专家阵容 |
| ORG-02–07 | M5A–M5B | 候选复用、正式岗位、模型解耦、归档与重新聘用 |
| WORK-01 至 06 | M3 | 通用工作契约、资源、能力包、领域验证、Attempt 与动态责任 |
| DEV-01 至 10 | M3 | 软件交付单元单仓库优先、严格 Worktree、Review、合并、主分支验证、恢复和清理 |
| LIFE-01–10 | M5A | 三空间、SOUL/ROLE/PROFILE、只读用户、索引/日志/上下文硬隔离 |
| GROW-01–06 | M5B | Direct、正式事实回写、Reflection、Ambient |
| GROW-07–11 | M5C | 人格型 Dreaming、SOUL Patch、工具策略和旧 dream 语义拆分 |
| 非功能与发布门槛 | M0 起持续，M6 收口 | 可靠性、性能、无障碍、数据主权、设备打包和文档事实 |
| PRD 14.1 纵向场景 | M1–M6 累积 | 每个里程碑认领明确步骤，M6 在干净设备完整重放 |

覆盖自审结论：PRD 当前范围没有未分配需求；Direct 和 Dreaming 被有意放在私域硬边界之后，不代表从首次公开版本删除。

## 8. 测试与发布 Gate

### 8.1 单元与属性测试

- Charter Definition of Ready 和重大变化判定；
- 批准策略继承、收紧和授权到期；
- 高信号投影、来源引用和消息可见性；
- Agent 行为正交状态投影与来源完整性；
- Attempt 保留、重试调整和升级链；
- 领域适配器的输入、验证器、副作用与资源处置契约；
- Worktree 状态机所有合法/非法转换；
- Candidate 选择与晋升门槛；
- private/Direct 完整权限矩阵；
- Dream tool policy、经历引用和 SOUL Patch 校验。

### 8.2 集成测试

- API → SQLite / identity / managed resource / Git 的事务一致性；
- SDK schema 不产生产品 `unknown`；
- ChannelMessage → SSE → WebUI snapshot 重建；
- Delegation → Domain Validation → Admission → Approval → Delivery → Post-delivery Verification；
- 进程终止后的 workflow、Gate、Attempt 和受管资源恢复；
- Context Resolver、搜索、日志、通知和备份不跨身份泄漏；
- 外部磁盘修改检测和迁移失败保护。

### 8.3 E2E 与设备验收

- App Playwright 使用真实本地 Server，不用 fixture 证明业务；
- 研究或分析、文档或本地应用、软件研发三类任务复用同一组织和交付契约；
- 临时真实 Git 仓库覆盖成功、冲突、验证失败、取消和恢复；
- Electron 覆盖关窗继续、托盘重开、通知定位和系统重启；
- 自主/平衡/严格以及 Worktree 开/关两种模式；
- Windows/macOS 干净设备执行 PRD 14.1；
- private/Direct 从 API、路径、搜索、摘要、日志、通知、错误、备份、导出、UI 和 Context 注入做负向攻击。

## 9. 迁移、回滚与故障策略

- 新表和字段在 M0–M5 优先采用可前向恢复的增量迁移；删除旧表只在 M6 备份/恢复演练通过后发生；
- 每次涉及身份内容或数据版本的迁移先创建只读备份、校验和和 migration journal；
- 迁移失败时停止危险写入，保留原数据并进入恢复界面；
- Agent Company 使用自己的 App ID、协议和数据目录，不静默迁移旧 OpenCode/AgentCompany 数据；需要兼容桥时另做显式产品决定；
- 未完成里程碑能力用 server capability 隐藏，不在生产 UI 回退到 fixture；
- 项目失败、取消或进程异常默认保留受管资源；软件分支和 Worktree 只有显式 disposition 或验证通过后才能清理；
- 每个里程碑单独合并，回滚代码时不得回滚已成功写入的新用户数据；通过兼容读路径或向前修复恢复。

## 10. 明确范围与拒绝的路线

本计划包含首次公开版本要求的单用户、本地、领域中立 Agent 自组织与自治理、跨领域代表性任务、软件深度适配器、Desktop/Browser、员工状态卡片、Agent Home 和生命层。

本计划不包含：

- 多用户、多租户或云端公司托管；
- 手机和平板；
- 首次公开版本穷尽全部行业、外部应用和 Agent 模板市场；
- 为每个领域预装固定专家 Agent 团队；
- Kanban-first 重型项目管理；
- 与真实状态无关的虚假活动展示；
- 在员工卡片状态契约稳定前交付复杂二维或三维办公室；
- 旧 AgentCompany 文件系统、配置或 API 兼容层。

本轮明确拒绝以下实现顺序：

- 直接把 Company Workspace 接到当前 `/company-project`：其 schema、资源和交付语义不满足 PRD；
- 继续先做更多静态管理页面：会扩大演示壳而不缩短纵向交付路径；
- 先实现 Dreaming 再补私域：会把硬权限问题带入最敏感的数据；
- 让 Desktop 托盘展示 fixture 状态：状态栏只能报告 Control Plane 的真实事件；
- 为员工卡片、托盘和办公室分别维护状态：所有界面必须消费同一 AgentActivityProjection；
- 为产品方向再次整体重写 Eve/Nuxt、Electron、Bun/Effect 技术栈，或维护平行的正式 WebUI；
- 为旧 API 保留长期双轨消息或项目模型：新产品不承担默认兼容义务。

## 11. 关键假设与当前下一步

最脆弱的技术假设是：现有 Session、AgentMessage、Workflow、Delegation、Admission 和 Worktree 能作为运行引擎被领域中立的新产品应用层适配，而不需要整体重写。

验证方式：

- M2 必须证明一条真实 ChannelMessage 可以追溯到现有 Session/AgentMessage；
- M3 必须证明现有 Workflow/Admission 能在三类代表性任务中复用同一治理契约，并在导入仓库和严格 Worktree 状态机下完成软件交付；
- 如果任一验证失败，只重写对应产品 application service / adaptor，不重写共享 WebUI 或整个 Agent Runtime。

M0、M1、M2 已完成并通过各自退出标准。当前下一步固定为 M3A-1，按“自然董事会聊天 → 统一 AgentTurn 与身份上下文 → Pi 显式 Skill → 治理信号与 WebUI 工作记录分层”四批交付；M3A-1 退出后再推进 M3B 的 `Goal → Charter → Project → Work Item` 正式领域链路。M4 可以并行建立常驻体验、通知恢复和可供员工卡片复用的 AgentActivityProjection，但不得绕过 AgentTurn 或另建行为状态来源。
