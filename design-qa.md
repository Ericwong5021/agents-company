# Marvis 前端复刻 · Design QA

日期：2026-07-17
结果：**Passed**

## 验收对象

- 本地原型：<http://127.0.0.1:5173/>
- Figma 文件：<https://www.figma.com/design/3qeohyiK2J7HSwhp8dB623>
- Figma Screens：<https://www.figma.com/design/3qeohyiK2J7HSwhp8dB623?node-id=62-2>
- Pencil 设计源：`docs/design/agent-company-marvis-pencil.pen`
- 主要实现：`packages/app/src/pages/company/`

Figma API 已直接读取该文件：共 8 个页面；`Screens / Marvis Replica` 下包含 New Conversation、Board Running、Conversation Work Log Expanded、Work Log Collapsed、Outputs、Preview Empty、Office Static 7 个核心画板。董事会节点 `64:147` 与办公室节点 `75:1003` 均可正常读取。

## 同视口视觉对照

董事会与办公室最终对照均使用 1421 × 768 视口，并把参考与实装放在同一张图片中复核：

- 董事会：`docs/design/qa/compare-board-reference-implementation-final.png`
- 办公室：`docs/design/qa/compare-office-reference-implementation-final.png`
- 设置弹窗：`docs/design/qa/compare-settings-reference-implementation-final.png`

设置弹窗另外通过 Computer Use 直接遍历 Marvis：确认其“保留底层会话 + 居中模态框 + 左侧垂直配置导航”的交互结构。参考与实装均从 1421 × 768 同坐标视口裁出 646 × 486 模态框后并排复核；通用设置仍使用项目已有真实配置控件。

提交仓库的 QA 素材已不可逆移除个人昵称、本机路径、Marvis 私人会话标题与使用量；办公室对照中的留白区域为脱敏遮挡，不影响壳层、舞台和统计布局的几何复核。

## 交互验证

- 本地浏览器按当前 PRD 的 loopback 边界直接进入真实 Company 工作区，不恢复历史配对门禁。
- 新建对话、Company / Board 切换、频道搜索、线程面板收起与重开均可用。
- 董事会议题通过真实 `sendMessage` 提交；验收议题运行完成并显示 `共识 3 / 3`、4 条协作事件。
- “新建对话”会先进入一个不恢复旧 Thread 的 Board 草稿态；从 Company 频道进入后发送也会真实启动董事会，不再把目标误投到 Company 主流。
- 工作日志、产出物、预览三个标签可切换，真实 source 与终态内容可读取。
- 设置弹窗可打开和关闭；公司概览、通用、快捷键、提供商、模型均可切换。
- 自定义 OpenAI-compatible Provider 可在首次引导中配置；本地 loopback 服务允许无真实 API Key，Company 默认模型会贯穿 Bid Probe、AgentRun、后备 Session Prompt 与 Product Lead 结构化结论，并在刷新后恢复。
- 项目工作台入口复用现有编码工作区；Company 与项目工作台可双向切换，已有会话、终端、评审、文件树、模型与 Agent 选择器仍可用。绑定仓库位于桌面端工作目录之外时也能通过安全边界；实机选择 `QA Model` 新建 session、发送消息并收到本地模型响应。
- 390 × 844 移动视口下，频道抽屉、遮罩关闭、董事会三角色布局、线程面板与办公室静态态均完成回归。
- 1024px 平板视口下，线程面板按覆盖层方式打开，不挤压主会话。

## 迭代记录

1. 将桌面壳层收敛为 168px 频道栏、主舞台、426px 线程栏，统一标题、输入框、舞台与右侧标签基线。
2. 修复 Company 与项目工作台之间使用 Solid 条件渲染时产生的陈旧状态，改为完整页面导航，保留两套真实功能面。
3. 修复移动端线程面板出现负向溢出、频道抽屉在完成导航后不关闭、董事会成员重叠等问题。
4. 依据 Marvis 设置实机对照，将 Company 设置改为保留底层上下文的居中模态配置流，并精确收敛弹窗尺寸。
5. 将未进入当前产品里程碑的自动任务、技能广场、应用、文档、图库与会话附件明确设为禁用，避免伪造能力。
6. 修复完整页面往返后只恢复董事会消息、未恢复最新 Thread 的状态缺口；现在刷新后仍保持终态、共识与协作事件。
7. 修复 Company 默认模型只写入初始化状态、董事会运行仍误用全局模型的问题；现在整个工作作用域使用 Company 的 provider/model，Agent 自身显式覆盖仍优先。
8. 修复自定义本地 Provider 在 UI 中允许留空 API Key、Pi runtime 却直接拒绝运行的问题；仅对配置来源的 loopback 或显式 header 认证连接提供非秘密占位凭证。
9. 修复 Company 页面只监听 `global` 目录、遗漏仓库作用域 SSE 终态事件的问题；董事会现在无需刷新即可从 `projecting` 收敛到 `completed`。
10. 修复“新建对话”沿用上一个 Company 频道的问题；新会话明确切到 Board，同时不恢复上一条 Thread。
11. 修复桌面端先切到用户主目录后，绑定在其他目录的公司仓库被项目工作台误判为越界的问题；安全边界现在仅额外允许数据库中精确绑定的仓库及其子目录，未绑定同级目录仍返回 403。

## 已知边界

- 按需求，办公室中央人物与工位动画暂时留空；办公室统计、线程摘要、静态结构和响应式布局已实现。
- 后端当前不暴露会话 Token 指标，界面显示 `—`，避免伪造数据。
- 自动任务、技能广场、应用、文档、图库等 M3–M6 能力保持诚实禁用。
- 项目工作台入口作为现有产品能力放在 Board 之后；这是相对 Pencil/Marvis 增加的唯一一级入口。
- 浏览器验收遵循 PRD LCP-01/LCP-09：Control Plane 仅监听 loopback，本地浏览器无需身份认证；非回环访问仍不属于当前产品路径。
- Figma/Pencil 使用固定演示文案，实装使用本地 Control Plane 的真实动态数据；验收以结构、尺寸、交互逻辑和状态语义一致为准。
- `packages/control-plane` 的仓库级全量测试目前仍有既有健康债务：2749 passed、277 failed、2234 errors（另有 11 skipped、1 todo）。抽样隔离复跑定位到未在本次 WebUI 改造中修改的 Memory、Project、Actor 等旧测试/全局状态问题；本次变更涉及及验收链路的后端测试均已通过。

## 工程验证

- `packages/app`: `bun typecheck` — passed
- `packages/app`: `bun run test:unit` — 399 passed, 0 failed（69 files）
- `packages/app`: Company 新会话、事件订阅与 Conversation Store 定向测试 — 36 passed, 0 failed，81 expects（2 files）
- `packages/app`: `bun run build` — passed
- CSS 生产校验 — 1 passed, 0 failed
- `packages/control-plane`: `bun typecheck` — passed
- `packages/control-plane`: GroupSession / Pi Provider / Conversation Runtime / Signal Projector / Company Conversation HTTP / Instance Directory Access 定向回归 — 38 passed, 0 failed，264 expects（6 files）
- `packages/desktop`: `bun typecheck` — passed
- `packages/desktop`: `bun run test:e2e` — 1 passed, 0 failed（Electron 生产构建、重启后公司选择与共享会话链路）
- `git diff --check` — passed

最终浏览器流程未产生新的 console error；构建仅保留已有的大 chunk 体积提示。
