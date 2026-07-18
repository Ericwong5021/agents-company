# Agent Company UI Design Tokens

> 状态：Pre-Public 当前视觉规范
> 适用范围：`packages/app` 共享 Company WebUI、Electron renderer 与 Pencil 设计稿
> 参考：Marvis macOS 客户端的浅色桌面氛围、留白节奏与结果分层

## 1. 视觉主题与氛围

Agent Company 的界面应当安静、可信、有生命感。它首先是一个可以长期开着的本地公司工作台，其次才是一个 Agent 控制界面。

- 大面积低对比暖白承担空间感，避免仪表盘式的边框和卡片堆叠。
- 黑色承担主要动作和标题，紫色只表达 Agent Company 身份、焦点与运行状态。
- 员工人格通过真实头像、行为、关系和经历呈现，不通过装饰性渐变或虚假忙碌动画表达。
- 主会话保持高信号；工作日志、失败、工具和产出物在 Thread 中逐层展开。

三个品牌词：**安静、可信、有生命感**。

## 2. 色彩 Token

所有新颜色使用 OKLCH。CSS Token 使用 `--ac-*` 前缀，Pencil variables 使用相同语义名称。

| Token | OKLCH | 用途 |
|---|---|---|
| `--ac-canvas` | `oklch(0.985 0.002 285)` | 主画布 |
| `--ac-sidebar` | `oklch(0.972 0.003 285)` | 左侧栏、弱背景 |
| `--ac-surface` | `oklch(1 0 0)` | 输入框、浮层、卡片 |
| `--ac-surface-subtle` | `oklch(0.961 0.004 285)` | 状态摘要、悬停、空状态图标 |
| `--ac-selected` | `oklch(0.948 0.012 286)` | 当前频道和当前选项 |
| `--ac-border` | `oklch(0.910 0.005 285)` | 普通分隔线 |
| `--ac-border-strong` | `oklch(0.865 0.008 285)` | 输入框和浮层边界 |
| `--ac-text` | `oklch(0.205 0.010 285)` | 主要文字 |
| `--ac-text-muted` | `oklch(0.530 0.012 285)` | 次要说明 |
| `--ac-text-faint` | `oklch(0.680 0.010 285)` | 时间、元数据、占位符 |
| `--ac-accent` | `oklch(0.580 0.140 286)` | 焦点、运行中状态、来源入口 |
| `--ac-accent-soft` | `oklch(0.960 0.025 286)` | Accent 弱背景 |
| `--ac-success` | `oklch(0.600 0.140 145)` | 完成、在线、验证通过 |
| `--ac-success-soft` | `oklch(0.965 0.035 145)` | 完成弱背景 |
| `--ac-warning` | `oklch(0.700 0.150 75)` | 等待、Review、可恢复风险 |
| `--ac-warning-soft` | `oklch(0.970 0.040 75)` | 警告弱背景 |
| `--ac-danger` | `oklch(0.620 0.190 25)` | 失败、阻塞、高风险 |
| `--ac-danger-soft` | `oklch(0.965 0.035 25)` | 失败弱背景 |

颜色不能单独承担状态。状态必须同时包含文字、图标或可访问名称。

## 3. 字体规则

```css
--ac-font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
  "Noto Sans CJK SC", "Segoe UI Variable", sans-serif;
--ac-font-mono: "JetBrainsMono Nerd Font Mono", "SFMono-Regular", Consolas, monospace;
```

| Token | 大小 | 常用位置 |
|---|---:|---|
| `--ac-text-2xs` | 10px | 时间、短标签 |
| `--ac-text-xs` | 11px | 侧栏、元数据 |
| `--ac-text-sm` | 12px | 主体默认字号 |
| `--ac-text-md` | 14px | 面板标题、卡片标题 |
| `--ac-text-lg` | 16px | 页面标题 |
| `--ac-text-xl` | 20px | 空状态和详情标题 |
| `--ac-text-display` | 28px | 新目标入口品牌标题 |

- 字重只使用 400、500、600、700。
- 20px 以上标题使用 `letter-spacing: -0.012em`，28px 使用 `-0.022em`。
- 标题和短文案使用 `text-wrap: balance`，正文使用 `text-wrap: pretty`。
- 计数、Token、时间和持续时长使用 `font-variant-numeric: tabular-nums`。
- 根布局只设置一次 macOS 字体抗锯齿。

## 4. 组件样式

### 导航

- 左侧栏宽 168px，当前项使用弱紫灰填充，不增加左侧彩色粗线。
- 所有可点击行实际命中区域至少 40px，高密度视觉内容可以位于 28px 到 32px 的内部区域。
- 部门与 Direct 只在服务端返回真实频道时出现。

### Composer

- 桌面最大宽度 720px，圆角 14px，浅阴影，不使用玻璃效果。
- 新目标和频道会话复用同一输入契约，附件、提及和结构化动作按 capability 显示。
- 发送、停止和失败重试共用固定高度动作槽，避免状态切换抖动。

### 高信号消息

- 用户消息允许弱蓝灰气泡；Agent 高信号消息默认无整块气泡，依靠头像、作者、信号标签和正文建立层级。
- `decision`、`approval`、`delivery` 只有存在真实结构化投影时才渲染卡片。
- 每条高信号消息都显示来源 Thread 入口。

### Thread

- 右面板桌面宽 426px，稳定页签为工作日志、产出物、预览。
- 工作日志默认展开 Attempt 摘要，工具参数和原始日志继续折叠。
- 产出物行默认无独立阴影，使用背景层级、间距和悬停建立可点击性。

### 员工卡片

- 卡片是长期 Agent 状态观察器，不是复杂办公室前的临时占位。
- 卡片只显示公开身份和有 Evidence 的活动。没有 Evidence 时只显示 Presence 与“暂无可验证活动”。
- 工作、等待、Review、失败恢复、闲逛、社交、反思和做梦使用同一字段契约。

## 5. 布局原则

空间 Token：`4 / 8 / 12 / 16 / 24 / 32`。外层 padding 默认与该区域主要 gap 相同。

- 桌面：`168px sidebar + minmax(560px, 1fr) + 426px thread`。
- 1180px 以下：Thread 压缩为 `minmax(320px, 36vw)`。
- 820px 以下：侧栏成为抽屉。
- 720px 以下：Thread 成为全屏覆盖面板，不与主会话垂直串联。
- 375px 和 320px：Composer 保持 16px 外边距，办公室员工卡片改为单列。

主会话、办公室舞台和 Thread 分别只有一个任务。不要用相同圆角卡片把所有内容包起来。

## 6. 深度与阴影

```css
--ac-shadow-raised: 0 1px 3px rgb(17 20 28 / 5%), 0 6px 18px rgb(17 20 28 / 6%);
--ac-shadow-floating: 0 18px 48px rgb(17 20 28 / 16%);
```

- Raised：Composer、可拖动或需要从画布抬起的卡片。
- Floating：设置弹窗、移动端抽屉、Thread 覆盖面板。
- 普通消息、列表、统计和员工卡片优先使用背景层级与 1px 边界。

## 7. Do / Don't

- Do：让状态、风险、失败和来源一眼可追溯。
- Do：用真实闲逛和社交事件增加生命感。
- Do：保持主会话高信号，完整过程进入 Thread。
- Do：复用已有头像、图标、Markdown、diff 和文件预览组件。
- Don't：为未开放能力保留可点击或禁用的 Marvis 导航副本。
- Don't：显示虚假 Token 节省、虚假进度或无来源活动。
- Don't：使用紫蓝渐变、玻璃拟态、渐变文字或装饰性大光晕。
- Don't：用 CSS 绘制头像、场景或品牌插画。
- Don't：在 `workspace.css` 继续叠加覆盖同一个选择器。

## 8. 响应式与无障碍

- 首个可聚焦元素是“跳到主要内容”。
- 所有页签使用 `tablist / tab / tabpanel`，支持方向键切换。
- 打开 Thread 时聚焦面板标题或当前页签；关闭后恢复到来源消息或员工卡片。
- Escape 关闭移动端 Thread 与侧栏抽屉，浏览器后退优先关闭当前覆盖层。
- `prefers-reduced-motion: reduce` 下取消位移、循环脉冲和自动滚动。
- 200% 缩放不遮挡 Composer、审批动作和面板关闭按钮。

## 9. Agent Prompt Guide

实现 Agent 在生成 Company UI 时必须显式给出：

1. 使用 `--ac-canvas: oklch(0.985 0.002 285)`、`--ac-text: oklch(0.205 0.010 285)` 和 `--ac-accent: oklch(0.580 0.140 286)`。
2. 使用 168px 侧栏和 426px Thread，不自行发明新的桌面几何。
3. 主动作使用黑色或 Accent 实色；普通容器使用背景层级，不默认加阴影。
4. 员工卡片必须包含 Evidence 状态，不能从动画或文案猜测活动。
5. 新组件必须给出 loading、empty、error、keyboard focus 和 375px 行为。
