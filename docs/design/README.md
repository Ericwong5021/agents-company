# Agent Company × Marvis Pencil 设计稿

- 主设计文件：`agent-company-marvis-pencil.pen`
- 本轮设计权威：Pencil
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

Pencil 文件内变量与 `UI-DESIGN-TOKENS.md`、`company-tokens.css` 对齐。可复用组件包含 Sidebar、Composer、Work Panel Header、Artifact Row、Tool Event、Signal Message、Attempt Card、Employee Activity Card 和 Status Badge。

## 验收输出

- `assets/references/marvis-*-2026-07-18.png`：九个 Marvis 实机状态存档
- `exports/KFn6r.png`：本轮四个关键目标屏 Contact Sheet
- `exports/DOEOk.png`：Company Group · High Signal
- `exports/EGnIP.png`：Thread · Attempt Recovery
- `exports/d5FhYn.png`：Agent Activity Detail
- `exports/VQyEm.png`：Office · Employee Cards
- `exports/zXTfi.png`：Responsive · 375px
- `qa/compare-board-reference-implementation-final.png`：董事会同视口对照
- `qa/compare-office-reference-implementation-final.png`：办公室同视口对照
- `qa/compare-settings-reference-implementation-final.png`：Marvis 与实装设置弹窗同视口对照
- Pencil 布局检查：当前 Master Board 无裁切、重叠或溢出问题
