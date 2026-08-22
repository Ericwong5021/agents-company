# Cumora 风格董事会群聊改造验收报告

日期：2026-08-23

## 结论

董事会已从治理表单页面重构为群聊优先的协作空间。页面以真实董事、消息、回复关系、表情反馈、投票和发言状态为主，Founder OS 治理信息移入右侧上下文栏和折叠工作台。

本次参考的是 Cumora 官方网站与 MIT 开源仓库。核对的源码版本为 `5dbbdee15b66e9f3faa52aacad14e8e27fe583e1`，重点参考其消息层级、浅色工作区、品牌蓝与珊瑚色身份区分、群成员状态和紧凑输入区，没有引入 Cumora 运行时依赖。

来源：

- https://cumora.ai/
- https://github.com/yetone/cumora

## 产品行为

- 董事会成员从当前公司 Agent 投影，不包含静态演示成员。
- 每位成员独立判断是否发言。公开消息按顺序落库；发现新消息时，旧响应会保留并重新阅读，避免多人同时发布过期回复。
- Agent 回复带 `reply_to_id`，界面显示引用卡片，点击可回到原消息并短暂高亮。
- 用户可回复消息、添加表情、发起投票、投票和查看成员响应状态。
- Agent 没有新的文字价值时，可以保持安静，也可以用 `👀`、`✅`、`🎯`、`👍`、`❤️` 做语义反馈；反馈以 Agent 身份持久化。
- 治理授权、决策台账、人工控制、影子建议和治理资产仍保留，但不再抢占群聊主界面。

## 设计系统

采用的 Cumora 设计色阶包括：

- 品牌蓝：`#00A8F0`、`#0078C8`、`#003B6F`
- 浅蓝背景：`#F2FAFE`、`#E1F3FD`、`#C2E6FB`、`#8FD3F7`、`#4FC2F4`
- 创始人珊瑚色：`#FF7A6B`、`#FFD9D2`、`#C84E3F`
- 强调金：`#F4B740`
- 中性色：`#0A1B2E`、`#233A53`、`#5B7186`、`#94A8BC`、`#C5D2DE`、`#E5ECF2`、`#FAFCFE`、`#FFFFFF`

视觉方向为浅色、克制、消息优先。非显然的选择是：Agent 使用蓝色，创始人使用珊瑚色；回复关系放进消息内部，不增加线程侧栏；Agent 的沉默也被设计成可观察状态，而不是伪造一条回复。

## 验收证据

- `packages/app` Nuxt typecheck：通过。
- `packages/control-plane` `bun typecheck`：通过。
- 根目录 lint：0 errors，3090 个仓库既有 warnings。
- group-session probe：2/2 通过。
- reaction、poll vote、read watermark 定向 HTTP 合约测试：1/1 通过。
- `git diff --check`：通过。
- 真实 Nuxt 页面，桌面 1440×900：4 条消息、4 组持久化反应、回复栏和引用跳转均可见，横向溢出为 0。
- 真实 Nuxt 页面，手机 390×844：相同消息与交互成立，横向溢出为 0。
- 临时验收消息仅用于本地页面检查，完成截图后已移除，产品未加入占位内容或演示数据。

截图：

- `packages/app/.artifacts/board-cumora-qa/board-desktop.png`
- `packages/app/.artifacts/board-cumora-qa/board-mobile.png`

## 已知验证边界

- R0 配置矩阵在现有自动登录 `waitForResponse` 处超时，未进入董事会断言。该脚本本次只修改了标题期望。
- 将 `conversation/runtime.test.ts` 与 `server/company-conversation.test.ts` 合并到同一进程执行时出现共享服务缺失和 hook timeout；单独执行本次相关的 reaction 合约测试通过。
- 本地假 Control Plane 不实现 Founder Advisor 和事件流端点，因此视觉验收期间对应请求返回 404/500；董事会消息、回复和反应渲染使用临时本地 fixture 验证，随后恢复为空。
