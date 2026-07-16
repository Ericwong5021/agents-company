# Marvis 前端复刻 · Design QA

日期：2026-07-16
结果：**Passed**

## 验收对象

- 本地原型：<http://127.0.0.1:3000/>
- Figma：<https://www.figma.com/design/3qeohyiK2J7HSwhp8dB623>
- Figma 文件：`Agent Company · Marvis UI Replica`
- Figma 设计规模：8 个页面、122 个变量、10 个组件集、52 个变体
- 主要实现：`packages/app/src/pages/company/`

## 视觉来源

- Marvis 会话态：`/Users/wangyidong/.codex/marvis-reference-20260716/conversation-outputs.png`
- Marvis 产出预览空态：`/Users/wangyidong/.codex/marvis-reference-20260716/conversation-preview-empty.png`
- Marvis 办公室：`/Users/wangyidong/.codex/marvis-reference-20260716/office.png`
- Figma 董事会运行态：`/Users/wangyidong/.codex/agent-company-marvis-qa-20260716/figma-board-running-1487x768.png`
- Figma 办公室静态态：`/Users/wangyidong/.codex/marvis-reference-20260716/figma-office-static.png`

## 同视口对照

- 董事会运行态，1487 × 768，Figma 在左、浏览器原型在右：`/Users/wangyidong/.codex/agent-company-marvis-qa-20260716/compare-board-running-fullscreen-2974x768.jpg`
- 办公室静态态，1487 × 768，Figma 在左、浏览器原型在右：`/Users/wangyidong/.codex/agent-company-marvis-qa-20260716/compare-office-static-2974x768.jpg`
- Marvis 办公室与原型，双方均为 1421 × 768：`/Users/wangyidong/.codex/agent-company-marvis-qa-20260716/compare-marvis-office-2842x768.jpg`
- 最终真实董事会完成态，1487 × 768：`/Users/wangyidong/.codex/agent-company-marvis-qa-20260716/board-completed-fullscreen-1487x768.png`

全屏原始分辨率对照已覆盖左侧栏、主舞台、输入框、右侧线程面板和底部边界，因此不再额外裁剪局部图。对照后确认三栏宽度、标题与状态基线、主舞台边界、输入框位置和右侧标签区均对齐。

## 交互验证

- 新建对话入口可用；从新建态发送后会自动进入真实会话并打开服务端接受的线程。
- Company / Board 频道来自真实快照；搜索和频道切换可用。
- 办公室入口可用，运行数、完成数、总数和最近线程来自真实数据。
- 董事会议题通过真实 `sendMessage` 提交，运行状态从空闲到完成，最终显示 `共识 3 / 3`。
- 最终线程包含 4 条真实协作事件，终态下中断按钮正确禁用。
- 工作日志、产出物、预览三个标签可切换；最终线程列出 4 个真实 source，点击产出后会加载并进入预览态。
- 右侧线程面板可收起和重新展开；设置面板可打开和关闭。
- 自动任务、技能广场、本地知识库和文件选择保持视觉态且明确禁用，没有伪造后端能力。

## 迭代记录

1. 首轮对照发现共享壳层保留 40px 顶部拖拽区，导致复刻界面整体下移；已将 Company 工作区固定覆盖完整视口。
2. 首轮运行态把最新线程读取为旧记录；已按服务端的倒序数据语义选择最新议题。
3. 线程已完成时办公室仍计入运行中；已统一按 conversation run 终态统计并显示。
4. 从新建对话发送后仍停留在新建空态；已在提交时切换回真实会话视图。

## 已知边界

- 按需求，办公室中央 3D 工位与人物动画暂时留空；统计、线程摘要和整体布局已实现。该差异属于明确验收豁免，不计为视觉失败。
- 后端当前不暴露会话 Token 指标，界面显示 `—`，避免伪造数据。
- 最终流程运行期间没有新增 console error 或 warning。日志中保留了 4 条更早的 SSE 重连错误（15:18–15:28Z），来自验收过程中主动重启本地 Control Plane；最终 15:48Z 的完整议题闭环没有新增同类错误。

## 工程验证

- `packages/app`: `bun typecheck` — passed
- `packages/app`: `bun test --preload ./happydom.ts ./src/pages/company` — 68 passed, 0 failed
- `packages/app`: `bun run build` — passed
- CSS 生产校验 — 1 passed, 0 failed
- `git diff --check` — passed
