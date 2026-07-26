# Agent Company × Marvis Pencil 设计稿

> **验收证据已失效（2026-07-26 标注）**：本目录的同视口 QA 对照图产生于 2026-07-17 的 Solid/Vite 实现（`e3b74a1`），该实现已在 2026-07-23 的 Eve/Nuxt 迁移（`f51af90`）中整体删除，`packages/app/src` 目录不复存在。下方“验收输出”中的 `qa/compare-*.png` 与 [design-qa.md](design-qa.md) 只能作为历史记录阅读，**不构成当前 Nuxt WebUI 的验收证据**。当前 WebUI 的视觉与交互门槛由[体验重构计划](../product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md)的 SHELL-04、QA-03、QA-04 定义，尚未产生新的同视口验收记录。
>
> 目标稿本身（Pencil 画板、Marvis 参照存档、`exports/*.png`）不受影响，继续作为设计参照有效。

- 主设计文件：`agent-company-marvis-pencil.pen`
- 本轮设计权威：Pencil（目标稿层面）；WebUI 视觉语言的当前事实源见 [CODEX-DESIGN-LANGUAGE.md](../product-design/CODEX-DESIGN-LANGUAGE.md)
- 标准视口：1421 × 768
- 视觉基准：Marvis macOS 客户端实机界面
- 办公室画板现状：已替换为真实员工活动卡片目标稿

## 设计规范

- [UI Design Tokens](UI-DESIGN-TOKENS.md)：颜色、字体、间距、组件、响应式、动效与无障碍规范
- [产品交互设计](PRODUCT-INTERACTION-DESIGN.md)：Marvis 转译原则、信息架构、核心旅程、Thread、员工卡片与实现边界
- [设计 QA](design-qa.md)：实机对照、自动验证、已知阻塞与下一轮验证门槛

## 当前产品决策

Marvis 是 Agent Company 的重要前端学习对象，重点吸收办公室氛围、角色辨识、状态可视化，以及主回答、工作日志、产出物和预览的分层方式。Agent Company 不复制 Marvis 的单聊结构，而是把这些优点融合进群聊主工作台。

员工卡片版先用卡片替代复杂二维或三维动画。卡片展示身份、临时责任、当前行为、位置、协作对象、持续时间、可打断性、风险和最近产出，并能进入来源 Thread、Direct、Ambient 事件或制品。

员工卡片、托盘、组织视图和后续办公室画面必须消费同一套 Agent 状态投影。闲逛、观察、探索和社交可以被真实呈现，并形成关系、文化理解、提案或人格经历；没有真实事件来源的循环忙碌动画不属于产品状态。

## 画板

1. New Goal
2. Board Running
3. Conversation · Work Log Expanded
4. Conversation · Work Log Collapsed
5. Conversation · Outputs
6. Conversation · Preview Empty
7. Office · Employee Cards
8. Company Group · High Signal
9. Thread · Attempt Recovery
10. Agent Activity Detail
11. Responsive · 375px
12. Agent Company Target Contact Sheet
13. Marvis Reference Archive · 2026-07-18

## 设计系统

Pencil 文件内变量与 `UI-DESIGN-TOKENS.md` 对齐。可复用组件包含 Sidebar、Composer、Work Panel Header、Artifact Row、Tool Event、Signal Message、Attempt Card、Employee Activity Card 和 Status Badge。

原先并列的 `company-tokens.css` 已随 Solid WebUI 一并删除；当前实现的样式来源是 `packages/ui/src/styles/` 与 `packages/app/app/assets/css/main.css`，两者与本文件的 token 对齐关系尚未重新建立。

## 验收输出

- `assets/references/marvis-*-2026-07-18.png`：九个 Marvis 实机状态存档
- `exports/KFn6r.png`：本轮四个关键目标屏 Contact Sheet
- `exports/DOEOk.png`：Company Group · High Signal
- `exports/EGnIP.png`：Thread · Attempt Recovery
- `exports/d5FhYn.png`：Agent Activity Detail
- `exports/VQyEm.png`：Office · Employee Cards
- `exports/zXTfi.png`：Responsive · 375px
- Pencil 布局检查：当前 Master Board 无裁切、重叠或溢出问题

以下同视口对照图针对已删除的 Solid 实现，保留为历史记录，不作为当前验收证据（见页首标注）：

- `qa/compare-board-reference-implementation-final.png`：董事会同视口对照
- `qa/compare-office-reference-implementation-final.png`：办公室同视口对照
- `qa/compare-settings-reference-implementation-final.png`：Marvis 与实装设置弹窗同视口对照
