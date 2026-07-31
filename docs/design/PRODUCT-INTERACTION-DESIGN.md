# Agent Company 产品交互设计

> 状态：Pre-Public 当前目标
> 上位产品定义：`docs/product-design/00-overview.md`
> 视觉规范：`docs/design/UI-DESIGN-TOKENS.md`

## 1. Marvis 学习结论

| Marvis 模式 | Agent Company 处理 |
|---|---|
| 168px 轻量侧栏、低对比浅色画布 | 吸收布局比例与视觉节奏 |
| 新任务大输入框和任务灵感 | 改为“新建目标”，示例跨领域且不对应固定专家 |
| 单个 Marvis 负责整段任务 | 拒绝，主工作台是用户与动态 Agent 团队的群聊 |
| 工作日志、产出物、预览三页签 | 吸收，绑定来源 Thread 和真实制品 |
| 办公室中固定 App/File/Browser Agent | 拒绝固定专职队伍，只吸收空间氛围和状态可见性 |
| 工具失败与后续调整可见 | 吸收并升级为不可覆盖的 Attempt 事实链 |
| 小马闲暇活动 | 吸收真实 Ambient、社交和闲逛，拒绝无来源循环忙碌 |

## 2. 默认信息架构

```text
Inbox
  Goal Brief / Decision Center / Attention
Work
  Project / Board Room / Thread / Artifact / Delivery
Team
  员工与临时责任 / 能力证据 / 活动投影
Library
  Deliveries / Company Commons / Interpretations / Beliefs / Learning Patches
Settings
  Provider / Founder Studio / Founder Control Center / Integrations
```

一级导航固定为 Inbox、Work、Team、Library、Settings。Board 使用 `/company/board` 作为 Work 内治理承载面；Founder OS 不新增平行一级入口。Direct 仅在私域硬边界与 capability 解冻后显示。

## 3. 核心用户旅程

### 3.1 新建目标

1. 用户选择“新建目标”。
2. 页面显示 Company 标识、当前本地运行状态、统一 Composer 和跨领域示例。
3. 示例仅填入输入框，用户可继续编辑。
4. 未配置 Provider 时，目标先持久化并显示可定位设置的卡片。
5. Provider 可用时，目标进入董事会频道并创建 Root Need 与来源 Thread。

### 3.2 董事会与群聊

- 董事会频道使用圆桌舞台表现最小固定董事会的讨论状态。
- 公司和项目频道使用群聊消息流。
- 主会话仅显示用户输入及 conclusion、decision、plan、status、risk、approval、delivery、intervention。
- 每条 Agent 高信号消息必须带作者或 DRI、时间、项目和来源 Thread。
- 普通协作、工具、逐步进度和内部调度留在 Thread。

### 3.3 Thread

Thread 右面板是当前议题的完整过程，页签稳定为：

- 工作日志：消息、Agent Run、Tool Run、Attempt、Review、状态变化。
- 产出物：文档、代码、数据、图片、决策和验证证据。
- 预览：安全渲染选中的产出物。

切换频道时清理当前 Thread 选择；返回同一 Thread 时恢复上次页签和产出物。移动端 Thread 使用全屏覆盖层，关闭后恢复来源焦点。

### 3.4 失败与恢复

Attempt 卡片必须显示尝试序号、负责人、失败原因、影响、保留现场、是否可重试、下一次调整和升级状态。后续成功不能删除或覆盖历史失败。

只有失败改变计划、扩大风险或需要用户介入时，群聊才增加 risk、status 或 approval 消息。

### 3.5 办公室与员工卡片

办公室第一版由两列员工卡片组成。卡片读取同一个 `AgentActivityProjection`：

- Presence：是否在线或可达；
- Attention：primary、reactive、ambient、dream；
- Activity：working、reviewing、waiting、roaming、socializing、reflecting 等；
- Location、Subject、Interruptibility、Evidence、Since；
- 临时责任、团队、风险、协作者和最近产出。

点击卡片进入 Evidence 指向的 Thread、Artifact、只读 Direct 或 Ambient 事件。没有 Evidence 时只显示“暂无可验证活动”，不推断具体行为。

## 4. 界面状态

| 状态 | 主要表现 | 允许操作 |
|---|---|---|
| loading | 保持原布局的轻量骨架，不整页闪白 | 等待、返回 |
| empty | 解释下一步，不伪造历史或项目 | 新建目标、配置 Provider |
| running | 文本、状态点、开始时间和来源 | 打开 Thread、按规则中断 |
| waiting | 说明等待对象和是否可打断 | 打开依赖或审批 |
| failed | 显示安全失败摘要和 Attempt | 重试、调整、升级 |
| interrupted | 显示已中断和保留现场 | 继续、重新委派 |
| completed | 显示交付与验证证据 | 打开产出物、复盘 |
| stale | 保留最后快照并提示正在重连 | 手动刷新 |
| disconnected | 说明本地 Control Plane 未连接 | 重试连接 |

状态必须同时使用文字和图标或形状，不能只依赖颜色。

## 5. 结构化消息卡片

- Charter Card：目标价值、交付物、验收、风险、DRI、里程碑和待决策项。
- Approval Card：申请人、动作、原因、资源、风险、成本、可逆性、拒绝后果和推荐选项。
- Delivery Card：真实产出物、领域验证、Review findings、剩余风险和资源处置。

卡片只由服务端结构化事实投影生成。普通自然语言消息不通过关键词猜测卡片类型。

## 6. 产出物与安全预览

列表显示名称、类型、来源、版本、验证状态、更新时间和大小。预览按媒体类型处理：

- Markdown 和纯文本：使用现有 Markdown / code renderer；
- diff：复用现有 diff 组件；
- 图片：复用现有 image preview；
- 其他类型：显示元数据和“在受管位置打开”。

UI 不直接显示完整任意本地路径，不执行制品内脚本，不在预览中加载非 loopback 任意资源。

## 7. 键盘、焦点和通知

- 提供 skip-to-content。
- Tab 顺序遵循侧栏、标题、消息、Composer、Thread。
- Thread 页签支持左右方向键；Escape 关闭移动端覆盖层。
- 打开 Thread、产出物或员工 Evidence 时记录触发元素，关闭后恢复焦点。
- 通知点击定位对应高信号消息，并自动打开其来源 Thread。
- 普通 Agent 消息、内部重试和工具完成不产生系统通知。

## 8. 响应式

- `>=1180px`：完整三栏。
- `821px–1179px`：三栏压缩，Thread 不低于 320px。
- `721px–820px`：侧栏抽屉，Thread 覆盖主区。
- `<=720px`：Thread 全屏；办公室和目标示例改为单列。
- 375px 与 320px 下 Composer、审批动作和关闭按钮必须始终可见，无横向滚动。

## 9. 当前实现与依赖

| 能力 | 当前事实 | 目标依赖 |
|---|---|---|
| Inbox / Work / Team / Library / Settings | Nuxt 路由与真实状态投影已存在 | 继续按体验重构 Gate 验收 |
| Board 治理面 | `/company/board` 已读取真实 Board、Ledger、Shadow/Advisor 与接管事实 | 高模式仍需授权 |
| Thread、Attempt、Artifact、Delivery | 读取 Control Plane 与 Project 投影，不以 Fixture 补成功 | R2/R3 继续做产品验收 |
| 员工活动与能力证据 | Team 页面读取真实责任、负载、最近交付与能力状态 | 规模和人工可理解性待弱门禁 |
| Commons 与 Learning | Library 已承载来源、Interpretation、Belief 与 Patch | 真实样本待弱门禁 |
| Ambient / Direct / Dream | 冻结，不描述为可用 | Life 层解冻条件 |

在依赖未完成时，UI 显示诚实的空状态或隐藏入口，不回退到 fixture。

## 10. 当前实现规则

WebUI 只消费 Control Plane 的权威快照、生成 SDK 和失效事件，不维护第二套领域状态机。服务缺失、连接中断、模式关闭或来源不足时，页面必须显示不可用、阻断或空状态。机器验证与人工体验验收分开登记；实现存在不等于已公开发布。
