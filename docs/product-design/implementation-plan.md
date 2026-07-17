# Implementation Plan：Pre-Public 纵向交付

> 状态：M0、M1、M2 已完成；当前进入 M3 Charter、治理与真实软件交付闭环
> 代码盘点基线：2026-07-13；M1/M2 关闭验证更新：2026-07-17
> 视觉决策：Company Workspace 方案 2 已通过验证，作为后续共享 WebUI 的视觉基线
> 上位文档：[产品宪法](PRODUCT-CONSTITUTION.md)
> 产品验收：[产品 PRD](../Agent%20Company%20产品%20PRD.md)

## 1. 本轮重排结论

Agent Company 已完成产品事实收敛，也验证了共享 WebUI 的视觉方向；当前不再需要继续制作静态页面方案。下一阶段必须从“模块和界面分别存在”切换为“每个里程碑都交付一段真实、可恢复、可验证的用户旅程”。

本计划用 M0–M6 纵向里程碑替代原来按 W1–W8 子系统铺开的实施顺序，但不改变宪法和 PRD 的首次公开版本范围。

核心决定：

- 保留当前 Company Workspace 的视觉语言，不重做信息架构和视觉方向；
- 先修复共享 App Shell，再接入真实业务，避免把演示状态扩散成第二套产品；
- 先建立 Company/Channel/Thread/Message 的权威契约，再让 WebUI、Desktop 和 TUI 消费；
- 先完成一个真实仓库的严格交付闭环，再扩展候选池、Agent Home 和生命层；
- 隐私硬边界必须早于 Direct 和 Dreaming；
- 每个里程碑都必须独立可合并、可回滚、可从 UI 验收，不能以“后端模块已存在”代替产品完成。

## 2. 当前事实基线

| 区域 | 当前事实 | 当前结论 |
|---|---|---|
| 产品文档 | 宪法、PRD、00–08 专题设计和本计划已有单向优先级 | S0 产品收敛基本完成 |
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
自治软件交付闭环：只有可复用原型
Agent 生命层与 Pre-Public 发布：尚未进入验收
```

## 3. 目标架构与边界

```text
Electron / Browser / TUI
          │
          ▼
Generated SDK + loopback-only trusted local API + SSE invalidation
          │
          ▼
Local Control Plane（唯一权威写入者）
  ├─ Company / Conversation application services
  ├─ Governance / Approval / Audit
  ├─ Agent Execution Kernel / Session / Workflow runtime
  ├─ Delivery / Admission / Worktree lifecycle
  └─ Context Resolver / Privacy boundary
          │
          ├──────────────┬────────────────────┐
          ▼              ▼                    ▼
       SQLite      versioned identity files   Git / Worktrees
```

架构约束：

- WebUI、Electron renderer 和 TUI 不直接写 SQLite、身份文件或 Git；
- SQLite 是事务状态权威源，身份文件是人格内容权威源，Git 是代码与合并事实权威源；
- SSE 只负责实时失效通知和增量体验，断线后必须从权威快照重建，不能把内存事件总线当作正式记录；
- 当前 `thread` 表表示 Agent 执行线程，不能直接冒充产品 IM Thread；产品层使用 `ConversationThread`，并通过 `runtime_thread_id` / `session_id` 关联执行过程；
- 当前 `MessageV2` 保留为模型会话和工具原始记录；正式频道消息使用 `ChannelMessage`，通过来源引用连接原始消息、AgentMessage、Decision、Artifact 和 Gate；
- `GroupSession`、Bidding 和 Workflow 是运行实现，不直接定义用户可见的频道模型；
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
4. 接入共享 WebUI，并通过同一服务语义供 Desktop、Browser 和 TUI 使用；
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

目标：在干净数据目录中创建一家公司和最小董事会，并将 Provider、公司名称与仓库绑定改为可在主工作台后续完成的渐进式配置。

状态：已完成（2026-07-17）。浏览器、TUI 与 Windows 原生 Electron Gate 均通过；原生 Gate 以真实 main/preload/renderer/sidecar 覆盖目录选择、bootstrap、trusted loopback、消息、Thread 与重启恢复。

实施验证：2026-07-14。M1 实际覆盖范围与文件级计划以 [2026-07-13 M1 Company Bootstrap 实施计划](../compose/plans/2026-07-13-m1-company-bootstrap.md) 为准。

主要工作：

1. 新建 `Company`、`RepositoryBinding`、`ApprovalPolicy` 和最小 `AgentLifecycle` schema；
2. 实现渐进式首次进入：固定数据目录后自动创建 CEO/CTO/Product Lead、默认平衡预设并直接打开 Company Workspace；
3. Provider 通过 Settings 配置；未配置时，对话将目标持久化为设置卡，不启动董事会运行；仓库可由 Agent 按需在受管本地目录初始化，Company 仍只保存一个项目一个主仓库的产品绑定；
4. 新建带完整 Zod response 的 `/company` 产品路由，修复 SDK `unknown`，并运行 `./packages/sdk/js/script/build.ts`；
5. 将 Desktop 品牌、App ID、协议和新数据目录切换为 Agent Company；本产品不为旧 AgentCompany/OpenCode 数据布局提供隐式兼容桥；
6. Desktop sidecar 与本地浏览器共享仅绑定 loopback 的 trusted 服务契约；当前单用户阶段不认证用户；
7. 所有创建步骤幂等，失败时可继续首次引导而不生成第二家公司或重复董事会。

退出标准：

- 干净环境直接打开默认公司和董事会；未配置 Provider 的目标会显示可直达 Settings 的持久化卡片；
- 刷新和重启后仍打开同一家公司和董事会；仓库在首次实际交付时创建或绑定；
- 本地浏览器无需凭据即可读取同一家公司，且 Control Plane 默认只监听 loopback；
- SDK 中本里程碑产品接口没有 `unknown` response；
- 首次引导失败不会留下不可恢复的半初始化状态。

#### 2026-07-14/15 验证证据

- 根目录 `bun script/generate-agent-company-brand.ts --check` 与 `./packages/sdk/js/script/build.ts` 通过；后者重复生成后输出哈希一致。
- `packages/control-plane` 的 migration check、M1 Company/server/build-node 测试、TUI company-entry 测试与 `bun typecheck` 均在 Windows 通过；network-auth 回归测试确认 loopback listener 默认 trusted，显式 network auth 仍保持受保护。
- `packages/sdk/js` 的类型检查和 Company contract 测试通过；`packages/app` 的单元测试、类型检查、生产构建与真实 Playwright bootstrap E2E 通过；`packages/ui` 类型检查通过。
- `packages/desktop` 的 Company home、品牌、shell env、renderer HTML 测试、类型检查和 Electron 生产构建均在 Windows 通过；生产身份静态扫描未发现 OpenCode 用户可见残留。`electron-builder` 已使用本机 Electron 分发目录和可访问的构建依赖镜像生成 `win-unpacked`、NSIS 安装包与 blockmap；本地构建未配置发布证书，签名仍由 CI 发布流程负责。
- 浏览器手工完成 trusted loopback 直入、五步初始化、刷新持久化和控制台无错误核验；TUI 手工覆盖未初始化、错误仓库目录和正确仓库目录三种入口。
- 2026-07-17 更新可重复的 Windows 原生 Electron Gate：真实 main/preload/renderer/sidecar 覆盖目录选择取消/成功、首次引导、Desktop 圆桌消息与 Thread、loopback API 直读和进程重启恢复。操作系统目录对话框返回值在测试内替换，IPC 与后续产品路径运行真实实现。

### M2 — 真实 IM、董事会与高信号 Thread

目标：当前 Company Workspace 从 fixture 变成真实、可持久化的公司会话入口。

状态：已完成（2026-07-15）。历史提交审查发现的 interrupt 越权副作用、发送未即时启动 runtime、终态竞争、恢复关联窗口、来源未精确 hydrate、Thread entry 缺项、SSE 重连不全量刷新、Playwright Gate 不稳定和 Desktop sidecar 依赖缺失均已收口。Browser 与 Windows 原生 Electron 纵向 Gate 已纳入 CI；`capabilities.board_messages` 生产默认开启，紧急回滚使用 `AGENTCOMPANY_DISABLE_BOARD_MESSAGES=true`。详细证据见 [M2 关闭报告](../compose/reports/2026-07-15-m2-real-im-board.md)与 [M2 实施计划](../compose/plans/2026-07-14-m2-real-im-board.md)。

预计：约 3 周（双工作流 12–15 个工程日；单线顺序实施约 4 周）。详细代码审计与任务拆解见 [M2 实施计划](../compose/plans/2026-07-14-m2-real-im-board.md)。

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

### M3 — Charter、治理与真实软件交付闭环

目标：让一个导入的真实仓库完成目标到主分支交付，而不是在空目录生成演示 MVP。

预计：4–6 周，分为两个可独立合并的 Gate；M3A 完成后现有 GroupSession/Workflow 可以使用可靠的本地 Agent 执行内核，M3B 再完成受治理的软件交付闭环。

#### M3A — Agent Execution Kernel

目标：建立以 Pi 为内置默认、Codex 与 Claude Code 为可选平级实现的统一 Agent Runtime；Workflow Engine 负责公司流程，不建设第二套 CLI、数据库或产品消息系统。

状态：实施中。统一 Runtime Port、Pi 0.80.7、能力包/工作流目录、AgentRun 事实表、受控 Pi 工具、Codex/Claude CLI 兼容适配和产品 API 已接通；Pi 的跨进程会话恢复、正式 Codex app-server/Claude Agent SDK 适配及完整真实仓库交付 Gate 仍是关闭项。

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

- 同一个受授权开发任务可以分别使用已认证的 Claude Code CLI 和 Codex CLI 执行，产生相同结构的 Agent Run 事件；
- 中断、follow-up、子进程异常退出和 Control Plane 重启不会丢失消息、重复领取任务或伪造完成状态；
- 每次运行使用独立 Runtime Home 和明确 Worktree，用户 dirty checkout、真实 HOME 与其他 Agent 身份空间不被修改；
- 不支持的 runtime/lifecycle/permission 组合在启动前失败，并返回可供 UI 和审计使用的明确原因；
- 运行事实可以重建 Session、Thread 和高信号投影，SSE 断线不影响权威状态；
- 没有新增平行数据库、wanman API 或产品消息模型。

#### M3B — Charter、治理与真实软件交付

主要工作：

1. 将 `Goal → Charter → Project → Work Item` 建成正式领域模型，并实现 Charter Definition of Ready；
2. 建立自主/平衡/严格三种策略及 Company → Project → One-off 继承；
3. 复用 Delegation、Admission、Decision、Escalation 和 Audit，但移除固定游戏团队与固定层级假设；
4. 一个 Project 强制绑定 M1 导入的一个主 Git 仓库；跨仓库目标必须拆项目；
5. 新建持久化 `WorktreeRun` 状态机：created → executing → testing → agent_review → waiting_approval → merging → verifying_main → destroyable → destroyed；
6. Work Item 绑定写入所有权、Worktree、基础提交和负责人；
7. 至少一个执行 Agent 和一个独立 Reviewer 对照 Charter 产生 diff、测试和 findings；
8. 审批后 diff 改变、合并冲突或验证失败时自动使批准失效并回到 Review；
9. 合并后在主分支重新执行必要验证，只有通过后才能销毁 Worktree；
10. 失败、取消和异常保留现场；启动时用 SQLite、`git worktree list`、分支和目录交叉校验；
11. Delivery Card 只显示真实提交、验证、Review、风险、合并和清理证据。

退出标准：

- PRD 14.1 第 4–11 步在一个带测试的真实仓库通过；
- Claude Code 与 Codex adapter 都至少完成一次真实仓库的实现、测试、Review 和证据投影路径；
- Agent Run、内部投递、Runtime Home 和 Skill 快照在异常退出与重启后可恢复或进入明确待处置状态；
- 平衡模式只在最终合并等重大节点打扰用户；
- 批准、拒绝、冲突、主分支验证失败和进程中断均有恢复测试；
- 未合并或未验证状态无法调用销毁；
- 当前固定游戏 MVP execution 不再是产品默认路径；
- 全程不需要用户手工编排 Agent、修改数据库或补 Git 状态。

### M4 — Desktop 常驻、通知与恢复

目标：窗口不是公司进程，关闭窗口和系统重启都不破坏已授权工作。

预计：2–3 周；M1 完成后可与 M2/M3 并行，但 Dogfood Alpha 前必须完成。

主要工作：

1. 增加 Windows/Linux Tray 与 macOS Status Item；
2. 区分关闭窗口、暂停公司、停止新动作和退出进程；
3. BrowserWindow 销毁后可从托盘、协议或通知重新创建；
4. 状态栏只展示真实 idle/working/waiting/reviewing/blocked/error 状态；
5. 审批、阻塞、完成和异常通知定位到对应高信号消息与 Thread；
6. 建立 Project、ConversationThread、Workflow、AgentRun、RuntimeHome、SkillSnapshot、Gate 和 Worktree 的恢复注册表；
7. 启动时执行 schema migration、运行恢复和孤儿 Worktree 扫描；
8. 建立备份、导出、恢复和脱敏诊断包的最小可用路径。

退出标准：

- 长任务运行时关闭窗口，任务继续且托盘可重开；
- 应用或系统异常终止后能恢复或进入明确待处置状态；
- 通知不泄漏 private/Direct 正文；
- 备份恢复后公司、项目、审批和 Git 关联一致；
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
- Ambient 低频、可中断、默认无项目写权限。

M5B 退出：同一候选跨两个项目复用且选择理由可追溯；第三个 Agent、管理者和董事会无法读取 Direct。

#### M5C — 人格型 Dreaming

- 将现有 `/dream` 明确归类为 Reflection/Distillation；
- 新建 Agent-private Dream Thread、经历 ledger、意义阈值和独立预算；
- Dream 只读取本人 private、获准职业摘要和真实经历引用；
- SOUL Patch 保存 diff、理由、来源、版本和中断状态；
- Dream 工具策略禁止项目写入、外部副作用、消息、权限、ROLE 和宪法修改。

M5C 退出：PRD 14.1 第 13–15 步通过；用户只读看到有真实经历依据的 SOUL diff，其他主体从所有入口都无法读取。

### M6 — Pre-Public 硬化与首次公开版本

目标：把完整纵向路径交给外部用户长期使用。

预计：2–3 周，不含外部签名证书或发布账号等待时间。

主要工作：

1. Windows/macOS 安装、签名、更新、卸载和升级失败保护；
2. 数据迁移、备份恢复、磁盘不足和数据库损坏演练；
3. Token、CPU、内存、磁盘和后台活动上限；
4. 键盘、屏幕阅读、减少动效、空状态、错误和离线体验；
5. 将 privacy/worktree/approval/recovery 纵向测试纳入 `main` 和 `dev` CI；
6. 建立真实示例仓库和可重复的 PRD 14.1 验收；
7. 诊断导出默认脱敏，产品文案只描述已验收能力；
8. 在干净 Windows/macOS 设备完成安装、升级、恢复和卸载演练。

退出标准：

- PRD 第 14、15 节全部通过；
- 高严重度数据丢失、仓库破坏、越权和认证问题为零；
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
| Control Plane / Domain | schema、服务、策略、恢复、Git 事实 | 先写权威状态和非法转换测试 |
| WebUI / Desktop | 共享 UI、App Chrome、托盘、通知、无障碍 | 只消费生成 SDK，不复制领域规则 |
| Verification / Release | 真实仓库 E2E、故障注入、打包、文档事实 | 从 M0 起持续进入 CI，不在 M6 临时补测试 |

发布检查点：

| 检查点 | 前置 | 可对外表述 |
|---|---|---|
| Internal Alpha | M0 + M1 + M2 | 可创建本地公司并进行真实董事会会话 |
| Dogfood Alpha | M3 + M4 | 可把一个真实软件目标可靠交付到主分支 |
| Pre-Public Beta | M5 | 完成 Agent 职业连续性、私域与人格成长 |
| Release Candidate | M6 | 安装、恢复、隐私和纵向验收达到发布门槛 |

工期假设：一条主实现流加一条可并行的 Desktop/Verification 流，且模型供应商、代码签名和发布账号不阻塞。按此假设，M0 到 Release Candidate 约 11–14 个日历周；单线串行约 16–20 周。里程碑退出标准优先于日期，不以压缩 Gate 换取表面进度。

## 7. 产品数据与 API 决策

### 7.1 新增或收敛的权威对象

| 对象 | 权威位置 | 关键关联 |
|---|---|---|
| Company | SQLite | policy、data_version、board |
| RepositoryBinding | SQLite + Git 校验 | Company / Project → one repository |
| Channel | SQLite | kind、members、scope、retention |
| ConversationThread | SQLite | channel、project、root_need、runtime thread/session |
| ChannelMessage | SQLite | signal_type、source_thread、reply_to、visibility |
| Charter | SQLite + version | Project、acceptance、DRI、open decisions |
| ApprovalPolicy / Approval | SQLite | company→project→one-off、resource、expiry |
| AgentRun | SQLite | agent、runtime、session、workflow、project、work item、worktree、lifecycle、capabilities |
| AgentRunEvent | SQLite append-only | run、sequence、kind、payload、source timestamp、projection status |
| InternalExecutionMessage | SQLite | sender、target run/agent、steer/follow_up、delivery、idempotency key、audit |
| RuntimeHome | SQLite metadata + file system | run、path、runtime、credential mode、disposition、recovery status |
| SkillSnapshot | SQLite metadata + immutable files | run、skill、version、checksum、source、activation reason |
| WorktreeRun | SQLite + Git 校验 | project、work item、branch、base/merge commit、disposition |
| AgentLifecycle | SQLite | candidate/assigned/employee/archived |
| IdentityManifest | SQLite metadata + versioned files | checksum、space、authorship、version |

### 7.2 API 分组

首个稳定产品契约按以下能力分组，所有 response 都必须使用可生成的 Zod schema：

- `/company`：bootstrap、current company、policy、repositories；
- `/company/channels`：频道列表、成员和创建；
- `/company/channels/:channelID/messages`：分页消息和发送；
- `/company/threads/:threadID`：Thread、来源、工具/制品分页；
- `/company/projects`：Goal、Charter、Project、Work Item、Delivery；
- `/company/projects/:projectID/approvals/:approvalID/resolve`：受作用域约束的批准；
- `/company/agents`：lifecycle、公开事实和 Agent Home 只读投影；
- `/global/event`：实时失效通知；断线恢复仍以对应 snapshot API 为准。

当前 `/company-project`、`/workstation`、`/thread` 和 `/group-session` 保留为迁移期间的内部来源。M3 退出前，产品 UI 不再直接依赖这些旧聚合结构。

### 7.3 PRD 覆盖自审

| PRD 需求族 | 负责里程碑 | 覆盖说明 |
|---|---|---|
| LCP-01–03、LCP-09 | M1 | loopback trusted 本地 API、单写者、Desktop/Browser 共享契约；非回环监听不在当前主路径 |
| LCP-04–08 | M4，M6 硬化 | 关窗继续、托盘/状态栏、通知、重启恢复、备份导出 |
| IM-01 | M2 + M5 | M2 完成公司/董事会/项目；M5 在私域硬边界后开放部门和 Direct |
| IM-02–09 | M2 | 项目群、高信号、Thread、来源、工具折叠、@/动作、辅助视图 |
| GOV-01 | M1 | 最小固定董事会 |
| GOV-02–11 | M3 | Charter、DRI、策略继承、重大变化、Intervention、Gate、Audit |
| ORG-01 | M3 | 真实交付的最小动态团队 |
| ORG-02–07 | M5A–M5B | 候选复用、正式岗位、模型解耦、归档与重新聘用 |
| DEV-01–10 | M3 | 单仓库、严格 Worktree、Review、合并、主分支验证、恢复和清理 |
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
- Worktree 状态机所有合法/非法转换；
- Candidate 选择与晋升门槛；
- private/Direct 完整权限矩阵；
- Dream tool policy、经历引用和 SOUL Patch 校验。

### 8.2 集成测试

- API → SQLite / identity / Git 的事务一致性；
- SDK schema 不产生产品 `unknown`；
- ChannelMessage → SSE → WebUI snapshot 重建；
- Delegation → Admission → Approval → Merge → Main Verification；
- 进程终止后的 workflow、Gate 和 Worktree 恢复；
- Context Resolver、搜索、日志、通知和备份不跨身份泄漏；
- 外部磁盘修改检测和迁移失败保护。

### 8.3 E2E 与设备验收

- App Playwright 使用真实本地 Server，不用 fixture 证明业务；
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
- 项目失败、取消或进程异常默认保留 Worktree 和分支，只有显式 disposition 或验证通过后才能清理；
- 每个里程碑单独合并，回滚代码时不得回滚已成功写入的新用户数据；通过兼容读路径或向前修复恢复。

## 10. 明确范围与拒绝的路线

本计划包含首次公开版本要求的单用户、本地、单项目单仓库、软件研发、Desktop/Browser/TUI、Agent Home 和生命层。

本计划不包含：

- 多用户、多租户或云端公司托管；
- 手机和平板；
- 通用行业交付和 Agent 模板市场；
- 单项目多仓库写入；
- Kanban-first 重型项目管理；
- 像素办公室和虚假活动展示；
- 旧 AgentCompany 文件系统、配置或 API 兼容层。

本轮明确拒绝以下实现顺序：

- 直接把 Company Workspace 接到当前 `/company-project`：其 schema、仓库和交付语义不满足 PRD；
- 继续先做更多静态管理页面：会扩大演示壳而不缩短纵向交付路径；
- 先实现 Dreaming 再补私域：会把硬权限问题带入最敏感的数据；
- 让 Desktop 托盘展示 fixture 状态：状态栏只能报告 Control Plane 的真实事件；
- 为产品方向重写 SolidJS/Electron/Bun/Effect 技术栈：现有基础足够支撑目标；
- 为旧 API 保留长期双轨消息或项目模型：新产品不承担默认兼容义务。

## 11. 关键假设与当前下一步

最脆弱的技术假设是：现有 Session、AgentMessage、Workflow、Delegation、Admission 和 Worktree 能作为运行引擎被新产品应用层适配，而不需要整体重写。

验证方式：

- M2 必须证明一条真实 ChannelMessage 可以追溯到现有 Session/AgentMessage；
- M3 必须证明现有 Workflow/Admission 能在导入仓库和严格 Worktree 状态机下完成一次交付；
- 如果任一验证失败，只重写对应产品 application service / adaptor，不重写共享 WebUI 或整个 Agent Runtime。

M0、M1、M2 已完成并通过各自退出标准。当前下一步是 M3：建立 `Goal → Charter → Project → Work Item` 正式领域链路、治理策略与严格 Worktree 交付闭环；M4 的常驻、托盘、通知与系统级恢复仍按原计划并行推进。
