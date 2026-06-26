# TUI 设计规范 (Design System)

本文件定义 `packages/opencode/src/cli/cmd/tui` 下所有 TUI 界面的统一设计规范：配色、尺寸、间距、排版与组件约定。新增或修改界面时**必须**遵循本规范，不要硬编码颜色或凭感觉取尺寸。

渲染层基于 [`@opentui/solid`](https://github.com/sst/opentui)（Yoga flexbox + 终端单元格）。所有度量单位是**终端单元格（cell）**，不是像素。

---

## 1. 核心原则

1. **一切颜色走主题 token**。永远通过 `useTheme()` 取色（`theme.primary`、`theme.text`…），禁止写死 hex / ANSI。主题可被用户切换、被品牌色覆盖、被 light/dark 模式翻转——硬编码会破坏全部三者。
2. **尺寸要容得下全角中文（CJK）**。中文字符占 **2 个单元格**。算宽度时按"列数"而非"字符数"算（见 §3.4）。这是历史上最常见的溢出来源。
3. **高度要有界**。对话框从屏幕 25% 处开始绘制且**无滚动**（见 §5.1）。任何会随数据增长的内容，优先横向并排而非纵向堆叠。
4. **间距用刻度，不用随机数**。只用 §3.1 的间距刻度（0/1/2/3/4）。
5. **复用现有组件**。新面板用 `<Card>`，新弹窗用 `<Dialog>` 体系，新按钮照抄 §4.3 的主按钮样式——不要各写各的。

---

## 2. 颜色系统

### 2.1 主题 token

通过 `const { theme } = useTheme()` 访问，每个值是 `RGBA`。完整 token 见 `context/theme/agentcompany.json`（默认主题）。

| 用途分类 | Token | 典型语义 |
| --- | --- | --- |
| **品牌** | `primary` | 主强调色 / 选中态 / 主按钮底色 |
| | `secondary` | 次强调（如 agent 名高亮） |
| | `accent` | 链接、标题点缀、markdown 标题 |
| **状态** | `success` | 成功 / 正向 |
| | `warning` | 警告 / 文件名高亮 |
| | `error` | 错误 |
| | `info` | 提示信息 |
| **文字** | `text` | 主文字 |
| | `textMuted` | 次要 / 说明 / 占位文字 |
| | `selectedListItemText` | 列表选中项文字（默认回退到 `background`） |
| **背景** | `background` | 最底层背景（可能为 `transparent`） |
| | `backgroundPanel` | 面板 / 卡片默认底色（比 background 亮一档） |
| | `backgroundElement` | 元素 / hover 态底色（再亮一档） |
| | `backgroundMenu` | 菜单底色（回退到 `backgroundElement`） |
| **边框** | `borderSubtle` | 最弱分隔线 |
| | `border` | 标准边框 |
| | `borderActive` | 聚焦 / 激活边框 |
| **diff** | `diffAdded` / `diffRemoved` / `diffContext` / `diff*Bg` … | 代码 diff 渲染 |
| **markdown / syntax** | `markdown*` / `syntax*` | markdown 与语法高亮（一般由渲染器消费，业务 UI 少用） |

**灰阶**：默认主题用 `step1`→`step12` 共 12 档（暗色 `#0a0a0a`→`#eeeeee`）。背景档位映射：`background=step1`、`backgroundPanel=step2`、`backgroundElement=step3`；边框 `borderSubtle=step6`、`border=step7`、`borderActive=step8`。需要"比面板再亮/暗一点"时，优先用相邻的语义 token，而不是自己 tint。

### 2.2 选中态的前景反转

选中（背景变 `theme.primary`）时，其上的文字必须翻到 `theme.background` 以保证对比度。标准三态写法：

```tsx
backgroundColor={
  isSelected() ? theme.primary
    : isHovered() ? theme.backgroundElement
    : theme.backgroundPanel
}
// 文字：
fg={isSelected() ? theme.background : theme.text}
fg={isSelected() ? theme.background : theme.textMuted}  // 次要文字
```

需要按背景动态算对比前景时用 `selectedForeground(theme, bg)`（见 `context/theme.tsx`）。

### 2.3 品牌色 (brand color)

用户可选 8 种品牌色：`red / yellow / orange / purple / blue / green / pink / white`（默认 `blue`）。它会在主题之上覆盖 `primary / secondary / accent / success / info` 以及微调背景/边框。业务代码无需感知——只要用 token，就自动跟随。

### 2.4 主题清单

内置 30+ 主题（`DEFAULT_THEMES`），默认 `agentcompany`。还支持：插件主题、用户 `~/.config/.../themes/*.json`、以及从终端调色板生成的 `system` 主题。`--plain` 模式下背景全透明。

---

## 3. 间距与尺寸

### 3.1 间距刻度

`gap` / `padding` / `margin` 只取以下值（单元格）：

| 值 | 用途 |
| --- | --- |
| `0` | 紧贴（紧凑列表、`flush` 卡片） |
| `1` | **默认**：面板内边距、堆叠元素间距、图标与文字间距 |
| `2` | 区块/列之间的间距、对话框左右内边距 |
| `3` | 主按钮左右内边距 |
| `4` | 强调型按钮左右内边距 |

> 经验法则：纵向堆叠元素 `gap={1}`；横向分栏 `gap={2}`；面板内补白 `padding 1`；对话框边缘 `padding 2`。

### 3.2 对话框尺寸 (`Dialog`)

弹窗宽度由 `dialog.setSize(...)` 决定（见 `ui/dialog.tsx`）：

| size | 宽度（cell） | 用途 |
| --- | --- | --- |
| `medium`（默认） | `60` | 简单确认 / 单列表单 / 选择列表 |
| `large` | `88` | 卡片网格、带预览的多列布局（如引导建团队） |
| `xlarge` | `116` | 信息密集型（少用） |

- 对话框水平居中，`maxWidth = 终端宽度 − 2`（窄终端自动收窄，但**内容不会自动缩**——见 §3.4/§6）。
- 垂直方向：弹窗顶部从 `终端高度 / 4` 开始，**没有滚动**。可用纵向空间约为屏幕高度的 60–70%，务必据此控制内容高度。
- 在组件 `onMount` 里设置尺寸：`onMount(() => dialog.setSize("large"))`。

### 3.3 卡片尺寸

| 场景 | 推荐宽度 | 说明 |
| --- | --- | --- |
| 含**中文名**的卡片 | `width={20}`–`{22}` | 22 是项目内成熟基准（见 `step-founding-team.tsx` 的 `FounderCard`）。内容区 = 宽度 − 2(padding) − 2(border)。 |
| 纯英文短标签卡片 | `width={22}` | 见 `business-scope-cards.tsx` |
| 紧凑卡（省高度） | 同上宽度 + 去掉上下 padding | 仅留 `paddingLeft/Right={1}`，图标与名称合并到一行 |

卡片标准结构：`border` + `borderColor`（选中 `primary` / 默认 `border`）+ 三态背景（§2.2）+ `paddingLeft/Right={1}`。

### 3.4 终端宽度与中文（关键）

- 全角 CJK = **2 单元格**。`width={15}` 的卡片内容区只有 ~11 列，装不下 `企业级科技公司`（7 字 = 14 列）→ 溢出。
- 估算文本宽度：`英文字符 × 1 + 中文字符 × 2 + emoji × 2`。给固定宽度容器留至少 1–2 列余量。
- `<text>` 超出父容器固定宽度时，opentui **不会自动截断**，会溢出/重叠相邻元素。要么把容器放宽，要么确保文本可换行。

---

## 4. 组件规范

### 4.1 对话框 (`Dialog` 体系)

所有弹窗经由共享对话框栈渲染（`ui/dialog.tsx` 的 `useDialog()`），保证统一的窗体、遮罩、Esc 关闭、点击外部关闭、框选复制。

- 推入内容：`dialog.replace(() => <X/>, onClose?)`；清空：`dialog.clear()`。
- 内层内容自身**不要**再画遮罩/居中/外框，只排版内容，并沿用 `paddingTop={1}`（外层已提供）+ 左右 `padding 2` 的惯例。
- 引导流程统一用 `<OnboardingFrame>`（`routes/onboarding/frame.tsx`）：标题行（标题 + 步骤圆点）、可选副标题、助手气泡、body、可选 footer。

### 4.2 卡片 (`<Card>`)

侧栏/右栏区块统一用 `component/card.tsx`：

- 默认 `padding 1`、底色 `backgroundPanel`、可点击时 hover 变 `backgroundElement`。
- `flush` → 去内边距（紧凑堆叠）；`separator` → 顶部加 `border:["top"]` 分隔线；`title` → 顶部标题行。

### 4.3 主按钮 (Primary Action)

标准主操作按钮（照抄，不要另造）：

```tsx
<box
  backgroundColor={theme.primary}
  paddingLeft={3} paddingRight={3}
  paddingTop={1} paddingBottom={1}
  onMouseUp={handle}
>
  <text fg={theme.background}>{t("...confirm")}</text>
</box>
```

- 强调型（如"进入"）可用左右 `padding 4`。
- 行内紧凑按钮可用左右 `padding 2`、去掉上下 padding。
- 按钮文字恒为 `theme.background`（在 `primary` 底色上）。

### 4.4 助手气泡 (Speech Bubble)

底色 `backgroundElement`，四边 `padding 1`，`gap 1`：左侧图标（`theme.primary`），右侧 `flexGrow={1}` 文本列（名字 BOLD + `theme.primary`，正文 `theme.text`）。见 `OnboardingFrame`。

### 4.5 层级 / 分组图标（统一约定）

| 含义 | 图标 |
| --- | --- |
| 部门 / 分组 (division) | `📁` |
| C-suite | `👑` |
| Lead | `⭐` |
| IC（普通成员） | `·`（或空格占位） |
| 助手 / 系统 | `🌟` |
| 选中勾选 | `✓` |
| 步骤进度 | 当前 `●` / 未到 `○` |

新增层级展示请复用以上图标，保持跨界面一致。

---

## 5. 排版 (Typography)

### 5.1 文本属性

强调用 `attributes={TextAttributes.BOLD}`（来自 `@opentui/core`）。标题、分组名、强调词用 BOLD；正文不加。

### 5.2 `<text>` 硬性约束

**`<text>` 的子节点只能是字符串**。禁止在 `<text>` 内嵌套 `<box>` / `<Spinner>` / `<code>` 等渲染组件——会抛 `TextNodeRenderable only accepts strings`。需要"图标 + 文字"时，用一个 `flexDirection="row"` 的 `<box>` 分别放多个 `<text>`，或直接在同一个 `<text>` 里用字符串模板：`{icon} {name}`。

### 5.3 颜色

文字色一律走 token：主文字 `theme.text`、次要 `theme.textMuted`、强调 `theme.primary`/`theme.accent`、状态色 `theme.error/warning/success/info`。

---

## 6. 布局与溢出规则

1. **优先横向并排，而非纵向无限堆叠**。当一块内容（如预览面板）会随选择/数据出现并增高时，把它放到主内容**右侧**（`flexDirection="row"` + 右侧 `flexShrink={0}` 固定宽面板），让总高度由两列中较高者决定，而非两者相加。参考 `step-template-select.tsx`。
2. **网格用 `flexWrap="wrap"`**。多卡片用 `flexDirection="row" flexWrap="wrap" gap={1}`，让其在容器宽度内自动换行。给固定宽卡片配 `flexWrap`，不要假设一行放得下。
3. **核对宽度预算**。可用内容宽 = 对话框宽 − 左右 padding。例：`large`(88) − frame 左右 2×2 = 84。`84 / (卡片宽 + gap)` 才是每行卡片数。
4. **核对高度预算**。屏幕 25% 起绘且无滚动 → 标题 + 气泡 + 主体 + 按钮的总高度要控制在屏幕高度 ~60% 内。窄/矮终端是默认要考虑的情况。
5. **固定宽度容器 + 可能超长的文本**：要么放宽容器（§3.4），要么允许换行，否则会横向溢出。

---

## 7. 反模式（禁止）

- ❌ 写死颜色：`fg="#3C93FF"` / `backgroundColor="black"` → 用 token。
- ❌ 用字符数当宽度给中文容器算尺寸（忽略全角 2 列）。
- ❌ 纵向堆叠会增高的预览/列表，导致超出屏幕底部（无滚动）。
- ❌ 在 `<text>` 里嵌套非字符串节点。
- ❌ 选中态背景变 `primary` 却忘了把文字翻成 `background`（对比度丢失）。
- ❌ 随手取 `gap={5}`/`padding={7}` 之类刻度外的值。
- ❌ 自造弹窗外框/遮罩，绕开 `Dialog` 体系。

---

## 参考实现

- 主题与 token：`context/theme.tsx`、`context/theme/agentcompany.json`
- 对话框体系与尺寸：`ui/dialog.tsx`
- 卡片组件：`component/card.tsx`
- 引导外框 / 气泡 / 步骤点：`routes/onboarding/frame.tsx`
- 卡片网格 + 并排预览 + 主按钮：`routes/onboarding/step-template-select.tsx`、`step-founding-team.tsx`
