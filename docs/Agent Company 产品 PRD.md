# Agent Company 产品 PRD

> 状态：当前 / 首次公开版本基线
> 版本：0.5
> 更新日期：2026-08-13
> 上位文档：[产品宪法](product-design/PRODUCT-CONSTITUTION.md)
> 当前排期：[体验重构计划](product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)（R0-R4）
> 架构路径：[implementation-plan.md](product-design/implementation-plan.md)（M0-M6）

> 0.5 变更说明：全体 Agent 的默认 Runtime 统一为 Codex。默认董事会成员、动态招聘、内置 Workflow 和未显式覆盖的 Agent Run 均继承该默认值；显式选择 Pi 或 Claude Code 仍然有效，能力不兼容时必须在启动前失败，不得静默切换 Runtime。

> 0.4 变更说明：吸收 2026-07-25 生效的体验重构范围决定，消除本文与下位计划在**目标用户**（2.1）、**版本范围与 Life 层排序**（4.1）、**一级导航**（5.1）三处的冲突。本文继续定义首次公开版本的完整验收目标；体验重构计划决定这些目标按 R0-R4 的哪一段交付。

## 1. 产品概述

### 1.1 一句话定位

> Agent Company 是一个 local-first、IM-first 的 AI 公司操作系统，让单个用户在自己的电脑上经营一支能够跨领域自组织、自治理并持续成长的 AI 团队。

### 1.2 首次公开版本目标

用户安装桌面应用并给出目标后，可以离开窗口，让本地公司自行完成：

1. 董事会把目标整理成可验收 Project Charter；
2. 动态选择 Agent 并建立项目群；
3. 分解工作，按需组合能力并受管执行；
4. 只在重大变动或策略要求时请求用户决策；
5. 按领域验证结果，交付制品并处置受管资源；
6. 在重启后恢复状态；
7. 让参与 Agent 沉淀职业经验，并在私域中发生可见但不可编辑的人格成长。

首次公开版本必须证明同一套组织内核可以完成研究或分析、文档或本地应用工作，以及严格的软件交付。软件研发保留 Git、Review 和 Worktree 的深度治理，但不再定义整个产品的边界。

### 1.3 产品价值

| 用户问题 | 产品回答 |
|---|---|
| 多 Agent 很强，但需要人工编排 | 董事会和动态组织负责分解、组队与委派 |
| 自动化过程噪音太大 | 主会话只显示高信号，完整过程收进 Thread |
| 自治系统不敢放手 | 可配置批准等级、Gate、审计和可恢复工作区 |
| Agent 每次都是无状态工具 | 候选池、正式岗位、职业记忆与 Agent Home |
| 多 Agent 看起来只是在群聊 | 清晰职责、可验收工作、正式决定和交付闭环 |
| 拟人化产品只有动画，没有内在连续性 | 私人空间、Direct、Ambient、Reflection 与 Dreaming |
| 固定专家团队很快遇到场景边界 | 根据目标动态形成团队和临时责任，能力包不等于永久岗位 |
| 过程真实但界面难以理解 | 群聊高信号分层、Thread 工作日志、制品预览和员工状态卡片 |

## 2. 目标用户与核心任务

### 2.1 核心用户

首次公开版本面向：

- 希望把复杂目标交给自主团队的个人创作者和知识工作者；
- 同时承担产品、研究、内容、运营或工程责任的小团队负责人；
- 已使用各类 Agent，希望把单任务能力升级为持续组织能力的高阶用户。

共同特征：愿意让 Agent 自主执行，但要求数据留在本地、过程可追溯、重要决定可控，并希望公司能随目标变化自行形成最合适的协作结构。

**首个稳定版本的优化对象（2026-07-25 范围决定）**：体验设计只围绕 AI 原生独立开发者、技术创业者，以及需要完成研究、产品定义、写作、分析和软件交付的高阶 Agent 用户优化，不同时为全部知识工作者设计。架构保持领域中立，上述更宽的用户面仍是首次公开版本的目标，但不作为当前体验取舍的依据。机器可读事实源为 `product-design/experience-refactor/language-contract.v1.json` 的 `audience`，由 CI 校验。

### 2.2 核心 Jobs to Be Done

1. 当我有一个尚不够具体的目标时，帮我把它变成真正能验收的项目。
2. 当项目需要多种能力时，自动挑选、组建和管理 Agent 团队。
3. 当公司在后台工作时，只把真正需要我关注的事项带回来。
4. 当结果要交付或产生外部副作用时，给我足够证据判断风险，并保持资源可恢复、可处置。
5. 当我长期使用时，让我看到每个 Agent 的职业成长、关系和独特人格。

### 2.3 不要求用户完成的工作

- 手工为每个步骤选择 Agent；
- 为每个目标画工作流；
- 逐条阅读 Agent 间讨论和工具日志；
- 审核每一次分解、重试和内部委派；
- 手工追踪失败重试、制品版本或受管资源是否已妥善处置；
- 维护 Agent 的 SOUL 或伪造其私人生活。

## 3. 产品原则

### 3.1 IM-first，不是 Kanban-first

目标、计划、决策和干预都可以从对话发生。任务卡、审批卡、交付卡和看板是会话生成的结构化视图。

### 3.2 高信号默认，完整过程可追溯

主会话展示结论、决定、风险、状态、审批和交付；Thread 保存完整协作；工具细节继续嵌套。

### 3.3 默认自治，重大事项升级

内部工作自动运行。用户介入由确定性策略和 Agent 主动升级共同触发。

### 3.4 项目与领域能力解耦

Project 以目标、Charter、团队和验收为边界，不以仓库或行业为边界。研究、写作、分析、本地应用操作和软件交付复用同一组织内核；能力包、工具和领域适配器由系统按目标选择，不固化成一组永久专职 Agent。

软件交付单元优先绑定一个主仓库。跨仓库工作必须显式拆成关联 Work Item 或交付单元，分别治理写入、验证和合并顺序，但不强迫用户把一个业务目标拆成互不相关的产品项目。

### 3.5 Agent 既是员工，也是独立身份

Agent 有工作职责，也有其他 Agent 不可见的私人空间。人格连续性不能以牺牲治理和权限边界为代价。

## 4. 版本范围

### 4.1 必须交付

- 共享 WebUI 的桌面与浏览器工作台；
- 本地常驻 Control Plane、托盘/状态栏、通知和重启恢复；
- 公司群、董事会、部门群、项目群、Direct 和 Thread；
- 最小固定董事会、Project Charter 和动态组队；
- 公司/项目/单次三级批准策略；
- 领域中立的工作契约，以及研究、文档、本地操作和软件研发等代表性能力组合；
- 软件研发的实现、测试、Review、合并、主分支验证和严格 Worktree 生命周期；
- 候选池、正式岗位、Agent Home 和公开 PROFILE；
- 严格私域、Reflection、Ambient、Direct 和人格型 Dreaming；
- 员工卡片、真实行为状态投影和可供后续办公室画面复用的状态契约；
- 安装、升级、备份、导出、恢复、Windows/macOS 打包；
- 关键隐私、审批、Worktree 与恢复测试。

**交付顺序（2026-07-25 范围决定）**：以上是首次公开版本的完整验收范围，不是当前批次的开发清单。体验重构计划把交付顺序固定为“结果可用 → 过程可控 → 状态可信 → 责任可追溯 → 组织连续性 → 人格与生命感”，并据此重排：

| 本节能力 | 当前阶段 |
|---|---|
| 真实产品外壳、连接可信、用户状态投影 | R0（执行中） |
| Goal → Charter、Provider 向导、Work 入口 | R1 |
| 可控执行、Inbox、Gate 交互 | R2 |
| Artifact、Delivery、验收与返工闭环 | R3 |
| 候选池、正式岗位、动态组织与能力证据 | R4 |
| Agent Home、公开 PROFILE、Direct、Reflection、Ambient、人格型 Dreaming | 冻结，须先满足 Life 层解冻条件 |

Life 层解冻条件（R3 连续两个发布候选通过、核心任务完成率 ≥ 70%、Delivery 可消费率与验收可判定率 100%、SUS 中位数 ≥ 75、无效打断率 < 20%、目标用户明确表达需求）见体验重构计划第 10 节。冻结指“不在当前批次开发”，不等于从首次公开版本删除；解冻条件未满足时，本节对应能力不得作为发布门槛的已完成项。

### 4.2 明确非目标

- 多用户、多租户和云端公司托管；
- 手机和平板应用；
- 首次公开版本就穷尽全部行业和外部应用；
- 为每个领域预装一套固定专职 Agent 团队；
- Kanban-first 重型项目管理；
- 与真实状态无关的虚假忙碌展示；
- 在状态契约稳定前交付复杂二维或三维办公室；
- 允许用户编辑 Agent 私人空间；
- 为视觉模仿而重写现有技术栈。

## 5. 信息架构

### 5.1 一级导航

首个稳定版本使用五个一级入口（2026-07-25 范围决定）。机器可读事实源为 `product-design/experience-refactor/language-contract.v1.json` 的 `primaryNavigation`，路由与文案由 CI 校验，本表不得与之独立演化。

| 入口 | 路由 | 内容 |
|---|---|---|
| Inbox | `/inbox` | 需要用户处理的输入、审批、阻塞、失败和交付 |
| Work | `/work` | 目标、进行中的工作、项目、里程碑和高信号进展 |
| Team | `/team` | Agent 当前责任、负载、可用性和能力证据 |
| Library | `/library` | 制品、交付、决定、报告和历史版本 |
| Settings | `/settings` | Provider、批准策略、本地运行、数据和诊断 |

原六区模型（Inbox / Company / Projects / Agents / Views / Settings）不再作为导航结构，其内容需求按下表并入五入口；第 8 节各小节描述的是这些内容要求，不再对应独立的一级区域。

| 原区域 | 现位置 |
|---|---|
| Inbox | Inbox |
| Company（公司群、董事会、部门群） | Work 中的长期频道或目标入口 |
| Projects | Work > Project |
| Agents（候选池、正式员工、公开名片） | Team |
| Agent Home 与私域入口 | 冻结，随 Life 层解冻条件重新进入（见 4.1） |
| Views > 制品库 | Library |
| Views > 看板、组织图、审计、Token 统计 | Work / Team / Library 的上下文视图与 Diagnostics |
| Settings | Settings |

### 5.2 主工作区

```text
频道导航 | 主会话 + 输入 | 当前项目/Thread 上下文
```

- 主会话是默认焦点；
- Context Panel 按当前消息、Thread 或项目变化；
- Thread 在主会话中展开或以侧面板打开；
- 看板和组织图从 Views 进入，不替代会话。

### 5.3 高信号消息类型

- Conclusion；
- Decision；
- Plan / Charter；
- Status / Milestone；
- Risk / Blocker；
- Approval；
- Delivery；
- Intervention。

每条消息都要关联来源 Thread、作者或 DRI、项目和时间。

## 6. 核心用户旅程

### 6.1 首次进入

1. 安装并启动桌面应用；
2. 选择或创建本地公司数据目录；
3. Control Plane 创建默认公司、CEO/CTO/Product Lead 最小董事会和“平衡”批准策略；
4. 直接进入 Company 主工作台；
5. Provider 在 Settings 中按需配置。首发只提供 OpenAI 兼容 Provider 的端点、密钥、模型与 Header 配置，不展示或预置旧 OpenCode Provider。未配置时发送目标，主会话必须保留目标并显示可直达设置的 Provider 配置卡，不得把它伪装成已开始的董事会讨论；
6. 公司名称可在后续与董事会对话或 Settings 中生成和修改；
7. 不要求预先导入代码仓库或配置全部外部应用。需要软件交付时可由 Agent 在受管本地目录初始化 Git 仓库；用户也可以在获得授权后选择现有本地仓库。

数据目录必须在 Control Plane 初始化前由启动它的 host 固定。本地浏览器直接连接到只监听 loopback 的 Control Plane，读取该服务返回的目录事实，不能在线迁移或更改目录。

首次进入不要求用户预建部门、批量招聘 Agent、配置复杂工作流、Provider、能力组合或代码仓库。可发送的董事会会话属于 M2；未配置 Provider 时输入框必须给出明确的设置恢复路径，不能把静态消息或输入框伪装成已开始的讨论。

### 6.2 从目标到 Charter

1. 用户在董事会提出目标；
2. 董事会读取目标相关的本地资源、能力、规则和现状；
3. 董事会在 Thread 内讨论价值、范围、风险和验收；
4. 主会话出现 Charter Card；
5. 无重大待决策时按策略自动立项；
6. 有重大歧义时只询问会改变结果的事项；
7. Charter 通过后创建项目群和项目 DRI。

用户不需要审核每个 Charter。是否需要用户确认由批准等级和重大变化规则决定。

### 6.3 动态组队与执行

1. 项目 DRI 根据 Charter 生成能力需求；
2. 系统从正式员工和候选池中推荐最小团队；
3. 记录入选与未入选理由；
4. 建立可验收 Work Items 和依赖；
5. 为每个 Work Item 选择能力包、工具、权限和领域验证器；
6. 软件写入按交付单元创建受管仓库或 Worktree，其他工作绑定对应资源与副作用边界；
7. Agent 在 Thread 中协作、执行、自检和验证；
8. 主会话只报告里程碑、风险和计划变化。

### 6.4 Review、批准与交付

1. 执行 Agent 提交制品和验证证据；
2. Reviewer 对照验收生成 findings；
3. 未通过则带明确反馈回到执行；
4. 通过后根据策略自动交付或显示 Approval Card；
5. 交付后执行领域要求的复核、回读或副作用确认；
6. 验证通过才允许处置临时资源；
7. Delivery Card 汇总制品、证据、失败尝试、已知风险和资源状态；
8. 软件交付额外执行合并、主分支验证和 Worktree 清理。

### 6.5 后台与恢复

1. 用户关闭窗口；
2. Control Plane 继续已授权任务；
3. 托盘/状态栏显示真实状态；
4. 需要决策、阻塞、完成或异常时发系统通知；
5. 用户重新打开或系统重启后恢复项目、Thread、审批、Agent Run 和受管资源；
6. 无法自动恢复的资源进入明确待处置状态。

### 6.6 Agent 成长

1. 项目结束，Agent 进行 Reflection；
2. 候选 Agent 返回候选池，使用和质量记录更新；
3. 反复稳定贡献触发正式岗位提案；
4. 正式 Agent 在 Ambient 中闲逛、观察、探索和社交；
5. 经历达到阈值后创建私有 Dream Thread；
6. 用户可以只读查看 Dream、SOUL diff 和 Agent 解释；
7. 其他 Agent、管理者和董事会无法读取这些内容。

Ambient 行为可以形成关系变化、人格经历、企业文化理解、改进提案或工作线索。它必须消耗真实预算并留下可追溯事件，但不自动取得项目写权限，也不能伪造任务进度。

## 7. 功能需求

### 7.1 Local Control Plane

| ID | 需求 |
|---|---|
| LCP-01 | Control Plane 默认仅在回环地址提供 API 与事件流，本地 WebUI 无需认证即可直接进入 |
| LCP-02 | SQLite、Agent 文件和 Git 的写入由 Control Plane 统一协调 |
| LCP-03 | Electron 与浏览器使用同一 WebUI 和服务契约 |
| LCP-04 | 关闭桌面窗口不停止已授权任务 |
| LCP-05 | Windows/Linux 托盘和 macOS 状态栏提供打开、暂停、停止、退出 |
| LCP-06 | 审批、阻塞、完成和异常可发系统通知 |
| LCP-07 | 异常退出后恢复公司、项目、Thread、Gate、Agent Run 和受管资源状态 |
| LCP-08 | 支持版本迁移、备份、导出和恢复 |
| LCP-09 | 当前本地单用户阶段不认证用户；非回环监听不属于当前产品主路径，未来开放前必须补充认证与威胁模型 |
| LCP-10 | 全体 Agent 默认使用 Codex；默认董事会成员、动态招聘、内置 Workflow 和任何未显式指定 Runtime 的执行均解析为 Codex |
| LCP-11 | Agent 或受治理流程可以显式选择 Pi 或 Claude Code；显式选择优先于 Codex 默认值，所选 Runtime 不满足能力、生命周期、模型、权限或工作区要求时必须在启动前失败，不得静默改用其他 Runtime |

### 7.2 IM 与 Thread

| ID | 需求 |
|---|---|
| IM-01 | 支持公司、董事会、部门、项目和 Direct 五类频道 |
| IM-02 | 每个项目自动创建独立项目群 |
| IM-03 | 主会话按高信号协议展示，普通协作默认进入 Thread |
| IM-04 | Thread 保存完整成员、消息、Work Item、工具、日志、决定和制品 |
| IM-05 | 高信号消息可跳转到来源 Thread 和证据 |
| IM-06 | 工具日志与长输出默认折叠并按需加载 |
| IM-07 | 支持 @Agent、@Role、引用 Thread 和结构化动作 |
| IM-08 | Bidding 等内部调度默认不暴露评分噪音，只在诊断层可见 |
| IM-09 | 看板从会话派生，是辅助视图而非工作必经入口 |
| IM-10 | Thread 将工作日志、失败尝试、制品和预览分层呈现，群聊只接收对应高信号投影 |

### 7.3 董事会与项目治理

| ID | 需求 |
|---|---|
| GOV-01 | 新公司默认 CEO、CTO、Product Lead 最小董事会 |
| GOV-02 | 不可验收目标必须先形成 Charter，不得直接下发执行 |
| GOV-03 | Charter 含价值、交付、验收、范围、约束、风险、DRI、里程碑、待决策项 |
| GOV-04 | 每个正式决定只有一个 DRI，并记录理由与异议 |
| GOV-05 | 支持自主、平衡、严格三种批准预设 |
| GOV-06 | 策略按公司→项目→单次授权继承 |
| GOV-07 | Agent 可提高但不能降低审批等级 |
| GOV-08 | 重大变化、权限升级和高风险动作触发策略评估 |
| GOV-09 | 用户越级干预可执行但必须明确标记并审计 |
| GOV-10 | Gate 失败返回可执行反馈和恢复路径 |
| GOV-11 | 审计按 Root Need / Project / Thread 串联，不记录私人原文 |

### 7.4 组织与 Agent 生命周期

| ID | 需求 |
|---|---|
| ORG-01 | Charter 通过后按能力需求动态组建最小团队 |
| ORG-02 | 临时 Agent 项目结束后回到候选池，不自动删除 |
| ORG-03 | 记录候选、选择、拒绝、质量、成本、速度、声誉和专长 |
| ORG-04 | 高频、高质量且持续需要的能力可触发正式岗位提案 |
| ORG-05 | 正式 Agent 拥有持久职业记录和 Agent Home |
| ORG-06 | Agent 身份与模型解耦，可按任务选择不同模型 |
| ORG-07 | 岗位归档保留历史，重新聘用时重新评估权限 |
| ORG-08 | 具体目标中的职责和团队组合动态形成，不把能力包或默认模板固化为永久专职 Agent 阵容 |

### 7.5 领域工作与能力适配

| ID | 需求 |
|---|---|
| WORK-01 | 所有领域共享 Goal、Charter、Project、Work Item、Artifact、Gate、Approval 和 Audit 契约 |
| WORK-02 | 每个 Work Item 显式绑定输入、资源、权限、能力包、领域验证器、交付物和资源处置策略 |
| WORK-03 | 研究或分析支持来源追踪、交叉验证、时效性与结论证据 |
| WORK-04 | 文档或本地应用工作支持版本、回读验证、外部副作用确认和必要的回滚路径 |
| WORK-05 | 失败、重试、恢复和升级记录进入 Thread，并能投影为用户可理解的正式状态 |
| WORK-06 | 同一 Agent 可以按目标承担不同临时责任，权限仍按 Work Item 和资源逐次授予 |

### 7.6 软件交付与 Worktree

| ID | 需求 |
|---|---|
| DEV-01 | 一个可独立验收的软件交付单元优先绑定一个主仓库 |
| DEV-02 | Worktree 可配置且默认开启 |
| DEV-03 | 启用后执行创建→执行→测试→Review→批准→合并→主分支验证→销毁 |
| DEV-04 | 合并冲突和审批后新增变化回到 Review |
| DEV-05 | 未确认合并与主分支验证前禁止销毁 |
| DEV-06 | 失败和取消保留现场，等待明确处置 |
| DEV-07 | 启动时发现并恢复孤儿 Worktree |
| DEV-08 | 关闭 Worktree 时启用单写者限制 |
| DEV-09 | Delivery 必须包含 diff/提交、测试、Review、风险和清理证据 |
| DEV-10 | 跨仓库工作拆成关联 Work Item 或交付单元，分别治理写入、验证和合并顺序 |

### 7.7 Agent Home 与私域

| ID | 需求 |
|---|---|
| LIFE-01 | Agent Home 分为 private、professional、public 三空间 |
| LIFE-02 | SOUL 在 private；ROLE 在 professional；PROFILE 在 public |
| LIFE-03 | Agent 本人可读写 private，用户只读，所有其他 Agent 拒绝 |
| LIFE-04 | 管理者和董事会 Agent 没有 private 或 Direct 的特权 |
| LIFE-05 | private 不进入组织搜索、推荐、招聘、声誉或跨 Agent 摘要 |
| LIFE-06 | 用户查看不注入后续 Agent 上下文 |
| LIFE-07 | UI 不提供 private 编辑、转发和一键引用 |
| LIFE-08 | 磁盘外部修改被检测、版本化并标记为非 Agent 作者 |
| LIFE-09 | PROFILE 由 Agent 选择自述，系统附加签名事实 |
| LIFE-10 | 越权访问被阻止，只审计元数据 |

### 7.8 Direct、Ambient、Reflection 与 Dreaming

| ID | 需求 |
|---|---|
| GROW-01 | 两个 Agent 可在 Ambient 时间发起 Direct |
| GROW-02 | Direct 只对两位 Agent 和只读用户可见 |
| GROW-03 | 正式工作决定和承诺必须摘要回项目群 |
| GROW-04 | Direct 不能绕过权限、委派、Gate 和审计 |
| GROW-05 | Reflection 提取事实、教训、工作记忆和 INSTRUCT 建议 |
| GROW-06 | Ambient 低频、可中断、默认无项目写权限，可以通过闲逛、观察、探索和社交形成真实关系、文化理解与提案 |
| GROW-07 | Dreaming 由经历阈值、空闲和独立预算触发 |
| GROW-08 | Dream Thread 私有，允许形成有依据的 SOUL Patch |
| GROW-09 | SOUL 变化保存来源、理由、diff 和版本历史 |
| GROW-10 | Dreaming 不执行项目/外部操作，不改变 ROLE、权限和宪法 |
| GROW-11 | 现有记忆 consolidation 在 UI 中与人格型 Dreaming 明确区分 |

## 8. 页面与视图

本节定义各视图的**内容要求**，不定义导航结构。一级入口以 5.1 的五入口为准，本节各小节按 5.1 的映射表落到对应入口；Agent Home 与私域入口随 Life 层解冻条件重新进入（见 4.1）。

### 8.1 Inbox

默认按紧急度显示：权限/安全异常、审批、阻塞问题、用户问题、完成通知。每项可定位来源 Thread，支持稍后处理但不能静默丢弃。

### 8.2 Company / Board

公司视图显示公司群、董事会和部门。董事会首屏突出当前目标、待成 Charter 的事项、重大风险和跨项目决定，不使用 KPI 仪表盘替代会话。

### 8.3 Project Room

项目群是交付主场。Context Panel 显示 Charter、DRI、动态团队、里程碑、当前 Gate、受管资源、制品和预览。用户从消息进入 Thread、工作日志、失败记录、验证或审批。软件项目再显示仓库、diff、测试和 Worktree。

### 8.4 Agents

分为正式员工和候选池。Agent 页面包含：

- Agent 自选公开 PROFILE；
- 系统签名的职位、组织、状态、任期、声誉和权限；
- 当前行为、协作对象、位置、持续时间、可打断性和最近产出价值；
- 贡献、技能和职业记录；
- 用户只读的私人空间入口；
- 用户只读的相关 Direct；
- SOUL 与 ROLE 的明确分区。

### 8.5 Office / 员工状态面

首发使用员工卡片构成公司的实时状态面。每张卡片必须展示：

- 身份与系统签名的当前责任；
- 当前行为及其所属 Thread 或 Ambient 事件；
- 所在项目或公司位置，以及正在协作的对象；
- 行为开始时间、可打断性、风险与最近产出；
- 进入详情、Thread、Direct 或制品的明确入口。

员工卡片不是复杂办公室出现前的临时占位，而是长期存在的 Agent 状态观察器。后续二维或三维办公室只能复用同一状态契约，把卡片中的位置、行为和关系渲染为空间画面。

### 8.6 Views

- Board：按状态、负责人和项目查看 Work Items；
- Organization：角色、汇报与动态项目团队；
- Artifacts：制品、版本和验证证据；
- Audit：治理事件与授权链；
- Usage：Token、时间、成本和资源；
- Worktrees：生命周期与孤儿处置。

### 8.7 Settings

- 模型与提供方；
- 公司默认批准等级和规则；
- 项目覆盖策略；
- Worktree 默认值与启动命令；
- 后台、托盘、通知和资源预算；
- 数据目录、备份、导出和恢复；
- 隐私说明与诊断导出；
- 浏览器连接信息。

## 9. 核心数据对象

### 9.1 Company

`id, name, policy, approvalPreset, dataVersion, createdAt`

### 9.2 Agent

`id, lifecycle(candidate|employee|archived), role, department, capabilities, reputation, preferredRuntime(default: codex), homePath`

人格化自述不与系统职位事实混存为一个可任意编辑字段。

### 9.3 Channel / Thread / Message

- Channel：`kind, members, scope, retentionPolicy`
- Thread：`channelId, projectId, participants, status, budget, rootNeedId`
- Message：`signalType, author, sourceThread, replyTo, visibility`

### 9.4 Project / Charter / Work Item

- Project：`dri, team, status, resources, policyOverride, budget`
- Charter：`value, deliverables, acceptance, scope, nonGoals, constraints, risks, milestones, openDecisions`
- Work Item：`owner, dependencies, input, output, acceptance, resources, capabilities, validators, state, disposition`

### 9.5 Gate / Approval / Decision

- Gate：`kind, criteria, reviewer, result, findings`
- Approval：`action, resources, risk, requester, scope, expiresAt, outcome`
- Decision：`dri, options, rationale, dissent, impact`

### 9.6 Worktree

`projectId, workItemId, repository, branch, baseCommit, owner, lifecycleState, mergeCommit, verification, disposition`

### 9.7 Agent Identity Files

Agent 身份内容以版本化文件为权威源，数据库只保存索引、版本、校验和与权限元数据。具体结构见[信息架构](product-design/03-information-architecture.md)。

### 9.8 Agent Activity Projection

Agent 的可见状态采用正交字段，不把所有含义压成单个枚举：

`presence, attention, activity, location, subject, interruptibility, evidence, since`

- `presence`：offline、online、away；
- `attention`：primary、reactive、ambient、dream；
- `activity`：working、waiting、reviewing、reflecting、exploring、socializing、roaming、dreaming、paused、error；
- `location`：公司空间、项目空间、Direct、外部资源或未定位；
- `subject`：当前 Project、Work Item、Thread、Agent 或 Ambient 主题；
- `evidence`：支撑状态的运行、消息、工具、制品或事件引用。

员工卡片、托盘状态、组织视图和未来办公室画面都从此投影读取，不各自推断 Agent 状态。

## 10. 状态与异常

### 10.1 项目状态

`draft → ready → active → waiting_user → validating → delivering → verifying → delivered`

旁路状态：`blocked, paused, failed, cancelled`。旁路状态必须保存可恢复信息和下一步。软件适配器在 `delivering` 内继续记录 merging 与主分支验证状态。

### 10.2 Agent 状态

Agent 状态使用 9.8 的正交投影。`ambient` 表示注意力模式，不再与 `roaming`、`socializing`、`exploring` 等具体行为互斥。

所有状态必须来自真实 Thread、Agent Run、Direct 或 Ambient 事件。真实闲逛与社交可以用卡片或动画表达；没有事件依据的任务进度和忙碌状态不得展示。

### 10.3 错误呈现

每个失败状态回答：发生了什么、影响什么、第几次尝试、已尝试什么、为何失败、是否可自动恢复、下一次调整是什么、需要用户做什么、现场是否保留。

失败记录不得被下一次重试覆盖。主会话只在失败改变计划、风险或需要用户介入时显示高信号消息；完整尝试链在 Thread 的工作日志中按时间展开。

## 11. 权限与隐私

### 11.1 权限原则

- 最小授权；
- 决定权限与读取权限分离；
- 管理层级不等于私域权限；
- 模式和关系不能扩大硬边界；
- 用户可以提高自动化，但不能让 Agent 自行降低宪法安全边界。

### 11.2 私域测试面

必须覆盖 API、文件路径、全文搜索、embedding/索引、摘要、日志、通知、错误、备份、导出、UI 动作和上下文注入，而不是只测试一个读取接口。

### 11.3 本地访问边界

桌面和浏览器共享同一套无需用户认证的本地服务契约。Control Plane 默认只绑定 loopback，本地 WebUI 可以直接进入。当前版本不提供局域网监听；未来如开放非回环访问，必须作为独立能力引入认证并重新评估威胁模型。

## 12. 非功能需求

### 12.1 可靠性

- 重要状态变化先持久化再通知 UI；
- 进程中断后操作可幂等恢复；
- Worktree 和主仓库状态以 Git 事实校验；
- 不因摘要、缓存或 UI 断连丢失正式记录；
- 迁移和恢复失败时保留原数据并给出诊断。

### 12.2 性能

- 冷启动能快速显示本地公司与恢复状态；
- 大 Thread 和日志增量加载；
- 后台 Ambient/Dream 不影响 Primary 任务和 UI 响应；
- 搜索索引可重建，不阻塞权威写入；
- Token、CPU、内存和磁盘有公司级上限。

### 12.3 可访问性

- 核心路径完整支持键盘；
- 状态不只靠颜色；
- 审批和风险卡支持屏幕阅读；
- 动画可减少；
- 桌面与浏览器保持一致语义。

### 12.4 数据主权

- 默认本地存储；
- 明确展示数据目录和外发模型请求；
- 用户能导出公司数据、身份文件、项目记录和审计；
- 卸载不静默删除用户公司；
- 诊断包默认脱敏，不包含 private 和 Direct 正文。

### 12.5 视觉与动效

- 视觉完成度属于核心产品能力，不能作为功能完成后的表面美化；
- 学习 Marvis 对办公室氛围、角色辨识、状态可视化和“主回答 + 工作日志 + 产出物 + 预览”的分层处理，但将单聊结构改造成 Agent Company 的群聊协作；
- 以 Multica 的网页完成度、细节控制和整体色调克制感作为质量标杆，但不复制其页面或 Kanban-first 信息架构；
- 使用低噪音、长期工作友好的中性色体系，以少量强调色表达需要注意的状态；
- 主要层级依靠排版、留白、对齐和信息密度建立，不用大量彩色卡片制造层级；
- 主会话、Thread、卡片和 Context Panel 在桌面与浏览器保持一致视觉语义；
- 动效可表达真实工作、等待、闲逛、社交、反思和关系变化，但不得伪造工具调用、任务进度或产出；
- 首发优先打磨员工卡片、群聊、Thread 和 Context Panel，后续二维或三维办公室复用同一状态机；
- Agent 私人空间、Ambient 与 Dreaming 可以有更柔和、个人化和游戏化的气质，同时保持事实来源、治理与可访问性；
- 完整支持减少动效设置，所有状态变化在无动画时仍可理解。

## 13. 成功指标

### 13.1 北极星体验

用户能够把不同类型的真实目标交给同一家公司，无需预选 Agent 或团队结构，随后只在关键节点参与，并最终得到可验证、可追溯的交付。

### 13.2 主要指标

- Charter 首次达到可验收的比例；
- 用户每项目被打扰次数，以及其中真正需要用户判断的比例；
- 从目标到领域验证通过的项目比例，按研究、文档、本地操作和软件交付分别观察；
- Agent Review 或领域 Gate 前的自检发现率和返工次数；
- Worktree 孤儿率、误销毁率和自动恢复率；
- 主会话高信号消息点击进入 Thread 的比例；
- 用户从员工卡片正确理解 Agent 状态、风险和可打断性的比例；
- 动态团队中临时责任与目标能力需求的匹配质量；
- Ambient 产生并被采纳的关系变化、文化理解和改进提案质量，不以活动次数计分；
- 候选 Agent 再使用率与正式岗位晋升质量；
- 私域越权测试通过率（必须 100%）；
- 重启恢复成功率；
- 用户对 Agent 连续性与人格可信度的定性反馈。

指标不得激励 Agent 制造消息、延长讨论、频繁做梦或隐藏失败。

## 14. 首次公开版本纵向验收

### 14.1 场景

在一台干净的 Windows 或 macOS 设备上：

1. 安装并启动 Agent Company；
2. 配置模型并创建最小董事会；
3. 提出一个初始描述较宽泛、需要多种能力的目标；
4. 董事会产出有明确非目标和验证方式的 Charter；
5. 系统建立项目群，动态选择候选 Agent、临时责任、能力包和最小权限；
6. 至少两个 Agent 在 Thread 中协作，主会话保持高信号；
7. 一次执行失败后保留尝试、原因、调整和恢复记录，不伪造完成；
8. 关闭窗口，任务继续，托盘可打开，通知能定位项目；
9. 平衡模式下只在重大变化或最终外部副作用前请求批准；
10. 交付物通过领域 Gate，临时资源被安全处置；
11. 重启应用，项目、审计、失败记录和交付记录完整；
12. 员工卡片能从真实状态显示工作、等待、协作、闲逛或反思，并定位来源 Thread 或事件；
13. Agent 在 Ambient 中形成一条可追溯的关系、文化理解、提案或工作线索；
14. Agent 完成 Reflection；
15. 满足触发条件的正式 Agent 产生私有 Dream 和有依据的 SOUL diff；
16. 用户可读不可改，另一个 Agent 和董事会无法读取。

上述主路径必须在至少三类任务中重放：

- 研究或分析：输出带来源、交叉验证和时效说明的证据包；
- 文档或本地应用工作：输出可回读的制品，并验证外部副作用或回滚路径；
- 软件交付：导入带测试的真实 Git 仓库，完成多文件修改、独立 Agent Review、合并、主分支验证和 Worktree 清理。

三类任务必须使用同一套组织、群聊、Thread、治理和状态投影，不得为演示另建固定专家团队或平行流程。

### 14.2 失败条件

任一情况出现即不通过：

- 执行层收到没有可验证验收的目标；
- 用户必须手工选择固定 Agent 组合、编排流程或修数据库状态；
- 主会话被工具日志淹没；
- 失败记录被重试覆盖，或用户无法知道系统做过哪些调整；
- 关闭窗口终止任务或无法重新打开；
- Worktree 在合并/验证前被删除；
- 合并后没有主分支验证；
- 员工卡片、托盘和办公室画面使用彼此矛盾的状态来源；
- 闲逛只是循环动画，没有真实 Ambient 事件或可追溯价值；
- 其他 Agent 能读取 private 或 Direct；
- 用户能通过产品 UI 修改 SOUL；
- 当前记忆 consolidation 被包装成人格 Dreaming；
- 纵向路径依赖演示数据或人工补写状态。

## 15. 发布门槛

- 所有纵向验收在 Windows 与 macOS 通过；
- 高严重度数据丢失、受管资源破坏、越权和认证问题为零；
- 关键隐私、审批、状态投影、领域交付、Worktree 和恢复测试进入 CI；
- 安装、升级、备份恢复和卸载完成演练；
- 产品文案明确区分已实现、实验性和规划能力；
- README、产品宪法、PRD、设计与实现状态没有已知重大冲突。
