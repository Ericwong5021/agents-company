# Agent Company × Marvis Pencil 设计稿

- 主设计文件：`agent-company-marvis-pencil.pen`
- Figma 文件：<https://www.figma.com/design/3qeohyiK2J7HSwhp8dB623>
- Figma Screens：<https://www.figma.com/design/3qeohyiK2J7HSwhp8dB623?node-id=62-2>
- 标准视口：1421 × 768
- 视觉基准：Marvis macOS 客户端实机界面
- 办公室动画舞台：按产品要求保留为空白区域

## 画板

1. New Conversation
2. Board Running
3. Conversation · Work Log Expanded
4. Conversation · Work Log Collapsed
5. Conversation · Outputs
6. Conversation · Preview Empty
7. Office · Static

## 设计系统

Pencil 文件内包含颜色、字体、圆角和布局变量，以及侧栏、输入框、工作面板标题、产出物行和工具事件等可复用组件。

## 验收输出

- `exports/contact-sheet.png`：七屏总览
- `exports/*.png`：各画板 1421 × 768 原尺寸导出
- `qa/compare-board-reference-implementation-final.png`：董事会同视口对照
- `qa/compare-office-reference-implementation-final.png`：办公室同视口对照
- `qa/compare-settings-reference-implementation-final.png`：Marvis 与实装设置弹窗同视口对照
- `../../design-qa.md`：交互、响应式、工程验证与已知边界
- Pencil 布局检查：七个画板均无裁切、重叠或溢出问题
