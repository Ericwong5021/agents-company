# M1 Company Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在干净的本地数据目录中，以同一套 Web/Desktop 服务契约创建唯一公司、固定三人董事会、默认模型、批准策略和一个真实 Git 主仓库，并让浏览器只能通过显式配对读取公司数据。

**Architecture:** Desktop 在加载 Control Plane 之前确定 AGENTCOMPANY_HOME；网络 Listener 默认使用进程级短期 Basic 凭据，浏览器通过一次性配对码换取只在服务端保存哈希的 Bearer 凭据。Company application service 先验证 Provider、Model 和 Git，再用一个 SQLite immediate transaction 原子写入 Company、ApprovalPolicy、RepositoryBinding 和三名董事会成员；共享 WebUI、Desktop 和 TUI 都读取同一 /company 契约。

**Tech Stack:** Bun、TypeScript、Effect、Drizzle/SQLite、Hono + hono-openapi、生成式 JavaScript SDK、SolidJS、Electron、Playwright、Bun test。

## Global Constraints

- 当前产品是 local-first Pre-Public，只面向单用户、本地、软件研发、一个 Project 一个主 Git 仓库。
- packages/app 与 packages/desktop 是主产品入口；TUI 只共享服务语义，不定义主信息架构。
- 不建设多用户、云托管、多仓库项目、Kanban-first、像素办公室或通用行业交付。
- 不为旧 AgentCompany/OpenCode 文件系统、配置、App ID、协议或 API 建立隐式兼容桥。
- M1 不创建 ChannelMessage、Thread、虚假审批、虚假测试结果或可发送的董事会会话；这些属于 M2。
- 网络 Listener 默认必须认证，即使只绑定 loopback；只有显式 --no-auth 才能关闭认证。
- Desktop 只在内存中持有每次启动生成的 Basic 密码；浏览器 Bearer token 的明文只返回一次。
- Browser/Desktop renderer 必须有禁止第三方脚本、object 和 frame 的 CSP；共享 App 不请求上游 OpenCode changelog/favicon。
- 所有新 HTTP operation 都必须声明完整 Zod success/error response；生成 SDK 的 M1 response 不得是 unknown。
- JavaScript SDK 必须从仓库根目录运行 ./packages/sdk/js/script/build.ts 重新生成。
- 测试和 bun typecheck 只能从具体 package 目录运行，不能从仓库根目录运行，也不能直接运行 tsc。
- 数据库变更只做可前向恢复的增量迁移；代码回滚不能删除已经成功写入的用户数据。
- 固定品牌值：Agent Company；协议 agentcompany；renderer scheme ac；App ID ai.agentcompany.desktop、ai.agentcompany.desktop.beta、ai.agentcompany.desktop.dev。
- Browser title/manifest/theme storage 与 Desktop 打包图标都必须使用 Agent Company 身份；不读取 `opencode-*` storage key，也不把上游 favicon、social image 或渠道 icon 带入产物。

---

## 输入依据

- docs/product-design/PRODUCT-CONSTITUTION.md
- docs/Agent Company 产品 PRD.md，尤其 6.1、7.1、7.3、7.5、14.1
- docs/product-design/implementation-plan.md 的 M1、迁移/回滚策略和范围拒绝项
- AGENTS.md
- M0 提交 e86410b3、abf1c19d、a8d99809

## M1 决策规格

### [M1-S1] 数据根目录与 Desktop 产品身份

Desktop 首次启动先展示数据目录 preflight，用户选择成功后把绝对路径写入新 App ID 自己的 electron-store，并 relaunch。主进程必须在第一次动态导入 virtual:opencode-server 之前设置 AGENTCOMPANY_HOME；浏览器只显示当前 Control Plane 的 data_directory，不能在线搬迁它。

命名上，用户选择的是 `company_home` 根目录；Control Plane 按现有 Global 约定在其下创建 data/config/cache/state。CompanyState.data_directory 固定返回实际持久数据路径 `<company_home>/data`，preflight 同时预览这个派生路径，避免用户误以为数据库直接写在根目录。

这会把 PRD 6.1 的“数据目录”技术前置到“Provider”之前。原因是 auth.json、SQLite、配置和日志都由同一个 home 派生；先写 Provider 再搬目录会制造临时凭据库和迁移语义。实施完成时同步修正文档顺序，但仍保留七个用户结果。

Desktop 不读取 `ai.opencode.*`、opencode.settings 或旧 XDG/opencode 目录；也不运行旧 Tauri/JSON 隐式迁移。Updater 在 M6 配置 Agent Company 自有发布源前保持关闭。

M1 使用一套与当前 WebUI 色彩一致的中性 AC monogram 作为 Browser/Desktop product mark；packages/app/public/agent-company-mark.svg 是唯一设计源，Desktop source.svg 是由测试保证 byte-identical 的镜像，PNG/ICNS/ICO 是从它生成并提交的发布资产。dev/beta/prod 共用图形，只改变产品名和 App ID。M6 可以精修完整品牌系统，但不能在 M1 继续展示或打包上游图标。

共享 App 仍可保留 `createOpencodeClient`、theme ID 和 provider adapter 等不可见继承符号，但所有可选 locale、storage/cookie namespace、deep link、错误/帮助链接和可到达的 Provider UI 都切到 Agent Company。`opencode`/`opencode-go` 托管 provider 在共享 UI 与 Company API 双层过滤；不能把 OpenCode Zen 机械改名成并不存在的 Agent Company 服务。

### [M1-S2] 本地网络认证与浏览器配对

Server.Default().app 是进程内 trusted app；Server.listen() 默认创建 protected network app。凭据优先级为显式 listen.auth、AGENTCOMPANY_SERVER_USERNAME/PASSWORD、最后自动生成 32-byte base64url 密码，默认用户名 agentcompany。

以下请求不需要凭据：

- OPTIONS；
- GET /global/health；
- GET/HEAD 静态 WebUI；
- POST /local-auth/exchange。

所有其他 API、SSE 和凭据管理端点都必须通过 Basic 或 Bearer。POST /local-auth/pairings、GET /local-auth/credentials、DELETE /local-auth/credentials/:id 只接受 Desktop/CLI 的 Basic 身份；已配对浏览器不能继续铸造或管理凭据。

配对码使用 8 位 Crockford Base32、显示为 XXXX-XXXX、5 分钟失效、成功交换一次后立即作废。Bearer token 格式为 `ac1_<credential-id>_<32-byte-secret>`；SQLite 只保存 SHA-256 hash、label、created/last_used/revoked 时间。

Local Auth DTO 固定为：

~~~ts
export const LocalAuthSession = z.object({
  authenticated: z.literal(true),
  kind: z.enum(["trusted", "basic", "bearer"]),
  credential_id: z.string().optional(),
}).strict().meta({ ref: "LocalAuthSession" })
export const LocalPairingInput = z.object({
  label: z.string().trim().min(1).max(80),
}).strict().meta({ ref: "LocalPairingInput" })
export const LocalPairing = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  label: z.string().min(1).max(80),
  expires_at: z.number().int(),
  pairing_url: z.string().url(),
}).strict().meta({ ref: "LocalPairing" })
export const LocalExchangeInput = z.object({
  code: z.string().min(8).max(9),
  label: z.string().trim().min(1).max(80),
}).strict().meta({ ref: "LocalExchangeInput" })
export const LocalCredential = z.object({
  id: z.string().startsWith("lcr_"),
  label: z.string(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
}).strict().meta({ ref: "LocalCredential" })
export const IssuedCredential = z.object({
  credential_id: z.string().startsWith("lcr_"),
  label: z.string(),
  token: z.string().startsWith("ac1_"),
  created_at: z.number().int(),
}).strict().meta({ ref: "IssuedCredential" })

export const LocalAuthUnauthorized = NamedError.create("LocalAuthUnauthorized", z.object({}).strict())
export const LocalAuthForbidden = NamedError.create("LocalAuthForbidden", z.object({}).strict())
export const LocalPairingInvalidOrExpired = NamedError.create("LocalPairingInvalidOrExpired", z.object({}).strict())
~~~

### [M1-S3] 公司领域模型

数据库新增：

- Company：singleton cmp_local，name、data_version=1、default_provider_id、default_model_id、bootstrap_request_id、bootstrap_input_path、时间；
- ApprovalPolicy：以 company_id 为主键，preset 为 autonomous/balanced/strict；
- RepositoryBinding：固定 ID rbd_primary，一家公司唯一、一个 Project 唯一，保存规范化 root_path、default_branch、bootstrap_head_commit、bootstrap_dirty；
- CompanyAgent 扩展 company_id、role_key、lifecycle；
- LocalClientCredential：浏览器凭据哈希。

固定董事会使用确定性 ID board-ceo、board-cto、board-product-lead；role_key 分别为 ceo、cto、product_lead；lifecycle 都是 employee。M1 不写 Agent Home、SOUL、私有记忆或角色 prompt。

### [M1-S4] 原子且幂等的 Bootstrap

POST /company/bootstrap 输入固定为：

~~~ts
export const BootstrapInput = z.object({
  request_id: z.string().uuid(),
  company_name: z.string().trim().min(1).max(80),
  provider_id: ProviderID.zod,
  model_id: ModelID.zod,
  repository_path: z.string().min(1),
  approval_preset: z.enum(["autonomous", "balanced", "strict"]).default("balanced"),
}).strict().meta({ ref: "BootstrapInput" })
~~~

bootstrap 先读取 singleton：若已经存在，只做无副作用的 request/business identity 比较并返回/409，不要求 Provider credential 和 Git 当前仍在线。只有不存在时才在事务前完成以下验证：Provider 已连接、Model 可解析、路径 realpath 成功、Project 探测结果是 git、主仓库路径规范化、branch/head/dirty 状态可读取。随后调用 Database.transaction(callback, { behavior: "immediate" })；callback 再检查一次并发 winner，再插入 Company、Policy、Binding 和三名董事会成员。

首次成功时同时保存 `bootstrap_input_path=path.resolve(raw repository_path)` 和 Binding 的 canonical realpath root。同一个 request_id 只比较 trim 后 company_name、provider_id、model_id、bootstrap_input_path 和 preset：完全一致直接返回 ready，任一字段改变都 409，整个分支不触碰 Provider、realpath 或 Git。使用新 request_id 时比较业务身份；输入绝对路径与 bootstrap_input_path 相同可直接命中，否则仅做 realpath 并与 Binding root 比较，无法解析或 canonical root 不同都 409。业务身份不包含 HEAD/dirty，因此这些事实变化不会制造第二家公司。崩溃发生在事务前时不产生公司；事务提交后响应丢失时，客户端重试可读回同一家公司。

Provider credential 文件和已探测但未绑定的 Project row 是可复用准备数据，不属于“半家公司”。UI draft 只保存 request_id、ID、路径、名称和 preset，不保存 Provider secret。

### [M1-S5] 产品 API 与 SDK

受保护的产品路由：

| Method | Path | operationId | Response |
|---|---|---|---|
| GET | /company | company.current | CompanyState |
| GET | /company/providers | company.providers | CompanyProviderList |
| GET | /company/providers/auth | company.providerAuth | ProviderAuth.Methods |
| PUT | /company/providers/:providerID/credentials | company.providerSet | ProviderConnection |
| DELETE | /company/providers/:providerID/credentials | company.providerRemove | boolean |
| POST | /company/providers/:providerID/oauth/authorize | company.providerOauthAuthorize | ProviderAuth.Authorization |
| POST | /company/providers/:providerID/oauth/callback | company.providerOauthCallback | ProviderConnection |
| POST | /company/repository/inspect | company.repositoryInspect | RepositoryCandidate |
| POST | /company/bootstrap | company.bootstrap | CompanyReadyState |
| GET | /local-auth/session | localAuth.session | LocalAuthSession |
| POST | /local-auth/pairings | localAuth.pair | LocalPairing |
| GET | /local-auth/credentials | localAuth.credentials | LocalCredential[] |
| DELETE | /local-auth/credentials/:id | localAuth.revoke | boolean |
| POST | /local-auth/exchange | localAuth.exchange | IssuedCredential |

ProviderConnection 固定为：

~~~ts
export const CompanyModelOption = z.object({
  model_id: ModelID.zod,
  name: z.string(),
  status: z.enum(["alpha", "beta", "deprecated", "active"]),
  context_window: z.number().int().positive(),
}).strict().meta({ ref: "CompanyModelOption" })

export const CompanyProviderOption = z.object({
  provider_id: ProviderID.zod,
  name: z.string(),
  connected: z.boolean(),
  models: z.array(CompanyModelOption),
}).strict().meta({ ref: "CompanyProviderOption" })

export const CompanyProviderList = z.object({
  providers: z.array(CompanyProviderOption),
  defaults: z.record(z.string(), ModelID.zod),
}).strict().meta({ ref: "CompanyProviderList" })

export const ProviderConnection = z.object({
  provider_id: ProviderID.zod,
  connected: z.literal(true),
  models: z.array(ModelID.zod).min(1),
}).strict().meta({ ref: "ProviderConnection" })
~~~

M1 Company setup 不暴露上游托管产品 `provider_id=opencode` / `opencode-go`；`/company/providers` 在把底层 Provider.ListResult 投影成 CompanyProviderList 时过滤这两个 ID，`/company/providers/auth` 过滤同名 key，直接对任一 provider 的 setup mutation 返回 400 CompanyProviderUnsupported。底层编码 runtime 暂不做全仓符号删除，但新产品首次引导不能要求用户注册上游品牌服务。

CompanyProviderList 是显式 allowlist projection，只返回 provider/model ID、显示名、连接状态、模型状态和 context window；不得把 Provider.Info.key、options、headers、环境变量值或 Auth.Info 回传给 renderer。

这里的 connected 表示本地凭据/配置已被 Provider.Service 成功加载，不宣称已经完成一次远程推理。M1 UI 使用“已配置”文案；真实模型请求能力会在 M2 董事会消息链进入验收。

CompanyState 是 state 字段判别联合；以下 schema 全部从 company/schema.ts 导出并作为 OpenAPI response 的唯一来源：

~~~ts
export const RepositoryCandidate = z.object({
  project_id: z.string(),
  root_path: z.string(),
  default_branch: z.string(),
  bootstrap_head_commit: z.string().nullable(),
  dirty: z.boolean(),
}).strict().meta({ ref: "RepositoryCandidate" })

export const StartSuggestion = z.object({
  kind: z.literal("bootstrap_complete"),
  action: z.literal("open_board"),
}).strict().meta({ ref: "StartSuggestion" })

export const CompanyNeedsBootstrapState = z.object({
  state: z.literal("needs_bootstrap"),
  data_directory: z.string(),
  defaults: z.object({
    company_name: z.literal("Agent Company"),
    approval_preset: z.literal("balanced"),
    board: z.array(BoardMember).length(3),
  }).strict(),
  capabilities: z.object({ board_messages: z.literal(false) }).strict(),
}).strict().meta({ ref: "CompanyNeedsBootstrapState" })

export const CompanyReadyState = z.object({
  state: z.literal("ready"),
  data_directory: z.string(),
  company: z.object({
    id: CompanyID,
    name: z.string(),
    data_version: z.literal(1),
    provider: z.object({
      provider_id: ProviderID.zod,
      model_id: ModelID.zod,
    }).strict(),
    approval_policy: z.object({ preset: ApprovalPreset }).strict(),
    repository: RepositoryCandidate,
    board: z.array(BoardMember).length(3),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  }).strict(),
  start_suggestion: StartSuggestion,
  capabilities: z.object({ board_messages: z.literal(false) }).strict(),
}).strict().meta({ ref: "CompanyReadyState" })

export const CompanyState = z.discriminatedUnion("state", [
  CompanyNeedsBootstrapState,
  CompanyReadyState,
]).meta({ ref: "CompanyState" })

export type CompanyNeedsBootstrapState = z.infer<typeof CompanyNeedsBootstrapState>
export type CompanyReadyState = z.infer<typeof CompanyReadyState>
export type CompanyState = z.infer<typeof CompanyState>
~~~

Ready state 返回真实 company、provider/model、policy、repository、board 和：

~~~json
{
  "start_suggestion": {
    "kind": "bootstrap_complete",
    "action": "open_board"
  },
  "capabilities": {
    "board_messages": false
  }
}
~~~

StartSuggestion 只返回语言无关的 kind/action；WebUI 用 `company.startSuggestion.bootstrapComplete.title/body` 做 locale 映射。`board_messages=false` 时 action 以禁用状态展示并说明 M2 才开放，不发送请求，也不把中文文案持久化进 SQLite/API。

### [M1-S6] 共享 WebUI 首次引导

WebUI 状态为 loading、needs_bootstrap、ready、error、disconnected 和显式 demo。生产和普通开发模式都使用生成 SDK；只有 VITE_AGENTCOMPANY_COMPANY_FIXTURE=true 才进入 M0 fixture。

Desktop preflight 完成目录选择后，产品引导顺序为 Provider → 公司名称与三人董事会预览 → Git 仓库 → 批准预设 → Review/Create。Web 入口先完成浏览器配对，再进入相同引导；其数据目录是只读服务器事实。

Ready 页面沿用 M0 Company Workspace 风格，展示真实公司、三名董事、仓库、模型和策略。它可以显示 start_suggestion 和“连接浏览器”，但当 board_messages=false 时不渲染 composer、消息气泡、Thread、Approval 或 Delivery。

### [M1-S7] TUI 共享语义

删除 onboarding_done 和“两位联合创始人/通用行业模板”的旧 TUI 初始化入口。TUI 调用生成 SDK 的 company.current：

- needs_bootstrap：显示“请先在 Agent Company Desktop 或浏览器完成公司初始化”及 data_directory；
- ready 且 cwd 不在主仓库目录树内：显示绑定仓库路径和重启命令；
- ready 且 cwd 是主仓库或其子目录：进入现有编码 Shell。

TUI 不写 Company、Board 或 Policy，不建设第二套 wizard。

### [M1-S8] Node/Desktop 构建与嵌入 WebUI

packages/control-plane/script/build-node.ts 当前只存在于 .gitignore 覆盖的本地忽略文件中，且引用错误的 @mimo-ai/script；干净 clone 不具备 Desktop 构建链。M1 必须提交可追踪的 Node build script，抽取 migration/WebUI bundle helper，并让 CLI build 与 Node build 都嵌入 packages/app 的生产构建。

Desktop prebuild/build 必须产出可导入的 dist/node/node.js，并把 WebUI/wasm 文件带入 Electron out。浏览器访问 Desktop sidecar 的 / 能得到共享 WebUI，而不是 503。

### [M1-S9] 纵向验收与恢复

必须证明：

1. 干净 Desktop home 完成目录、Provider、三人董事会、Git、balanced 和起始建议；
2. 刷新和 sidecar 重启后读到同一 company/board/repository；
3. 无凭据访问 /company、/global/event、Provider API 均为 401；
4. 配对码一次性、过期拒绝，Bearer 可跨 sidecar 重启，revoke 后立即 401；
5. invalid repo、unconnected provider、concurrent/repeated bootstrap 不产生第二家公司或重复董事；
6. SDK 的 9 个 Company 与 5 个 LocalAuth operation response/error 全部不是 unknown/any；
7. App、Desktop、opencode、SDK 的目标测试、typecheck 和 build 全部通过。

## 明确非目标

- 不持久化董事会消息，不开放 composer，不创建 Channel/Thread/Root Need。
- 不实现项目交付、Worktree、Reviewer、合并或 Approval Card。
- 不创建 Agent Home、private memory、Dream 或人格成长。
- 不迁移旧 OpenCode/AgentCompany 数据。
- 不在 M1 完成 Tray、关窗后台运行、系统通知恢复；这些属于 M4。
- 不把当前 company_project 游戏式执行表改造成新项目模型；M3 会处理交付领域，新 RepositoryBinding 只引用通用 ProjectTable。
- 不做全仓继承符号重命名；新增 public operation、OpenAPI metadata 和所有用户可见品牌必须使用 Agent Company。
- 不在 M1 展开完整品牌视觉探索；本里程碑只完成可发布的中性 AC product mark、浏览器元数据和 Desktop identity，M6 再做精修。

## 选定方案与拒绝方案

| 决策 | 采用 | 拒绝 |
|---|---|---|
| 数据目录 | Server import 前由 host 选定 | Server 启动后动态搬家；临时保存 Provider secret 再迁移 |
| Bootstrap | 外部验证后一次 immediate transaction | 每个 wizard step 各写一张表 |
| 董事会 | 确定性 DB rows，不写身份文件 | 复用旧 cofounder 模板或在 M1 提前建立 Agent Home |
| 浏览器 auth | 一次性码换 hash-backed Bearer | loopback 裸 API、URL 长期 secret、服务端明文 token |
| M1 ready UI | 真实事实 + capability-gated suggestion | 把 fixture 消息、审批和测试结果伪装成业务数据 |
| TUI | 只读同一 Company contract | 保留独立 onboarding_done 初始化器 |

## 组件关系

~~~
Desktop launcher
  └─ companyHome ──> AGENTCOMPANY_HOME ──> Node Control Plane
                                               │
Desktop renderer ── ephemeral Basic ───────────┤
Browser WebUI ── pairing code -> Bearer ───────┤
TUI internal fetch ── trusted app ─────────────┤
                                               v
                                      /company product routes
                                               │
                         ┌─────────────────────┼────────────────────┐
                         v                     v                    v
                  Company Service       Provider/Auth        Project/Git
                         │
                         v
                                       SQLite
~~~

## 推进节奏与完成度口径

以下是单人顺序实施的工程量区间，不把“文件已创建”当成里程碑完成；累计进度只在该阶段的自动 gate 通过后更新。

| 阶段 | Tasks | 预计工程量 | 阶段退出条件 | 累计进度 |
|---|---:|---:|---|---:|
| A. 构建基线 | 1 | 0.5–1 天 | 干净 clone 可构建 Node sidecar，`GET /` 返回共享 WebUI | 10% |
| B. Company 契约 | 2–4 | 3–4 天 | migration、原子 bootstrap、9 个 typed `/company` operations 全绿 | 40% |
| C. 本地安全与 SDK | 5–6 | 2–3 天 | 默认认证、一次性配对、重启凭据、SDK 非 `unknown` | 60% |
| D. 三入口产品化 | 7–10 | 4–6 天 | WebUI 首次引导、真实 ready、Desktop home/品牌、TUI gate | 90% |
| E. 纵向关闭 | 11 | 1–2 天 | 真实 Git E2E、进程重启、手工 Desktop 验收、文档同步 | 100% |

总计约 10.5–16 个工程日，即单人顺序实施约 2–3 周。这是对 implementation-plan.md 原“1–2 周”粗估的显式修订：代码审计确认还必须补齐干净 clone 缺失的 Node build、默认网络认证与浏览器凭据生命周期、全入口产品身份切换，以及真实进程重启/E2E gate；删掉这些工作会直接导致 M1 退出标准不成立。Task 2–6 是不可拆开的契约关键路径；Task 7 与 Task 9 只有在 Task 6 生成 SDK 后才具备稳定输入，且 Task 9 的 icon 生成必须等待 Task 7 提交 canonical SVG。

## 文件结构映射

本里程碑跨越超过 8 个文件，因为它是一条必须同时打通 Control Plane、生成 SDK、共享 WebUI、Desktop host 和 TUI 的纵向切片。每一组仍按单一职责拆分。

### 构建与静态 WebUI

- Create packages/control-plane/script/build-support.ts：迁移和 WebUI 虚拟模块生成。
- Create packages/control-plane/script/build-node.ts：可追踪 Node/Electron server build。
- Modify packages/control-plane/.gitignore：显式放行 build-node.ts。
- Modify packages/control-plane/script/build.ts：复用 helper，恢复默认嵌入 WebUI。
- Modify packages/control-plane/src/server/routes/ui.ts：Agent Company 虚拟模块和静态公开路由。
- Create packages/control-plane/test/script/build-node.test.ts：Node import 与 embedded UI smoke。

### Company 与 Local Auth 领域

- Create packages/control-plane/src/company/schema.ts：M1 DTO、enum、errors。
- Create packages/control-plane/src/company/company.sql.ts：Company、Policy、RepositoryBinding。
- Create packages/control-plane/src/company/company.ts：current/inspect/bootstrap service。
- Create packages/control-plane/src/company/setup-instance.ts：Provider setup 的稳定 Instance context。
- Create packages/control-plane/src/company/index.ts：namespace export。
- Modify packages/control-plane/src/company-agent/company-agent.sql.ts：company/role/lifecycle。
- Create packages/control-plane/src/local-auth/schema.ts：pairing/credential DTO 与 errors。
- Create packages/control-plane/src/local-auth/local-auth.sql.ts：credential hash table。
- Create packages/control-plane/src/local-auth/local-auth.ts：pair/exchange/verify/list/revoke。
- Create packages/control-plane/src/local-auth/index.ts：namespace export。
- Modify packages/control-plane/src/id/id.ts：localCredential prefix；Company/Binding 使用固定 singleton literals。
- Modify packages/control-plane/src/storage/schema.ts：导出新 tables。
- Modify packages/control-plane/src/effect/app-runtime.ts：注入 Company 和 LocalAuth layers。
- Create packages/control-plane/migration/20260713120000_m1_company_bootstrap/migration.sql：增量 schema。
- Create packages/control-plane/test/company/company.test.ts：领域、事务、幂等与恢复。
- Create packages/control-plane/test/local-auth/local-auth.test.ts：token 生命周期。

### HTTP 与 SDK

- Create packages/control-plane/src/server/routes/company.ts：/company 产品路由。
- Create packages/control-plane/src/server/routes/local-auth.ts：public/protected local auth routes。
- Modify packages/control-plane/src/server/routes/global.ts：拆分 public health。
- Modify packages/control-plane/src/server/server.ts：trusted/protected app composition。
- Modify packages/control-plane/src/server/middleware.ts：Basic/Bearer middleware 与错误映射。
- Modify packages/control-plane/src/cli/network.ts：默认认证语义。
- Modify packages/control-plane/src/cli/cmd/serve.ts：输出一次性浏览器 pairing URL。
- Modify packages/control-plane/src/cli/cmd/acp.ts：传递 Listener Basic header。
- Modify packages/control-plane/src/cli/cmd/tui/worker.ts：返回 external listener credentials。
- Modify packages/control-plane/src/cli/cmd/tui/thread.ts：给 external TUI SDK 传 auth header。
- Create packages/control-plane/test/server/company-route.test.ts：Company OpenAPI/route。
- Create packages/control-plane/test/server/network-auth.test.ts：public/protected matrix。
- Create packages/control-plane/test/server/local-auth-route.test.ts：pairing route 权限。
- Modify packages/sdk/js/script/build.ts：Agent Company OpenAPI metadata/生成契约。
- Modify packages/sdk/js/package.json：Agent Company SDK public metadata 与 package-local typecheck。
- Modify packages/sdk/js/src/v2/server.ts：spawned server 的随机密码和 headers。
- Modify packages/sdk/js/src/v2/index.ts：server credential 传给 client。
- Modify packages/sdk/js/src/v2/client.ts：把可见的 server mismatch 错误改为 Agent Company。
- Create packages/sdk/js/src/v2/company-contract.test.ts：编译期非 unknown assertion。
- Regenerate packages/sdk/js/src/v2/gen/*：只由 SDK build script 生成。

### 共享 App

- Create script/generate-agent-company-brand.ts，并修改根 package.json/bun.lock：从唯一 SVG 可复现生成 Browser/Desktop PNG、ICNS 和 ICO。
- Create packages/app/public/agent-company-mark.svg：Browser product mark 的唯一 SVG 源。
- Create packages/app/public/agent-company-icon-180.png：Apple touch icon。
- Create packages/app/public/agent-company-icon-192.png：manifest/notification icon。
- Create packages/app/public/agent-company-icon-512.png：manifest large icon。
- Create packages/app/public/agent-company-theme-preload.js：使用 Agent Company storage key 的同源预加载脚本。
- Replace packages/app/public/site.webmanifest symlink with a regular Agent Company manifest：不再读取 packages/ui 的上游 manifest。
- Delete packages/app/public/oc-theme-preload.js：不保留旧 storage/preload 入口。
- Delete packages/app/public/apple-touch-icon-v3.png、packages/app/public/apple-touch-icon.png、packages/app/public/favicon-96x96-v3.png、packages/app/public/favicon-96x96.png、packages/app/public/favicon-v3.ico、packages/app/public/favicon-v3.svg、packages/app/public/favicon.ico、packages/app/public/favicon.svg：移除上游 favicon 集。
- Delete packages/app/public/social-share-zen.png、packages/app/public/social-share.png、packages/app/public/web-app-manifest-192x192.png、packages/app/public/web-app-manifest-512x512.png：移除上游分享/manifest 图。
- Modify packages/app/index.html、packages/app/public/_headers、packages/app/vite.js、packages/app/vite.config.ts：Agent Company metadata、同源 preload 与 CSP。
- Create packages/app/src/brand-entry.test.ts：title、manifest、icon、preload 与 CSP contract。
- Modify packages/app/src/theme-preload.test.ts：新 key、无 legacy fallback、CSP-safe preload。
- Create packages/app/src/components/connection-auth-gate.tsx：受保护 API 探针和 401 gate。
- Create packages/app/src/pages/company/browser-pairing.tsx：配对码交换。
- Create packages/app/src/pages/company/company-bootstrap.tsx：五阶段 setup。
- Create packages/app/src/pages/company/company-ready.tsx：真实董事会 ready landing。
- Create packages/app/src/pages/company/company-ready.test.tsx：capability gate 与无伪 M2 surface。
- Create packages/app/src/pages/company/company-state.ts：draft/reducer/validation。
- Create packages/app/src/pages/company/company-state.test.ts：状态机测试。
- Create packages/app/src/pages/company/company-data-source.test.ts：SDK adapter 测试。
- Create packages/app/src/utils/server.test.ts：Bearer/Basic header 优先级。
- Modify packages/app/src/pages/company/company-model.ts：M1 discriminated snapshots。
- Modify packages/app/src/pages/company/company-data-source.ts：生成 SDK adapter。
- Modify packages/app/src/pages/company/company-fixture.ts：仅显式 demo。
- Modify packages/app/src/pages/company/index.tsx：按 snapshot 分派。
- Modify packages/app/src/pages/company/workspace.css：setup/ready/pairing 响应式样式。
- Modify packages/app/src/context/server.tsx：Bearer token。
- Modify packages/app/src/context/language.tsx、packages/app/src/context/layout.tsx、packages/app/src/utils/persist.ts、packages/app/src/utils/persist.test.ts：全新 Agent Company storage namespace，无旧 key fallback。
- Modify packages/app/src/utils/server.ts：Bearer 优先、Basic fallback。
- Modify packages/app/src/app.tsx：AuthGate 位于 GlobalSDK 之前。
- Modify packages/app/src/entry.tsx：Agent Company storage/env/notification。
- Modify packages/app/src/context/highlights.tsx：移除上游 OpenCode changelog fetch。
- Modify packages/app/src/hooks/use-providers.ts、packages/app/src/components/dialog-connect-provider.tsx、packages/app/src/components/dialog-custom-provider.tsx、packages/app/src/components/settings-general.tsx、packages/app/src/components/status-popover-body.tsx：隐藏上游托管 provider，移除上游 docs/Zen links。
- Modify packages/app/src/pages/error.tsx、packages/app/src/pages/layout.tsx、packages/app/src/pages/layout/deep-links.ts、packages/app/src/pages/layout/sidebar-items.tsx：Agent Company feedback/deep-link/local icon。
- Modify packages/app/src/env.d.ts：`VITE_AGENTCOMPANY_*`。
- Modify packages/app/src/i18n/ar.ts、br.ts、bs.ts、da.ts、de.ts、en.ts、es.ts、fr.ts、ja.ts、ko.ts、no.ts、pl.ts、ru.ts、th.ts、tr.ts、zh.ts、zht.ts：所有可选 locale 的 Agent Company/config 文案；不伪造 Agent Company Zen。
- Modify packages/ui/src/theme/context.tsx、packages/ui/src/theme/loader.ts：Agent Company storage/style IDs，不读取旧 key。
- Modify packages/ui/src/theme/desktop-theme.schema.json、packages/ui/src/theme/themes/oc-2.json、packages/ui/src/theme/themes/opencode.json：公开 schema/主题显示名不暴露上游品牌；继承的 theme ID 只作为内部实现名保留。

### Desktop

- Create packages/desktop/src/shared/brand.ts：main/builder/scripts 共用的产品身份常量。
- Create packages/desktop/src/shared/brand.test.ts：App ID、协议、图标 magic/hash 与无上游 identity 断言。
- Create packages/desktop/icons/agent-company/source.svg、packages/desktop/icons/agent-company/icon.icns、packages/desktop/icons/agent-company/icon.ico、packages/desktop/icons/agent-company/icon.png、packages/desktop/icons/agent-company/dock.png：同一 AC mark 的跨平台发布资产。
- Create packages/desktop/icons/agent-company/32x32.png、packages/desktop/icons/agent-company/64x64.png、packages/desktop/icons/agent-company/128x128.png、packages/desktop/icons/agent-company/256x256.png、packages/desktop/icons/agent-company/512x512.png：Linux/高 DPI size set。
- Modify packages/desktop/icons/README.md、packages/desktop/scripts/copy-icons.ts：记录唯一源和固定复制 Agent Company icons。
- Create packages/desktop/src/main/company-home.ts：pure home state/validation。
- Create packages/desktop/src/main/company-home.test.ts：路径、launcher state 和 home-before-import 行为。
- Modify packages/desktop/src/main/index.ts：preflight、home-before-import、去旧迁移。
- Modify packages/desktop/src/main/server.ts：显式短期 Basic 和正确 AGENTCOMPANY env。
- Modify packages/desktop/src/main/ipc.ts：launcher state/select home IPC。
- Modify packages/desktop/src/preload/index.ts 和 packages/desktop/src/preload/types.ts：typed launcher API。
- Modify packages/desktop/src/renderer/index.tsx：preflight screen 与 Agent Company globals。
- Modify packages/desktop/src/main/constants.ts、packages/desktop/src/main/windows.ts、packages/desktop/src/main/menu.ts：品牌常量。
- Modify packages/desktop/src/main/store.ts、packages/desktop/src/renderer/i18n/index.ts：Agent Company store/language namespace，无 legacy read。
- Modify packages/desktop/src/main/env.d.ts：直接引用 opencode source types。
- Delete packages/desktop/src/main/migrate.ts：删除旧 Tauri 隐式桥。
- Modify packages/desktop/electron-builder.config.ts、packages/desktop/electron.vite.config.ts、packages/desktop/package.json：App ID、协议、artifact、无 upstream publish。
- Modify packages/desktop/scripts/utils.ts、packages/desktop/scripts/predev.ts：AGENTCOMPANY_CHANNEL。
- Modify packages/desktop/src/renderer/index.html、packages/desktop/src/renderer/loading.html、packages/desktop/src/renderer/env.d.ts：可见品牌/global。
- Modify packages/desktop/src/renderer/i18n/ar.ts、br.ts、bs.ts、da.ts、de.ts、en.ts、es.ts、fr.ts、ja.ts、ko.ts、no.ts、pl.ts、ru.ts、zh.ts、zht.ts：品牌和 agents CLI 文案。

### TUI、E2E 与文档

- Create packages/control-plane/src/cli/cmd/tui/routes/company-entry.ts：pure gate decision。
- Create packages/control-plane/src/cli/cmd/tui/routes/company-entry.test.ts：needs/ready/mismatch。
- Create packages/control-plane/src/cli/cmd/tui/routes/company-setup-required.tsx：只读指引。
- Modify packages/control-plane/src/cli/cmd/tui/app.tsx：以 company.current 替代 KV gate。
- Modify packages/control-plane/src/cli/cmd/tui/feature-plugins/system/org-disband.tsx：移除 onboarding_done 写入。
- Delete packages/control-plane/src/cli/cmd/tui/routes/onboarding/ 下 11 个旧 wizard 文件。
- Modify packages/control-plane/src/cli/cmd/tui/i18n/en.ts、zh.ts、zht.ts：新 gate 文案。
- Create packages/app/e2e/m1-server.ts：真实临时 home/repository server。
- Create packages/app/e2e/company-bootstrap.spec.ts：配对和 bootstrap 纵向路径。
- Modify packages/app/e2e/app-shell.spec.ts：改为匿名 pairing shell，不读取生产 fixture。
- Modify packages/app/playwright.config.ts：同时启动真实 Control Plane 和 Vite。
- Modify packages/app/.gitignore：忽略测试自有 `.artifacts/m1-e2e`。
- Create packages/control-plane/test/company/restart.test.ts：真实进程重启与 Bearer 恢复。
- Modify docs/Agent Company 产品 PRD.md：数据目录技术前置。
- Modify docs/product-design/implementation-plan.md：M1 实施状态和验证证据。
- Modify docs/README.md：索引本计划和 M1 决策。

## Task 1: 修复可追踪的 Node build 与 embedded WebUI

**Covers:** [M1-S8]

**Files:**

- Create: packages/control-plane/script/build-support.ts
- Create: packages/control-plane/script/build-node.ts
- Modify: packages/control-plane/.gitignore
- Modify: packages/control-plane/script/build.ts
- Modify: packages/control-plane/src/server/routes/ui.ts
- Modify: packages/desktop/src/main/env.d.ts
- Modify: packages/desktop/electron.vite.config.ts
- Test: packages/control-plane/test/script/build-node.test.ts

**Interfaces:**

- Produces: loadMigrations(): Promise<Migration[]>、createEmbeddedWebUIBundle(): Promise<string>、dist/node/node.js。
- Produces: virtual module agent-company-web-ui.gen.ts whose default export is Record<string, string>。
- Consumes: packages/app 的 bun run build 和 packages/control-plane/src/node.ts。

- [ ] **Step 1: 写失败的 build contract test**

~~~ts
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")

describe("build-node", () => {
  test("emits a Node-importable server and embedded index", async () => {
    const build = Bun.spawnSync({
      cmd: ["bun", "script/build-node.ts"],
      cwd: root,
      env: { ...process.env, AGENTCOMPANY_DISABLE_MODELS_FETCH: "true" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode).toBe(0)

    await using home = await tmpdir()
    const probe = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        "import('./dist/node/node.js').then(async m => { const r = await m.Server.Default().app.request('/'); if (r.status !== 200) process.exit(2); if (!r.headers.get('content-security-policy')?.includes(\"object-src 'none'\")) process.exit(3) })",
      ],
      cwd: root,
      env: { ...process.env, AGENTCOMPANY_HOME: home.path },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(probe.exitCode).toBe(0)
  }, 120_000)
})
~~~

- [ ] **Step 2: 运行测试并确认当前失败**

Run: bun test test/script/build-node.test.ts

Working directory: packages/control-plane

Expected: FAIL；干净 clone 中 script/build-node.ts 不存在，当前本地忽略版本也会因 @mimo-ai/script 或空 WebUI 失败。

- [ ] **Step 3: 提交 build helper 和 Node entry build**

packages/control-plane/.gitignore 增加精确 negation：

~~~gitignore
script/build-*.ts
!script/build-node.ts
!script/build-support.ts
~~~

build-support.ts 必须导出完整的迁移和 WebUI 生成函数：

~~~ts
import path from "node:path"

export type Migration = { sql: string; timestamp: number; name: string }

export async function loadMigrations(root: string): Promise<Migration[]> {
  return Promise.all(
    (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: path.join(root, "migration") })))
      .map((file) => path.dirname(file))
      .filter((name) => /^\d{14}/.test(name))
      .sort()
      .map(async (name) => {
        const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
        if (!match) throw new Error("Invalid migration directory: " + name)
        return {
          name,
          sql: await Bun.file(path.join(root, "migration", name, "migration.sql")).text(),
          timestamp: Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          ),
        }
      }),
  )
}

export async function createEmbeddedWebUIBundle(root: string) {
  const app = path.join(root, "../app")
  const build = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: app,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await build.exited) !== 0) throw new Error("WebUI build failed")
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(app, "dist") }))).sort()
  const imports = files.map((file, index) => {
    const spec = path.relative(root, path.join(app, "dist", file)).replaceAll("\\", "/")
    return "import file_" + index + " from " + JSON.stringify(spec.startsWith(".") ? spec : "./" + spec) + " with { type: \"file\" };"
  })
  return [
    ...imports,
    "export default {",
    ...files.map((file, index) => "  " + JSON.stringify(file.replaceAll("\\", "/")) + ": file_" + index + ","),
    "};",
  ].join("\n")
}
~~~

build-node.ts 使用 @agents-company/script，且失败时退出非零：

~~~ts
#!/usr/bin/env bun

import path from "node:path"
import { Script } from "@agents-company/script"
import { createEmbeddedWebUIBundle, loadMigrations } from "./build-support"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)
await import("./generate.ts")

const embedded = process.argv.includes("--skip-embed-web-ui")
  ? "export default {};"
  : await createEmbeddedWebUIBundle(root)
const result = await Bun.build({
  target: "node",
  conditions: ["node"],
  tsconfig: "./tsconfig.json",
  entrypoints: ["./src/node.ts", "agent-company-web-ui.gen.ts"],
  outdir: "./dist/node",
  format: "esm",
  splitting: true,
  sourcemap: "external",
  external: ["jsonc-parser", "@lydell/node-pty", "node-gyp"],
  files: { "agent-company-web-ui.gen.ts": embedded },
  define: {
    AGENTCOMPANY_VERSION: JSON.stringify(Script.version),
    AGENTCOMPANY_CHANNEL: JSON.stringify(Script.channel),
    OPENCODE_MIGRATIONS: JSON.stringify(await loadMigrations(root)),
  },
})
if (!result.success) throw new AggregateError(result.logs, "Node build failed")
~~~

在 script/build.ts 复用两个 helper，恢复：

~~~ts
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle(dir)
~~~

UIRoutes 的动态 import 改为 agent-company-web-ui.gen.ts；Desktop env.d.ts 的 type import 改为 ../../../opencode/src/node；electron.vite.config.ts 的 copy hook 复制 dist/node 下所有非 .js/.map 的 build asset，而不只 .wasm。

UIRoutes 给 HTML/asset response 写入 production CSP：script-src 仅 self，object-src none，frame-ancestors none，base-uri none；connect-src 只允许 self 与 loopback http/ws，style-src 允许现有 Solid inline style。Vite dev 由自己的 dev header 配置提供等价策略。

- [ ] **Step 4: 运行目标测试和 Desktop build**

Run: bun test test/script/build-node.test.ts

Working directory: packages/control-plane

Expected: PASS；dist/node/node.js 可由 Node import，GET / 返回 200 HTML。

Run: bun typecheck

Working directory: packages/control-plane

Expected: PASS。

Run: bun run build

Working directory: packages/desktop

Expected: PASS；不再出现 missing script/build-node.ts 或 missing dist/types。

- [ ] **Step 5: Commit**

~~~bash
git add packages/control-plane/.gitignore packages/control-plane/script/build-support.ts packages/control-plane/script/build-node.ts packages/control-plane/script/build.ts packages/control-plane/src/server/routes/ui.ts packages/control-plane/test/script/build-node.test.ts packages/desktop/src/main/env.d.ts packages/desktop/electron.vite.config.ts
git commit -m "build: restore embedded node control plane"
~~~

## Task 2: 建立 M1 schema 与增量迁移

**Covers:** [M1-S2], [M1-S3]

**Files:**

- Create: packages/control-plane/src/company/schema.ts
- Create: packages/control-plane/src/company/company.sql.ts
- Create: packages/control-plane/src/company/index.ts
- Create: packages/control-plane/src/local-auth/schema.ts
- Create: packages/control-plane/src/local-auth/local-auth.sql.ts
- Create: packages/control-plane/src/local-auth/index.ts
- Modify: packages/control-plane/src/company-agent/company-agent.sql.ts
- Modify: packages/control-plane/src/id/id.ts
- Modify: packages/control-plane/src/storage/schema.ts
- Create: packages/control-plane/migration/20260713120000_m1_company_bootstrap/migration.sql
- Test: packages/control-plane/test/company/schema.test.ts

**Interfaces:**

- Produces: CompanyID、ApprovalPreset、AgentLifecycle、BoardRole、BootstrapInput、CompanyProviderList、CompanyState、CompanyReadyState。
- Produces: CompanyTable、ApprovalPolicyTable、RepositoryBindingTable、LocalClientCredentialTable。
- Consumes: ProjectID、ProviderID、ModelID、CompanyAgentTable、Timestamps。

- [ ] **Step 1: 写 schema 失败测试**

~~~ts
import { describe, expect, test } from "bun:test"
import { BootstrapInput, CompanyState } from "../../src/company/schema"

describe("M1 company schema", () => {
  test("defaults policy to balanced and rejects a second repository field", () => {
    const input = BootstrapInput.parse({
      request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
      company_name: "Agent Company",
      provider_id: "openai",
      model_id: "gpt-5",
      repository_path: "/tmp/product",
    })
    expect(input.approval_preset).toBe("balanced")
    expect(BootstrapInput.safeParse({ ...input, repository_paths: ["/tmp/other"] }).success).toBe(false)
  })

  test("ready state always exposes exactly three board roles", () => {
    const parsed = CompanyState.parse({
      state: "ready",
      data_directory: "/tmp/company/data",
      company: {
        id: "cmp_local",
        name: "Agent Company",
        data_version: 1,
        provider: { provider_id: "openai", model_id: "gpt-5" },
        approval_policy: { preset: "balanced" },
        repository: {
          project_id: "project-1",
          root_path: "/tmp/product",
          default_branch: "main",
          bootstrap_head_commit: null,
          dirty: false,
        },
        board: [
          { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["公司目标与最终取舍"] },
          { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["技术方向与工程质量"] },
          { id: "board-product-lead", role: "product_lead", name: "Product Lead", lifecycle: "employee", responsibilities: ["用户价值与验收"] },
        ],
        created_at: 1,
        updated_at: 1,
      },
      start_suggestion: {
        kind: "bootstrap_complete",
        action: "open_board",
      },
      capabilities: { board_messages: false },
    })
    expect(parsed.company.board.map((item) => item.role)).toEqual(["ceo", "cto", "product_lead"])
  })
})
~~~

- [ ] **Step 2: 运行测试确认 schema 尚不存在**

Run: bun test test/company/schema.test.ts

Working directory: packages/control-plane

Expected: FAIL with Cannot find module ../../src/company/schema。

- [ ] **Step 3: 定义 schema 和 Drizzle tables**

company/schema.ts 至少导出以下稳定定义；所有 object 使用 strict()，防止多仓库字段被静默接受：

~~~ts
import z from "zod"
import { ModelID, ProviderID } from "@/provider/schema"

export const CompanyID = z.string().startsWith("cmp_").brand<"CompanyID">().meta({ ref: "CompanyID" })
export type CompanyID = z.infer<typeof CompanyID>
export const ApprovalPreset = z.enum(["autonomous", "balanced", "strict"]).meta({ ref: "ApprovalPreset" })
export const AgentLifecycle = z.enum(["candidate", "assigned", "employee", "archived"])
export const BoardRole = z.enum(["ceo", "cto", "product_lead"])
export const BoardMember = z.object({
  id: z.string(),
  role: BoardRole,
  name: z.string(),
  lifecycle: z.literal("employee"),
  responsibilities: z.array(z.string()),
}).strict().meta({ ref: "BoardMember" })
export const BootstrapInput = z.object({
  request_id: z.string().uuid(),
  company_name: z.string().trim().min(1).max(80),
  provider_id: ProviderID.zod,
  model_id: ModelID.zod,
  repository_path: z.string().min(1),
  approval_preset: ApprovalPreset.default("balanced"),
}).strict().meta({ ref: "BootstrapInput" })
~~~

company.sql.ts 的字段名全部 snake_case：

~~~ts
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { CompanyID } from "./schema"

export const CompanyTable = sqliteTable("company", {
  id: text().$type<CompanyID>().primaryKey(),
  name: text().notNull(),
  data_version: integer().notNull(),
  default_provider_id: text().notNull(),
  default_model_id: text().notNull(),
  bootstrap_request_id: text().notNull(),
  bootstrap_input_path: text().notNull(),
  ...Timestamps,
}, (table) => [
  uniqueIndex("company_bootstrap_request_idx").on(table.bootstrap_request_id),
])

export const ApprovalPolicyTable = sqliteTable("approval_policy", {
  company_id: text().$type<CompanyID>().primaryKey().references(() => CompanyTable.id, { onDelete: "cascade" }),
  preset: text().notNull(),
  ...Timestamps,
})

export const RepositoryBindingTable = sqliteTable("repository_binding", {
  id: text().primaryKey(),
  company_id: text().$type<CompanyID>().notNull().references(() => CompanyTable.id, { onDelete: "cascade" }),
  project_id: text().$type<ProjectID>().notNull().references(() => ProjectTable.id),
  root_path: text().notNull(),
  default_branch: text().notNull(),
  bootstrap_head_commit: text(),
  bootstrap_dirty: integer({ mode: "boolean" }).notNull(),
  ...Timestamps,
}, (table) => [
  uniqueIndex("repository_binding_company_idx").on(table.company_id),
  uniqueIndex("repository_binding_project_idx").on(table.project_id),
])
~~~

CompanyAgentTable 增加 nullable company_id/role_key 以容纳现有未绑定 row，lifecycle 默认 employee，并建立 company_id + role_key unique index。LocalClientCredentialTable 使用 id 主键、token_hash unique、label、time_last_used、time_revoked 和 Timestamps；Identifier prefixes 增加 `localCredential: "lcr"`，Company 与 RepositoryBinding 继续使用本计划锁定的确定性 singleton ID，不为它们生成随机 ID。

- [ ] **Step 4: 写并验证精确 migration**

migration.sql 只执行 CREATE TABLE、ALTER TABLE ADD COLUMN、CREATE INDEX，不删除或重命名旧表，内容固定为：

~~~sql
CREATE TABLE company (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  data_version integer NOT NULL,
  default_provider_id text NOT NULL,
  default_model_id text NOT NULL,
  bootstrap_request_id text NOT NULL,
  bootstrap_input_path text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX company_bootstrap_request_idx ON company(bootstrap_request_id);
--> statement-breakpoint
CREATE TABLE approval_policy (
  company_id text PRIMARY KEY NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  preset text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE repository_binding (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id),
  root_path text NOT NULL,
  default_branch text NOT NULL,
  bootstrap_head_commit text,
  bootstrap_dirty integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_binding_company_idx ON repository_binding(company_id);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_binding_project_idx ON repository_binding(project_id);
--> statement-breakpoint
ALTER TABLE company_agent ADD company_id text REFERENCES company(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE company_agent ADD role_key text;
--> statement-breakpoint
ALTER TABLE company_agent ADD lifecycle text DEFAULT 'employee' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX company_agent_company_role_idx ON company_agent(company_id, role_key);
--> statement-breakpoint
CREATE TABLE local_client_credential (
  id text PRIMARY KEY NOT NULL,
  token_hash text NOT NULL,
  label text NOT NULL,
  time_last_used integer,
  time_revoked integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX local_client_credential_hash_idx ON local_client_credential(token_hash);
~~~

Run: bun script/check-migrations.ts

Working directory: packages/control-plane

Expected: Migrations are up to date。

Run: bun test test/company/schema.test.ts

Working directory: packages/control-plane

Expected: PASS。

- [ ] **Step 5: Commit**

~~~bash
git add packages/control-plane/src/company/schema.ts packages/control-plane/src/company/company.sql.ts packages/control-plane/src/company/index.ts packages/control-plane/src/local-auth/schema.ts packages/control-plane/src/local-auth/local-auth.sql.ts packages/control-plane/src/local-auth/index.ts packages/control-plane/src/company-agent/company-agent.sql.ts packages/control-plane/src/id/id.ts packages/control-plane/src/storage/schema.ts packages/control-plane/migration/20260713120000_m1_company_bootstrap/migration.sql packages/control-plane/test/company/schema.test.ts
git commit -m "feat(company): add M1 bootstrap schema"
~~~

## Task 3: 实现 Company bootstrap application service

**Covers:** [M1-S3], [M1-S4]

**Files:**

- Create: packages/control-plane/src/company/company.ts
- Create: packages/control-plane/src/company/setup-instance.ts
- Modify: packages/control-plane/src/company/index.ts
- Modify: packages/control-plane/src/effect/app-runtime.ts
- Test: packages/control-plane/test/company/company.test.ts

**Interfaces:**

- Consumes: Project.Service.fromDirectory(path)、Git.Service.defaultBranch/branch/hasHead/run/status、Provider.Service.list/getModel。
- Produces: Company.Service.current()、inspectRepository(path)、bootstrap(input)。
- Produces: CompanyAlreadyInitialized、CompanyRepositoryNotGit、CompanyProviderUnsupported、CompanyProviderNotConnected、CompanyModelNotAvailable named errors。

- [ ] **Step 1: 写失败的 transaction/idempotency tests**

测试必须使用真实临时 Git repo 和真实 SQLite，不 mock Project/Git/Database：

~~~ts
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Company } from "../../src/company"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

const providerConfig = {
  provider: {
    "m1-test": {
      name: "M1 Test",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "test-model": {
          name: "Test Model",
          tool_call: true,
          limit: { context: 8_000, output: 2_000 },
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}

async function bootstrap(path: string, companyName = "Agent Company") {
  return Instance.provide({
    directory: path,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const providers = yield* Provider.Service
          const connected = Object.values(yield* providers.list())
          const provider = connected.find((item) => item.id === "m1-test")
          if (!provider) throw new Error("Test provider was not connected")
          const model = Object.values(provider.models)[0]
          if (!model) throw new Error("Test provider had no models")
          const company = yield* Company.Service
          return yield* company.bootstrap({
            request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
            company_name: companyName,
            provider_id: provider.id,
            model_id: model.id,
            repository_path: path,
            approval_preset: "balanced",
          })
        }),
      ),
  })
}

describe("Company bootstrap", () => {
  test("creates one company, one binding, and exactly three board members", async () => {
    await using repo = await tmpdir({
      git: true,
      config: providerConfig,
    })
    const result = await bootstrap(repo.path)
    expect(result.state).toBe("ready")
    if (result.state !== "ready") throw new Error("Expected ready state")
    expect(result.company.board).toHaveLength(3)
    expect(result.company.repository.root_path).toBe(repo.path)
  })

  test("same request is idempotent and changed request conflicts", async () => {
    await using repo = await tmpdir({
      git: true,
      config: providerConfig,
    })
    const first = await bootstrap(repo.path)
    const second = await bootstrap(repo.path)
    expect(second).toEqual(first)
    await expect(bootstrap(repo.path, "Other")).rejects.toMatchObject({ name: "CompanyAlreadyInitialized" })
  })
})
~~~

测试通过真实 Config/Provider.Service 解析一个完全在测试配置中声明的 openai-compatible provider/model，避免 models.dev/网络依赖；不会发起模型请求，也不在测试里复制 Company 的验证逻辑。provider route 与纵向 E2E 另行覆盖内建 OpenAI credential 路径。

- [ ] **Step 2: 运行测试确认 service 尚不存在**

Run: bun test test/company/company.test.ts

Working directory: packages/control-plane

Expected: FAIL with Company.Service is undefined。

- [ ] **Step 3: 实现 repository inspection 和稳定 setup Instance**

setup-instance.ts 固定使用 Global.Path.data/bootstrap-runtime，并通过 Instance.provide + InstanceBootstrap 运行 Provider/Plugin 相关 Effect；credential 更新后调用 Instance.dispose 使下一次 provider list 重新加载真实 Auth 状态。

RepositoryCandidate 必须由同一 inspectRepository 函数供 preview 与 bootstrap 复用：

~~~ts
const inspectRepository = Effect.fn("Company.inspectRepository")(function* (input: string) {
  const root = yield* Effect.tryPromise(() => fs.realpath(input))
  const project = yield* projectService.fromDirectory(root)
  if (project.project.vcs !== "git" || project.project.id === ProjectID.global) {
    return yield* new CompanyRepositoryNotGit({ path: root })
  }
  const branch = yield* gitService.defaultBranch(project.project.worktree)
  const current = yield* gitService.branch(project.project.worktree)
  const hasHead = yield* gitService.hasHead(project.project.worktree)
  const head = hasHead
    ? (yield* gitService.run(["rev-parse", "HEAD"], { cwd: project.project.worktree })).text().trim()
    : null
  return {
    project_id: project.project.id,
    root_path: project.project.worktree,
    default_branch: branch?.name ?? current ?? "main",
    bootstrap_head_commit: head || null,
    dirty: (yield* gitService.status(project.project.worktree)).length > 0,
  }
})
~~~

- [ ] **Step 4: 实现一次事务的 bootstrap**

事务外先做 existing fast path；事务内仍先查 CompanyTable。不存在时插入确定性 rows（Company=cmp_local、Binding=rbd_primary）；并发 winner 已存在时使用与事务外完全相同的 pure identity comparison helper，传入事务前已解析好的 canonical candidate，不能在同步 transaction callback 中再次 realpath 或复制第二套规则。现有公司同 request_id fast path 不调用 Provider、realpath 或 Git；因此 credential 暂时移除、仓库目录暂时改名、仓库变 dirty 或 HEAD 前进后，同一 bootstrap retry 仍返回原 snapshot。三名董事定义为 readonly 常量，不能由 UI body 覆盖：

~~~ts
export const BOARD = [
  { id: "board-ceo", role: "ceo", name: "CEO", reports_to: null, responsibilities: ["公司目标与最终取舍"] },
  { id: "board-cto", role: "cto", name: "CTO", reports_to: "board-ceo", responsibilities: ["技术方向与工程质量"] },
  { id: "board-product-lead", role: "product_lead", name: "Product Lead", reports_to: "board-ceo", responsibilities: ["用户价值与验收"] },
] as const
~~~

核心写入顺序必须是 Company → Policy → Binding → Board，全部位于：

~~~ts
Database.transaction((tx) => {
  tx.insert(CompanyTable).values(company).run()
  tx.insert(ApprovalPolicyTable).values(policy).run()
  tx.insert(RepositoryBindingTable).values(binding).run()
  tx.insert(CompanyAgentTable).values(
    BOARD.map((member) => ({
      id: member.id,
      company_id: company.id,
      role_key: member.role,
      lifecycle: "employee",
      name: member.name,
      org_layer: "board",
      reports_to: member.reports_to,
      responsibilities: JSON.stringify(member.responsibilities),
    })),
  ).run()
}, { behavior: "immediate" })
~~~

Provider/Model 与 Git 验证必须在此 transaction 之前完成；transaction callback 保持同步。binding.bootstrap_dirty 保存创建时 inspect 的快照，current() 不因仓库暂时离线而把完整公司降级为损坏状态。current() 用 join/query 组装 CompanyState，并验证 Company row 恰好一个且 ID 为 cmp_local、Policy/Binding 各一个、board roles 恰好为三个；任一基数或引用异常都抛 CompanyCorruptState，不能选择第一行或静默补 fixture。

- [ ] **Step 5: 运行领域测试与 typecheck**

Run: bun test test/company/company.test.ts

Working directory: packages/control-plane

Expected: PASS，包括 invalid git、unconnected provider、same retry、credential 移除/仓库暂时改名/HEAD 改变后的 same retry、复用 request_id 改 payload、new request alias 到同一 canonical root、concurrent calls 和 transaction failure 后零 Company row。

Run: bun typecheck

Working directory: packages/control-plane

Expected: PASS。

- [ ] **Step 6: Commit**

~~~bash
git add packages/control-plane/src/company/company.ts packages/control-plane/src/company/setup-instance.ts packages/control-plane/src/company/index.ts packages/control-plane/src/effect/app-runtime.ts packages/control-plane/test/company/company.test.ts
git commit -m "feat(company): add atomic company bootstrap"
~~~

## Task 4: 发布完整的 /company HTTP contract

**Covers:** [M1-S4], [M1-S5]

**Files:**

- Create: packages/control-plane/src/server/routes/company.ts
- Modify: packages/control-plane/src/server/server.ts
- Modify: packages/control-plane/src/server/middleware.ts
- Modify: packages/control-plane/src/server/error.ts
- Test: packages/control-plane/test/server/company-route.test.ts

**Interfaces:**

- Consumes: Company.Service、CompanySetupInstance.provide、Auth.Service、Config.Service、ModelsDev.get、Provider.Service、ProviderAuth.Service。
- Produces: M1-S5 表中 9 个 /company operations，全部有 resolver(...) success schema 和 errors(...)。
- Produces: namedErrorResponse(schemas) OpenAPI helper；ErrorMiddleware 对 Company named errors 的 400/409/500 映射。

- [ ] **Step 1: 写失败的 raw HTTP tests**

~~~ts
import { afterEach, describe, expect, test } from "bun:test"
import { CompanyProviderList } from "../../src/company/schema"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Server.Default().app.request("/company/providers/openai/credentials", { method: "DELETE" })
  await resetDatabase()
})

describe("/company", () => {
  test("returns typed needs_bootstrap state", async () => {
    const response = await Server.Default().app.request("/company")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: "needs_bootstrap",
      defaults: {
        company_name: "Agent Company",
        approval_preset: "balanced",
      },
      capabilities: { board_messages: false },
    })
  })

  test("rejects non-git repository inspection with a product error", async () => {
    await using directory = await tmpdir()
    const response = await Server.Default().app.request("/company/repository/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository_path: directory.path }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ name: "CompanyRepositoryNotGit" })
  })

  test("returns a strict provider projection without secrets or upstream Zen", async () => {
    const app = Server.Default().app
    const before = CompanyProviderList.parse(await (await app.request("/company/providers")).json())
    expect(before.providers.some((provider) => provider.provider_id === "openai" && !provider.connected)).toBe(true)
    expect(
      (
        await app.request("/company/providers/openai/credentials", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key: "super-secret-provider-key" }),
        })
      ).status,
    ).toBe(200)
    const response = await app.request("/company/providers")
    const providers = CompanyProviderList.parse(await response.json())
    expect(JSON.stringify(providers)).not.toContain("super-secret-provider-key")
    expect(providers.providers.some((provider) => provider.provider_id === "openai" && provider.connected)).toBe(true)
    expect(providers.providers.some((provider) => ["opencode", "opencode-go"].includes(provider.provider_id))).toBe(false)
  })
})
~~~

- [ ] **Step 2: 运行测试确认 route 404**

Run: bun test test/server/company-route.test.ts

Working directory: packages/control-plane

Expected: FAIL；GET /company 当前落入 UI/404，JSON 不符合 CompanyState。

- [ ] **Step 3: 实现 route group 与 Provider setup adapter**

route 必须挂在 Control Plane 的 global product API，不能放进 InstanceRoutes，也不能要求浏览器提供 directory query。Provider 相关 handler 内部调用 CompanySetupInstance.provide：

~~~ts
export const CompanyRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "company.current",
        summary: "Get the local company bootstrap state",
        responses: {
          200: {
            description: "Current company state",
            content: { "application/json": { schema: resolver(Company.State) } },
          },
          ...errors(500),
        },
      }),
      async (c) => {
        const state = await AppRuntime.runPromise(Company.Service.use((service) => service.current()))
        return c.json(state)
      },
    )
)
~~~

其余八个 operation 使用同一 pattern，并满足：

- credentials body 是 Auth.Info.zod；secret 绝不进入 response/log；
- providers list 复用现有 ProviderRoutes 的事实语义：从 ModelsDev.get 取得可选全集，应用 Config enabled/disabled，再叠加 Provider.Service.list 的已连接实例；不能只返回 connected map，否则干净环境没有 Provider 可选；
- repository inspect body 是 strict 的 { repository_path: string }；
- bootstrap body 是 BootstrapInput；
- API credential PUT/DELETE 与 OAuth callback 写入 Auth 后都 dispose setup Instance，再 re-enter 同一个稳定 setup directory 读取新 Provider 状态并返回 ProviderConnection/boolean；OAuth authorize 到 callback 之间不 dispose，确保 pending OAuth state 仍在同一 cached Instance；
- OAuth authorize 对不存在或非 oauth 的 method index 返回 400，不能用 undefined 充当 200 response；
- ProviderConnection 固定为 { provider_id, connected: true, models: string[] }；
- Company setup adapter 统一拒绝 provider_id=opencode/opencode-go，并在 list/auth response 中过滤它们；route test 断言它们不会出现在首次引导；
- CompanyAlreadyInitialized 返回 409；
- CompanyRepositoryNotGit、CompanyProviderUnsupported、CompanyProviderNotConnected、CompanyModelNotAvailable 返回 400；
- schema corruption 返回 500 且不返回 SQLite row 原文。

不能把现有 `errors(400/409)` 直接套给 Company：当前 400 schema 是含 any 的 validator envelope，409 描述也是 Session 专用，都与运行时 NamedError 不同。server/error.ts 新增严格的 ProductValidationError（`{ name, data: { issues: { path: string[], message: string }[] } }`）、把 Standard Schema issues 投影成该 shape 的 productValidationHook，以及接受非空 Zod schema tuple 的 `namedErrorResponse(description, schemas)`。所有 M1 param/json validator 都传入这个 hook；每个 Company operation 按实际错误集合声明 ProductValidationError 与业务 400/409/500，500 至少覆盖 CompanyCorruptState 与稳定的 UnknownError shape。ErrorMiddleware 的响应必须能被对应声明 parse；Task 5 在引入 network/trusted mode 时再把 network UnknownError 消息收敛为稳定文案。

- [ ] **Step 4: 增加 OpenAPI response coverage test**

~~~ts
test("declares non-empty schemas for every M1 company operation", async () => {
  const spec = await Server.openapi()
  const operations = [
    { method: "get", path: "/company", statuses: ["200", "500"] },
    { method: "get", path: "/company/providers", statuses: ["200", "500"] },
    { method: "get", path: "/company/providers/auth", statuses: ["200", "500"] },
    { method: "put", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "500"] },
    { method: "delete", path: "/company/providers/{providerID}/credentials", statuses: ["200", "400", "500"] },
    { method: "post", path: "/company/providers/{providerID}/oauth/authorize", statuses: ["200", "400", "500"] },
    { method: "post", path: "/company/providers/{providerID}/oauth/callback", statuses: ["200", "400", "500"] },
    { method: "post", path: "/company/repository/inspect", statuses: ["200", "400", "500"] },
    { method: "post", path: "/company/bootstrap", statuses: ["200", "400", "409", "500"] },
  ] as const
  for (const item of operations) {
    const operation = spec.paths?.[item.path]?.[item.method]
    expect(operation).toBeDefined()
    item.statuses.map((status) =>
      expect(operation?.responses?.[status]?.content?.["application/json"]?.schema).toBeDefined(),
    )
  }
})
~~~

Run: bun test test/server/company-route.test.ts

Working directory: packages/control-plane

Expected: PASS；干净 Auth 仍能列出可配置 OpenAI、credential mutation 后同一 route 立即显示 connected，且不会返回 secret 或上游托管 provider。

- [ ] **Step 5: Commit**

~~~bash
git add packages/control-plane/src/server/routes/company.ts packages/control-plane/src/server/server.ts packages/control-plane/src/server/middleware.ts packages/control-plane/src/server/error.ts packages/control-plane/test/server/company-route.test.ts
git commit -m "feat(server): expose typed company bootstrap API"
~~~

## Task 5: 实现网络默认认证与浏览器凭据生命周期

**Covers:** [M1-S2], [M1-S5], [M1-S9]

**Files:**

- Create: packages/control-plane/src/local-auth/local-auth.ts
- Create: packages/control-plane/src/server/routes/local-auth.ts
- Modify: packages/control-plane/src/local-auth/index.ts
- Modify: packages/control-plane/src/effect/app-runtime.ts
- Modify: packages/control-plane/src/server/routes/company.ts
- Modify: packages/control-plane/src/server/routes/global.ts
- Modify: packages/control-plane/src/server/server.ts
- Modify: packages/control-plane/src/server/middleware.ts
- Modify: packages/control-plane/src/cli/network.ts
- Modify: packages/control-plane/src/cli/cmd/serve.ts
- Modify: packages/control-plane/src/cli/cmd/acp.ts
- Modify: packages/control-plane/src/cli/cmd/tui/worker.ts
- Modify: packages/control-plane/src/cli/cmd/tui/thread.ts
- Test: packages/control-plane/test/local-auth/local-auth.test.ts
- Test: packages/control-plane/test/server/network-auth.test.ts
- Test: packages/control-plane/test/server/local-auth-route.test.ts

**Interfaces:**

- Produces: LocalAuth.Service.createPairing/exchange/verify/list/revoke。
- Produces: Server.AuthMode、Server.ListenOptions、Listener.credentials。
- Produces: authorization(credentials): string，供 ACP/TUI/CLI 复用。
- Consumes: LocalClientCredentialTable、AppRuntime、node:crypto。

- [ ] **Step 1: 写失败的 credential lifecycle tests**

~~~ts
import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { LocalAuth } from "../../src/local-auth"
import { LocalClientCredentialTable } from "../../src/local-auth/local-auth.sql"
import { Database } from "../../src/storage"
import { resetDatabase } from "../fixture/db"

afterEach(resetDatabase)

describe("LocalAuth", () => {
  test("issues one token, stores no plaintext, and revokes it", async () => {
    const pairing = await AppRuntime.runPromise(
      LocalAuth.Service.use((service) => service.createPairing({ label: "Chrome on this Mac" })),
    )
    const issued = await AppRuntime.runPromise(
      LocalAuth.Service.use((service) => service.exchange({ code: pairing.code, label: pairing.label })),
    )
    expect(issued.token).toStartWith("ac1_")
    const stored = Database.use((db) => db.select().from(LocalClientCredentialTable).get())
    expect(stored?.token_hash).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(issued.token.slice(issued.token.lastIndexOf("_") + 1))
    expect(
      await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.verify(issued.token))),
    ).toMatchObject({ kind: "bearer", credential_id: issued.credential_id })
    await expect(
      AppRuntime.runPromise(LocalAuth.Service.use((service) => service.exchange({ code: pairing.code, label: pairing.label }))),
    ).rejects.toMatchObject({ name: "LocalPairingInvalidOrExpired" })
    await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.revoke(issued.credential_id)))
    expect(await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.verify(issued.token)))).toBeUndefined()
  })
})
~~~

- [ ] **Step 2: 写失败的 public/protected route matrix**

~~~ts
import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("network authentication", () => {
  test("protects data while keeping health and WebUI public", async () => {
    const built = Server.create({
      auth: { mode: "network", basic: { username: "agentcompany", password: "secret" } },
    })
    expect((await built.app.request("/global/health")).status).toBe(200)
    expect((await built.app.request("/")).status).not.toBe(401)
    expect((await built.app.request("/company")).status).toBe(401)
    expect((await built.app.request("/global/event")).status).toBe(401)
    expect(
      (
        await built.app.request("/company", {
          headers: { authorization: "Basic " + btoa("agentcompany:secret") },
        })
      ).status,
    ).toBe(200)
  })
})
~~~

Run: bun test test/local-auth/local-auth.test.ts test/server/network-auth.test.ts test/server/local-auth-route.test.ts

Working directory: packages/control-plane

Expected: FAIL；LocalAuth service、Server.create auth option 和 routes 尚不存在。

- [ ] **Step 3: 实现 LocalAuth service**

使用 node:crypto 以兼容 Bun 与 Electron Node engine：

~~~ts
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const pairings = new Map<string, { label: string; expires_at: number }>()

function pairingCode() {
  const bytes = randomBytes(8)
  const raw = Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length]).join("")
  return raw.slice(0, 4) + "-" + raw.slice(4)
}

function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex")
}
~~~

createPairing 删除过期 map entries 后创建不与现有 challenge 冲突的 5 分钟 code，service 返回内部 PairingChallenge（code/label/expires_at）；route 只从已通过 Basic 认证请求的 `c.req.url` 取实际 listener origin，再添加 `/?pair=<code>` 并投影为 public LocalPairing，绝不信任 HTTP `Origin` header 或 body 传入的 URL。exchange 先规范化大写/连字符，验证成功后创建 lcr_ ID 和 32-byte secret，在 transaction 中插入 token_hash；成功写入后删除 pairing 并返回一次明文。map 检查、同步 transaction 和删除之间不得 yield，并用 concurrent exchange test 证明同一码只有一个成功。verify 从 token 最后一个 `_` 分隔 secret，保留 `lcr_` 作为 credential ID 的一部分，查询未 revoked row、用 timingSafeEqual 比较固定长度 SHA-256 digest，并更新 time_last_used。

list 只返回 id/label/timestamps/revoked，不返回 token_hash；revoke 只写 time_revoked，保持审计事实。

- [ ] **Step 4: 拆分 public shell 与 protected API**

Server 类型固定为：

~~~ts
export type BasicCredentials = { username: string; password: string }
export type AuthMode =
  | { mode: "trusted" }
  | { mode: "network"; basic: BasicCredentials }

export type Listener = {
  hostname: string
  port: number
  url: URL
  credentials?: BasicCredentials
  stop: (close?: boolean) => Promise<void>
}
~~~

Server.Default() 调用 create({ auth: { mode: "trusted" } })。listen() 在 noAuth=true 时 trusted；否则解析显式 auth/env/随机密码，调用 protected create，并把 credentials 返回给调用者。

App composition 顺序必须为：

1. common error/cors/logger/compression；
2. public GET /global/health；
3. public POST /local-auth/exchange；
4. protected API sub-app，AuthMiddleware(auth) 位于所有 data routes、SSE、/doc 与 OpenAPI spec 之前；
5. public UIRoutes 最后挂载。

AuthMiddleware 成功后设置 localAuth context 为 trusted/basic/bearer。Basic 把 expected/provided credential material 各自做 SHA-256 后再用 timingSafeEqual，避免不同长度输入抛异常；Bearer 调用 LocalAuth.verify。401 响应 body 固定为 LocalAuthUnauthorized、包含 WWW-Authenticate，但不区分“token 不存在”和“已 revoked”；authenticated Bearer 调用 Basic-only route 时返回 typed LocalAuthForbidden 403。ErrorMiddleware 接收 AuthMode：trusted app 保留现有进程内诊断，network app 的未知 500 只回传稳定 “Internal server error”，完整 stack 仅写 server log。

删除通用 `?auth_token=` → Basic header 兼容入口，凭据不得进入 URL/history/log；只保留现有 `PTY_CONNECT_TICKET_QUERY` 的专用一次性 websocket ticket 例外，因为 ticket 本身由受保护 API 签发并由 PTY handler 校验。CorsMiddleware 删除 `opencode.ai` 与旧 Tauri origin 放行，仅接受 localhost/127.0.0.1 WebUI、Desktop 显式传入的 `ac://renderer` 和 operator 明确配置的 cors origin。

- [ ] **Step 5: 实现 protected credential routes 与 caller propagation**

local-auth route 规则：

- GET /session：任意 authenticated identity，返回 kind 和 bearer credential_id；
- POST /pairings：只允许 basic；
- GET /credentials、DELETE /credentials/:id：只允许 basic；
- POST /exchange：public，但错误统一 LocalPairingInvalidOrExpired。

LocalAuth 的 param/json validator 复用 Task 4 productValidationHook；local-auth-route.test.ts 用 malformed body 证明运行时 400 可被 ProductValidationError parse，并从 Server.openapi() 检查上述 5 个 operation 的 200 schema 均非空，session 声明 401，pair/list/revoke 声明 401/403，exchange 声明 400，且每个 JSON error response 都有 schema；同一测试遍历 9 个 Company operation，确认 Task 4 的原有 error schema 仍在并统一新增 typed 401。不能把 LocalAuth/Company 的认证 OpenAPI 完整性推迟到 SDK 生成时才发现。

CLI/ACP/TUI 不得丢失新凭据：

~~~ts
export function authorization(credentials: BasicCredentials) {
  return "Basic " + Buffer.from(credentials.username + ":" + credentials.password).toString("base64")
}
~~~

- ServeCommand 不再因“非 loopback 且没设 env password”拒绝启动，因为 listen 会生成随机凭据；启动后用 Listener.credentials 请求 POST /local-auth/pairings，只向终端打印 pairing_url，不打印自动生成密码。显式 --no-auth 时不创建 pairing，并打印 unauthenticated diagnostic warning；
- ACP create client 时加入 Authorization；
- external TUI worker RPC 返回 url、username、password，thread.ts 把 Authorization 放进 SDKProvider headers；
- --no-auth 帮助文案改成“disable all authentication (DANGEROUS)”，默认 false。

- [ ] **Step 6: 运行 auth tests**

Run: bun test test/local-auth/local-auth.test.ts test/server/network-auth.test.ts test/server/local-auth-route.test.ts

Working directory: packages/control-plane

Expected: PASS，包括 expired、one-time、wrong code、Bearer restart lookup、revoke、Basic-only management、SSE 401、URL auth_token 被拒绝、旧 opencode/Tauri CORS origin 被拒绝和显式 noAuth。

Run: bun typecheck

Working directory: packages/control-plane

Expected: PASS。

- [ ] **Step 7: Commit**

~~~bash
git add packages/control-plane/src/local-auth/local-auth.ts packages/control-plane/src/local-auth/index.ts packages/control-plane/src/effect/app-runtime.ts packages/control-plane/src/server/routes/local-auth.ts packages/control-plane/src/server/routes/company.ts packages/control-plane/src/server/routes/global.ts packages/control-plane/src/server/server.ts packages/control-plane/src/server/middleware.ts packages/control-plane/src/cli/network.ts packages/control-plane/src/cli/cmd/serve.ts packages/control-plane/src/cli/cmd/acp.ts packages/control-plane/src/cli/cmd/tui/worker.ts packages/control-plane/src/cli/cmd/tui/thread.ts packages/control-plane/test/local-auth/local-auth.test.ts packages/control-plane/test/server/network-auth.test.ts packages/control-plane/test/server/local-auth-route.test.ts
git commit -m "feat(auth): secure local control plane with browser pairing"
~~~

## Task 6: 生成 M1 SDK 并锁定非 unknown response

**Covers:** [M1-S5], [M1-S8], [M1-S9]

**Files:**

- Modify: packages/control-plane/src/server/server.ts
- Modify: packages/control-plane/src/server/routes/control/index.ts
- Modify: packages/sdk/js/script/build.ts
- Modify: packages/sdk/js/package.json
- Modify: packages/sdk/js/src/v2/server.ts
- Modify: packages/sdk/js/src/v2/index.ts
- Modify: packages/sdk/js/src/v2/client.ts
- Create: packages/sdk/js/src/v2/company-contract.test.ts
- Regenerate: packages/sdk/js/src/v2/gen/client/*
- Regenerate: packages/sdk/js/src/v2/gen/core/*
- Regenerate: packages/sdk/js/src/v2/gen/sdk.gen.ts
- Regenerate: packages/sdk/js/src/v2/gen/types.gen.ts

**Interfaces:**

- Consumes: Server.openapi() 和所有 M1 operationId。
- Produces: sdk.company.current/providers/providerAuth/providerSet/providerRemove/providerOauthAuthorize/providerOauthCallback/repositoryInspect/bootstrap。
- Produces: sdk.localAuth.session/pair/credentials/revoke/exchange。
- Produces: createOpencodeServer() 返回 url、username、password；createOpencode() 自动给 client 配置 Basic header。

- [ ] **Step 1: 写编译期 contract assertions**

~~~ts
import { test } from "bun:test"
import type {
  CompanyBootstrapError,
  CompanyBootstrapResponse,
  CompanyCurrentError,
  CompanyCurrentResponse,
  CompanyProviderAuthError,
  CompanyProviderAuthResponse,
  CompanyProviderOauthAuthorizeError,
  CompanyProviderOauthAuthorizeResponse,
  CompanyProviderOauthCallbackError,
  CompanyProviderOauthCallbackResponse,
  CompanyProviderRemoveError,
  CompanyProviderRemoveResponse,
  CompanyProviderSetError,
  CompanyProviderSetResponse,
  CompanyProvidersError,
  CompanyProvidersResponse,
  CompanyRepositoryInspectError,
  CompanyRepositoryInspectResponse,
  LocalAuthCredentialsError,
  LocalAuthCredentialsResponse,
  LocalAuthExchangeError,
  LocalAuthExchangeResponse,
  LocalAuthPairError,
  LocalAuthPairResponse,
  LocalAuthRevokeError,
  LocalAuthRevokeResponse,
  LocalAuthSessionError,
  LocalAuthSessionResponse,
} from "./gen/types.gen"

type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnsafe<T> = IsAny<T> extends true ? true : unknown extends T ? ([keyof T] extends [never] ? true : false) : false
type ExpectFalse<T extends false> = T

type M1Responses =
  | CompanyCurrentResponse
  | CompanyProvidersResponse
  | CompanyProviderAuthResponse
  | CompanyProviderSetResponse
  | CompanyProviderRemoveResponse
  | CompanyProviderOauthAuthorizeResponse
  | CompanyProviderOauthCallbackResponse
  | CompanyRepositoryInspectResponse
  | CompanyBootstrapResponse
  | LocalAuthSessionResponse
  | LocalAuthPairResponse
  | LocalAuthCredentialsResponse
  | LocalAuthRevokeResponse
  | LocalAuthExchangeResponse

type M1Errors =
  | CompanyCurrentError
  | CompanyProvidersError
  | CompanyProviderAuthError
  | CompanyProviderSetError
  | CompanyProviderRemoveError
  | CompanyProviderOauthAuthorizeError
  | CompanyProviderOauthCallbackError
  | CompanyRepositoryInspectError
  | CompanyBootstrapError
  | LocalAuthSessionError
  | LocalAuthPairError
  | LocalAuthCredentialsError
  | LocalAuthRevokeError
  | LocalAuthExchangeError

export type M1ContractAssertions = [ExpectFalse<IsUnsafe<M1Responses>>, ExpectFalse<IsUnsafe<M1Errors>>]

test("M1 generated response types are concrete", () => {})
~~~

- [ ] **Step 2: 更新 OpenAPI product metadata**

Server.openapi() 和 /doc 的 metadata 固定为：

~~~ts
info: {
  title: "Agent Company Local API",
  version: "1.0.0",
  description: "Authenticated local Control Plane API for Agent Company",
}
~~~

build script 保持 generated files clean，并在生成后格式化 src/v2；不要手改 gen 目录。
src/v2/client.ts 的 HTML mismatch 错误文案改为 `Request is not supported by this version of Agent Company Server`；不重命名继承的 `createOpencodeClient` 技术符号。
packages/sdk/js/package.json 的 author/homepage/description 只指向 Agent Company 当前仓库，不保留 Xiaomi MiMo/OpenCode 产品元数据。

- [ ] **Step 3: 让 spawned SDK server 自带认证**

src/v2/server.ts 在 spawn 前生成密码，向 child env 注入 AGENTCOMPANY_SERVER_USERNAME=agentcompany 和 AGENTCOMPANY_SERVER_PASSWORD；返回结构增加 username/password。src/v2/index.ts 用同一 Basic header 创建 client。日志 parser 同时接受当前 agentcompany server listening 文案，不能依赖输出明文密码。

- [ ] **Step 4: 运行唯一允许的 SDK regeneration command**

先把 build.ts 末尾的 `bun tsc` 改为 `bun typecheck`；脚本已经把 cwd 切到 packages/sdk/js，因此满足仓库的 package-local typecheck 规则，禁止直接调用 tsc。

Run: ./packages/sdk/js/script/build.ts

Working directory: repository root

Expected: command exits 0；生成 Company 与 LocalAuth class/types，且不产生手写 diff 到 gen 目录之外。

Run: bun typecheck

Working directory: packages/sdk/js

Expected: PASS；company-contract.test.ts 的 14 个 operation response/error 联合断言编译通过。

Run: bun test src/v2/company-contract.test.ts

Working directory: packages/sdk/js

Expected: PASS；运行时 smoke 与同文件中的编译期 assertion 都生效。

Run: rg -n "(Company|LocalAuth)[A-Za-z]+(Response|Error) = (unknown|any)" src/v2/gen

Working directory: packages/sdk/js

Expected: no output，exit 1。

- [ ] **Step 5: Commit**

~~~bash
git add packages/control-plane/src/server/server.ts packages/control-plane/src/server/routes/control/index.ts packages/sdk/js/script/build.ts packages/sdk/js/package.json packages/sdk/js/src/v2/server.ts packages/sdk/js/src/v2/index.ts packages/sdk/js/src/v2/client.ts packages/sdk/js/src/v2/company-contract.test.ts packages/sdk/js/src/v2/gen
git commit -m "feat(sdk): generate typed M1 product contract"
~~~

## Task 7: 接入 App 认证 gate 与真实 Company data source

**Covers:** [M1-S1], [M1-S2], [M1-S5], [M1-S6]

**Files:**

- Create: packages/app/public/agent-company-mark.svg
- Create: packages/app/public/agent-company-icon-180.png
- Create: packages/app/public/agent-company-icon-192.png
- Create: packages/app/public/agent-company-icon-512.png
- Create: packages/app/public/agent-company-theme-preload.js
- Create: script/generate-agent-company-brand.ts
- Modify: package.json
- Modify: bun.lock
- Replace symlink with regular file: packages/app/public/site.webmanifest
- Delete: packages/app/public/oc-theme-preload.js
- Delete: packages/app/public/apple-touch-icon-v3.png
- Delete: packages/app/public/apple-touch-icon.png
- Delete: packages/app/public/favicon-96x96-v3.png
- Delete: packages/app/public/favicon-96x96.png
- Delete: packages/app/public/favicon-v3.ico
- Delete: packages/app/public/favicon-v3.svg
- Delete: packages/app/public/favicon.ico
- Delete: packages/app/public/favicon.svg
- Delete: packages/app/public/social-share-zen.png
- Delete: packages/app/public/social-share.png
- Delete: packages/app/public/web-app-manifest-192x192.png
- Delete: packages/app/public/web-app-manifest-512x512.png
- Modify: packages/app/index.html
- Modify: packages/app/public/_headers
- Modify: packages/app/vite.js
- Modify: packages/app/vite.config.ts
- Create: packages/app/src/brand-entry.test.ts
- Modify: packages/app/src/theme-preload.test.ts
- Create: packages/app/src/components/connection-auth-gate.tsx
- Create: packages/app/src/pages/company/browser-pairing.tsx
- Create: packages/app/src/pages/company/company-data-source.test.ts
- Create: packages/app/src/utils/server.test.ts
- Modify: packages/app/src/utils/persist.ts
- Modify: packages/app/src/utils/persist.test.ts
- Modify: packages/app/src/context/server.tsx
- Modify: packages/app/src/context/language.tsx
- Modify: packages/app/src/context/layout.tsx
- Modify: packages/app/src/utils/server.ts
- Modify: packages/app/src/app.tsx
- Modify: packages/app/src/entry.tsx
- Modify: packages/app/src/context/highlights.tsx
- Modify: packages/app/src/env.d.ts
- Modify: packages/app/src/hooks/use-providers.ts
- Create: packages/app/src/hooks/use-providers.test.ts
- Modify: packages/app/src/components/dialog-connect-provider.tsx
- Modify: packages/app/src/components/dialog-custom-provider.tsx
- Modify: packages/app/src/components/settings-general.tsx
- Modify: packages/app/src/components/status-popover-body.tsx
- Modify: packages/app/src/pages/error.tsx
- Modify: packages/app/src/pages/layout.tsx
- Modify: packages/app/src/pages/layout/deep-links.ts
- Modify: packages/app/src/pages/layout/helpers.test.ts
- Modify: packages/app/src/pages/layout/sidebar-items.tsx
- Modify: packages/app/src/utils/server-errors.ts
- Modify: packages/app/src/pages/company/company-model.ts
- Modify: packages/app/src/pages/company/company-data-source.ts
- Modify: packages/app/src/pages/company/company-fixture.ts
- Modify: packages/app/src/i18n/en.ts
- Modify: packages/app/src/i18n/zh.ts
- Modify: packages/app/src/i18n/ar.ts
- Modify: packages/app/src/i18n/br.ts
- Modify: packages/app/src/i18n/bs.ts
- Modify: packages/app/src/i18n/da.ts
- Modify: packages/app/src/i18n/de.ts
- Modify: packages/app/src/i18n/es.ts
- Modify: packages/app/src/i18n/fr.ts
- Modify: packages/app/src/i18n/ja.ts
- Modify: packages/app/src/i18n/ko.ts
- Modify: packages/app/src/i18n/no.ts
- Modify: packages/app/src/i18n/pl.ts
- Modify: packages/app/src/i18n/ru.ts
- Modify: packages/app/src/i18n/th.ts
- Modify: packages/app/src/i18n/tr.ts
- Modify: packages/app/src/i18n/zht.ts
- Modify: packages/ui/src/theme/context.tsx
- Modify: packages/ui/src/theme/loader.ts
- Modify: packages/ui/src/theme/desktop-theme.schema.json
- Modify: packages/ui/src/theme/themes/oc-2.json
- Modify: packages/ui/src/theme/themes/opencode.json
- Modify: packages/ui/src/components/favicon.tsx

**Interfaces:**

- Consumes: generated sdk.localAuth.session 和 sdk.company.current。
- Produces: CompanyClient = Pick<ReturnType<typeof createOpencodeClient>, "company" | "localAuth">，不另写一套 DTO。
- Produces: ServerConnection.HttpBase.token、authorizationHeaders(http)。
- Produces: CompanyWorkspaceDataSource.refresh/listProviders/setProvider/inspectRepository/bootstrap/createPairing/listCredentials/revokeCredential。
- Produces: CompanyWorkspaceSnapshot discriminated union，包含由 localAuth.session 投影的 access.kind/can_manage_credentials。
- Produces: Agent Company Browser metadata、CSP-safe external theme preload 与不读取旧 key 的 theme storage contract。
- Produces: 可复现的 Browser/Desktop brand asset generator；唯一输入是 canonical SVG。

- [ ] **Step 1: 写失败的 auth、data-source 与 Browser identity tests**

~~~ts
import { describe, expect, test } from "bun:test"
import { authorizationHeaders } from "@/utils/server"

describe("connection authorization", () => {
  test("prefers a paired bearer token over Basic fields", () => {
    expect(
      authorizationHeaders({
        url: "http://127.0.0.1:4096",
        username: "agentcompany",
        password: "ephemeral",
        token: "ac1_credential_secret",
      }),
    ).toEqual({ Authorization: "Bearer ac1_credential_secret" })
  })
})
~~~

data-source test 使用真实生成 SDK，并只用注入的 fetch fake 网络边界；不重写 SDK method 或复制业务逻辑：

~~~ts
import type { CompanyState } from "@agents-company/sdk/v2/client"
import { createOpencodeClient } from "@agents-company/sdk/v2/client"
import { createSdkCompanyWorkspaceDataSource } from "./company-data-source"

const needsBootstrap: CompanyState = {
  state: "needs_bootstrap",
  data_directory: "/company/data",
  defaults: {
    company_name: "Agent Company",
    approval_preset: "balanced",
    board: [
      { id: "board-ceo", role: "ceo", name: "CEO", lifecycle: "employee", responsibilities: ["公司目标与最终取舍"] },
      { id: "board-cto", role: "cto", name: "CTO", lifecycle: "employee", responsibilities: ["技术方向与工程质量"] },
      { id: "board-product-lead", role: "product_lead", name: "Product Lead", lifecycle: "employee", responsibilities: ["用户价值与验收"] },
    ],
  },
  capabilities: { board_messages: false },
}

const ready: CompanyState = {
  state: "ready",
  data_directory: "/company/data",
  company: {
    id: "cmp_local",
    name: "Agent Company",
    data_version: 1,
    provider: { provider_id: "openai", model_id: "gpt-5" },
    approval_policy: { preset: "balanced" },
    repository: {
      project_id: "project-1",
      root_path: "/repo",
      default_branch: "main",
      bootstrap_head_commit: "abc",
      dirty: false,
    },
    board: needsBootstrap.defaults.board,
    created_at: 1,
    updated_at: 1,
  },
  start_suggestion: {
    kind: "bootstrap_complete",
    action: "open_board",
  },
  capabilities: { board_messages: false },
}

test("publishes needs_bootstrap then ready from SDK responses", async () => {
  const responses: CompanyState[] = [needsBootstrap, ready]
  const source = createSdkCompanyWorkspaceDataSource(
    createOpencodeClient({
      baseUrl: "http://company.test",
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/local-auth/session") {
          return Response.json({ authenticated: true, kind: "basic" })
        }
        const data = responses.shift()
        if (!data) return Response.json({ name: "UnexpectedRequest" }, { status: 500 })
        return Response.json(data)
      },
    }),
  )
  await source.refresh()
  const bootstrap = source.getSnapshot()
  expect(bootstrap.status).toBe("needs_bootstrap")
  if (bootstrap.status !== "needs_bootstrap") throw new Error("Expected bootstrap snapshot")
  expect(bootstrap.access.can_manage_credentials).toBe(true)
  await source.refresh()
  expect(source.getSnapshot().status).toBe("ready")
})
~~~

brand-entry.test.ts 读取真实 HTML、manifest 和 headers；theme-preload.test.ts 在 DOM 中证明只读取新 key：

~~~ts
import { describe, expect, test } from "bun:test"

describe("Agent Company browser entry", () => {
  test("uses branded same-origin assets and a strict CSP", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
    const manifest = await Bun.file(new URL("../public/site.webmanifest", import.meta.url)).json()
    const headers = await Bun.file(new URL("../public/_headers", import.meta.url)).text()

    expect(html).toContain("<title>Agent Company</title>")
    expect(html).toContain('src="/agent-company-theme-preload.js"')
    expect(html).toContain('href="/agent-company-mark.svg"')
    expect(html).not.toContain("OpenCode")
    expect(manifest).toMatchObject({ name: "Agent Company", short_name: "Agent Company" })
    expect(headers).toContain("Content-Security-Policy")
    expect(headers).toContain("script-src 'self'")
  })
})

// packages/app/src/theme-preload.test.ts，复用文件顶部现有的 run helper
test("ignores old OpenCode theme storage instead of migrating it", () => {
  localStorage.setItem("opencode-theme-id", "nightowl")
  run()
  expect(document.documentElement.dataset.theme).toBe("oc-2")
  expect(localStorage.getItem("agent-company.theme-id")).toBeNull()
})
~~~

use-providers.test.ts 对纯 allowlist boundary 断言 `isAgentCompanyProvider("opencode")` 和 `isAgentCompanyProvider("opencode-go")` 为 false、OpenAI/custom 为 true；layout/helpers.test.ts 的所有 deep-link case 改用 agentcompany://，并新增旧 opencode:// 返回 undefined。i18n/parity.test.ts 保证 17 个 dictionary key 仍与英文基线一致。

Run: bun test --preload ./happydom.ts src/pages/company/company-data-source.test.ts src/utils/server.test.ts src/utils/persist.test.ts src/hooks/use-providers.test.ts src/pages/layout/helpers.test.ts src/i18n/parity.test.ts src/brand-entry.test.ts src/theme-preload.test.ts

Working directory: packages/app

Expected: FAIL；token、authorizationHeaders、SDK source 与 Agent Company Browser entry 尚不存在。

- [ ] **Step 2: 扩展 connection contract**

~~~ts
export type HttpBase = {
  url: string
  username?: string
  password?: string
  token?: string
}

export type CompanyClient = Pick<ReturnType<typeof createOpencodeClient>, "company" | "localAuth">

export function authorizationHeaders(server: ServerConnection.HttpBase) {
  if (server.token) return { Authorization: "Bearer " + server.token }
  if (!server.password) return {}
  return {
    Authorization: "Basic " + btoa((server.username ?? "agentcompany") + ":" + server.password),
  }
}
~~~

createSdkForServer 合并 caller headers 后再覆盖 Authorization，确保过期 Basic 不覆盖 Bearer。GlobalSDK 的普通 client 与 eventSdk 必须都通过这个 helper 构造；server.test.ts 用注入 fetch 分别捕获普通 operation 和 `/global/event` SSE 请求，并断言两者都携带同一 Bearer header。health 仍可匿名；ConnectionAuthGate 对 /local-auth/session 做受保护探针。

- [ ] **Step 3: 在 GlobalSDK 前加入认证 gate**

Provider 顺序必须是 ServerProvider → ConnectionGate → ConnectionAuthGate → GlobalSDKProvider → GlobalSyncProvider。ConnectionAuthGate 状态：

- 200：渲染 children；
- 401 且 platform=web：渲染 BrowserPairing；
- 401 且 platform=desktop：显示 sidecar credential mismatch 并提供 restart；
- 网络错误：沿用 ConnectionError；
- token 被 revoke：删除当前 origin 的 token，再进入 BrowserPairing。

ConnectionAuthGate 直接用 Server context 调用 createSdkForServer({ server }) 创建临时 client；它不能读取尚未挂载的 GlobalSDK context。BrowserPairing 接收这个 client 的 localAuth.exchange callback，成功 reload 后才挂载 GlobalSDKProvider。Auth gate 不把 token 写日志或错误 UI。

BrowserPairing 在本 Task 完整实现，保证 Task 7 单独 typecheck：从 `?pair=XXXX-XXXX` 预填 code，label 默认使用浏览器/OS 的非敏感名称，调用 public localAuth.exchange；成功后把 token 写入 `agent-company.local-auth:<normalized-server-url>`，用 history.replaceState 移除 pair query，再 reload。400 只显示“配对码无效或已过期”，不显示/log response token；Desktop platform 永不渲染该组件。pairing key 同步加入全部 17 个 app locale 并通过 parity test。

- [ ] **Step 4: 把 Company fixture 改为显式 opt-in**

CompanyWorkspaceSnapshot 定义：

~~~ts
export type CompanyWorkspaceSnapshot =
  | { status: "loading" }
  | ({ status: "needs_bootstrap"; access: CompanyWorkspaceAccess } & CompanyNeedsBootstrapState)
  | ({ status: "ready"; access: CompanyWorkspaceAccess } & CompanyReadyState)
  | { status: "error"; title: string; description: string; retryable: boolean }
  | CompanyDisconnectedSnapshot
  | ({ status: "demo" } & CompanyDemoSnapshot)

export type CompanyWorkspaceAccess = {
  kind: "trusted" | "basic" | "bearer"
  can_manage_credentials: boolean
}
~~~

SDK data source 的 refresh 并行请求 company.current 与 localAuth.session；只有 trusted/basic 将 can_manage_credentials 设为 true。Bearer 可以完成 Company setup，但不能创建、列出或 revoke 其他浏览器凭据。

所有 generated SDK 调用都按现有 `{ data, error, response }` contract 显式 unwrap：有 error 时按 typed NamedError/status 投影到 gate 或 retryable snapshot，data 缺失且无 error 视为 contract violation；禁止用 `data!`、`as CompanyState` 或复制 response DTO 掩盖生成契约问题。

createCompanyWorkspaceDataSource(client) 的选择规则：

~~~ts
export function createCompanyWorkspaceDataSource(client: CompanyClient): CompanyWorkspaceDataSource {
  if (import.meta.env.VITE_AGENTCOMPANY_COMPANY_FIXTURE === "true") {
    return createFixtureCompanyWorkspaceDataSource()
  }
  return createSdkCompanyWorkspaceDataSource(client)
}
~~~

普通 bun dev 必须连接真实 server；Playwright fixture 用例通过 env 显式开启 demo。

- [ ] **Step 5: 品牌化 Browser entry 的连接状态**

entry.tsx 使用：

- agent-company.settings.dat:defaultServerUrl；
- `agent-company.local-auth:<normalized-server-url>`；
- VITE_AGENTCOMPANY_SERVER_HOST/PORT；
- 默认 localhost:4096；
- Notification 不再引用 opencode.ai 远程 favicon；
- HighlightsProvider 不再请求 opencode.ai/changelog.json；M1 没有 Agent Company 自有更新源时返回空 feed；
- server connection 从 storage 注入 token。
- app.tsx 与 Desktop renderer 统一读取 window.__AGENTCOMPANY__；不保留 __OPENCODE__ fallback。
- index.html title/manifest/icon 全部引用 Agent Company 本地资产，删除 OG/social 上游图片；notification 使用 /agent-company-icon-192.png；
- packages/app/public/site.webmanifest 从上游 symlink 替换为普通文件，name/short_name 为 Agent Company，icons 只引用 192/512 新资产；
- theme preload 保持同源外部 script，不再由 Vite inline；storage key 固定为 agent-company.theme-id、agent-company.color-scheme、agent-company.theme-css-light、agent-company.theme-css-dark，style id 使用 `agent-company-theme-*`，不读或迁移 `opencode-*`；
- 通用 Persist namespace 固定为 agent-company.global.dat、agent-company.workspace.* 和 agent-company.*；移除 default.dat/legacy key 读取及 layout 的旧 key 参数，language 只读 agent-company.global.dat:language；persist test 反向放入 opencode.* 值并证明不会读取；
- UI theme 的继承 ID oc-2/opencode 可以保留为内部值，但菜单显示名分别改为 Agent Company/Graphite，公开 theme schema 使用 Agent Company；
- shared provider hook 在所有 coding/settings UI 中过滤 opencode/opencode-go；删除 Zen CTA 与上游 provider/theme docs links，在 Agent Company 自有文档存在前不显示“了解更多”，不能把旧产品机械改名成不存在的“Agent Company Zen”；
- 17 个 app locale 的用户可见 OpenCode 文案替换为 Agent Company，配置文件提示替换为 agent-company.json；现有翻译语言不变，parity test 必须通过；
- deep link event/protocol/global 固定为 agentcompany:deep-link、agentcompany://、window.__AGENTCOMPANY__；旧 opencode:// 和 __OPENCODE__ 不解析；language cookie 改为 agent_company_locale；
- Error/help 链接指向当前仓库 issues，特殊上游 Project 远程 favicon 分支删除并回到项目 avatar fallback，Favicon meta 使用 Agent Company；
- index meta、Vite dev headers、public/_headers 和 Task 1 的 production UIRoutes 使用同一 CSP：default-src/self，script-src/self，object-src/none，frame-ancestors/none，base-uri/none；只额外放行同源、本机 http/ws connect，现有 inline style、data/blob image/font；
- agent-company-mark.svg 为当前批准 WebUI 风格下的中性 AC monogram：方形 viewBox、固定 light/dark-safe 颜色、至少 12% safe area、不依赖外部 font/CSS；180/192/512 PNG 从该源导出，删除且不再引用旧 favicon/manifest/social assets。

根 package.json 精确加入与当前 lock 一致的 `sharp@0.33.5` 和 `app-builder-bin@5.0.0-alpha.12` devDependencies。script/generate-agent-company-brand.ts 使用 sharp 从 canonical SVG 生成 Browser 180/192/512 PNG；`--desktop` 额外 byte-copy Desktop source.svg、生成 32/64/128/256/512/icon/dock PNG，并通过 `appBuilderPath icon --format=icns|ico` 生成两个发布容器。脚本所有临时文件放在 `fs.mkdtemp(path.join(os.tmpdir(), ...))` 下并 finally 删除，不能覆盖 source.svg 之外的手工输入；`--check` 在临时目录重建并逐个 byte compare 已提交资产。

Run: bun add --dev --exact sharp@0.33.5 app-builder-bin@5.0.0-alpha.12

Working directory: repository root

Expected: package.json 与 bun.lock 只增加两个直接开发依赖；不升级其他 package。

Run: bun script/generate-agent-company-brand.ts --browser

Working directory: repository root

Expected: PASS；只更新本 Task 声明的 Browser PNG，IHDR 尺寸分别为 180/192/512。

Run: bun test --preload ./happydom.ts src/pages/company/company-data-source.test.ts src/utils/server.test.ts src/utils/persist.test.ts src/hooks/use-providers.test.ts src/pages/layout/helpers.test.ts src/i18n/parity.test.ts src/brand-entry.test.ts src/theme-preload.test.ts

Working directory: packages/app

Expected: PASS。

Run: bun typecheck

Working directory: packages/app

Expected: PASS。

Run: bun typecheck

Working directory: packages/ui

Expected: PASS。

Run: rg -n "OpenCode|opencode\\.ai|opencode://|anomalyco/opencode|oc-theme-preload|opencode-theme-id|opencode-color-scheme|opencode\\.global\\.dat|opencode\\.workspace|opencode\\.json" index.html public vite.js vite.config.ts src ../ui/src/theme ../ui/src/components/favicon.tsx --glob '!**/*.test.ts*'

Working directory: packages/app

Expected: no production identity/storage hits；测试中的“旧 key 被忽略”断言不在扫描范围。

- [ ] **Step 6: Commit**

~~~bash
git add script/generate-agent-company-brand.ts package.json bun.lock packages/app/index.html packages/app/public/agent-company-mark.svg packages/app/public/agent-company-icon-180.png packages/app/public/agent-company-icon-192.png packages/app/public/agent-company-icon-512.png packages/app/public/agent-company-theme-preload.js packages/app/public/site.webmanifest packages/app/public/_headers packages/app/public/oc-theme-preload.js packages/app/public/apple-touch-icon-v3.png packages/app/public/apple-touch-icon.png packages/app/public/favicon-96x96-v3.png packages/app/public/favicon-96x96.png packages/app/public/favicon-v3.ico packages/app/public/favicon-v3.svg packages/app/public/favicon.ico packages/app/public/favicon.svg packages/app/public/social-share-zen.png packages/app/public/social-share.png packages/app/public/web-app-manifest-192x192.png packages/app/public/web-app-manifest-512x512.png packages/app/vite.js packages/app/vite.config.ts packages/app/src/brand-entry.test.ts packages/app/src/theme-preload.test.ts packages/app/src/components/connection-auth-gate.tsx packages/app/src/components/dialog-connect-provider.tsx packages/app/src/components/dialog-custom-provider.tsx packages/app/src/components/settings-general.tsx packages/app/src/components/status-popover-body.tsx packages/app/src/context/server.tsx packages/app/src/context/language.tsx packages/app/src/context/layout.tsx packages/app/src/context/highlights.tsx packages/app/src/hooks/use-providers.ts packages/app/src/hooks/use-providers.test.ts packages/app/src/utils/server.ts packages/app/src/utils/server.test.ts packages/app/src/utils/server-errors.ts packages/app/src/utils/persist.ts packages/app/src/utils/persist.test.ts packages/app/src/app.tsx packages/app/src/entry.tsx packages/app/src/env.d.ts packages/app/src/pages/error.tsx packages/app/src/pages/layout.tsx packages/app/src/pages/layout/deep-links.ts packages/app/src/pages/layout/helpers.test.ts packages/app/src/pages/layout/sidebar-items.tsx packages/app/src/pages/company/browser-pairing.tsx packages/app/src/pages/company/company-model.ts packages/app/src/pages/company/company-data-source.ts packages/app/src/pages/company/company-fixture.ts packages/app/src/pages/company/company-data-source.test.ts packages/app/src/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,th,tr,zh,zht}.ts packages/ui/src/components/favicon.tsx packages/ui/src/theme/context.tsx packages/ui/src/theme/loader.ts packages/ui/src/theme/desktop-theme.schema.json packages/ui/src/theme/themes/oc-2.json packages/ui/src/theme/themes/opencode.json
git commit -m "feat(app): connect branded company shell to authenticated SDK"
~~~

## Task 8: 完成共享 WebUI 首次引导与真实 ready landing

**Covers:** [M1-S6], [M1-S9]

**Files:**

- Create: packages/app/src/pages/company/company-bootstrap.tsx
- Create: packages/app/src/pages/company/company-ready.tsx
- Create: packages/app/src/pages/company/company-ready.test.tsx
- Create: packages/app/src/pages/company/company-state.ts
- Create: packages/app/src/pages/company/company-state.test.ts
- Modify: packages/app/src/pages/company/index.tsx
- Modify: packages/app/src/pages/company/workspace.css
- Modify: packages/app/src/i18n/en.ts
- Modify: packages/app/src/i18n/zh.ts
- Modify: packages/app/src/i18n/ar.ts
- Modify: packages/app/src/i18n/br.ts
- Modify: packages/app/src/i18n/bs.ts
- Modify: packages/app/src/i18n/da.ts
- Modify: packages/app/src/i18n/de.ts
- Modify: packages/app/src/i18n/es.ts
- Modify: packages/app/src/i18n/fr.ts
- Modify: packages/app/src/i18n/ja.ts
- Modify: packages/app/src/i18n/ko.ts
- Modify: packages/app/src/i18n/no.ts
- Modify: packages/app/src/i18n/pl.ts
- Modify: packages/app/src/i18n/ru.ts
- Modify: packages/app/src/i18n/th.ts
- Modify: packages/app/src/i18n/tr.ts
- Modify: packages/app/src/i18n/zht.ts

**Interfaces:**

- Consumes: CompanyWorkspaceDataSource from Task 7。
- Produces: CompanyBootstrapDraft、reduceDraft、canSubmit、serializeDraft/restoreDraft。
- Produces: CompanyBootstrap、CompanyReady components；复用 Task 7 的 BrowserPairing。

- [ ] **Step 1: 写失败的 wizard reducer 与 capability render tests**

~~~ts
import { describe, expect, test } from "bun:test"
import {
  canSubmit,
  createDraft,
  reduceDraft,
  restoreDraft,
  serializeDraft,
  type CompanyDraftAction,
} from "./company-state"

describe("company bootstrap draft", () => {
  test("starts balanced and becomes submittable only with provider, model and inspected git", () => {
    const initial = createDraft("018f84f8-9c21-7d4d-a850-d63f8f9344cc")
    expect(initial.approval_preset).toBe("balanced")
    expect(canSubmit(initial)).toBe(false)
    const actions = [
      { type: "provider.selected", provider_id: "openai", model_id: "gpt-5" },
      {
        type: "repository.inspected",
        repository: {
          project_id: "project-1",
          root_path: "/repo",
          default_branch: "main",
          bootstrap_head_commit: "abc",
          dirty: false,
        },
      },
    ] satisfies CompanyDraftAction[]
    const ready = actions.reduce(reduceDraft, initial)
    expect(canSubmit(ready)).toBe(true)
  })

  test("does not persist provider secrets in draft", () => {
    const draft = {
      ...createDraft("018f84f8-9c21-7d4d-a850-d63f8f9344cc"),
      provider_id: "openai",
      model_id: "gpt-5",
      api_key: "must-not-persist",
    }
    const saved = serializeDraft(draft)
    expect(saved).not.toContain("must-not-persist")
    expect(restoreDraft(saved)).toMatchObject({
      request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
      provider_id: "openai",
      model_id: "gpt-5",
    })
  })
})
~~~

company-ready.test.tsx 使用 `solid-js/web` 的 render/dispose 和 CompanyReadyState.parse 后的真实 DTO，不引入新的 testing-library，也不复制 CompanyReady 的投影逻辑；先写出真实事实可见、五类 M0 DOM class 不存在的断言。

Run: bun test --preload ./happydom.ts src/pages/company/company-state.test.ts src/pages/company/company-ready.test.tsx

Working directory: packages/app

Expected: FAIL；company-state.ts 与 company-ready.tsx 尚不存在。

- [ ] **Step 2: 实现五阶段 CompanyBootstrap**

组件必须使用一个 form/reducer，不为每一步写服务器状态：

1. Provider：列出 providers 和 auth methods；API key 调用 providerSet，OAuth 调用 authorize/callback；连接成功后选择 model；
2. Company：name 默认 Agent Company；只读显示 data_directory；预览固定 CEO/CTO/Product Lead；
3. Repository：Desktop 使用 openDirectoryPickerDialog，Web 使用路径输入；调用 repositoryInspect，并显示 branch/head/dirty；
4. Policy：三种 preset 单选，balanced 默认；
5. Review：展示不含 secret 的 summary；调用 bootstrap。

submit 期间禁用重复按钮；网络错误保留 draft。CompanyAlreadyInitialized 时立即 refresh：相同公司进入 ready，不同公司显示 409 指引。

非 secret draft 以 `agent-company.bootstrap-draft:<normalized-server-url>` 写 localStorage，只白名单保存 request_id、company_name、provider_id、model_id、repository_path 和 approval_preset。API key/OAuth code 只存在于当前表单 signal，调用后立即清空；repository inspect 结果不持久化，刷新恢复 path 后必须重新 inspect。bootstrap 成功或 current 已 ready 时删除 draft。

- [ ] **Step 3: 实现 capability-gated CompanyReady**

Ready 页面必须从 snapshot 渲染：

- company.name、data_directory；
- provider_id/model_id；
- repository root/default branch/bootstrap head/dirty；
- balanced/autonomous/strict；
- 三名 board member；
- start_suggestion.kind 映射当前 locale 的 title/body；
- access.can_manage_credentials=true 时，“连接浏览器”打开 pair/list/revoke 面板；Bearer ready 页面只显示“此浏览器已配对”，不发起管理请求。

当 capabilities.board_messages=false，渲染一个带 data-capability="board-messages-disabled" 的说明区；start suggestion action 同时 disabled 并显示本地化的 M2 提示。M1 不定义或引用 composer component。M0 的消息、Thread、Approval、Delivery 只在 status=demo 分支渲染。

company-ready.test.tsx 用真实 ready snapshot 渲染组件，断言 company/board/repository/policy/start suggestion 可见，同时 `.company-channels`、`.company-composer`、`.company-thread`、`.company-approval`、`.company-delivery` 全部不存在；这项测试防止把 M0 shell 的静态频道和卡片误当成 M1 业务。

- [ ] **Step 4: 接入 index 与响应式样式**

CompanyWorkspace 在 onMount 调用 source.refresh，并用 Switch 精确处理六种 snapshot。needs_bootstrap 和 ready 仍在共享 AppChrome 内，但不挂载 M0 的 CompanyRail/ChannelSidebar/Conversation/ThreadPanel；这些组件只属于显式 demo branch。窄屏下步骤栏折叠为 progress label，pairing 表单可键盘操作。

Run: bun test --preload ./happydom.ts src/pages/company/company-state.test.ts src/pages/company/company-ready.test.tsx src/pages/company/company-data-source.test.ts src/i18n/parity.test.ts

Working directory: packages/app

Expected: PASS。

Run: bun run build

Working directory: packages/app

Expected: PASS；CSS utility smoke 仍通过，生产 bundle 不包含 fixture 业务事实作为默认状态。

Run: rg -n "2 项决定等待确认|准备合并到 main|继续推进 M0" dist

Working directory: packages/app

Expected: no output，exit 1；显式 demo fixture 没有进入 production bundle。

- [ ] **Step 5: Commit**

~~~bash
git add packages/app/src/pages/company/company-bootstrap.tsx packages/app/src/pages/company/company-ready.tsx packages/app/src/pages/company/company-ready.test.tsx packages/app/src/pages/company/company-state.ts packages/app/src/pages/company/company-state.test.ts packages/app/src/pages/company/index.tsx packages/app/src/pages/company/workspace.css packages/app/src/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,th,tr,zh,zht}.ts
git commit -m "feat(app): add real company bootstrap journey"
~~~

## Task 9: 切换 Desktop home、短期凭据与 Agent Company 品牌

**Covers:** [M1-S1], [M1-S2], [M1-S8], [M1-S9]

**Files:**

- Create: packages/desktop/src/shared/brand.ts
- Create: packages/desktop/src/shared/brand.test.ts
- Create: packages/desktop/icons/agent-company/source.svg
- Create: packages/desktop/icons/agent-company/icon.icns
- Create: packages/desktop/icons/agent-company/icon.ico
- Create: packages/desktop/icons/agent-company/icon.png
- Create: packages/desktop/icons/agent-company/dock.png
- Create: packages/desktop/icons/agent-company/32x32.png
- Create: packages/desktop/icons/agent-company/64x64.png
- Create: packages/desktop/icons/agent-company/128x128.png
- Create: packages/desktop/icons/agent-company/256x256.png
- Create: packages/desktop/icons/agent-company/512x512.png
- Modify: packages/desktop/icons/README.md
- Modify: packages/desktop/scripts/copy-icons.ts
- Create: packages/desktop/src/main/company-home.ts
- Create: packages/desktop/src/main/company-home.test.ts
- Modify: packages/desktop/src/main/index.ts
- Modify: packages/desktop/src/main/server.ts
- Modify: packages/desktop/src/main/ipc.ts
- Modify: packages/desktop/src/preload/index.ts
- Modify: packages/desktop/src/preload/types.ts
- Modify: packages/desktop/src/renderer/index.tsx
- Modify: packages/desktop/src/main/constants.ts
- Modify: packages/desktop/src/main/store.ts
- Modify: packages/desktop/src/main/windows.ts
- Modify: packages/desktop/src/main/menu.ts
- Modify: packages/desktop/src/main/env.d.ts
- Delete: packages/desktop/src/main/migrate.ts
- Modify: packages/desktop/electron-builder.config.ts
- Modify: packages/desktop/electron.vite.config.ts
- Modify: packages/desktop/package.json
- Modify: packages/desktop/scripts/utils.ts
- Modify: packages/desktop/scripts/predev.ts
- Modify: packages/desktop/src/renderer/index.html
- Modify: packages/desktop/src/renderer/loading.html
- Modify: packages/desktop/src/renderer/env.d.ts
- Modify: packages/desktop/src/renderer/i18n/index.ts
- Modify: packages/desktop/src/renderer/i18n/ar.ts
- Modify: packages/desktop/src/renderer/i18n/br.ts
- Modify: packages/desktop/src/renderer/i18n/bs.ts
- Modify: packages/desktop/src/renderer/i18n/da.ts
- Modify: packages/desktop/src/renderer/i18n/de.ts
- Modify: packages/desktop/src/renderer/i18n/en.ts
- Modify: packages/desktop/src/renderer/i18n/es.ts
- Modify: packages/desktop/src/renderer/i18n/fr.ts
- Modify: packages/desktop/src/renderer/i18n/ja.ts
- Modify: packages/desktop/src/renderer/i18n/ko.ts
- Modify: packages/desktop/src/renderer/i18n/no.ts
- Modify: packages/desktop/src/renderer/i18n/pl.ts
- Modify: packages/desktop/src/renderer/i18n/ru.ts
- Modify: packages/desktop/src/renderer/i18n/zh.ts
- Modify: packages/desktop/src/renderer/i18n/zht.ts

**Interfaces:**

- Produces: LauncherState = needs_company_home | ready。
- Produces: getCompanyHome/selectCompanyHome；M1 不在线迁移或清空已选 home。
- Produces: ElectronAPI.getLauncherState/selectCompanyHome。
- Produces: shared PRODUCT_BRAND identity 与 byte-validated AC icon set。
- Consumes: Server.listen({ auth })、Listener.credentials 和 Task 7 的 packages/app/public/agent-company-mark.svg。

- [ ] **Step 1: 写失败的 pure launcher 与 product identity tests**

~~~ts
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { launcherState, loadCompanyRuntime, normalizeCompanyHome } from "./company-home"

const originalHome = process.env.AGENTCOMPANY_HOME
afterEach(() => {
  if (originalHome) process.env.AGENTCOMPANY_HOME = originalHome
  if (!originalHome) delete process.env.AGENTCOMPANY_HOME
})

describe("company home", () => {
  test("requires an absolute path", () => {
    expect(() => normalizeCompanyHome("./company")).toThrow("Company home must be an absolute path")
  })

  test("returns preflight before a home is stored", () => {
    expect(launcherState(null, "/Users/test/Documents")).toEqual({
      state: "needs_company_home",
      suggested_path: path.join("/Users/test/Documents", "Agent Company"),
    })
  })

  test("returns ready with the same stored root", () => {
    expect(launcherState("/company/root", "/ignored")).toEqual({
      state: "ready",
      company_home: "/company/root",
    })
  })

  test("sets company home before loading the control plane", async () => {
    expect(
      await loadCompanyRuntime("/company/root", async () => process.env.AGENTCOMPANY_HOME),
    ).toBe("/company/root")
  })
})
~~~

brand.test.ts 只测试 shared identity 和真实二进制资产，不读取一份复制的期望 config：

~~~ts
import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { PRODUCT_BRAND } from "./brand"

const digest = async (file: string) =>
  createHash("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const prefix = async (file: string, length: number) =>
  Array.from(new Uint8Array(await Bun.file(file).slice(0, length).arrayBuffer()))

test("has one Agent Company identity and non-upstream release assets", async () => {
  expect(PRODUCT_BRAND).toEqual({
    names: { dev: "Agent Company Dev", beta: "Agent Company Beta", prod: "Agent Company" },
    app_ids: {
      dev: "ai.agentcompany.desktop.dev",
      beta: "ai.agentcompany.desktop.beta",
      prod: "ai.agentcompany.desktop",
    },
    settings_store: "agent-company.settings",
    deep_link_protocol: "agentcompany",
    renderer_scheme: "ac",
  })

  const icons = path.resolve(import.meta.dir, "../../icons/agent-company")
  expect(await prefix(path.join(icons, "icon.icns"), 4)).toEqual([105, 99, 110, 115])
  expect(await prefix(path.join(icons, "icon.ico"), 4)).toEqual([0, 0, 1, 0])
  expect(await prefix(path.join(icons, "icon.png"), 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(await digest(path.join(icons, "source.svg"))).toBe(
    await digest(path.resolve(import.meta.dir, "../../../app/public/agent-company-mark.svg")),
  )
  expect(await digest(path.join(icons, "icon.icns"))).not.toBe(
    await digest(path.resolve(import.meta.dir, "../../icons/prod/icon.icns")),
  )
})
~~~

Run: bun test src/main/company-home.test.ts src/shared/brand.test.ts

Working directory: packages/desktop

Expected: FAIL；company-home.ts、shared brand contract 与 Agent Company icons 尚不存在。

- [ ] **Step 2: 实现 preflight IPC 和 import ordering**

Electron API：

~~~ts
export type LauncherState =
  | { state: "needs_company_home"; suggested_path: string }
  | { state: "ready"; company_home: string }

export type ElectronAPI = {
  getLauncherState: () => Promise<LauncherState>
  selectCompanyHome: () => Promise<string | null>
}
~~~

selectCompanyHome 调用 native directory picker，mkdir recursive，并用创建/删除一个随机 probe file 验证可写；取消时不写 store。成功后存 companyHome 并由 renderer 调用已有 relaunch IPC。

renderer 启动先 await getLauncherState；needs_company_home 时只挂载本地 preflight component，不调用 awaitInitialization，也不挂载共享 App providers。只有 ready 时才动态 import/mount 正常 App 并等待 sidecar credentials。preflight 同时显示将使用的 `<company_home>/data`。

company-home.ts 导出并由 main 唯一调用：

~~~ts
export async function loadCompanyRuntime<T>(companyHome: string, load: () => Promise<T>) {
  process.env.AGENTCOMPANY_HOME = normalizeCompanyHome(companyHome)
  return load()
}
~~~

main startup 严格按顺序：

1. set Agent Company App ID/userData；
2. register IPC/protocol；
3. 无 companyHome：创建 renderer window，跳过 initialize/server import；
4. 有 companyHome：调用 loadCompanyRuntime；
5. load callback 内动态 import virtual:opencode-server；
6. 启动 sidecar，再创建正常窗口。

删除 sqliteFileExists、JsonMigration/Tauri migration 路径。Drizzle 自己的增量 migration 是唯一数据库迁移入口。

- [ ] **Step 3: 修复 Desktop 短期凭据**

spawnLocalServer：

~~~ts
const credentials = {
  username: "agentcompany",
  password: randomBytes(32).toString("base64url"),
}
const listener = await Server.listen({
  port,
  hostname,
  auth: credentials,
  cors: ["ac://renderer"],
})
~~~

prepareServerEnv 只写 AGENTCOMPANY_CLIENT=desktop、`AGENTCOMPANY_EXPERIMENTAL_*` 和 AGENTCOMPANY_HOME；不再写 `OPENCODE_SERVER_*`。renderer 从 awaitInitialization 获得 Basic fields，只存内存，不进入 electron-store。

- [ ] **Step 4: 执行精确品牌切换**

packages/desktop/src/shared/brand.ts 是 main 与 electron-builder 唯一产品身份来源，必须固定为：

~~~ts
export const PRODUCT_BRAND = {
  names: { dev: "Agent Company Dev", beta: "Agent Company Beta", prod: "Agent Company" },
  app_ids: {
    dev: "ai.agentcompany.desktop.dev",
    beta: "ai.agentcompany.desktop.beta",
    prod: "ai.agentcompany.desktop",
  },
  settings_store: "agent-company.settings",
  deep_link_protocol: "agentcompany",
  renderer_scheme: "ac",
} as const
export const COMPANY_HOME_KEY = "companyHome"
~~~

同时：

- artifactName = agent-company-desktop-${os}-${arch}.${ext}；
- deep link 与 browser event 使用 agentcompany:// 和 agentcompany:deep-link；
- window global 使用 __AGENTCOMPANY__；
- env 使用 AGENTCOMPANY_CHANNEL/VITE_AGENTCOMPANY_CHANNEL/AGENTCOMPANY_PORT；
- Desktop storage/language 只使用 agent-company.settings、agent-company.global.dat 和 agent_company_locale，不读取 opencode.global.dat/default.dat/language.v1；
- Electron Vite 内部的 OPENCODE_SERVER_DIST 常量改为 CONTROL_PLANE_DIST；virtual:opencode-server 仅作为继承的构建模块名保留；
- package homepage/author 指向当前 Agent Company repo；
- menu docs/issues 指向 github.com/Ericwong5021/agents-company；
- 移除 anomalyco/opencode publish targets，UPDATER_ENABLED=false；
- 所有 locale 保留原语言，只替换产品名和 CLI 命令为 Agent Company / agents；
- HTML title 使用 Agent Company；
- HTML theme preload 改为 ./agent-company-theme-preload.js，renderer html test 同步断言新文件；
- renderer index/loading HTML 增加与 WebUI 等价的 CSP meta，只放行 ac self 与 loopback Control Plane；
- packages/desktop/icons/agent-company/source.svg 与 Browser canonical SVG byte-identical；提交 ICNS/ICO/PNG size set，copy-icons.ts 无论 channel 都只复制该目录，现有 dev/beta/prod 上游目录保留为未引用的历史源码且绝不能进入 resources/dist；
- main dev Dock icon、electron-builder mac/win/linux icon 都来自 resources/icons 中的新资产；brand test 检查 magic bytes、canonical SVG hash 与 upstream prod icon hash 不同；
- 不新增旧 key 读取 fallback。

Run: bun script/generate-agent-company-brand.ts --desktop

Working directory: repository root

Expected: PASS；Desktop source.svg 与 Browser canonical SVG byte-identical，PNG/ICNS/ICO 只由该输入生成。

- [ ] **Step 5: 运行 Desktop tests/build**

Run: bun test src/main/company-home.test.ts src/shared/brand.test.ts src/main/shell-env.test.ts src/renderer/html.test.ts

Working directory: packages/desktop

Expected: PASS。

Run: bun typecheck

Working directory: packages/desktop

Expected: PASS。

Run: bun run build

Working directory: packages/desktop

Expected: PASS；out/main 包含 sidecar server 与静态 WebUI assets。

Run: rg --pcre2 -n '^import(?! type).*virtual:opencode-server' src/main

Working directory: packages/desktop

Expected: no output，exit 1；Control Plane 没有可能早于 companyHome 的静态 value import。

Run: cmp icons/agent-company/icon.icns resources/icons/icon.icns

Working directory: packages/desktop

Expected: PASS；prebuild 实际复制新 macOS icon。

Run: cmp icons/agent-company/icon.ico resources/icons/icon.ico

Working directory: packages/desktop

Expected: PASS；prebuild 实际复制新 Windows icon。

Run: rg -n "OpenCode|opencode://|ai\.opencode|anomalyco/opencode|OPENCODE_SERVER|opencode\.global\.dat|opencode\.settings|oc-theme-preload" src electron-builder.config.ts electron.vite.config.ts package.json

Working directory: packages/desktop

Expected: no user-visible or runtime result；允许的唯一命中是 virtual:opencode-server 模块名和明确说明 inherited internal name 的注释。

- [ ] **Step 6: Commit**

~~~bash
git add packages/desktop/src/shared/brand.ts packages/desktop/src/shared/brand.test.ts packages/desktop/icons/agent-company/source.svg packages/desktop/icons/agent-company/icon.icns packages/desktop/icons/agent-company/icon.ico packages/desktop/icons/agent-company/icon.png packages/desktop/icons/agent-company/dock.png packages/desktop/icons/agent-company/32x32.png packages/desktop/icons/agent-company/64x64.png packages/desktop/icons/agent-company/128x128.png packages/desktop/icons/agent-company/256x256.png packages/desktop/icons/agent-company/512x512.png packages/desktop/icons/README.md packages/desktop/scripts/copy-icons.ts packages/desktop/src/main/company-home.ts packages/desktop/src/main/company-home.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/server.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/renderer/index.tsx packages/desktop/src/main/constants.ts packages/desktop/src/main/store.ts packages/desktop/src/main/windows.ts packages/desktop/src/main/menu.ts packages/desktop/src/main/env.d.ts packages/desktop/src/main/migrate.ts packages/desktop/electron-builder.config.ts packages/desktop/electron.vite.config.ts packages/desktop/package.json packages/desktop/scripts/utils.ts packages/desktop/scripts/predev.ts packages/desktop/src/renderer/index.html packages/desktop/src/renderer/loading.html packages/desktop/src/renderer/env.d.ts packages/desktop/src/renderer/i18n/index.ts packages/desktop/src/renderer/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,zh,zht}.ts
git commit -m "feat(desktop): adopt Agent Company home and identity"
~~~

## Task 10: 让 TUI 只读取同一 Company contract

**Covers:** [M1-S7]

**Files:**

- Create: packages/control-plane/src/cli/cmd/tui/routes/company-entry.ts
- Create: packages/control-plane/src/cli/cmd/tui/routes/company-entry.test.ts
- Create: packages/control-plane/src/cli/cmd/tui/routes/company-setup-required.tsx
- Modify: packages/control-plane/src/cli/cmd/tui/app.tsx
- Modify: packages/control-plane/src/cli/cmd/tui/feature-plugins/system/org-disband.tsx
- Modify: packages/control-plane/src/cli/cmd/tui/i18n/en.ts
- Modify: packages/control-plane/src/cli/cmd/tui/i18n/zh.ts
- Modify: packages/control-plane/src/cli/cmd/tui/i18n/zht.ts
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/business-scope-cards.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/cofounder-recruit-skill.ts
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/founding-roles.ts
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/frame.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/index.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/prompts.ts
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-founding-team.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-mission.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-profile.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-template-select.tsx
- Delete: packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-welcome.tsx

**Interfaces:**

- Consumes: sdk.client.company.current()、current cwd realpath。
- Produces: decideCompanyEntry(state, cwd) 返回 setup_required | repository_mismatch | ready。

- [ ] **Step 1: 写失败的 pure decision tests**

~~~ts
import { describe, expect, test } from "bun:test"
import { decideCompanyEntry, type CompanyEntryState } from "./company-entry"

const ready = (repository_path: string): CompanyEntryState => ({
  state: "ready",
  repository_path,
})

describe("TUI company entry", () => {
  test("requires primary UI bootstrap", () => {
    expect(
      decideCompanyEntry(
        { state: "needs_bootstrap", data_directory: "/company/data" },
        "/repo",
      ),
    ).toEqual({ type: "setup_required", data_directory: "/company/data" })
  })

  test("rejects a cwd outside the primary repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/other")).toEqual({
      type: "repository_mismatch",
      repository_path: "/repo",
    })
  })

  test("enters the existing shell in the bound repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/repo")).toEqual({ type: "ready" })
  })

  test("accepts a cwd inside the bound repository", () => {
    expect(decideCompanyEntry(ready("/repo"), "/repo/packages/app")).toEqual({ type: "ready" })
  })
})
~~~

Run: bun test src/cli/cmd/tui/routes/company-entry.test.ts

Working directory: packages/control-plane

Expected: FAIL；company-entry.ts 尚不存在。

- [ ] **Step 2: 替换 KV onboarding gate**

company-entry.ts 的输入投影固定为：

~~~ts
import path from "node:path"

export type CompanyEntryState =
  | { state: "needs_bootstrap"; data_directory: string }
  | { state: "ready"; repository_path: string }

export function decideCompanyEntry(state: CompanyEntryState, cwd: string) {
  if (state.state === "needs_bootstrap") {
    return { type: "setup_required" as const, data_directory: state.data_directory }
  }
  const relative = path.relative(state.repository_path, cwd)
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { type: "ready" as const }
  }
  return { type: "repository_mismatch" as const, repository_path: state.repository_path }
}
~~~

app.tsx 用 createResource 请求 company.current，把 generated SDK result 的 data 解包后投影为 repository_path；cwd 先做 realpath，repository_path 的 realpath 失败时保留数据库中的规范路径并进入 repository_mismatch，不能因仓库被移动而崩溃或绕过 gate。随后传入 decideCompanyEntry，再以 Switch 渲染：

- pending：沿用 StartupLoading；
- request/auth error：显示可重试的 Control Plane 连接错误，不进入 Shell；
- setup_required/repository_mismatch：CompanySetupRequired；
- ready：现有 Shell/Home/Session/GroupSession。

CompanySetupRequired 文案只给出 Desktop/browser 下一步和绑定路径；不创建公司，不调用 auth.set，不写 KV。

- [ ] **Step 3: 删除旧 writer 与 dead wizard**

删除 onboarding 目录 11 个文件、Onboarding import、kv.get("onboarding_done") 和 org-disband 的 kv.set。i18n 删除旧 onboarding interview/template/team 文案，新增：

- company.setup.required.title/body；
- company.setup.dataDirectory；
- company.repositoryMismatch.title/body/command。

Run: rg -n "onboarding_done|content-strategist|cofounder-|<Onboarding" src/cli/cmd/tui

Working directory: packages/control-plane

Expected: no output，exit 1。

- [ ] **Step 4: 运行 tests/typecheck**

Run: bun test src/cli/cmd/tui/routes/company-entry.test.ts

Working directory: packages/control-plane

Expected: PASS。

Run: bun typecheck

Working directory: packages/control-plane

Expected: PASS。

- [ ] **Step 5: Commit**

~~~bash
git add packages/control-plane/src/cli/cmd/tui/routes/company-entry.ts packages/control-plane/src/cli/cmd/tui/routes/company-entry.test.ts packages/control-plane/src/cli/cmd/tui/routes/company-setup-required.tsx packages/control-plane/src/cli/cmd/tui/app.tsx packages/control-plane/src/cli/cmd/tui/feature-plugins/system/org-disband.tsx packages/control-plane/src/cli/cmd/tui/i18n/en.ts packages/control-plane/src/cli/cmd/tui/i18n/zh.ts packages/control-plane/src/cli/cmd/tui/i18n/zht.ts packages/control-plane/src/cli/cmd/tui/routes/onboarding/business-scope-cards.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/cofounder-recruit-skill.ts packages/control-plane/src/cli/cmd/tui/routes/onboarding/founding-roles.ts packages/control-plane/src/cli/cmd/tui/routes/onboarding/frame.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/index.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/prompts.ts packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-founding-team.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-mission.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-profile.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-template-select.tsx packages/control-plane/src/cli/cmd/tui/routes/onboarding/step-welcome.tsx
git commit -m "feat(tui): gate entry on the shared company contract"
~~~

## Task 11: 真实纵向 E2E、重启恢复、文档与 M1 release gate

**Covers:** [M1-S1], [M1-S2], [M1-S4], [M1-S6], [M1-S7], [M1-S8], [M1-S9]

**Files:**

- Create: packages/app/e2e/m1-server.ts
- Create: packages/app/e2e/company-bootstrap.spec.ts
- Modify: packages/app/e2e/app-shell.spec.ts
- Modify: packages/app/playwright.config.ts
- Modify: packages/app/.gitignore
- Create: packages/control-plane/test/company/restart.test.ts
- Modify: docs/Agent Company 产品 PRD.md
- Modify: docs/product-design/implementation-plan.md
- Modify: docs/README.md

**Interfaces:**

- Consumes: built/real opencode server、shared Vite App、real temp Git。
- Produces: deterministic E2E root packages/app/.artifacts/m1-e2e。
- Produces: M1 completion evidence recorded in implementation-plan.md only after all gates pass。

- [ ] **Step 1: 建立真实 E2E server fixture**

m1-server.ts 每次启动：

1. 删除并重建 packages/app/.artifacts/m1-e2e/home 和 repository；
2. git init --initial-branch=main；
3. 写 README.md、git config 本地 test identity、git add/commit；
4. 设置 AGENTCOMPANY_HOME、AGENTCOMPANY_SERVER_USERNAME=agentcompany、AGENTCOMPANY_SERVER_PASSWORD=m1-e2e-secret、AGENTCOMPANY_DISABLE_MODELS_FETCH=true；
5. spawn packages/control-plane/src/index.ts serve --hostname=127.0.0.1 --port=4096，并显式允许 Playwright Vite origin 的 CORS；
6. 转发 signal 并等待 child，禁止遗留 server process。

这是测试 fixture，可以创建/删除自己的 .artifacts；不得触碰用户 home 或仓库。

~~~ts
import path from "node:path"
import fs from "node:fs/promises"

const app = path.resolve(import.meta.dir, "..")
const artifacts = path.join(app, ".artifacts/m1-e2e")
const home = path.join(artifacts, "home")
const repository = path.join(artifacts, "repository")
const uiOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`

await fs.rm(artifacts, { recursive: true, force: true })
await fs.mkdir(repository, { recursive: true })
await Bun.write(path.join(repository, "README.md"), "# M1 E2E repository\n")

for (const command of [
  ["git", "init", "--initial-branch=main"],
  ["git", "config", "user.email", "m1-e2e@agentcompany.test"],
  ["git", "config", "user.name", "M1 E2E"],
  ["git", "add", "README.md"],
  ["git", "commit", "-m", "Initial M1 fixture"],
]) {
  const git = Bun.spawn({ cmd: command, cwd: repository, stdout: "inherit", stderr: "inherit" })
  if ((await git.exited) !== 0) throw new Error(`Fixture command failed: ${command.join(" ")}`)
}

const child = Bun.spawn({
  cmd: [
    "bun", "run", "src/index.ts", "serve",
    "--hostname", "127.0.0.1",
    "--port", "4096",
    "--cors", uiOrigin,
  ],
  cwd: path.resolve(app, "../opencode"),
  env: {
    ...process.env,
    AGENTCOMPANY_HOME: home,
    AGENTCOMPANY_SERVER_USERNAME: "agentcompany",
    AGENTCOMPANY_SERVER_PASSWORD: "m1-e2e-secret",
    AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
  },
  stdout: "inherit",
  stderr: "inherit",
})
const stop = () => child.kill("SIGTERM")
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
process.exitCode = await child.exited
~~~

- [ ] **Step 2: 写失败的 Playwright vertical test**

~~~ts
import { expect, test } from "@playwright/test"

test("pairs a browser and completes real M1 bootstrap", async ({ page, request }) => {
  const basic = "Basic " + Buffer.from("agentcompany:m1-e2e-secret").toString("base64")
  expect((await request.get("http://127.0.0.1:4096/company")).status()).toBe(401)
  expect((await request.get("http://127.0.0.1:4096/company/providers")).status()).toBe(401)
  expect((await request.get("http://127.0.0.1:4096/global/event")).status()).toBe(401)

  const pairing = await request.post("http://127.0.0.1:4096/local-auth/pairings", {
    headers: { authorization: basic },
    data: { label: "Playwright Chromium" },
  })
  expect(pairing.ok()).toBe(true)
  const pair = await pairing.json()

  await page.goto("/?pair=" + encodeURIComponent(pair.code))
  await page.getByRole("button", { name: "连接本地公司" }).click()
  await expect(page.getByRole("heading", { name: "配置模型提供方" })).toBeVisible()

  await page.getByLabel("提供方").selectOption("openai")
  await page.getByLabel("API Key").fill("test-openai-key")
  await page.getByRole("button", { name: "保存并继续" }).click()
  await page.getByLabel("模型").selectOption({ index: 0 })
  await page.getByRole("button", { name: "下一步" }).click()

  await expect(page.getByRole("heading", { name: "创建本地公司" })).toBeVisible()
  await expect(page.getByLabel("公司名称")).toHaveValue("Agent Company")
  await expect(page.getByText("CEO", { exact: true })).toBeVisible()
  await expect(page.getByText("CTO", { exact: true })).toBeVisible()
  await expect(page.getByText("Product Lead", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "下一步" }).click()

  await page.getByLabel("Git 仓库路径").fill(process.env.PLAYWRIGHT_M1_REPOSITORY!)
  await page.getByRole("button", { name: "检查仓库" }).click()
  await expect(page.getByText("main", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "下一步" }).click()

  await expect(page.getByLabel("平衡")).toBeChecked()
  await page.getByRole("button", { name: "下一步" }).click()
  await expect(page.getByRole("heading", { name: "确认并创建" })).toBeVisible()
  await page.getByRole("button", { name: "创建公司" }).click()

  await expect(page.getByRole("heading", { name: "董事会准备就绪" })).toBeVisible()
  await expect(page.getByText("CEO", { exact: true })).toBeVisible()
  await expect(page.getByText("CTO", { exact: true })).toBeVisible()
  await expect(page.getByText("Product Lead", { exact: true })).toBeVisible()
  await expect(page.getByText("平衡", { exact: true })).toBeVisible()
  await expect(page.getByText("从一个可验收目标开始")).toBeVisible()
  await expect(page.locator('[data-capability="board-messages-disabled"]')).toBeVisible()
  await expect(page.locator(".company-composer, .company-thread, .company-approval, .company-delivery")).toHaveCount(0)

  const reused = await request.post("http://127.0.0.1:4096/local-auth/exchange", {
    data: { code: pair.code, label: "Reused code" },
  })
  expect(reused.status()).toBe(400)

  await page.reload()
  await expect(page.getByRole("heading", { name: "董事会准备就绪" })).toBeVisible()
})
~~~

Playwright config 使用两个 webServer entries：m1-server.ts 和 Vite。M1 server 的 reuseExistingServer 固定 false，确保每次 run 都清空自己的 fixture；Vite env 使用 VITE_AGENTCOMPANY_SERVER_HOST/PORT 指向 127.0.0.1:4096。company-bootstrap project 单独设置 locale=zh-CN、testMatch=company-bootstrap.spec.ts、retries=0，保证上面的中文 accessible name 稳定，且避免一次 run 内复用已创建状态伪装成干净 bootstrap。app-shell.spec.ts 使用独立 project，改成不交换 code 的匿名 pairing shell 测试，不再依赖 M0 fixture；M0 demo 只留在显式 fixture unit/visual 测试。

- [ ] **Step 3: 写真实 process restart test**

restart.test.ts 用 Bun.spawn 启动同一个 temp AGENTCOMPANY_HOME 两次：

- 第一次通过 API 设置 dummy OpenAI credential、bootstrap、保存 returned company id，SIGTERM 并等待退出；
- 第二次使用相同 home 和 Basic password，GET /company；
- 断言 company id、三个 board ids、repository project_id 完全相同；
- 断言第一次签发的 Browser Bearer 仍可访问；
- revoke 后同一 token 返回 401。

关键测试实现固定为真实 child process 和真实 HTTP，不在测试进程内重建 service：

~~~ts
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { CompanyProviderList, CompanyReadyState } from "../../src/company/schema"
import { IssuedCredential, LocalPairing } from "../../src/local-auth/schema"
import { tmpdir } from "../fixture/fixture"

const basic = "Basic " + Buffer.from("agentcompany:restart-secret").toString("base64")

async function waitForHealth(url: string, attempts = 200): Promise<void> {
  const ready = await fetch(new URL("/global/health", url))
    .then((response) => response.ok)
    .catch(() => false)
  if (ready) return
  if (attempts === 0) throw new Error("Restart test server did not become healthy")
  await Bun.sleep(25)
  return waitForHealth(url, attempts - 1)
}

async function start(home: string) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  const url = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    AGENTCOMPANY_HOME: home,
    AGENTCOMPANY_SERVER_USERNAME: "agentcompany",
    AGENTCOMPANY_SERVER_PASSWORD: "restart-secret",
    AGENTCOMPANY_DISABLE_MODELS_FETCH: "true",
  }
  delete env.AGENTCOMPANY_DB
  const child = Bun.spawn({
    cmd: ["bun", "run", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "inherit",
    stderr: "inherit",
  })
  await waitForHealth(url).catch(async (error) => {
    child.kill("SIGTERM")
    await child.exited
    throw error
  })
  return {
    url,
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null) child.kill("SIGTERM")
      await child.exited
    },
  }
}

async function json(url: string, pathname: string, init: RequestInit = {}, authorization: string | null = basic) {
  const headers = new Headers(init.headers)
  if (authorization) headers.set("authorization", authorization)
  if (init.body) headers.set("content-type", "application/json")
  const response = await fetch(new URL(pathname, url), { ...init, headers })
  return {
    response,
    body: await response.json().catch(() => undefined),
  }
}

async function initialize(home: string, repository: string) {
  await using server = await start(home)
  const providerSet = await json(server.url, "/company/providers/openai/credentials", {
    method: "PUT",
    body: JSON.stringify({ type: "api", key: "restart-test-key" }),
  })
  expect(providerSet.response.status).toBe(200)

  const providersResult = await json(server.url, "/company/providers")
  const providers = CompanyProviderList.parse(providersResult.body)
  const provider = providers.providers.find((item) => item.provider_id === "openai")
  const model = provider?.models[0]
  if (!provider || !model) throw new Error("Expected a connected OpenAI test model")

  const bootstrap = await json(server.url, "/company/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      request_id: randomUUID(),
      company_name: "Agent Company",
      provider_id: provider.provider_id,
      model_id: model.model_id,
      repository_path: repository,
      approval_preset: "balanced",
    }),
  })
  expect(bootstrap.response.status).toBe(200)
  const company = CompanyReadyState.parse(bootstrap.body)

  const pairingResult = await json(server.url, "/local-auth/pairings", {
    method: "POST",
    body: JSON.stringify({ label: "Restart browser" }),
  })
  const pairing = LocalPairing.parse(pairingResult.body)
  const exchange = await json(
    server.url,
    "/local-auth/exchange",
    {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, label: pairing.label }),
    },
    null,
  )
  return { company, issued: IssuedCredential.parse(exchange.body) }
}

test("restores company and browser credential after process restart", async () => {
  await using home = await tmpdir()
  await using repository = await tmpdir({ git: true })
  const first = await initialize(home.path, repository.path)

  await using server = await start(home.path)
  const bearer = "Bearer " + first.issued.token
  const restoredResult = await json(server.url, "/company", {}, bearer)
  expect(restoredResult.response.status).toBe(200)
  const restored = CompanyReadyState.parse(restoredResult.body)
  expect(restored.company.id).toBe(first.company.company.id)
  expect(restored.company.board.map((member) => member.id)).toEqual(
    first.company.company.board.map((member) => member.id),
  )
  expect(restored.company.repository.project_id).toBe(first.company.company.repository.project_id)

  const revoke = await json(
    server.url,
    "/local-auth/credentials/" + first.issued.credential_id,
    { method: "DELETE" },
  )
  expect(revoke.response.status).toBe(200)
  expect((await json(server.url, "/company", {}, bearer)).response.status).toBe(401)
})
~~~

同文件再写 `isolates two AGENTCOMPANY_HOME roots across child processes`：用 home A 初始化 Company/credential，启动全新 home B 后断言 `/company` 为 needs_bootstrap、data_directory 指向 B/data 且 A 的 Bearer 返回 401，再重启 A 断言仍为原 ready。两个 home 必须由独立 child process 导入 Control Plane，不能只在一个测试进程里改 env。

Run: bun test test/company/restart.test.ts

Working directory: packages/control-plane

Expected: PASS，覆盖同 home restart、两 home 隔离、Bearer persistence/revoke，且测试 finally 确认所有 child 都已退出。

- [ ] **Step 4: 运行完整 M1 gate**

Run: bun script/generate-agent-company-brand.ts --check

Working directory: repository root

Expected: PASS；Browser/Desktop 已提交品牌资产与当前唯一 SVG 可复现且 byte-identical。

Run: bun script/check-migrations.ts

Working directory: packages/control-plane

Expected: Migrations are up to date。

Run: bun test test/company test/local-auth test/server/company-route.test.ts test/server/network-auth.test.ts test/server/local-auth-route.test.ts test/script/build-node.test.ts

Working directory: packages/control-plane

Expected: PASS。

Run: bun typecheck

Working directory: packages/control-plane

Expected: PASS。

Run: ./packages/sdk/js/script/build.ts

Working directory: repository root

Expected: PASS。

Run: git diff --exit-code -- packages/sdk/js/src/v2/gen

Working directory: repository root

Expected: PASS；Task 6 提交后的 SDK regeneration 完全可复现，没有 generated drift。

Run: bun typecheck

Working directory: packages/sdk/js

Expected: PASS。

Run: bun test src/v2/company-contract.test.ts

Working directory: packages/sdk/js

Expected: PASS。

Run: bun test --preload ./happydom.ts ./src

Working directory: packages/app

Expected: PASS。

Run: bun typecheck

Working directory: packages/app

Expected: PASS。

Run: bun typecheck

Working directory: packages/ui

Expected: PASS。

Run: bun run build

Working directory: packages/app

Expected: PASS。

Run: PLAYWRIGHT_M1_REPOSITORY="$PWD/.artifacts/m1-e2e/repository" bun run test:e2e

Working directory: packages/app

Expected: PASS on chromium。

Run: bun test src/main/company-home.test.ts src/shared/brand.test.ts src/main/shell-env.test.ts src/renderer/html.test.ts

Working directory: packages/desktop

Expected: PASS。

Run: bun typecheck

Working directory: packages/desktop

Expected: PASS。

Run: bun run build

Working directory: packages/desktop

Expected: PASS。

Run: rg -n "OpenCode|opencode\\.ai|opencode://|ai\\.opencode|anomalyco/opencode|oc-theme-preload|opencode-theme-id|opencode-color-scheme|opencode\\.global\\.dat|opencode\\.workspace|opencode\\.json" packages/app/index.html packages/app/public packages/app/vite.js packages/app/vite.config.ts packages/app/src packages/ui/src/theme packages/ui/src/components/favicon.tsx packages/desktop/src packages/desktop/electron-builder.config.ts packages/desktop/electron.vite.config.ts packages/desktop/package.json --glob '!**/*.test.ts*'

Working directory: repository root

Expected: no production user-visible identity/storage hit；允许 lowercase virtual:opencode-server 和继承 theme ID/file name 等显式内部实现名，但本正则不应命中它们。

- [ ] **Step 5: 手工 Desktop/Browser/TUI 验收**

在一个全新 ai.agentcompany.desktop.dev userData 上：

1. 启动 Desktop，确认先出现目录选择；
2. 取消一次，确认没有 sidecar/Company/credential 被创建；
3. 选择 Documents/Agent Company，确认 relaunch 后 provider setup；
4. 用一个真实但低风险的 Provider credential 完成引导，导入带 commit 的真实 Git repo；
5. 关闭并重启 Desktop，确认同一公司/董事会/仓库；
6. 用无痕浏览器打开 sidecar URL，确认只能看到 pairing；
7. Desktop 生成 pairing link，浏览器交换成功；
8. Desktop revoke 后刷新浏览器，确认回到 pairing；
9. 在未初始化 home 启动 TUI，确认只提示主 UI；
10. 在已初始化 home 的错误 cwd 启动 TUI，确认显示绑定仓库；在正确 repo 启动，确认进入 Shell；
11. 确认 Browser tab、manifest 安装预览、Desktop Dock 与 About/menu 都显示 Agent Company/AC mark，Network 面板没有上游 favicon、social image 或 changelog 请求。

记录 macOS 一次完整结果。当前仓库没有 Desktop Windows CI job，M1 只以 platform-independent brand/config test、ICO magic 和 TypeScript build 证明静态契约，不把它表述成 Windows 运行证据；Windows/macOS 干净设备打包矩阵在 M6 建立。

- [ ] **Step 6: 同步产品文档**

只有 Step 4 和 Step 5 全通过后：

- PRD 6.1 调整为“安装 → 数据目录 → Provider → 三人董事会 → Git → preset → 起始建议”，并说明 browser 使用 host 已选目录；
- implementation-plan.md 把 M1 标记为完成，列出命令和日期，不把 M2 会话写成已实现；
- docs/README.md 索引本计划和“数据目录必须先于 Control Plane 初始化”的决策。

- [ ] **Step 7: Commit**

~~~bash
git add packages/app/e2e/m1-server.ts packages/app/e2e/company-bootstrap.spec.ts packages/app/e2e/app-shell.spec.ts packages/app/playwright.config.ts packages/app/.gitignore packages/control-plane/test/company/restart.test.ts docs/Agent\ Company\ 产品\ PRD.md docs/product-design/implementation-plan.md docs/README.md
git commit -m "test: close M1 bootstrap vertical slice"
~~~

## Failure/Recovery Matrix

| 失败点 | 已产生状态 | 用户恢复方式 | 自动验证 |
|---|---|---|---|
| 取消 data directory | 无 companyHome、无 sidecar | 留在 preflight 再选 | Desktop unit/manual |
| data directory 不可写 | 不保存 store | 显示路径错误，重选 | company-home test |
| Provider credential 失败 | 无 Company；可能已有可删除 auth entry | 原步骤重试/删除凭据 | provider route test |
| repository 非 Git | 无 Company；可有 unbound Project probe | 修正路径并 inspect | company service/route |
| transaction 前崩溃 | 无 Company rows | 重启后 draft 重试 | company test |
| transaction 中失败 | SQLite 全回滚 | 重试同一 request_id | company test |
| commit 后 response 丢失 | 完整 Company 已存在 | 同 request_id 返回 ready | idempotency test |
| 两个并发 bootstrap | immediate transaction 串行 | 一个 ready，另一个同输入 ready/不同输入 409 | concurrency test |
| pairing 码过期/复用 | 无新增 credential | Desktop 生成新 code | local-auth test |
| browser token 丢失 | server credential 仍在 | 重新 pairing，Desktop 可 revoke 旧 token | E2E/manual |
| browser token revoked | row 保留、time_revoked 写入 | 重新 pairing | route/E2E |
| Desktop Basic 每次重启变化 | renderer 旧值随进程销毁 | 新 renderer 从 preload 收新值 | restart/manual |

## Rollback Strategy

- 代码回滚不反向执行 20260713120000 migration，不删除 Company、Binding、Policy、Board 或 credential rows。
- 如果 M1 UI 必须回滚，M0 shell 只能显示明确 capability unavailable，不得回到生产 fixture。
- 如果 network auth 出现回归，允许操作者显式使用 --no-auth 进行本机诊断；该 flag 不成为默认，也不用于正式验收。
- 如果 Desktop 新 App ID 启动失败，保留 ai.agentcompany.* userData 与选定 companyHome；通过向前修复恢复，绝不读取 ai.opencode.* 作为 fallback。
- Browser credential 可由 Desktop revoke；服务端永远无法恢复明文 token。
- SDK generated contract 与 server route 必须同 commit 回滚/前滚，不能只回滚一侧。

## Assumptions and Fragile Points

| 假设 | 证据 | 风险 | 验证 |
|---|---|---|---|
| AGENTCOMPANY_HOME 在第一次动态 import 前设置即可隔离所有 Global/Database/Auth singleton | packages/shared/src/global.ts 与 Desktop 当前 dynamic import | 任一早期 value import 会把路径锁到默认 XDG | company-home import-order test + 两个 home process test |
| Bun target=node 能完整打包 src/node.ts 并由 Electron Vite 二次打包 | 现有 #db/#hono node export 与 virtual module pattern | native/asset/chunk 丢失 | build-node test + Desktop build + GET / |
| Provider.Service 可在稳定 bootstrap Instance 中复用而无需先选择 repo | Config/Provider 使用 InstanceState | setup Instance cache 可能看不到刚写 auth | provider route test，credential mutation 后 dispose/re-enter |
| Project.fromDirectory 的 worktree 是可持久化的规范主仓库根 | 现有 Project tests 和 project-id marker | symlink/worktree 可能产生不同字符串 | realpath/symlink repository tests |
| Browser localStorage 是 Pre-Public 可接受的本地 bearer 持久层 | 单用户 loopback threat model | 本机恶意脚本/XSS 可读取 | CSP、无第三方 script、token hash、revoke；M6 安全复审 |

最脆弱的假设是第一项：Global.Path 和 Database 在模块加载阶段有 singleton 行为。Task 9 和 Task 11 必须用独立 child process 证明两个 companyHome 不串数据；仅靠单进程 unit test 不能关闭这个风险。

## Review Gates

每个 Task commit 后做一次范围 review；Task 5 必须进行安全 review，检查：

- 无 unauthenticated data route；
- pairing 码不进入持久日志；
- token 明文只出现在 exchange response/browser storage；
- Basic password 不进入 electron-store；
- errors 不泄露 token_hash、auth.json 或 filesystem secrets。

Task 8 必须进行产品事实 review，检查：

- production/default dev 不显示 M0 fixture；
- board_messages=false 时没有 composer/message/thread/approval/delivery；
- UI 中每个“已连接/已创建/已绑定”都来自 server response。

## Plan Self-Review Checklist

- [x] [M1-S1] 被 Task 7、9、11 覆盖。
- [x] [M1-S2] 被 Task 2、5、7、9、11 覆盖。
- [x] [M1-S3] 被 Task 2、3 覆盖。
- [x] [M1-S4] 被 Task 3、4、11 覆盖。
- [x] [M1-S5] 被 Task 4、5、6、7 覆盖。
- [x] [M1-S6] 被 Task 7、8、11 覆盖。
- [x] [M1-S7] 被 Task 10、11 覆盖。
- [x] [M1-S8] 被 Task 1、6、9、11 覆盖。
- [x] [M1-S9] 被 Task 5、6、7、8、9、11 覆盖。
- [x] 文件路径均为仓库内精确路径，删除清单已展开；后续 Task 的 Modify 可以指向前序 Task 创建的文件。
- [x] 所有 code-producing Task 都包含 failing test、实现、验证和只 stage 本 Task 文件的 commit。
- [x] BootstrapInput、CompanyState、Listener.credentials、HttpBase.token 命名跨 Task 一致。
- [x] 文档没有把 M2/M3/M4 行为写成 M1 已实现。
- [x] 没有反向 migration、legacy fallback 或生产 fixture。
- [x] PRD 6.1 顺序差异与 implementation-plan.md 工期差异都已显式记录原因和同步时点。

## Execution Handoff

计划批准后按 Task 1 → 11 顺序执行；Task 2–5 是 Control Plane 契约主链，不能并行写同一 server/schema 文件。若未来获准并行，Task 7 与 Task 9 的 home/server 部分可在 Task 6 后分别推进，但 Task 9 icon 必须消费 Task 7 canonical SVG，最终都以 Task 11 的真实纵向 gate 汇合。

当前未发现 compose-preferences 的 execution-style 记录。由于本仓库规则没有授权使用 subagent，默认在当前任务内按 compose:execute 逐 Task 实施；只有用户明确要求委派时才切换 compose:subagent。
